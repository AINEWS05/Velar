import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isTempAllowed, addTempAllow, pruneExpiredTempAllows } from '../src/temp-allow'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-tempallow-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('temp-allow', () => {
  it('is not allowed when no grant exists', () => {
    expect(isTempAllowed(tmpDir, 'env-file-protection', 'acme-corp')).toBe(false)
  })

  it('is allowed within the grant window for the same rule + project', () => {
    addTempAllow(tmpDir, {
      ruleId: 'env-file-protection',
      projectName: 'acme-corp',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    expect(isTempAllowed(tmpDir, 'env-file-protection', 'acme-corp')).toBe(true)
  })

  it('does not apply to a different rule', () => {
    addTempAllow(tmpDir, {
      ruleId: 'env-file-protection',
      projectName: 'acme-corp',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    expect(isTempAllowed(tmpDir, 'rm-rf-risky-path', 'acme-corp')).toBe(false)
  })

  it('does not apply to a different project', () => {
    addTempAllow(tmpDir, {
      ruleId: 'env-file-protection',
      projectName: 'acme-corp',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    expect(isTempAllowed(tmpDir, 'env-file-protection', 'other-project')).toBe(false)
  })

  it('is not allowed once the grant has expired', () => {
    addTempAllow(tmpDir, {
      ruleId: 'env-file-protection',
      projectName: 'acme-corp',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    expect(isTempAllowed(tmpDir, 'env-file-protection', 'acme-corp')).toBe(false)
  })

  it('pruneExpiredTempAllows removes expired entries from disk', () => {
    addTempAllow(tmpDir, {
      ruleId: 'env-file-protection',
      projectName: 'acme-corp',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    addTempAllow(tmpDir, {
      ruleId: 'rm-rf-risky-path',
      projectName: 'acme-corp',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    pruneExpiredTempAllows(tmpDir)
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'temp-allows.json'), 'utf8'))
    expect(raw).toHaveLength(1)
    expect(raw[0].ruleId).toBe('rm-rf-risky-path')
  })
})
