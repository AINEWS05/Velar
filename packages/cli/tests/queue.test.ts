import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendToQueue, readQueue, removeFromQueue, QUEUE_MAX } from '../src/queue'
import type { VelarWireEvent } from '@velar/shared'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-queue-test-'))
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
    riskLevel: 'critical',
    decision: 'blocked',
    approverId: null,
    approvalMethod: 'none',
    approvalLatencyMs: null,
    cliVersion: '0.1.0',
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
    expect(queue.map((e) => e.eventId)).toEqual(['e1', 'e2'])
  })

  it('removes a specific event by id', () => {
    appendToQueue(tmpDir, fakeEvent('e1'))
    appendToQueue(tmpDir, fakeEvent('e2'))
    removeFromQueue(tmpDir, 'e1')
    expect(readQueue(tmpDir).map((e) => e.eventId)).toEqual(['e2'])
  })

  it('discards the oldest entries and warns once the queue exceeds QUEUE_MAX', () => {
    const warnings: string[] = []
    for (let i = 0; i < QUEUE_MAX + 5; i++) {
      appendToQueue(tmpDir, fakeEvent(`e${i}`), (msg) => warnings.push(msg))
    }
    const queue = readQueue(tmpDir)
    expect(queue).toHaveLength(QUEUE_MAX)
    // Oldest 5 (e0..e4) should have been dropped, newest retained.
    expect(queue[0].eventId).toBe('e5')
    expect(queue[queue.length - 1].eventId).toBe(`e${QUEUE_MAX + 4}`)
    expect(warnings.some((w) => w.includes('discarded'))).toBe(true)
  })
})
