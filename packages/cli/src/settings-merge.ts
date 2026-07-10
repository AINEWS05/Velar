import fs from 'node:fs'
import path from 'node:path'

/**
 * The exact command Claude Code invokes for a PreToolUse hook. Used both to
 * install the hook and to detect whether it's already installed (idempotency).
 */
export const VELAR_HOOK_COMMAND = 'velar hook pre-tool-use'

export interface InitResult {
  settingsPath: string
  velarDir: string
  /** true when .claude/settings.json did not exist before this run */
  created: boolean
  /** true when the Velar hook was already present — this run was a no-op */
  alreadyInstalled: boolean
  /** path to the pre-change backup, only set when an existing file was modified */
  backupPath?: string
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Installs (or verifies) the Velar PreToolUse hook in a project's
 * .claude/settings.json.
 *
 * Guarantees:
 *  - Never removes or rewrites any existing hooks, matchers, or top-level
 *    settings keys — the Velar hook is appended as its own PreToolUse group.
 *  - Idempotent: running this twice does not duplicate the hook entry.
 *  - Always backs up the pre-existing file (byte-for-byte) before the first
 *    modification, as .claude/settings.json.velar-backup-<timestamp>.
 *  - Refuses to touch a settings.json that isn't valid JSON, rather than
 *    guessing and risking data loss.
 */
export function runInit(cwd: string): InitResult {
  const claudeDir = path.join(cwd, '.claude')
  const settingsPath = path.join(claudeDir, 'settings.json')
  const velarDir = path.join(cwd, '.velar')

  fs.mkdirSync(claudeDir, { recursive: true })
  fs.mkdirSync(velarDir, { recursive: true })

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

  const alreadyInstalled = preToolUse.some((group) => {
    if (!group || typeof group !== 'object') return false
    const hookList = (group as Record<string, unknown>).hooks
    if (!Array.isArray(hookList)) return false
    return hookList.some(
      (h) => h && typeof h === 'object' && (h as Record<string, unknown>).command === VELAR_HOOK_COMMAND,
    )
  })

  if (alreadyInstalled) {
    return { settingsPath, velarDir, created: !fileExisted, alreadyInstalled: true }
  }

  let backupPath: string | undefined
  if (fileExisted && existingRaw !== null) {
    backupPath = path.join(claudeDir, `settings.json.velar-backup-${timestampForFilename()}`)
    fs.writeFileSync(backupPath, existingRaw, 'utf8')
  }

  preToolUse.push({
    matcher: '.*',
    hooks: [{ type: 'command', command: VELAR_HOOK_COMMAND }],
  })
  hooks.PreToolUse = preToolUse
  settings.hooks = hooks

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')

  return {
    settingsPath,
    velarDir,
    created: !fileExisted,
    alreadyInstalled: false,
    backupPath,
  }
}
