import type { ApprovalCreateRequest, ApprovalCreateResponse, ApprovalStatusResponse, TempAllowGrant } from '@velar/shared'
import type { FetchFn, ReporterConfig } from './reporter'

export type CloudApprovalStatus = 'approved' | 'blocked' | 'timed_out' | 'unavailable'

export interface CloudApprovalOutcome {
  status: CloudApprovalStatus
  approverId: string | null
  tempAllow: TempAllowGrant | null
}

const POLL_INTERVAL_MS = 2000
export const APPROVAL_POLL_TIMEOUT_MS = 120_000

export type SleepFn = (ms: number) => Promise<void>
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Creates a Slack approval request and polls for its resolution.
 *
 * Returns 'unavailable' immediately (no polling) when apps/api can't be
 * reached, OR when the org has no Slack configured (slackPosted: false) —
 * in both cases the caller should fall back to the Phase 1 terminal prompt
 * rather than waiting up to 120s for a card that will never appear.
 *
 * On poll timeout, returns 'timed_out' — the caller must treat this as
 * blocked (fail-closed), matching the server's own lazy timeout resolution.
 */
export async function requestSlackApproval(
  config: ReporterConfig,
  request: ApprovalCreateRequest,
  fetchImpl: FetchFn = fetch,
  sleepImpl: SleepFn = defaultSleep,
  pollTimeoutMs: number = APPROVAL_POLL_TIMEOUT_MS,
): Promise<CloudApprovalOutcome> {
  let created: ApprovalCreateResponse
  try {
    const res = await fetchImpl(`${config.apiBaseUrl}/api/v1/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(request),
    })
    if (!res.ok) return { status: 'unavailable', approverId: null, tempAllow: null }
    created = (await res.json()) as ApprovalCreateResponse
  } catch {
    return { status: 'unavailable', approverId: null, tempAllow: null }
  }

  if (!created.slackPosted) {
    // No Slack configured for this org — polling would just burn 120s for nothing.
    return { status: 'unavailable', approverId: null, tempAllow: null }
  }

  const deadline = Date.now() + pollTimeoutMs
  while (Date.now() < deadline) {
    await sleepImpl(POLL_INTERVAL_MS)
    try {
      const res = await fetchImpl(`${config.apiBaseUrl}/api/v1/approvals/${created.approvalId}`, {
        headers: { Authorization: `Bearer ${config.token}` },
      })
      if (!res.ok) continue
      const json = (await res.json()) as ApprovalStatusResponse
      if (json.status !== 'pending') {
        return {
          status: json.status === 'approved' ? 'approved' : json.status === 'blocked' ? 'blocked' : 'timed_out',
          approverId: json.approverId,
          tempAllow: json.tempAllow,
        }
      }
    } catch {
      // Transient polling failure — keep trying until the deadline.
    }
  }

  return { status: 'timed_out', approverId: null, tempAllow: null }
}
