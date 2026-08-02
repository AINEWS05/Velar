import fs from 'node:fs'
import path from 'node:path'

/**
 * A record of exactly what `velar init` did to this project, so `velar
 * doctor`, `velar test`, and `velar uninstall` never have to re-derive or
 * guess it by re-parsing settings.local.json. Written to
 * .velar/install-receipt.json.
 */
export interface InstallReceipt {
  schemaVersion: 1
  cliVersion: string
  installedAt: string
  /** Root of the vendored copy this install points at, e.g. ~/.velar/vendor/0.2.0 */
  vendorRoot: string
  /** Absolute path to the vendored entry point the hook invokes. */
  vendorEntryPath: string
  /** sha256 of vendorEntryPath's contents at install time — re-checked before every execution. */
  vendorEntryFingerprint: string
  /** The node executable path used to build the hook command. */
  hookExecutable: string
  /** Args passed to hookExecutable for direct (shell:false) invocation. */
  hookArgs: string[]
  /** The shell-quoted command string written into settings.local.json. */
  hookCommand: string
  /** Absolute path to the settings file the hook was written into. */
  settingsPath: string
  /** Absolute path to the .claude/settings.json.velar-backup-<ts> file, if one was made. */
  backupPath?: string
}

function receiptPath(velarDir: string, fileName: string = 'install-receipt.json'): string {
  return path.join(velarDir, fileName)
}

export function writeInstallReceipt(velarDir: string, receipt: InstallReceipt, fileName?: string): string {
  const filePath = receiptPath(velarDir, fileName)
  fs.mkdirSync(velarDir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(receipt, null, 2) + '\n', 'utf8')
  return filePath
}

/** Returns null if no receipt exists or it's unreadable/malformed — callers must fall back gracefully. */
export function readInstallReceipt(velarDir: string, fileName?: string): InstallReceipt | null {
  const filePath = receiptPath(velarDir, fileName)
  if (!fs.existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 1 && typeof parsed.vendorEntryPath === 'string') {
      return parsed as InstallReceipt
    }
    return null
  } catch {
    return null
  }
}

export function removeInstallReceipt(velarDir: string, fileName?: string): void {
  const filePath = receiptPath(velarDir, fileName)
  if (fs.existsSync(filePath)) fs.rmSync(filePath)
}

/** Codex's install receipt — same shape, own file (.velar/codex-install-receipt.json) so it never collides with the Claude Code receipt when both adapters are installed in the same project. */
export const CODEX_RECEIPT_FILE_NAME = 'codex-install-receipt.json'
