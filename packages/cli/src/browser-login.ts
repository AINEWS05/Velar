import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import os from 'node:os'

/** Opaque, unguessable id for a single browser-pairing attempt — never a credential itself, only a lookup key the server treats as pending until an authenticated browser approves it. */
export function generateSessionId(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Best-effort "open the default browser". Never throws and never blocks —
 * the caller always prints the URL too, since headless/SSH/CI environments
 * have no browser to open regardless of exit code.
 */
export function openBrowser(url: string): void {
  try {
    const platform = process.platform
    const child =
      platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true, windowsHide: true })
        : platform === 'darwin'
          ? spawn('open', [url], { stdio: 'ignore', detached: true })
          : spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
    child.on('error', () => {
      // No browser opener available on this system — the printed URL is the fallback.
    })
    child.unref()
  } catch {
    // Same as above: printed URL is the fallback.
  }
}

export interface PairingApproval {
  token: string
  orgId: string
}

export type PollOutcome = PairingApproval | 'denied' | 'expired' | 'timeout'

interface PollResponse {
  success: boolean
  status?: 'pending' | 'approved' | 'denied' | 'expired'
  token?: string
  orgId?: string
}

const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000

/** Best-effort os.hostname() — never throws. A device label is not worth failing login over. */
function safeHostname(): string | null {
  try {
    return os.hostname() || null
  } catch {
    return null
  }
}

/**
 * Polls `GET {apiBaseUrl}/api/cli-auth/{sessionId}` until approved, denied,
 * expired, or timed out. Network hiccups are swallowed and retried — only
 * the overall deadline ends the loop.
 *
 * Sends `?host=<hostname>` on every poll — deliberately NOT part of the URL
 * the browser gets opened to (see the sibling route's own comment), so the
 * machine name never ends up in browser history or gets pasted into a
 * support channel along with the login link. Purely cosmetic: it only ever
 * affects the label shown for this token in the user's own dashboard, never
 * any auth decision. Pass `hostname: null` to omit it entirely.
 */
export async function pollForApproval(
  apiBaseUrl: string,
  sessionId: string,
  options: { intervalMs?: number; timeoutMs?: number; onTick?: () => void; hostname?: string | null } = {},
): Promise<PollOutcome> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const hostname = options.hostname === undefined ? safeHostname() : options.hostname
  const pollUrl = `${apiBaseUrl}/api/cli-auth/${sessionId}${hostname ? `?host=${encodeURIComponent(hostname)}` : ''}`

  while (Date.now() < deadline) {
    options.onTick?.()
    try {
      const res = await fetch(pollUrl)
      if (res.ok) {
        const json = (await res.json()) as PollResponse
        if (json.status === 'approved' && json.token && json.orgId) {
          return { token: json.token, orgId: json.orgId }
        }
        if (json.status === 'denied') return 'denied'
        if (json.status === 'expired') return 'expired'
      }
    } catch {
      // Transient network error — keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return 'timeout'
}
