import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface VelarConfig {
  /** Velar Ingest Token (vlr_...) — issued by Velar, unrelated to any LLM provider API key. */
  token: string
  /** The org this token belongs to — shown alongside the token when it's issued in the dashboard. */
  orgId: string
  apiBaseUrl?: string
}

export function defaultConfigDir(): string {
  return path.join(os.homedir(), '.velar')
}

function configFilePath(dir: string): string {
  return path.join(dir, 'config.json')
}

/** Writes ~/.velar/config.json with 600 permissions (best-effort on Windows, enforced on POSIX). */
export function saveConfig(config: VelarConfig, dir: string = defaultConfigDir()): string {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = configFilePath(dir)
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Windows ACLs don't map 1:1 to POSIX mode bits — best effort only.
  }
  return filePath
}

export function loadConfig(dir: string = defaultConfigDir()): VelarConfig | null {
  const filePath = configFilePath(dir)
  if (!fs.existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (parsed && typeof parsed.token === 'string' && typeof parsed.orgId === 'string') {
      return parsed as VelarConfig
    }
    return null
  } catch {
    return null
  }
}

const DEFAULT_API_BASE_URL = 'https://usevelar.com'

export function resolveApiBaseUrl(config: VelarConfig | null): string {
  return process.env.VELAR_API_URL ?? config?.apiBaseUrl ?? DEFAULT_API_BASE_URL
}
