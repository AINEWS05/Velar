import { describe, it, expect } from 'vitest'
import { actionEnvelopeSchema, ACTION_ENVELOPE_ALLOWED_KEYS, ACTION_ENVELOPE_VERSION } from '../src/action-envelope'

const validEnvelope = {
  envelopeVersion: ACTION_ENVELOPE_VERSION,
  actionId: '123e4567-e89b-12d3-a456-426614174000',
  tenantId: 'org_abc123',
  projectPseudonym: 'a1b2c3d4e5f6a1b2',
  actor: 'a1b2c3d4e5f6',
  agent: 'claude-code',
  agentVersion: null,
  actionType: 'file_read',
  unclassifiedToolName: null,
  targetClass: 'secrets',
  environment: 'unknown',
  canonicalizedParameterDigest: 'deadbeef'.repeat(4),
  riskFactors: ['secrets'],
  riskLevel: 'critical',
  matchedRuleIds: ['env-file-protection'],
  policyVersion: '0.2.0',
  requestedAt: new Date().toISOString(),
  expiry: null,
  nonce: 'nonce-abc-123',
  decision: 'approved',
  decisionSource: 'slack_approval',
  approver: 'U0123ABC',
  isSubagent: false,
  subagentTypeHash: null,
  resultStatus: 'decided',
  durationMs: 12,
  errorClass: null,
  cliVersion: '0.2.0',
}

describe('actionEnvelopeSchema — accepts the exact allowed shape', () => {
  it('parses a fully valid envelope', () => {
    expect(() => actionEnvelopeSchema.parse(validEnvelope)).not.toThrow()
  })

  it('accepts every nullable field as null (allow-tier, local decision)', () => {
    expect(() =>
      actionEnvelopeSchema.parse({
        ...validEnvelope,
        agentVersion: null,
        canonicalizedParameterDigest: null,
        expiry: null,
        approver: null,
        durationMs: null,
        errorClass: null,
        decisionSource: 'local_rule_engine',
        decision: 'allowed',
        riskLevel: 'allow',
        targetClass: 'generic',
        riskFactors: [],
      }),
    ).not.toThrow()
  })
})

describe('actionEnvelopeSchema — zero-knowledge allow-list enforcement', () => {
  it('rejects an unknown field (filePath)', () => {
    const result = actionEnvelopeSchema.safeParse({ ...validEnvelope, filePath: '/Users/x/.env.production' })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown field (command)', () => {
    const result = actionEnvelopeSchema.safeParse({ ...validEnvelope, command: 'rm -rf /' })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown field (rawParameters / parameters)', () => {
    expect(actionEnvelopeSchema.safeParse({ ...validEnvelope, rawParameters: {} }).success).toBe(false)
    expect(actionEnvelopeSchema.safeParse({ ...validEnvelope, parameters: {} }).success).toBe(false)
  })

  it('rejects the old wire-event field names (projectName, orgId, ruleId) — this is a different shape, not a rename shim', () => {
    expect(actionEnvelopeSchema.safeParse({ ...validEnvelope, projectName: 'acme' }).success).toBe(false)
    expect(actionEnvelopeSchema.safeParse({ ...validEnvelope, orgId: 'org_x' }).success).toBe(false)
    expect(actionEnvelopeSchema.safeParse({ ...validEnvelope, ruleId: 'x' }).success).toBe(false)
  })

  it('rejects a targetClass outside the allow-list', () => {
    const result = actionEnvelopeSchema.safeParse({ ...validEnvelope, targetClass: 'anything-goes' })
    expect(result.success).toBe(false)
  })

  it('rejects an environment value outside the allow-list ("development" is never asserted)', () => {
    const result = actionEnvelopeSchema.safeParse({ ...validEnvelope, environment: 'development' })
    expect(result.success).toBe(false)
  })

  it('rejects matchedRuleIds as an empty array (must name at least one rule)', () => {
    const result = actionEnvelopeSchema.safeParse({ ...validEnvelope, matchedRuleIds: [] })
    expect(result.success).toBe(false)
  })

  it('rejects when a required field is missing', () => {
    const { tenantId: _drop, ...rest } = validEnvelope
    const result = actionEnvelopeSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })
})

describe('ACTION_ENVELOPE_ALLOWED_KEYS', () => {
  it('never contains any content-carrying field name', () => {
    const forbidden = ['filePath', 'path', 'command', 'prompt', 'content', 'fileContent', 'secret', 'parameters', 'rawParameters']
    for (const f of forbidden) {
      expect(ACTION_ENVELOPE_ALLOWED_KEYS).not.toContain(f)
    }
  })

  it('does not reuse the old wire-event field names for renamed concepts', () => {
    for (const old of ['projectName', 'orgId', 'ruleId', 'userIdHash', 'operationType', 'approverId', 'approvalMethod', 'eventId', 'timestamp']) {
      expect(ACTION_ENVELOPE_ALLOWED_KEYS).not.toContain(old)
    }
  })
})
