import fs from 'node:fs'
import path from 'node:path'
import { vendorCli, buildHookCommand } from './vendor'

/**
 * The exact command Claude Code invoked for a PreToolUse hook before 0.2.0.
 * Kept only so `runInit` can recognize and upgrade a pre-0.2.0 install (see
 * VELAR_HOOK_COMMAND_SUFFIX below for the general, version-independent check).
 */
export const VELAR_HOOK_COMMAND = 'velar hook pre-tool-use'

/**
 * Every Velar hook command -- the legacy bare form and every vendored
 * absolute-path form -- ends with this. Used to find (and upgrade) an
 * existing Velar entry regardless of which version installed it.
 */
const VELAR_HOOK_COMMAND_SUFFIX = 'hook pre-tool-use'

function isVelarHookCommand(command: unknown): command is string {
  return typeof command === 'string' && command.trim().endsWith(VELAR_HOOK_COMMAND_SUFFIX)
}

export interface InitResult {
  settingsPath: string
  velarDir: string
  /** true when .claude/settings.json did not exist before this run */
  created: boolean
  /** true when the current Velar hook command was already present verbatim — this run was a no-op */
  alreadyInstalled: boolean
  /** true when a pre-existing (older-version or legacy) Velar hook entry was rewritten in place */
  upgraded: boolean
  /** path to the pre-change backup, only set when an existing file was modified */
  backupPath?: string
  /** the exact hook command written (or already present) in settings.json */
  hookCommand: string
  /** absolute path to the vendored CLI entry point the hook command invokes */
  vendorEntryPath: string
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Installs (or verifies/upgrades) the Velar PreToolUse hook in a project's
 * .claude/settings.json.
 *
 * Guarantees:
 *  - Never removes or rewrites any existing hooks, matchers, or top-level
 *    settings keys — the Velar hook is appended as its own PreToolUse group
 *    (or, if a Velar entry already exists, only that entry is touched).
 *  - Idempotent: running this twice with the same installed CLI version
 *    does not duplicate or rewrite the hook entry.
 *  - Self-healing across versions: if an older/legacy Velar hook entry is
 *    found (bare `velar hook pre-tool-use`, or a vendored path from an
 *    earlier version), it is replaced in place with the current version's
 *    vendored command rather than duplicated.
 *  - Always backs up the pre-existing file (byte-for-byte) before the first
 *    modification, as .claude/settings.json.velar-backup-<timestamp>.
 *  - Refuses to touch a settings.json that isn't valid JSON, rather than
 *    guessing and risking data loss.
 *  - The installed hook command is an absolute path into a vendored copy of
 *    the running CLI (see ./vendor.ts) — it does not depend on `velar`
 *    still being on PATH later, which is what makes this work uniformly
 *    whether Velar was installed via `npx`, a global install, or a
 *    project-local devDependency.
 */
export function runInit(
  cwd: string,
  options: { vendorBaseDir?: string; vendorCliRoot?: string } = {},
): InitResult {
  const claudeDir = path.join(cwd, '.claude')
  const settingsPath = path.join(claudeDir, 'settings.json')
  const velarDir = path.join(cwd, '.velar')

  fs.mkdirSync(claudeDir, { recursive: true })
  fs.mkdirSync(velarDir, { recursive: true })

  const { entryPath: vendorEntryPath } = vendorCli({
    vendorBaseDir: options.vendorBaseDir,
    cliRoot: options.vendorCliRoot,
  })
  const hookCommand = buildHookCommand(vendorEntryPath)

  const fileExisted = fs.existsSync(settingsPath)
  let existingRaw: string | null = null
  let settings: Record<string, unknown> = {}

  if (fileExisted) {
    existingRaw = fs.readFileSync(settingsPath, 'utf8')
    let parsed: unknown
    try {
      parsed = existingRaw.trim() === '' ? {} : JSON.parse(existingRaw)
    } catch {
      throw new Error(
        `既存の ${settingsPath} が有効なJSONではありません。破壊を避けるため変更していません。` +
          `手動で修正してから再度 velar init を実行してください。`,
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`既存の ${settingsPath} はJSONオブジェクトではありません。変更していません。`)
    }
    settings = parsed as Record<string, unknown>
  }

  const existingHooks =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {}
  const hooks: Record<string, unknown> = { ...existingHooks }
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...(hooks.PreToolUse as unknown[])] : []

  const existingGroupIndex = preToolUse.findIndex((group) => {
    if (!group || typeof group !== 'object') return false
    const hookList = (group as Record<string, unknown>).hooks
    if (!Array.isArray(hookList)) return false
    return hookList.some((h) => h && typeof h === 'object' && isVelarHookCommand((h as Record<string, unknown>).command))
  })

  if (existingGroupIndex !== -1) {
    const group = preToolUse[existingGroupIndex] as Record<string, unknown>
    const hookList = group.hooks as Array<Record<string, unknown>>
    const alreadyExact = hookList.some((h) => h.command === hookCommand)

    if (alreadyExact) {
      return {
        settingsPath,
        velarDir,
        created: !fileExisted,
        alreadyInstalled: true,
        upgraded: false,
        hookCommand,
        vendorEntryPath,
      }
    }

    // A Velar entry exists but points at a different (older/legacy) command
    // — upgrade it in place instead of duplicating.
    let backupPath: string | undefined
    if (fileExisted && existingRaw !== null) {
      backupPath = path.join(claudeDir, `settings.json.velar-backup-${timestampForFilename()}`)
      fs.writeFileSync(backupPath, existingRaw, 'utf8')
    }

    const updatedGroup = {
      ...group,
      hooks: hookList.map((h) => (isVelarHookCommand(h.command) ? { ...h, command: hookCommand } : h)),
    }
    preToolUse[existingGroupIndex] = updatedGroup
    hooks.PreToolUse = preToolUse
    settings.hooks = hooks
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')

    return {
      settingsPath,
      velarDir,
      created: !fileExisted,
      alreadyInstalled: false,
      upgraded: true,
      hookCommand,
      vendorEntryPath,
      backupPath,
    }
  }

  let backupPath: string | undefined
  if (fileExisted && existingRaw !== null) {
    backupPath = path.join(claudeDir, `settings.json.velar-backup-${timestampForFilename()}`)
    fs.writeFileSync(backupPath, existingRaw, 'utf8')
  }

  preToolUse.push({
    matcher: '.*',
    hooks: [{ type: 'command', command: hookCommand }],
  })
  hooks.PreToolUse = preToolUse
  settings.hooks = hooks

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')

  return {
    settingsPath,
    velarDir,
    created: !fileExisted,
    alreadyInstalled: false,
    upgraded: false,
    hookCommand,
    vendorEntryPath,
    backupPath,
  }
}
