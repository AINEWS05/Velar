export type VersionCheckFetchFn = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

export interface NpmVersionInfo {
  version: string
  /**
   * Present only when the latest published version's package.json declares
   * a `velar.securityAdvisory` field — a human-written note that THIS
   * version fixes something security-relevant. Read directly from the npm
   * registry response, so an OLD installed CLI (which has no idea what a
   * future version might fix) can still surface a stronger warning about
   * a newer release without needing to embed that knowledge in advance.
   */
  securityAdvisory: string | null
}

const REGISTRY_TIMEOUT_MS = 3000

/**
 * Fetches `@velar-dev/cli`'s latest published version + security advisory
 * note from the public npm registry (`GET /<pkg>/latest`, no auth needed).
 * Never throws: network failure, timeout, or a malformed response all
 * resolve to `null` — a doctor check building on this must degrade to "could
 * not check for updates" rather than fail outright, since this is reporting
 * on an OPTIONAL, best-effort signal, not the core hook-integrity checks.
 */
export async function fetchLatestPublishedVersion(
  fetchImpl: VersionCheckFetchFn = fetch,
  packageName = '@velar-dev/cli',
): Promise<NpmVersionInfo | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS)
    let res: { ok: boolean; json: () => Promise<unknown> }
    try {
      res = await fetchImpl(`https://registry.npmjs.org/${packageName}/latest`)
    } finally {
      clearTimeout(timeout)
    }
    if (!res.ok) return null
    const json = (await res.json()) as Record<string, unknown>
    if (typeof json.version !== 'string') return null
    const velarField = json.velar as Record<string, unknown> | undefined
    const securityAdvisory = typeof velarField?.securityAdvisory === 'string' ? velarField.securityAdvisory : null
    return { version: json.version, securityAdvisory }
  } catch {
    return null
  }
}

/**
 * Plain `x.y.z` semver-shaped compare — true iff `a` is strictly older than
 * `b`. Deliberately simple (no prerelease/build-metadata handling): this
 * package's own release scheme never uses those, and a false negative here
 * only means a slightly-stale "update available" check, never a false
 * security claim.
 */
export function isOlderVersion(a: string, b: string): boolean {
  const partsA = a.split('.').map((n) => parseInt(n, 10) || 0)
  const partsB = b.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < len; i++) {
    const na = partsA[i] ?? 0
    const nb = partsB[i] ?? 0
    if (na !== nb) return na < nb
  }
  return false
}
