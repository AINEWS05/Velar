import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface VelarConfig {
  /** Velar Ingest Token (vlr_...) — issued by Velar, unrelated to any LLM provider API key. */
  token: string
  /** The org this token belongs to — shown alongside the token when it's issued in the dashboard. */
  orgId: string
  apiBaseUrl?: string
  /**
   * The risk level applied to ANY operation that fell through to
   * classify.ts's `'unclassified'` catch-all — an MCP tool call matching
   * none of @velar-dev/rules' known mcp-* patterns (ruleId
   * `mcp-unknown-tool-default`), or any other tool with no dedicated
   * classification branch at all (ruleId `unclassified-tool-default`), both
   * of which always evaluate to `'warn'` on their own. Applied as a single
   * post-evaluate() override in hook-pre-tool-use.ts, never inside the pure
   * rule engine — one config knob generalizing what would otherwise need a
   * separate field per rule. Default `'warn'` when unset: never silently
   * allowed, but not every unrecognized tool interrupts the user either. An
   * org that wants stricter enforcement can set this to `'critical'` (every
   * unrecognized tool call then requires approval) — provisioned from the
   * dashboard's org settings and synced into this file at `velar
   * login`/`velar init` time, same as `token`/`orgId`; not fetched on the
   * hook's hot path.
   */
  unclassifiedToolRisk?: 'warn' | 'critical'
  /** @deprecated renamed to `unclassifiedToolRisk` (2026-08-01), which now also covers non-MCP unclassified tools — read as a fallback so an existing config.json written by an older `velar login`/`velar init` keeps working until the next sync overwrites it with the new field name. */
  mcpUnknownToolRisk?: 'warn' | 'critical'
}

/** Resolves the effective unclassified-tool risk override, preferring the current field name and falling back to the deprecated `mcpUnknownToolRisk` for a config.json written before the rename. */
export function resolveUnclassifiedToolRisk(config: VelarConfig | null): 'warn' | 'critical' | undefined {
  return config?.unclassifiedToolRisk ?? config?.mcpUnknownToolRisk
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
