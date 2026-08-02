import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recordLifecycleMilestone, buildLifecycleEvent, sendLifecycleEvent } from '../src/lifecycle'
import { lifecycleEventSchema } from '@velar-dev/shared'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-lifecycle-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const CONFIG = { apiBaseUrl: 'https://api.velar.test', token: 'vlr_test' }

describe('buildLifecycleEvent', () => {
  it('produces a schema-valid event', () => {
    const event = buildLifecycleEvent('init_success', { tenantId: 'org_1', projectName: 'acme' })
    expect(() => lifecycleEventSchema.parse(event)).not.toThrow()
  })

  it('pseudonymizes the project name, never sending it raw', () => {
    const event = buildLifecycleEvent('init_success', { tenantId: 'org_1', projectName: 'acme-corp' })
    expect(JSON.stringify(event)).not.toContain('acme-corp')
  })
})

describe('recordLifecycleMilestone — not logged in', () => {
  it('does nothing at all (no queue file created) when tenantId is undefined', async () => {
    await recordLifecycleMilestone(tmpDir, 'init_success', { tenantId: undefined, projectName: 'acme' })
    expect(fs.existsSync(path.join(tmpDir, 'queue', 'lifecycle-pending.jsonl'))).toBe(false)
  })
})

describe('recordLifecycleMilestone — logged in, non-"first" types fire every time', () => {
  it('queues an event each time init_success is recorded', async () => {
    await recordLifecycleMilestone(tmpDir, 'init_success', { tenantId: 'org_1', projectName: 'acme' })
    await recordLifecycleMilestone(tmpDir, 'init_success', { tenantId: 'org_1', projectName: 'acme' })
    const raw = fs.readFileSync(path.join(tmpDir, 'queue', 'lifecycle-pending.jsonl'), 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(2)
  })

  it('sends immediately when a reporterConfig is provided, then clears the queue', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    await recordLifecycleMilestone(
      tmpDir,
      'doctor_pass',
      { tenantId: 'org_1', projectName: 'acme' },
      { reporterConfig: CONFIG, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.velar.test/api/v1/lifecycle',
      expect.objectContaining({ method: 'POST' }),
    )
    const raw = fs.readFileSync(path.join(tmpDir, 'queue', 'lifecycle-pending.jsonl'), 'utf8')
    expect(raw.trim()).toBe('')
  })
})

describe('recordLifecycleMilestone — "first_*" types fire at most once, permanently', () => {
  it('only queues first_real_critical_block once across repeated calls', async () => {
    await recordLifecycleMilestone(tmpDir, 'first_real_critical_block', { tenantId: 'org_1', projectName: 'acme' })
    await recordLifecycleMilestone(tmpDir, 'first_real_critical_block', { tenantId: 'org_1', projectName: 'acme' })
    await recordLifecycleMilestone(tmpDir, 'first_real_critical_block', { tenantId: 'org_1', projectName: 'acme' })
    const raw = fs.readFileSync(path.join(tmpDir, 'queue', 'lifecycle-pending.jsonl'), 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(1)
  })

  it('tracks first_real_decision and first_real_critical_block as independently-dedup\'d types', async () => {
    await recordLifecycleMilestone(tmpDir, 'first_real_decision', { tenantId: 'org_1', projectName: 'acme' })
    await recordLifecycleMilestone(tmpDir, 'first_real_critical_block', { tenantId: 'org_1', projectName: 'acme' })
    const raw = fs.readFileSync(path.join(tmpDir, 'queue', 'lifecycle-pending.jsonl'), 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(2)
  })

  it('records the "fired" state locally even when NOT logged in, so a later login does not misreport a stale first event as fresh', async () => {
    // Fires (and would be recorded as "already happened") while logged out.
    await recordLifecycleMilestone(tmpDir, 'first_real_critical_block', { tenantId: undefined, projectName: 'acme' })
    expect(fs.existsSync(path.join(tmpDir, 'queue', 'lifecycle-pending.jsonl'))).toBe(false) // nothing sent/queued

    // Now logged in -- the SAME milestone must not fire again as if it were the first time.
    await recordLifecycleMilestone(tmpDir, 'first_real_critical_block', { tenantId: 'org_1', projectName: 'acme' })
    expect(fs.existsSync(path.join(tmpDir, 'queue', 'lifecycle-pending.jsonl'))).toBe(false)
  })

  it('persists dedup state in .velar/lifecycle-state.json', async () => {
    await recordLifecycleMilestone(tmpDir, 'first_real_decision', { tenantId: 'org_1', projectName: 'acme' })
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, 'lifecycle-state.json'), 'utf8'))
    expect(state.firedTypes).toContain('first_real_decision')
  })
})

describe('sendLifecycleEvent', () => {
  it('posts to /api/v1/lifecycle and returns true on 2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    const event = buildLifecycleEvent('test_pass', { tenantId: 'org_1', projectName: 'acme' })
    const ok = await sendLifecycleEvent(CONFIG, event, fetchImpl as unknown as typeof fetch)
    expect(ok).toBe(true)
  })

  it('never throws on a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'))
    const event = buildLifecycleEvent('test_pass', { tenantId: 'org_1', projectName: 'acme' })
    await expect(sendLifecycleEvent(CONFIG, event, fetchImpl as unknown as typeof fetch)).resolves.toBe(false)
  })
})
