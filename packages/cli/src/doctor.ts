import fs from 'node:fs'
import path from 'node:path'
import { runHookSelfTest, type HookSelfTestResult } from './hook-selftest'
import { defaultConfigDir } from './config'

export interface DoctorCheck {
  id: string
  level: 'pass' | 'warn' | 'fail'
  message: string
}

export interface DoctorResult {
  /** true iff no check has level "fail" — a "warn" alone does not fail doctor. */
  ok: boolean
  checks: DoctorCheck[]
}

const HOOK_COMMAND_SUFFIX = 'hook pre-tool-use'
const VENDORED_COMMAND_PATTERN = /node_modules[\\/]@velar-dev[\\/]cli[\\/]dist[\\/]index\.js/
/** Above this, the hook still "works" but a warning is worth surfacing. */
const SLOW_HOOK_THRESHOLD_MS = 200

function extractVelarHookCommand(settings: unknown): string | undefined {
  if (!settings || typeof settings !== 'object') return undefined
  const hooks = (settings as Record<string, unknown>).hooks
  if (!hooks || typeof hooks !== 'object') return undefined
  const preToolUse = (hooks as Record<string, unknown>).PreToolUse
  if (!Array.isArray(preToolUse)) return undefined

  for (const group of preToolUse) {
    if (!group || typeof group !== 'object') continue
    const hookList = (group as Record<string, unknown>).hooks
    if (!Array.isArray(hookList)) continue
    for (const h of hookList) {
      if (!h || typeof h !== 'object') continue
      const command = (h as Record<string, unknown>).command
      if (typeof command === 'string' && command.trim().endsWith(HOOK_COMMAND_SUFFIX)) return command
    }
  }
  return undefined
}

/**
 * Verifies that a project's `.claude/settings.json` has a working Velar
 * PreToolUse hook — not just that a settings file mentions one, but that
 * the exact registered command actually executes. Used by `velar doctor`
 * and safe to call repeatedly; makes no writes.
 */
export function runDoctor(
  cwd: string,
  options: { selfTest?: (command: string, cwd: string) => HookSelfTestResult; configDir?: string } = {},
): DoctorResult {
  const selfTest = options.selfTest ?? runHookSelfTest
  const checks: DoctorCheck[] = []

  const settingsPath = path.join(cwd, '.claude', 'settings.json')
  if (!fs.existsSync(settingsPath)) {
    checks.push({
      id: 'settings-exists',
      level: 'fail',
      message: `${settingsPath} does not exist. Run \`velar init\` in this project first.`,
    })
    return { ok: false, checks }
  }
  checks.push({ id: 'settings-exists', level: 'pass', message: `${settingsPath} exists.` })

  let settings: unknown
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    checks.push({ id: 'settings-valid-json', level: 'fail', message: `${settingsPath} is not valid JSON.` })
    return { ok: false, checks }
  }

  const command = extractVelarHookCommand(settings)
  if (!command) {
    checks.push({
      id: 'hook-registered',
      level: 'fail',
      message: 'No Velar PreToolUse hook entry found in settings.json. Run `velar init`.',
    })
    return { ok: false, checks }
  }
  checks.push({ id: 'hook-registered', level: 'pass', message: `Velar hook registered: ${command}` })

  if (VENDORED_COMMAND_PATTERN.test(command)) {
    checks.push({
      id: 'hook-command-form',
      level: 'pass',
      message: 'Hook command is a self-contained absolute path (not PATH-dependent).',
    })
  } else {
    checks.push({
      id: 'hook-command-form',
      level: 'warn',
      message:
        'Hook command looks like a pre-0.2.0 install (a bare `velar` command). ' +
        'It depends on `velar` still being on PATH and can silently stop working after an `npx` install ' +
        'leaves PATH — run `velar init` again to upgrade it to a self-contained absolute path.',
    })
  }

  const selfTestResult = selfTest(command, cwd)
  if (selfTestResult.ok) {
    checks.push({
      id: 'hook-executes',
      level: selfTestResult.elapsedMs > SLOW_HOOK_THRESHOLD_MS ? 'warn' : 'pass',
      message:
        selfTestResult.elapsedMs > SLOW_HOOK_THRESHOLD_MS
          ? `Hook executed successfully but took ${selfTestResult.elapsedMs}ms (target: well under 50ms warm).`
          : `Hook executed successfully in ${selfTestResult.elapsedMs}ms.`,
    })
  } else {
    checks.push({
      id: 'hook-executes',
      level: 'fail',
      message:
        `Hook command failed to execute correctly` +
        `${selfTestResult.exitCode !== null ? ` (exit code ${selfTestResult.exitCode})` : ''}` +
        `${selfTestResult.spawnError ? ` — ${selfTestResult.spawnError}` : ''}. ` +
        'Velar is NOT currently protecting this project, despite being listed in settings.json.',
    })
  }

  const configDir = options.configDir ?? defaultConfigDir()
  const configPath = path.join(configDir, 'config.json')
  if (fs.existsSync(configPath)) {
    checks.push({
      id: 'login-state',
      level: 'pass',
      message: `Logged in (${configPath}). Slack approval and dashboard reporting are enabled.`,
    })
  } else {
    checks.push({
      id: 'login-state',
      level: 'warn',
      message: `Not logged in (${configPath} not found). Local blocking still works; run \`velar login\` to enable Slack approval and dashboard reporting.`,
    })
  }

  return { ok: checks.every((c) => c.level !== 'fail'), checks }
}
