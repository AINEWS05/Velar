import fs from 'node:fs'
import path from 'node:path'
import { vendorCli, buildHookInvocation } from './vendor'
import { removeMatchingHooks } from './settings-merge'
import { writeInstallReceipt, type InstallReceipt, CODEX_RECEIPT_FILE_NAME } from './install-receipt'
import { ownCliVersion } from './cli-version'

const VELAR_CODEX_HOOK_SUFFIX = 'hook codex-pre-tool-use'

export function isVelarCodexHookHandler(handler: unknown): boolean {
  if (!handler || typeof handler !== 'object') return false
  const h = handler as Record<string, unknown>
  const command = typeof h.command === 'string' ? h.command : ''
  const commandWindows = typeof h.commandWindows === 'string' ? h.commandWindows : ''
  return command.endsWith(VELAR_CODEX_HOOK_SUFFIX) || commandWindows.endsWith(VELAR_CODEX_HOOK_SUFFIX)
}

/** Removes every Velar PreToolUse handler from a Codex hooks.json object — shared by runCodexInit's exact-match check style and runUninstall. */
export function removeVelarCodexHooks(settings: Record<string, unknown>): { settings: Record<string, unknown>; removed: boolean } {
  return removeMatchingHooks(settings, isVelarCodexHookHandler)
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
        `手動で修正してから再度 velar codex-init を実行してください。`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`既存の ${filePath} はJSONオブジェクトではありません。変更していません。`)
  }
  return { raw, parsed: parsed as Record<string, unknown> }
}

export interface CodexInitResult {
  /** .codex/hooks.json — where the hook is written. Project-local; requires Codex's own hook-trust review (or `--dangerously-bypass-hook-trust`) before it actually runs — velar codex-init cannot grant that trust itself. */
  hooksPath: string
  velarDir: string
  created: boolean
  alreadyInstalled: boolean
  upgraded: boolean
  backupPath?: string
  hookCommand: string
  vendorEntryPath: string
  receiptPath: string
}

/**
 * Installs (or verifies/upgrades) the Velar PreToolUse hook in a project's
 * `.codex/hooks.json`.
 *
 * IMPORTANT — capability scope: unlike the Claude Code adapter, Codex's
 * PreToolUse deny is only actually enforced for file writes (`apply_patch`)
 * today; Bash commands still run even when this hook denies them. See
 * packages/shared/src/capability-manifest.ts and
 * docs/design/codex-hook-verification.md. This installer registers the hook
 * regardless (it's still useful for file-write blocking and for
 * observe-only audit visibility on Bash) but never overstates what it does.
 *
 * Guarantees mirror settings-merge.ts's runInit: never touches unrelated
 * hook events or handlers in hooks.json, idempotent, self-healing across
 * versions, always backs up before modifying an existing file, refuses to
 * touch invalid JSON, writes its own receipt
 * (.velar/codex-install-receipt.json) separate from Claude's.
 */
export function runCodexInit(cwd: string, options: { vendorBaseDir?: string; vendorCliRoot?: string } = {}): CodexInitResult {
  const codexDir = path.join(cwd, '.codex')
  const hooksPath = path.join(codexDir, 'hooks.json')
  const velarDir = path.join(cwd, '.velar')

  fs.mkdirSync(codexDir, { recursive: true })
  fs.mkdirSync(velarDir, { recursive: true })

  const vendorResult = vendorCli({ vendorBaseDir: options.vendorBaseDir, cliRoot: options.vendorCliRoot })
  const { entryPath: vendorEntryPath, entryFingerprint } = vendorResult
  const invocation = buildHookInvocation(vendorEntryPath, 'codex-pre-tool-use')
  const hookCommand = invocation.command

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
      settingsPath: hooksPath,
      backupPath,
    }
    return writeInstallReceipt(velarDir, receipt, CODEX_RECEIPT_FILE_NAME)
  }

  const existing = readJsonObjectIfValid(hooksPath)
  const fileExisted = existing !== null
  const settings: Record<string, unknown> = existing?.parsed ?? {}

  const existingHooks =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? (settings.hooks as Record<string, unknown>) : {}
  const hooks: Record<string, unknown> = { ...existingHooks }
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...(hooks.PreToolUse as unknown[])] : []

  const existingGroupIndex = preToolUse.findIndex((group) => {
    if (!group || typeof group !== 'object') return false
    const handlerList = (group as Record<string, unknown>).hooks
    if (!Array.isArray(handlerList)) return false
    return handlerList.some(isVelarCodexHookHandler)
  })

  const handlerEntry = { type: 'command', command: hookCommand, commandWindows: hookCommand, timeoutSec: 15 }

  if (existingGroupIndex !== -1) {
    const group = preToolUse[existingGroupIndex] as Record<string, unknown>
    const handlerList = group.hooks as Array<Record<string, unknown>>
    const alreadyExact = handlerList.some((h) => h.command === hookCommand && h.commandWindows === hookCommand)

    if (alreadyExact) {
      const receiptPath = writeReceipt()
      return { hooksPath, velarDir, created: !fileExisted, alreadyInstalled: true, upgraded: false, hookCommand, vendorEntryPath, receiptPath }
    }

    let backupPath: string | undefined
    if (fileExisted && existing) {
      backupPath = path.join(codexDir, `hooks.json.velar-backup-${timestampForFilename()}`)
      fs.writeFileSync(backupPath, existing.raw, 'utf8')
    }

    const updatedGroup = {
      ...group,
      hooks: handlerList.map((h) => (isVelarCodexHookHandler(h) ? handlerEntry : h)),
    }
    preToolUse[existingGroupIndex] = updatedGroup
    hooks.PreToolUse = preToolUse
    settings.hooks = hooks
    fs.writeFileSync(hooksPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    const receiptPath = writeReceipt(backupPath)

    return { hooksPath, velarDir, created: !fileExisted, alreadyInstalled: false, upgraded: true, backupPath, hookCommand, vendorEntryPath, receiptPath }
  }

  let backupPath: string | undefined
  if (fileExisted && existing) {
    backupPath = path.join(codexDir, `hooks.json.velar-backup-${timestampForFilename()}`)
    fs.writeFileSync(backupPath, existing.raw, 'utf8')
  }

  preToolUse.push({ matcher: '*', hooks: [handlerEntry] })
  hooks.PreToolUse = preToolUse
  settings.hooks = hooks
  fs.writeFileSync(hooksPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  const receiptPath = writeReceipt(backupPath)

  return { hooksPath, velarDir, created: !fileExisted, alreadyInstalled: false, upgraded: false, backupPath, hookCommand, vendorEntryPath, receiptPath }
}
