import fs from 'node:fs'
import path from 'node:path'
import { vendorCli } from './vendor'
import { resolveHookTarget } from './hook-target'

/**
 * Every Velar statusLine command ends with this. Mirrors
 * VELAR_HOOK_COMMAND_SUFFIX in settings-merge.ts — same reasoning: lets us
 * recognize (and safely remove) our own entry regardless of which version's
 * vendored path wrote it, without ever touching a statusLine some other
 * tool or the user configured by hand.
 */
const STATUSLINE_COMMAND_SUFFIX = 'statusline'

export function isVelarStatuslineCommand(command: unknown): command is string {
  return typeof command === 'string' && command.trim().endsWith(STATUSLINE_COMMAND_SUFFIX)
}

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

/** Builds the exact `<node> <vendored entry> statusline` command Claude Code's statusLine config should invoke. */
export function buildStatuslineInvocation(entryPath: string): { command: string } {
  const executable = process.execPath
  return { command: `${shellQuote(executable)} ${shellQuote(entryPath)} statusline` }
}

/**
 * Structural removal of a Velar-installed statusLine entry — mirrors
 * removeVelarHooks in settings-merge.ts. Only ever touches the top-level
 * `statusLine` key, and only when its `command` is recognizably ours;
 * a statusLine belonging to the user or another tool is left completely
 * alone.
 */
export function removeVelarStatusLine(settings: Record<string, unknown>): { settings: Record<string, unknown>; removed: boolean } {
  const statusLine = settings.statusLine
  if (!statusLine || typeof statusLine !== 'object' || Array.isArray(statusLine)) {
    return { settings, removed: false }
  }
  const command = (statusLine as Record<string, unknown>).command
  if (!isVelarStatuslineCommand(command)) return { settings, removed: false }
  const { statusLine: _drop, ...rest } = settings
  return { settings: rest, removed: true }
}

export type InstallStatusLineResult =
  | { status: 'installed'; settingsPath: string; backupPath?: string }
  | { status: 'already-installed'; settingsPath: string }
  | { status: 'conflict'; settingsPath: string; existingCommand: unknown }

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function readJsonObjectIfValid(filePath: string): { raw: string; parsed: Record<string, unknown> } | null {
  if (!fs.existsSync(filePath)) return null
  const raw = fs.readFileSync(filePath, 'utf8')
  let parsed: unknown
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    throw new Error(`既存の ${filePath} が有効なJSONではありません。破壊を避けるため変更していません。`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`既存の ${filePath} はJSONオブジェクトではありません。変更していません。`)
  }
  return { raw, parsed: parsed as Record<string, unknown> }
}

/**
 * Opts a project into a persistent "🛡 Velar monitoring" segment in Claude
 * Code's status line — a live indicator, not a static label: it re-checks
 * the hook installation on every render (see resolveStatuslineText below),
 * so it goes silent or warns the moment the hook actually stops working.
 *
 * Claude Code's settings.json only has ONE statusLine slot — there is no
 * way to compose multiple tools' segments into it. So unlike the hook
 * (which Velar always installs unconditionally), this is opt-in and
 * conflict-safe: if a statusLine is already configured and it isn't
 * Velar's own, this refuses to overwrite it and reports the conflict
 * instead. Pass `force: true` to overwrite anyway.
 */
export function installStatusLine(
  cwd: string,
  options: { force?: boolean; vendorBaseDir?: string; vendorCliRoot?: string } = {},
): InstallStatusLineResult {
  const claudeDir = path.join(cwd, '.claude')
  const settingsPath = path.join(claudeDir, 'settings.local.json')
  fs.mkdirSync(claudeDir, { recursive: true })

  const vendorResult = vendorCli({ vendorBaseDir: options.vendorBaseDir, cliRoot: options.vendorCliRoot })
  const { command } = buildStatuslineInvocation(vendorResult.entryPath)

  const local = readJsonObjectIfValid(settingsPath)
  const fileExisted = local !== null
  const settings: Record<string, unknown> = local?.parsed ?? {}

  const existing = settings.statusLine
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const existingCommand = (existing as Record<string, unknown>).command
    if (existingCommand === command) {
      return { status: 'already-installed', settingsPath }
    }
    if (!isVelarStatuslineCommand(existingCommand) && !options.force) {
      return { status: 'conflict', settingsPath, existingCommand }
    }
  }

  let backupPath: string | undefined
  if (fileExisted && local) {
    backupPath = path.join(claudeDir, `settings.local.json.velar-backup-${timestampForFilename()}`)
    fs.writeFileSync(backupPath, local.raw, 'utf8')
  }

  const nextSettings = { ...settings, statusLine: { type: 'command', command } }
  fs.writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2) + '\n', 'utf8')

  return { status: 'installed', settingsPath, backupPath }
}

/** The live text `velar statusline` should print for `cwd` right now — empty string when nothing worth showing (e.g. Velar isn't installed in this project at all, so staying silent beats nagging every unrelated workspace). */
export function resolveStatuslineText(cwd: string): string {
  const { target, checks } = resolveHookTarget(cwd)
  if (target) return '🛡 Velar monitoring'

  const registered = checks.find((c) => c.id === 'hook-registered')
  if (!registered || registered.level === 'fail') return ''

  return '⚠ Velar hook unverified — run `velar doctor`'
}
