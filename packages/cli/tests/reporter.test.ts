import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reportEvent, sendEvent, flushQueue } from '../src/reporter'
import { readQueue } from '../src/queue'
import type { VelarWireEvent } from '@velar/shared'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-reporter-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function fakeEvent(eventId: string): VelarWireEvent {
  return {
    schemaVersion: 1,
    eventId,
    timestamp: new Date().toISOString(),
    orgId: 'org_1',
    userIdHash: 'hash',
    projectName: 'p',
    agentName: 'claude-code',
    operationType: 'file_read',
    ruleId: 'r',
    riskLevel: 'allow',
    decision: 'allowed',
    approverId: null,
    approvalMethod: 'none',
    approvalLatencyMs: null,
    cliVersion: '0.1.0',
  }
}

const CONFIG = { apiBaseUrl: 'https://api.velar.test', token: 'vlr_test' }

describe('sendEvent', () => {
  it('returns true on a 2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    const ok = await sendEvent(CONFIG, fakeEvent('e1'), fetchImpl as unknown as typeof fetch)
    expect(ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.velar.test/api/v1/events',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('returns false (never throws) on a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const ok = await sendEvent(CONFIG, fakeEvent('e1'), fetchImpl as unknown as typeof fetch)
    expect(ok).toBe(false)
  })

  it('returns false on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const ok = await sendEvent(CONFIG, fakeEvent('e1'), fetchImpl as unknown as typeof fetch)
    expect(ok).toBe(false)
  })
})

describe('reportEvent — queue-first, never throws', () => {
  it('queues the event even when there is no config (not logged in)', async () => {
    await reportEvent(tmpDir, null, fakeEvent('e1'))
    expect(readQueue(tmpDir).map((e) => e.eventId)).toEqual(['e1'])
  })

  it('queues then immediately removes the event on a successful send', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    await reportEvent(tmpDir, CONFIG, fakeEvent('e1'), fetchImpl as unknown as typeof fetch)
    expect(readQueue(tmpDir)).toEqual([])
  })

  it('leaves the event queued when the send fails — decision is unaffected either way', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(reportEvent(tmpDir, CONFIG, fakeEvent('e1'), fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined()
    expect(readQueue(tmpDir).map((e) => e.eventId)).toEqual(['e1'])
  })
})

describe('flushQueue', () => {
  it('sends queued events oldest-first and removes each on success', async () => {
    await reportEvent(tmpDir, null, fakeEvent('e1'))
    await reportEvent(tmpDir, null, fakeEvent('e2'))
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })

    const result = await flushQueue(tmpDir, CONFIG, fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({ sent: 2, remaining: 0 })
    expect(readQueue(tmpDir)).toEqual([])
  })

  it('stops at the first failure, leaving the rest queued in order', async () => {
    await reportEvent(tmpDir, null, fakeEvent('e1'))
    await reportEvent(tmpDir, null, fakeEvent('e2'))
    await reportEvent(tmpDir, null, fakeEvent('e3'))

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true }) // e1 succeeds
      .mockResolvedValueOnce({ ok: false }) // e2 fails -> stop

    const result = await flushQueue(tmpDir, CONFIG, fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({ sent: 1, remaining: 2 })
    expect(readQueue(tmpDir).map((e) => e.eventId)).toEqual(['e2', 'e3'])
  })
})
