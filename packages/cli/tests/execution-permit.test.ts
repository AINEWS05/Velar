import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { issueExecutionPermit, verifyAndConsumeExecutionPermit, type VerifyPermitContext } from '../src/execution-permit'
import { getOrCreatePermitSecret, permitSecretPath } from '../src/permit-secret'

let velarDir: string
let homeDir: string

beforeEach(() => {
  velarDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-permit-test-velar-'))
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-permit-test-home-'))
})

afterEach(() => {
  fs.rmSync(velarDir, { recursive: true, force: true })
  fs.rmSync(homeDir, { recursive: true, force: true })
})

const baseParams = {
  ruleId: 'env-file-protection',
  canonicalizedParameterDigest: 'a1b2'.repeat(16),
  targetClass: 'secrets',
  environment: 'unknown' as const,
  agent: 'claude-code',
  projectPseudonym: 'proj-abc123',
  approvalMethod: 'terminal' as const,
  approverId: null,
}

function contextFor(overrides: Partial<VerifyPermitContext> = {}): VerifyPermitContext {
  return {
    ruleId: baseParams.ruleId,
    canonicalizedParameterDigest: baseParams.canonicalizedParameterDigest,
    targetClass: baseParams.targetClass,
    environment: baseParams.environment,
    agent: baseParams.agent,
    projectPseudonym: baseParams.projectPseudonym,
    ...overrides,
  }
}

describe('permit-secret', () => {
  it('creates a 64-char hex secret file on first use', () => {
    getOrCreatePermitSecret(homeDir)
    const raw = fs.readFileSync(permitSecretPath(homeDir), 'utf8').trim()
    expect(raw).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns the same secret on repeated calls (persisted, not regenerated)', () => {
    const first = getOrCreatePermitSecret(homeDir)
    const second = getOrCreatePermitSecret(homeDir)
    expect(first.equals(second)).toBe(true)
  })

  it('regenerates a usable secret if the stored file is corrupted', () => {
    fs.mkdirSync(path.dirname(permitSecretPath(homeDir)), { recursive: true })
    fs.writeFileSync(permitSecretPath(homeDir), 'not-valid-hex\n')
    const secret = getOrCreatePermitSecret(homeDir)
    expect(secret.length).toBe(32)
  })
})

describe('issueExecutionPermit + verifyAndConsumeExecutionPermit — happy path', () => {
  it('a freshly issued permit verifies successfully against its own operation', () => {
    const permit = issueExecutionPermit({ ...baseParams, homeDir })
    const result = verifyAndConsumeExecutionPermit(permit, contextFor(), velarDir, { homeDir })
    expect(result.ok).toBe(true)
  })

  it('issues a unique nonce every time', () => {
    const a = issueExecutionPermit({ ...baseParams, homeDir })
    const b = issueExecutionPermit({ ...baseParams, homeDir })
    expect(a.nonce).not.toBe(b.nonce)
  })
})

describe('one-time use: reuse is rejected', () => {
  it('a permit that has already been consumed cannot be used again', () => {
    const permit = issueExecutionPermit({ ...baseParams, homeDir })
    const first = verifyAndConsumeExecutionPermit(permit, contextFor(), velarDir, { homeDir })
    expect(first.ok).toBe(true)
    const second = verifyAndConsumeExecutionPermit(permit, contextFor(), velarDir, { homeDir })
    expect(second).toEqual({ ok: false, reason: 'already_consumed' })
  })

  it('replaying the exact same permit 10 times only ever succeeds once', () => {
    const permit = issueExecutionPermit({ ...baseParams, homeDir })
    const results = Array.from({ length: 10 }, () => verifyAndConsumeExecutionPermit(permit, contextFor(), velarDir, { homeDir }))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })
})

describe('tampering: any single-character change invalidates the signature', () => {
  const tamperCases: Array<{ name: string; mutate: (p: ReturnType<typeof issueExecutionPermit>) => ReturnType<typeof issueExecutionPermit> }> = [
    { name: 'ruleId', mutate: (p) => ({ ...p, ruleId: p.ruleId + 'x' }) },
    { name: 'canonicalizedParameterDigest (one hex char flipped)', mutate: (p) => ({ ...p, canonicalizedParameterDigest: '0' + p.canonicalizedParameterDigest.slice(1) }) },
    { name: 'targetClass', mutate: (p) => ({ ...p, targetClass: 'destructive_command' }) },
    { name: 'environment', mutate: (p) => ({ ...p, environment: p.environment === 'production' ? 'unknown' : 'production' }) },
    { name: 'agent', mutate: (p) => ({ ...p, agent: 'codex' }) },
    { name: 'projectPseudonym', mutate: (p) => ({ ...p, projectPseudonym: p.projectPseudonym + 'x' }) },
    { name: 'expiresAt (extending the deadline)', mutate: (p) => ({ ...p, expiresAt: new Date(Date.now() + 999_999_999).toISOString() }) },
    { name: 'nonce', mutate: (p) => ({ ...p, nonce: p.nonce.slice(0, -1) + (p.nonce.endsWith('a') ? 'b' : 'a') }) },
    { name: 'approverId', mutate: (p) => ({ ...p, approverId: 'someone-else' }) },
  ]

  for (const { name, mutate } of tamperCases) {
    it(`a permit with a tampered ${name} fails signature verification`, () => {
      const permit = mutate(issueExecutionPermit({ ...baseParams, homeDir }))
      const result = verifyAndConsumeExecutionPermit(permit, contextFor(), velarDir, { homeDir })
      expect(result).toEqual({ ok: false, reason: 'invalid_signature' })
    })
  }

  it('a tampered permit is NOT marked consumed — a legitimate retry with the real permit still works', () => {
    const permit = issueExecutionPermit({ ...baseParams, homeDir })
    const tampered = { ...permit, ruleId: permit.ruleId + 'x' }
    verifyAndConsumeExecutionPermit(tampered, contextFor(), velarDir, { homeDir })
    const realResult = verifyAndConsumeExecutionPermit(permit, contextFor(), velarDir, { homeDir })
    expect(realResult.ok).toBe(true)
  })

  it('a forged signature (not derived from the real secret) is rejected', () => {
    const permit = issueExecutionPermit({ ...baseParams, homeDir })
    const forged = { ...permit, signature: 'deadbeef'.repeat(8) }
    const result = verifyAndConsumeExecutionPermit(forged, contextFor(), velarDir, { homeDir })
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' })
  })
})

describe('expiry: an expired permit is rejected even with a valid signature', () => {
  it('rejects a permit whose expiresAt is in the past', () => {
    const issuedAt = Date.now() - 10 * 60_000
    const permit = issueExecutionPermit({ ...baseParams, homeDir, now: issuedAt, ttlMs: 60_000 })
    const result = verifyAndConsumeExecutionPermit(permit, contextFor(), velarDir, { homeDir })
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('accepts a permit right up to (but not including) its expiry instant', () => {
    const issuedAt = Date.now()
    const permit = issueExecutionPermit({ ...baseParams, homeDir, now: issuedAt, ttlMs: 60_000 })
    const result = verifyAndConsumeExecutionPermit(permit, contextFor(), velarDir, { homeDir, now: issuedAt + 59_999 })
    expect(result.ok).toBe(true)
  })

  it('rejects exactly at the expiry instant (expiry is exclusive)', () => {
    const issuedAt = Date.now()
    const permit = issueExecutionPermit({ ...baseParams, homeDir, now: issuedAt, ttlMs: 60_000 })
    const result = verifyAndConsumeExecutionPermit(permit, contextFor(), velarDir, { homeDir, now: issuedAt + 60_000 })
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('dev-permit-in-prod: environment mismatch is rejected', () => {
  it('a permit issued while environment=unknown cannot authorize a now-production-classified operation', () => {
    const permit = issueExecutionPermit({ ...baseParams, environment: 'unknown', homeDir })
    const result = verifyAndConsumeExecutionPermit(permit, contextFor({ environment: 'production' }), velarDir, { homeDir })
    expect(result).toEqual({ ok: false, reason: 'environment_mismatch' })
  })

  it('a permit issued for production cannot be used against an unknown-environment operation either', () => {
    const permit = issueExecutionPermit({ ...baseParams, environment: 'production', homeDir })
    const result = verifyAndConsumeExecutionPermit(permit, contextFor({ environment: 'unknown' }), velarDir, { homeDir })
    expect(result).toEqual({ ok: false, reason: 'environment_mismatch' })
  })
})

describe('cross-agent reuse is rejected', () => {
  it('a permit issued for claude-code cannot be consumed by codex', () => {
    const permit = issueExecutionPermit({ ...baseParams, agent: 'claude-code', homeDir })
    const result = verifyAndConsumeExecutionPermit(permit, contextFor({ agent: 'codex' }), velarDir, { homeDir })
    expect(result).toEqual({ ok: false, reason: 'agent_mismatch' })
  })

  it('a permit issued for codex cannot be consumed by claude-code', () => {
    const permit = issueExecutionPermit({ ...baseParams, agent: 'codex', homeDir })
    const result = verifyAndConsumeExecutionPermit(permit, contextFor({ agent: 'claude-code' }), velarDir, { homeDir })
    expect(result).toEqual({ ok: false, reason: 'agent_mismatch' })
  })
})

describe('operation binding: a permit only authorizes the exact operation it was issued for', () => {
  it('rejects when the digest differs (approved for a different target)', () => {
    const permit = issueExecutionPermit({ ...baseParams, homeDir })
    const result = verifyAndConsumeExecutionPermit(permit, contextFor({ canonicalizedParameterDigest: 'ffff'.repeat(16) }), velarDir, { homeDir })
    expect(result).toEqual({ ok: false, reason: 'operation_mismatch' })
  })

  it('rejects when the ruleId differs', () => {
    const permit = issueExecutionPermit({ ...baseParams, homeDir })
    const result = verifyAndConsumeExecutionPermit(permit, contextFor({ ruleId: 'secret-in-command' }), velarDir, { homeDir })
    expect(result).toEqual({ ok: false, reason: 'operation_mismatch' })
  })

  it('rejects when the targetClass differs', () => {
    const permit = issueExecutionPermit({ ...baseParams, homeDir })
    const result = verifyAndConsumeExecutionPermit(permit, contextFor({ targetClass: 'destructive_command' }), velarDir, { homeDir })
    expect(result).toEqual({ ok: false, reason: 'operation_mismatch' })
  })

  it('rejects when the project differs (permit approved in one project cannot authorize another)', () => {
    const permit = issueExecutionPermit({ ...baseParams, homeDir })
    const result = verifyAndConsumeExecutionPermit(permit, contextFor({ projectPseudonym: 'a-different-project' }), velarDir, { homeDir })
    expect(result).toEqual({ ok: false, reason: 'project_mismatch' })
  })
})

describe('cross-machine: a permit signed with a different secret is rejected', () => {
  it('a permit issued under one $HOME does not verify under another', () => {
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-permit-test-other-home-'))
    try {
      const permit = issueExecutionPermit({ ...baseParams, homeDir: otherHome })
      const result = verifyAndConsumeExecutionPermit(permit, contextFor(), velarDir, { homeDir })
      expect(result).toEqual({ ok: false, reason: 'invalid_signature' })
    } finally {
      fs.rmSync(otherHome, { recursive: true, force: true })
    }
  })
})
