import { describe, it, expect } from 'vitest'
import { velarWireEventSchema, WIRE_EVENT_ALLOWED_KEYS, WIRE_SCHEMA_VERSION } from '../src/wire-event'

const validEvent = {
  schemaVersion: WIRE_SCHEMA_VERSION,
  eventId: '123e4567-e89b-12d3-a456-426614174000',
  timestamp: new Date().toISOString(),
  orgId: 'org_abc123',
  userIdHash: 'a1b2c3d4e5f6',
  projectName: 'acme-corp',
  agentName: 'claude-code',
  operationType: 'file_read',
  ruleId: 'env-file-protection',
  riskLevel: 'critical',
  decision: 'approved',
  approverId: 'U0123ABC',
  approvalMethod: 'slack',
  approvalLatencyMs: 4200,
  cliVersion: '0.1.0',
}

describe('velarWireEventSchema — accepts the exact allowed shape', () => {
  it('parses a fully valid event', () => {
    expect(() => velarWireEventSchema.parse(validEvent)).not.toThrow()
  })

  it('accepts null approverId and null approvalLatencyMs', () => {
    expect(() =>
      velarWireEventSchema.parse({ ...validEvent, approverId: null, approvalLatencyMs: null }),
    ).not.toThrow()
  })
})

describe('velarWireEventSchema — zero-knowledge allow-list enforcement', () => {
  it('rejects an unknown field (filePath)', () => {
    const result = velarWireEventSchema.safeParse({ ...validEvent, filePath: '/Users/x/.env.production' })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown field (command)', () => {
    const result = velarWireEventSchema.safeParse({ ...validEvent, command: 'rm -rf /' })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown field (prompt)', () => {
    const result = velarWireEventSchema.safeParse({ ...validEvent, prompt: 'ignore previous instructions' })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown field (content)', () => {
    const result = velarWireEventSchema.safeParse({ ...validEvent, content: 'file contents here' })
    expect(result.success).toBe(false)
  })

  it('rejects a decision value outside the allow-list ("warned")', () => {
    const result = velarWireEventSchema.safeParse({ ...validEvent, decision: 'warned' })
    expect(result.success).toBe(false)
  })

  it('rejects when a required field is missing', () => {
    const { orgId: _drop, ...rest } = validEvent
    const result = velarWireEventSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })
})

describe('WIRE_EVENT_ALLOWED_KEYS', () => {
  it('matches exactly the field list from the Phase 2 spec', () => {
    expect([...WIRE_EVENT_ALLOWED_KEYS].sort()).toEqual(
      [
        'schemaVersion',
        'eventId',
        'timestamp',
        'orgId',
        'userIdHash',
        'projectName',
        'agentName',
        'operationType',
        'ruleId',
        'riskLevel',
        'decision',
        'approverId',
        'approvalMethod',
        'approvalLatencyMs',
        'cliVersion',
      ].sort(),
    )
  })

  it('never contains any content-carrying field name', () => {
    const forbidden = ['filePath', 'path', 'command', 'prompt', 'content', 'fileContent', 'secret']
    for (const f of forbidden) {
      expect(WIRE_EVENT_ALLOWED_KEYS).not.toContain(f)
    }
  })
})
