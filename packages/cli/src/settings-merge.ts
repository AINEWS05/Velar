import fs from 'node:fs'
import path from 'node:path'
import { vendorCli, buildHookInvocation } from './vendor'
import { writeInstallReceipt, type InstallReceipt } from './install-receipt'
import { ownCliVersion } from './cli-version'

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

export function isVelarHookCommand(command: unknown): command is string {
  return typeof command === 'string' && command.trim().endsWith(VELAR_HOOK_COMMAND_SUFFIX)
}

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
    throw new Error(
      `既存の ${filePath} が有効なJSONではありません。破壊を避けるため変更していません。` +
        `手動で修正してから再度 velar init を実行してください。`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`既存の ${filePath} はJSONオブジェクトではありません。変更していません。`)
  }
  return { raw, parsed: parsed as Record<string, unknown> }
}

/**
 * Removes every PreToolUse hook handler matching `isMatch` from a settings
 * object, in place structurally (returns a new object; input is
 * untouched). Groups that only contained matching handlers are dropped
 * entirely; groups with other, unrelated handlers keep those and lose only
 * the matched ones. Shape-generic so it works for both Claude Code's
 * settings.local.json and Codex's hooks.json, which nest handlers under
 * `hooks.PreToolUse[].hooks[]` identically.
 */
export function removeMatchingHooks(
  settings: Record<string, unknown>,
  isMatch: (handler: unknown) => boolean,
): { settings: Record<string, unknown>; removed: boolean } {
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { settings, removed: false }
  const hooksObj = hooks as Record<string, unknown>
  const preToolUse = hooksObj.PreToolUse
  if (!Array.isArray(preToolUse)) return { settings, removed: false }

  let removed = false
  const nextPreToolUse = preToolUse
    .map((group) => {
      if (!group || typeof group !== 'object') return group
      const groupObj = group as Record<string, unknown>
      const hookList = groupObj.hooks
      if (!Array.isArray(hookList)) return group
      const filtered = hookList.filter((h) => {
        const isMatched = isMatch(h)
        if (isMatched) removed = true
        return !isMatched
      })
      if (filtered.length === hookList.length) return group
      return { ...groupObj, hooks: filtered }
    })
    .filter((group) => {
      if (!group || typeof group !== 'object') return true
      const hookList = (group as Record<string, unknown>).hooks
      return !Array.isArray(hookList) || hookList.length > 0
    })

  if (!removed) return { settings, removed: false }

  const nextHooks = { ...hooksObj, PreToolUse: nextPreToolUse }
  return { settings: { ...settings, hooks: nextHooks }, removed: true }
}

/** Claude Code-specific wrapper around removeMatchingHooks — matches by the bare `command` string. Shared by runInit's cross-file migration and runUninstall. */
export function removeVelarHooks(settings: Record<string, unknown>): { settings: Record<string, unknown>; removed: boolean } {
  return removeMatchingHooks(settings, (h) => !!h && typeof h === 'object' && isVelarHookCommand((h as Record<string, unknown>).command))
}

export interface InitResult {
  /** .claude/settings.local.json — where the hook is actually written. Never commit this file's Velar entry as-is to a shared settings.json; the vendored path is machine-specific. */
  settingsPath: string
  velarDir: string
  /** true when settings.local.json did not exist before this run */
  created: boolean
  /** true when the current Velar hook command was already present verbatim — this run was a no-op */
  alreadyInstalled: boolean
  /** true when a pre-existing (older-version, legacy-location, or legacy-command) Velar entry was rewritten/migrated in place */
  upgraded: boolean
  /** true when a stale entry was found and removed from the old .claude/settings.json location as part of migrating to settings.local.json */
  migratedFromSharedSettings: boolean
  /** path to the pre-change backup, only set when an existing settings.local.json was modified */
  backupPath?: string
  /** the exact hook command written (or already present) in settings.local.json */
  hookCommand: string
  /** absolute path to the vendored CLI entry point the hook command invokes */
  vendorEntryPath: string
  /** path to .velar/install-receipt.json */
  receiptPath: string
}

/**
 * Installs (or verifies/upgrades) the Velar PreToolUse hook in a project's
 * .claude/settings.local.json.
 *
 * Why settings.local.json, not settings.json: the hook command embeds an
 * absolute, machine-specific path into this user's vendored CLI copy
 * (~/.velar/vendor/<version>/...). Writing that into settings.json — which
 * teammates pull via git — would ship a hook command pointing at a path
 * that only exists on the machine that ran `velar init`, silently broken
 * for everyone else who clones the repo. settings.local.json is Claude
 * Code's own per-machine, git-ignored-by-convention override file, which is
 * exactly the right place for a value this project-independent.
 *
 * Guarantees:
 *  - Never removes or rewrites any existing hooks, matchers, or top-level
 *    settings keys — the Velar hook is appended as its own PreToolUse group
 *    (or, if a Velar entry already exists, only that entry is touched).
 *  - Idempotent: running this twice with the same installed CLI version
 *    does not duplicate or rewrite the hook entry.
 *  - Self-healing across versions: if an older/legacy Velar hook entry is
 *    found (bare `velar hook pre-tool-use`, or a vendored path from an
 *    earlier version, in settings.local.json OR the legacy settings.json
 *    location from before this migration), it is replaced/removed and
 *    re-written in the current location rather than duplicated.
 *  - Always backs up the pre-existing file (byte-for-byte) before the first
 *    modification, as .claude/settings.local.json.velar-backup-<timestamp>.
 *  - Refuses to touch a settings file that isn't valid JSON, rather than
 *    guessing and risking data loss.
 *  - Writes .velar/install-receipt.json recording exactly what was done, so
 *    `velar doctor`/`velar test`/`velar uninstall` never have to re-derive
 *    it by re-parsing settings files.
 */
export function runInit(
  cwd: string,
  options: { vendorBaseDir?: string; vendorCliRoot?: string } = {},
): InitResult {
  const claudeDir = path.join(cwd, '.claude')
  const settingsPath = path.join(claudeDir, 'settings.local.json')
  const legacySettingsPath = path.join(claudeDir, 'settings.json')
  const velarDir = path.join(cwd, '.velar')

  fs.mkdirSync(claudeDir, { recursive: true })
  fs.mkdirSync(velarDir, { recursive: true })

  const vendorResult = vendorCli({ vendorBaseDir: options.vendorBaseDir, cliRoot: options.vendorCliRoot })
  const { entryPath: vendorEntryPath, entryFingerprint } = vendorResult
  const invocation = buildHookInvocation(vendorEntryPath)
  const hookCommand = invocation.command

  // Migrate away a stale Velar entry from the pre-4a shared-settings.json
  // location, if one exists — never leave a duplicate hook installed in
  // both files.
  let migratedFromSharedSettings = false
  const legacyFile = readJsonObjectIfValid(legacySettingsPath)
  if (legacyFile) {
    const { settings: cleanedLegacy, removed } = removeVelarHooks(legacyFile.parsed)
    if (removed) {
      const legacyBackupPath = path.join(claudeDir, `settings.json.velar-backup-${timestampForFilename()}`)
      fs.writeFileSync(legacyBackupPath, legacyFile.raw, 'utf8')
      fs.writeFileSync(legacySettingsPath, JSON.stringify(cleanedLegacy, null, 2) + '\n', 'utf8')
      migratedFromSharedSettings = true
    }
  }

  const local = readJsonObjectIfValid(settingsPath)
  const fileExisted = local !== null
  let settings: Record<string, unknown> = local?.parsed ?? {}

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

  function writeReceipt(backupPath?: string): string {
    const receipt: InstallReceipt = {
      schemaVersion: 1,
      cliVersion: ownCliVersion(),
      installedAt: new Date().toISOString(),
      vendorRoot: vendorResult.vendorRoot,
      vendorEntryPath,
      vendorEntryFingerprint: entryFingerprint,
      hookExecutable: invocation.executable,
      hookArgs: invocation.args,
      hookCommand,
      settingsPath,
      backupPath,
    }
    return writeInstallReceipt(velarDir, receipt)
  }

  if (existingGroupIndex !== -1 && !migratedFromSharedSettings) {
    const group = preToolUse[existingGroupIndex] as Record<string, unknown>
    const hookList = group.hooks as Array<Record<string, unknown>>
    const alreadyExact = hookList.some((h) => h.command === hookCommand)

    if (alreadyExact) {
      const receiptPath = writeReceipt()
      return {
        settingsPath,
        velarDir,
        created: !fileExisted,
        alreadyInstalled: true,
        upgraded: false,
        migratedFromSharedSettings,
        hookCommand,
        vendorEntryPath,
        receiptPath,
      }
    }

    // A Velar entry exists but points at a different (older/legacy) command
    // — upgrade it in place instead of duplicating.
    let backupPath: string | undefined
    if (fileExisted && local) {
      backupPath = path.join(claudeDir, `settings.local.json.velar-backup-${timestampForFilename()}`)
      fs.writeFileSync(backupPath, local.raw, 'utf8')
    }

    const updatedGroup = {
      ...group,
      hooks: hookList.map((h) => (isVelarHookCommand(h.command) ? { ...h, command: hookCommand } : h)),
    }
    preToolUse[existingGroupIndex] = updatedGroup
    hooks.PreToolUse = preToolUse
    settings.hooks = hooks
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    const receiptPath = writeReceipt(backupPath)

    return {
      settingsPath,
      velarDir,
      created: !fileExisted,
      alreadyInstalled: false,
      upgraded: true,
      migratedFromSharedSettings,
      hookCommand,
      vendorEntryPath,
      backupPath,
      receiptPath,
    }
  }

  let backupPath: string | undefined
  if (fileExisted && local) {
    backupPath = path.join(claudeDir, `settings.local.json.velar-backup-${timestampForFilename()}`)
    fs.writeFileSync(backupPath, local.raw, 'utf8')
  }

  preToolUse.push({
    matcher: '.*',
    hooks: [{ type: 'command', command: hookCommand }],
  })
  hooks.PreToolUse = preToolUse
  settings.hooks = hooks

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  const receiptPath = writeReceipt(backupPath)

  return {
    settingsPath,
    velarDir,
    created: !fileExisted,
    alreadyInstalled: false,
    upgraded: migratedFromSharedSettings,
    migratedFromSharedSettings,
    hookCommand,
    vendorEntryPath,
    backupPath,
    receiptPath,
  }
}
