import { describe, it, expect } from 'vitest'
import { executionPermitSchema, EXECUTION_PERMIT_VERSION, EXECUTION_PERMIT_ALLOWED_KEYS } from '../src/execution-permit'

const validPermit = {
  permitVersion: EXECUTION_PERMIT_VERSION,
  nonce: 'a'.repeat(32),
  ruleId: 'env-file-protection',
  canonicalizedParameterDigest: 'deadbeef'.repeat(8),
  targetClass: 'secrets',
  environment: 'unknown',
  agent: 'claude-code',
  projectPseudonym: 'a1b2c3d4e5f6a1b2',
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  approvalMethod: 'terminal',
  approverId: null,
  signature: 'f'.repeat(64),
}

describe('executionPermitSchema — accepts the exact allowed shape', () => {
  it('parses a fully valid permit', () => {
    expect(() => executionPermitSchema.parse(validPermit)).not.toThrow()
  })

  it('accepts approverId as a real id or null', () => {
    expect(() => executionPermitSchema.parse({ ...validPermit, approverId: 'U0123ABC' })).not.toThrow()
    expect(() => executionPermitSchema.parse({ ...validPermit, approverId: null })).not.toThrow()
  })

  it('accepts both environment values', () => {
    expect(() => executionPermitSchema.parse({ ...validPermit, environment: 'production' })).not.toThrow()
    expect(() => executionPermitSchema.parse({ ...validPermit, environment: 'unknown' })).not.toThrow()
  })

  it('accepts both approval methods', () => {
    expect(() => executionPermitSchema.parse({ ...validPermit, approvalMethod: 'slack' })).not.toThrow()
    expect(() => executionPermitSchema.parse({ ...validPermit, approvalMethod: 'terminal' })).not.toThrow()
  })
})

describe('executionPermitSchema — rejects anything outside the allow-list (zero-knowledge contract)', () => {
  it('rejects an unknown extra field', () => {
    expect(() => executionPermitSchema.parse({ ...validPermit, rawCommand: 'rm -rf /' })).toThrow()
  })

  it('rejects a malformed digest (not 64 hex chars)', () => {
    expect(() => executionPermitSchema.parse({ ...validPermit, canonicalizedParameterDigest: 'too-short' })).toThrow()
  })

  it('rejects a malformed signature (not 64 hex chars)', () => {
    expect(() => executionPermitSchema.parse({ ...validPermit, signature: 'too-short' })).toThrow()
  })

  it('rejects an unknown environment value', () => {
    expect(() => executionPermitSchema.parse({ ...validPermit, environment: 'staging' })).toThrow()
  })

  it('rejects an unknown approvalMethod value', () => {
    expect(() => executionPermitSchema.parse({ ...validPermit, approvalMethod: 'timeout' })).toThrow()
  })

  it('rejects a wrong permitVersion', () => {
    expect(() => executionPermitSchema.parse({ ...validPermit, permitVersion: 2 })).toThrow()
  })

  it('rejects a missing required field', () => {
    const { nonce: _drop, ...withoutNonce } = validPermit
    expect(() => executionPermitSchema.parse(withoutNonce)).toThrow()
  })
})

describe('EXECUTION_PERMIT_ALLOWED_KEYS', () => {
  it('matches exactly the schema keys', () => {
    expect(new Set(EXECUTION_PERMIT_ALLOWED_KEYS)).toEqual(new Set(Object.keys(validPermit)))
  })
})
