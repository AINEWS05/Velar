import { describe, it, expect, vi } from 'vitest'
import { requestSlackApproval } from '../src/approval-client'

const CONFIG = { apiBaseUrl: 'https://api.velar.test', token: 'vlr_test' }
const REQUEST = {
  ruleId: 'env-file-protection',
  riskLevel: 'critical' as const,
  projectName: 'acme-corp',
  agentName: 'claude-code',
  operationType: 'file_read' as const,
  ruleDescription: 'desc',
}

function noopSleep() {
  return Promise.resolve()
}

describe('requestSlackApproval', () => {
  it('returns unavailable immediately when the create request fails (no polling)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false })
    const outcome = await requestSlackApproval(CONFIG, REQUEST, fetchImpl as unknown as typeof fetch, noopSleep)
    expect(outcome.status).toBe('unavailable')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('returns unavailable immediately when the network is down (no polling)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'))
    const outcome = await requestSlackApproval(CONFIG, REQUEST, fetchImpl as unknown as typeof fetch, noopSleep)
    expect(outcome.status).toBe('unavailable')
  })

  it('returns unavailable immediately when Slack was not posted (org has no Slack configured)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ approvalId: 'a1', status: 'pending', expiresAt: new Date().toISOString(), slackPosted: false }),
    })
    const outcome = await requestSlackApproval(CONFIG, REQUEST, fetchImpl as unknown as typeof fetch, noopSleep)
    expect(outcome.status).toBe('unavailable')
    // Only the create call — must not have polled.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('polls until approved and returns the approver + tempAllow grant', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ approvalId: 'a1', status: 'pending', expiresAt: new Date().toISOString(), slackPosted: true }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ approvalId: 'a1', status: 'pending', approverId: null, tempAllow: null }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          approvalId: 'a1',
          status: 'approved',
          approverId: 'U123',
          tempAllow: { ruleId: 'env-file-protection', projectName: 'acme-corp', expiresAt: new Date().toISOString() },
        }),
      })

    const outcome = await requestSlackApproval(CONFIG, REQUEST, fetchImpl as unknown as typeof fetch, noopSleep)
    expect(outcome).toMatchObject({ status: 'approved', approverId: 'U123' })
    expect(outcome.tempAllow).toMatchObject({ ruleId: 'env-file-protection' })
  })

  it('polls until denied and returns blocked', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ approvalId: 'a1', status: 'pending', expiresAt: new Date().toISOString(), slackPosted: true }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ approvalId: 'a1', status: 'blocked', approverId: 'U456', tempAllow: null }) })

    const outcome = await requestSlackApproval(CONFIG, REQUEST, fetchImpl as unknown as typeof fetch, noopSleep)
    expect(outcome).toMatchObject({ status: 'blocked', approverId: 'U456' })
  })

  it('resolves to timed_out once the poll deadline passes without resolution', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/approvals')) {
        return { ok: true, json: async () => ({ approvalId: 'a1', status: 'pending', expiresAt: new Date().toISOString(), slackPosted: true }) }
      }
      return { ok: true, json: async () => ({ approvalId: 'a1', status: 'pending', approverId: null, tempAllow: null }) }
    })

    // Use a tiny poll timeout so the test doesn't actually wait 120s.
    const outcome = await requestSlackApproval(CONFIG, REQUEST, fetchImpl as unknown as typeof fetch, noopSleep, 10)
    expect(outcome.status).toBe('timed_out')
  })
})
