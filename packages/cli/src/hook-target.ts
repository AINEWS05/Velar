import fs from 'node:fs'
import path from 'node:path'
import { readInstallReceipt } from './install-receipt'
import type { HookSelfTestTarget } from './hook-selftest'

export interface HookTargetCheck {
  id: string
  level: 'pass' | 'warn' | 'fail'
  message: string
}

export interface ResolvedHookTarget {
  checks: HookTargetCheck[]
  /** null when the hook isn't registered, or is registered but has no verifiable (fingerprinted) receipt. */
  target: HookSelfTestTarget | null
  command: string | null
}

const HOOK_COMMAND_SUFFIX = 'hook pre-tool-use'
const VENDORED_COMMAND_PATTERN = /node_modules[\\/]@velar-dev[\\/]cli[\\/]dist[\\/]index\.js/

/** A matcher that covers every tool — `.*` explicitly, or the field omitted entirely (Claude Code's own "match everything" default). Anything else means the hook has been narrowed to a subset of tools. */
function matcherCoversEverything(matcher: unknown): boolean {
  return matcher === undefined || matcher === '.*'
}

interface ExtractedHookEntry {
  command: string
  matcher: unknown
}

function extractVelarHookEntry(settings: unknown): ExtractedHookEntry | undefined {
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
      if (typeof command === 'string' && command.trim().endsWith(HOOK_COMMAND_SUFFIX)) {
        return { command, matcher: (group as Record<string, unknown>).matcher }
      }
    }
  }
  return undefined
}

function extractVelarHookCommand(settings: unknown): string | undefined {
  return extractVelarHookEntry(settings)?.command
}

function readJsonIfExists(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return undefined
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Shared resolution logic for `velar doctor` and `velar test`: find the
 * registered hook command (settings.local.json, falling back to the legacy
 * settings.json location), match it against the install receipt, and
 * produce a HookSelfTestTarget that's safe to execute (fingerprint-verified,
 * contained within the recorded vendor root) — or null with an explanation
 * if that's not currently possible.
 */
export function resolveHookTarget(cwd: string): ResolvedHookTarget {
  const checks: HookTargetCheck[] = []
  const claudeDir = path.join(cwd, '.claude')
  const localSettingsPath = path.join(claudeDir, 'settings.local.json')
  const legacySettingsPath = path.join(claudeDir, 'settings.json')

  const localSettings = readJsonIfExists(localSettingsPath)
  const legacySettings = readJsonIfExists(legacySettingsPath)

  let settingsPath: string | undefined
  let entry = extractVelarHookEntry(localSettings)
  if (entry) {
    settingsPath = localSettingsPath
    checks.push({ id: 'settings-exists', level: 'pass', message: `${localSettingsPath} exists.` })
  } else {
    const legacyEntry = extractVelarHookEntry(legacySettings)
    if (legacyEntry) {
      entry = legacyEntry
      settingsPath = legacySettingsPath
      checks.push({
        id: 'settings-exists',
        level: 'warn',
        message:
          `Velar hook found in the legacy ${legacySettingsPath} location, not settings.local.json. ` +
          `Run \`velar init\` again to migrate.`,
      })
    }
  }

  if (!settingsPath || !entry) {
    checks.push({
      id: 'hook-registered',
      level: 'fail',
      message: `No Velar PreToolUse hook entry found in ${localSettingsPath} (or the legacy settings.json). Run \`velar init\`.`,
    })
    return { checks, target: null, command: null }
  }
  const command = entry.command
  checks.push({ id: 'hook-registered', level: 'pass', message: `Velar hook registered: ${command}` })

  // Drift check: the hook entry can still be found (so 'hook-registered'
  // passes) while its `matcher` has been narrowed from `.*` to a subset of
  // tools — e.g. only `Bash` — silently dropping coverage for Read/Write/
  // WebFetch/etc. `velar doctor`'s self-test below only proves the resolved
  // COMMAND still runs; it never exercises Claude Code's own matcher logic,
  // so this is the only place that can catch a narrowed matcher at all.
  if (matcherCoversEverything(entry.matcher)) {
    checks.push({ id: 'hook-matcher-coverage', level: 'pass', message: 'Hook matcher covers every tool call (`.*`).' })
  } else {
    checks.push({
      id: 'hook-matcher-coverage',
      level: 'warn',
      message:
        `Hook matcher is "${String(entry.matcher)}", not \`.*\` — Velar is only watching a subset of tools. ` +
        'Run `velar init` again to restore full coverage.',
    })
  }

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
      message: 'Hook command looks like a pre-0.2.0 install (a bare `velar` command). Run `velar init` again to upgrade it.',
    })
  }

  const velarDir = path.join(cwd, '.velar')
  const receipt = readInstallReceipt(velarDir)

  if (!receipt || receipt.hookCommand !== command) {
    checks.push({
      id: 'install-receipt',
      level: 'warn',
      message: !receipt
        ? 'No install receipt found (.velar/install-receipt.json) — cannot cryptographically verify the hook ' +
          'target before executing it. Run `velar init` again to get a verified receipt.'
        : 'Install receipt does not match the currently registered hook command. Run `velar init` again to refresh it.',
    })
    return { checks, target: null, command }
  }

  checks.push({ id: 'install-receipt', level: 'pass', message: 'Install receipt matches the registered hook command.' })

  const target: HookSelfTestTarget = {
    executable: receipt.hookExecutable,
    args: receipt.hookArgs,
    entryPath: receipt.vendorEntryPath,
    vendorRoot: receipt.vendorRoot,
    expectedFingerprint: receipt.vendorEntryFingerprint,
  }
  return { checks, target, command }
}
