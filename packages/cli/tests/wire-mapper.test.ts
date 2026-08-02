import { describe, it, expect } from 'vitest'
import {
  computeProjectPseudonym,
  computeCanonicalizedParameterDigest,
  classifyTargetClass,
  classifyEnvironment,
  deriveRiskFactors,
  buildActionEnvelope,
} from '../src/wire-mapper'
import { actionEnvelopeSchema } from '@velar-dev/shared'

describe('computeProjectPseudonym', () => {
  it('is stable for the same tenantId + projectName', () => {
    expect(computeProjectPseudonym('org_1', 'acme-corp')).toBe(computeProjectPseudonym('org_1', 'acme-corp'))
  })

  it('differs for a different projectName', () => {
    expect(computeProjectPseudonym('org_1', 'acme-corp')).not.toBe(computeProjectPseudonym('org_1', 'other-corp'))
  })

  it('differs for the same projectName under a different tenantId (no cross-org linkability)', () => {
    expect(computeProjectPseudonym('org_1', 'acme-corp')).not.toBe(computeProjectPseudonym('org_2', 'acme-corp'))
  })

  it('never contains the raw project name as a substring', () => {
    expect(computeProjectPseudonym('org_1', 'acme-corp')).not.toContain('acme-corp')
  })
})

describe('computeCanonicalizedParameterDigest', () => {
  it('returns null when the operation has neither path nor command', () => {
    expect(computeCanonicalizedParameterDigest({ operationType: 'bash' })).toBeNull()
  })

  it('hashes a path, never returning the raw value', () => {
    const digest = computeCanonicalizedParameterDigest({ operationType: 'file_read', path: '/Users/dev/secret/.env.production' })
    expect(digest).not.toBeNull()
    expect(digest).not.toContain('.env.production')
    expect(digest).not.toContain('/Users/dev')
    expect(digest).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is stable for the same input and case/whitespace-insensitive', () => {
    const a = computeCanonicalizedParameterDigest({ operationType: 'bash', command: 'rm -rf /tmp' })
    const b = computeCanonicalizedParameterDigest({ operationType: 'bash', command: '  RM -RF /tmp  ' })
    expect(a).toBe(b)
  })

  it('differs for a different command', () => {
    const a = computeCanonicalizedParameterDigest({ operationType: 'bash', command: 'git status' })
    const b = computeCanonicalizedParameterDigest({ operationType: 'bash', command: 'git push' })
    expect(a).not.toBe(b)
  })
})

describe('classifyTargetClass', () => {
  it('maps a secrets-category rule to "secrets"', () => {
    expect(classifyTargetClass('env-file-protection')).toBe('secrets')
  })

  it('maps a production-db-category rule to "production_database"', () => {
    expect(classifyTargetClass('prod-db-drop')).toBe('production_database')
  })

  it('maps a destructive-command rule to "destructive_command"', () => {
    expect(classifyTargetClass('rm-rf-risky-path')).toBe('destructive_command')
  })

  it('falls back to "generic" for an unrecognized rule id', () => {
    expect(classifyTargetClass('no-such-rule')).toBe('generic')
  })
})

describe('classifyEnvironment', () => {
  it('is conservative: only "production" when the rule id itself signals it', () => {
    expect(classifyEnvironment('prod-db-drop')).toBe('production')
    expect(classifyEnvironment('kubernetes-apply-prod')).toBe('production')
  })

  it('is never asserted as anything but unknown/production (no "development" guess)', () => {
    expect(classifyEnvironment('env-file-protection')).toBe('unknown')
    expect(classifyEnvironment('default-allow')).toBe('unknown')
  })
})

describe('deriveRiskFactors', () => {
  it('returns the rule category as a single-element list', () => {
    expect(deriveRiskFactors('env-file-protection')).toEqual(['secrets'])
  })

  it('returns an empty list for an unrecognized rule id', () => {
    expect(deriveRiskFactors('no-such-rule')).toEqual([])
  })
})

describe('buildActionEnvelope', () => {
  const baseParams = {
    tenantId: 'org_1',
    projectName: 'acme-corp',
    agentName: 'claude-code',
    operation: { operationType: 'file_read' as const, path: '/Users/dev/acme/.env.production' },
    matchedRuleId: 'env-file-protection',
    riskLevel: 'critical' as const,
    decision: 'blocked' as const,
    approvalMethod: 'terminal' as const,
    requestedAt: Date.now(),
    durationMs: 12,
    resultStatus: 'decided' as const,
  }

  it('produces a schema-valid envelope', () => {
    const envelope = buildActionEnvelope(baseParams)
    expect(() => actionEnvelopeSchema.parse(envelope)).not.toThrow()
  })

  it('never includes the raw project name or path anywhere in the built object', () => {
    const envelope = buildActionEnvelope(baseParams)
    const serialized = JSON.stringify(envelope)
    expect(serialized).not.toContain('acme-corp')
    expect(serialized).not.toContain('.env.production')
    expect(serialized).not.toContain('/Users/dev')
  })

  it('maps riskLevel critical + approvalMethod slack to decisionSource slack_approval', () => {
    const envelope = buildActionEnvelope({ ...baseParams, approvalMethod: 'slack', decision: 'approved' })
    expect(envelope.decisionSource).toBe('slack_approval')
  })

  it('maps a non-critical decision to decisionSource local_rule_engine regardless of approvalMethod', () => {
    const envelope = buildActionEnvelope({ ...baseParams, riskLevel: 'allow', decision: 'allowed', approvalMethod: 'none' })
    expect(envelope.decisionSource).toBe('local_rule_engine')
  })

  it('sets expiry only when expiryMs is provided', () => {
    const withExpiry = buildActionEnvelope({ ...baseParams, expiryMs: Date.now() + 120_000 })
    expect(withExpiry.expiry).not.toBeNull()
    const withoutExpiry = buildActionEnvelope(baseParams)
    expect(withoutExpiry.expiry).toBeNull()
  })

  it('always sets agentVersion to null (not guessed)', () => {
    expect(buildActionEnvelope(baseParams).agentVersion).toBeNull()
  })

  it('reports exactly one matchedRuleId today (first-match-wins engine)', () => {
    expect(buildActionEnvelope(baseParams).matchedRuleIds).toEqual(['env-file-protection'])
  })
})
