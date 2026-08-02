import fs from 'node:fs'
import path from 'node:path'
import { removeVelarHooks } from './settings-merge'
import { removeVelarCodexHooks } from './codex-hooks-merge'

export interface UninstallResult {
  /** true if there was nothing to remove (idempotent no-op). */
  nothingToDo: boolean
  removedFromLocalSettings: boolean
  removedFromLegacySettings: boolean
  /** true when settings.local.json ended up empty and was deleted entirely, rather than left as `{}`. */
  deletedLocalSettingsFile: boolean
  /** true when .codex/hooks.json had a Velar entry removed (velar codex-init was used in this project). */
  removedFromCodexHooks: boolean
  removedVelarDir: boolean
  /** true when .claude/ ended up completely empty afterward and was removed too (never removed if anything else is in it). */
  removedEmptyClaudeDir: boolean
  /** true when .codex/ ended up completely empty afterward and was removed too (never removed if anything else is in it). */
  removedEmptyCodexDir: boolean
  backupPaths: string[]
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function stripVelarFromSettingsFile(
  filePath: string,
  backupPaths: string[],
  removeFn: (settings: Record<string, unknown>) => { settings: Record<string, unknown>; removed: boolean } = removeVelarHooks,
): { removed: boolean; deletedFile: boolean } {
  if (!fs.existsSync(filePath)) return { removed: false, deletedFile: false }

  const raw = fs.readFileSync(filePath, 'utf8')
  let parsed: unknown
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    // Not valid JSON — same policy as runInit: never touch a file we can't
    // safely parse, rather than risk destroying whatever's actually there.
    return { removed: false, deletedFile: false }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { removed: false, deletedFile: false }
  }

  const { settings: cleaned, removed } = removeFn(parsed as Record<string, unknown>)
  if (!removed) return { removed: false, deletedFile: false }

  // Clean up hooks.PreToolUse / hooks entirely if they're now empty, so we
  // don't leave `{"hooks":{"PreToolUse":[]}}` litter behind.
  let finalSettings = cleaned
  const hooks = finalSettings.hooks as Record<string, unknown> | undefined
  if (hooks) {
    const preToolUse = hooks.PreToolUse
    const nextHooks = { ...hooks }
    if (Array.isArray(preToolUse) && preToolUse.length === 0) delete nextHooks.PreToolUse
    if (Object.keys(nextHooks).length === 0) {
      const { hooks: _drop, ...rest } = finalSettings
      finalSettings = rest
    } else {
      finalSettings = { ...finalSettings, hooks: nextHooks }
    }
  }

  if (Object.keys(finalSettings).length === 0) {
    // The file had nothing in it besides what Velar itself put there —
    // delete it entirely rather than leave a `{}` husk. No backup needed:
    // there's nothing here beyond Velar's own hook entry, which is fully
    // described by the fact that it existed at all. Behaviorally identical
    // to Claude Code either way (an absent settings.local.json and an
    // empty one are equivalent), and this is what makes a fresh
    // init-then-uninstall round-trip leave truly zero residue.
    fs.rmSync(filePath)
    return { removed: true, deletedFile: true }
  }

  // Other content survives — back up first, as a safety net in case the
  // merge above ever has a bug that eats something it shouldn't have.
  const dir = path.dirname(filePath)
  const backupPath = path.join(dir, `${path.basename(filePath)}.velar-uninstall-backup-${timestampForFilename()}`)
  fs.writeFileSync(backupPath, raw, 'utf8')
  backupPaths.push(backupPath)

  fs.writeFileSync(filePath, JSON.stringify(finalSettings, null, 2) + '\n', 'utf8')
  return { removed: true, deletedFile: false }
}

/**
 * Removes everything `velar init` added to a project: the Velar hook entry
 * from .claude/settings.local.json (and, if present, a stale entry left in
 * the legacy .claude/settings.json location), and the project-local
 * .velar/ directory (event log, install receipt, temp-allow state).
 *
 * Deliberately does NOT touch ~/.velar/vendor/<version>/ — that's a
 * per-user cache shared across every project on this machine, not owned by
 * any single project's uninstall.
 *
 * Backs up every settings file it modifies before touching it, same as
 * runInit. Idempotent: uninstalling a project with no Velar install is a
 * safe no-op.
 */
export function runUninstall(cwd: string): UninstallResult {
  const claudeDir = path.join(cwd, '.claude')
  const localSettingsPath = path.join(claudeDir, 'settings.local.json')
  const legacySettingsPath = path.join(claudeDir, 'settings.json')
  const codexDir = path.join(cwd, '.codex')
  const codexHooksPath = path.join(codexDir, 'hooks.json')
  const velarDir = path.join(cwd, '.velar')

  const backupPaths: string[] = []
  const local = stripVelarFromSettingsFile(localSettingsPath, backupPaths)
  const legacy = stripVelarFromSettingsFile(legacySettingsPath, backupPaths)
  const codex = stripVelarFromSettingsFile(codexHooksPath, backupPaths, removeVelarCodexHooks)

  let removedVelarDir = false
  if (fs.existsSync(velarDir)) {
    fs.rmSync(velarDir, { recursive: true, force: true })
    removedVelarDir = true
  }

  // Only ever removes .claude/ or .codex/ when completely empty afterward —
  // never if it holds anything else (a real settings.json, other tools'
  // config, etc.). Safe in the general case; gives a truly clean
  // fresh-install -> uninstall round-trip when Velar was the only thing
  // that ever touched it.
  let removedEmptyClaudeDir = false
  if (fs.existsSync(claudeDir) && fs.readdirSync(claudeDir).length === 0) {
    fs.rmdirSync(claudeDir)
    removedEmptyClaudeDir = true
  }
  let removedEmptyCodexDir = false
  if (fs.existsSync(codexDir) && fs.readdirSync(codexDir).length === 0) {
    fs.rmdirSync(codexDir)
    removedEmptyCodexDir = true
  }

  const nothingToDo =
    !local.removed && !legacy.removed && !codex.removed && !removedVelarDir && !removedEmptyClaudeDir && !removedEmptyCodexDir

  return {
    nothingToDo,
    removedFromLocalSettings: local.removed,
    removedFromLegacySettings: legacy.removed,
    deletedLocalSettingsFile: local.deletedFile,
    removedFromCodexHooks: codex.removed,
    removedVelarDir,
    removedEmptyClaudeDir,
    removedEmptyCodexDir,
    backupPaths,
  }
}
