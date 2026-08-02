import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendToQueue, readQueue, removeFromQueue, QUEUE_MAX } from '../src/queue'
import type { ActionEnvelope } from '@velar-dev/shared'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-queue-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function fakeEvent(actionId: string): ActionEnvelope {
  return {
    envelopeVersion: 1,
    actionId,
    tenantId: 'org_1',
    projectPseudonym: 'pseudo',
    actor: 'hash',
    agent: 'claude-code',
    agentVersion: null,
    actionType: 'file_read',
    targetClass: 'generic',
    environment: 'unknown',
    canonicalizedParameterDigest: null,
    riskFactors: [],
    riskLevel: 'critical',
    matchedRuleIds: ['r'],
    policyVersion: '0.2.0',
    requestedAt: new Date().toISOString(),
    expiry: null,
    nonce: 'n',
    decision: 'blocked',
    decisionSource: 'terminal_prompt',
    approver: null,
    resultStatus: 'decided',
    durationMs: 5,
    errorClass: null,
    cliVersion: '0.2.0',
  }
}

describe('queue', () => {
  it('starts empty', () => {
    expect(readQueue(tmpDir)).toEqual([])
  })

  it('appends and reads events back in order', () => {
    appendToQueue(tmpDir, fakeEvent('e1'))
    appendToQueue(tmpDir, fakeEvent('e2'))
    const queue = readQueue(tmpDir)
    expect(queue.map((e) => e.actionId)).toEqual(['e1', 'e2'])
  })

  it('removes a specific event by id', () => {
    appendToQueue(tmpDir, fakeEvent('e1'))
    appendToQueue(tmpDir, fakeEvent('e2'))
    removeFromQueue(tmpDir, 'e1')
    expect(readQueue(tmpDir).map((e) => e.actionId)).toEqual(['e2'])
  })

  it('discards the oldest entries and warns once the queue exceeds QUEUE_MAX', () => {
    const warnings: string[] = []
    for (let i = 0; i < QUEUE_MAX + 5; i++) {
      appendToQueue(tmpDir, fakeEvent(`e${i}`), (msg) => warnings.push(msg))
    }
    const queue = readQueue(tmpDir)
    expect(queue).toHaveLength(QUEUE_MAX)
    // Oldest 5 (e0..e4) should have been dropped, newest retained.
    expect(queue[0].actionId).toBe('e5')
    expect(queue[queue.length - 1].actionId).toBe(`e${QUEUE_MAX + 4}`)
    expect(warnings.some((w) => w.includes('discarded'))).toBe(true)
  })

  it('skips (does not crash on) a leftover pre-4a-2 queue line missing actionId', () => {
    const qDir = path.join(tmpDir, 'queue')
    fs.mkdirSync(qDir, { recursive: true })
    fs.writeFileSync(path.join(qDir, 'pending.jsonl'), JSON.stringify({ eventId: 'old-shape', schemaVersion: 1 }) + '\n')
    expect(readQueue(tmpDir)).toEqual([])
  })
})
