import { describe, it, expect } from 'vitest'
import { toSafeBasename, buildVelarEvent } from '../src/redact'

describe('toSafeBasename', () => {
  it('strips a full POSIX path down to the basename', () => {
    expect(toSafeBasename('/Users/alice/secret-project/.env.production')).toBe('.env.production')
  })

  it('strips a full Windows path down to the basename', () => {
    expect(toSafeBasename('C:\\Users\\alice\\secret-project\\.env.production')).toBe('.env.production')
  })

  it('returns undefined for undefined input', () => {
    expect(toSafeBasename(undefined)).toBeUndefined()
  })
})

describe('buildVelarEvent', () => {
  it('never includes the full path, only the basename', () => {
    const event = buildVelarEvent({
      projectName: 'acme-corp',
      agentName: 'claude-code',
      operation: { operationType: 'file_read', path: '/Users/alice/secret-project/deep/nested/.env.production' },
      matchedRuleId: 'env-file-protection',
      riskLevel: 'critical',
      decision: 'blocked',
      approvalMethod: 'terminal',
    })
    expect(event.fileBasename).toBe('.env.production')
    expect(JSON.stringify(event)).not.toContain('/Users/alice')
    expect(JSON.stringify(event)).not.toContain('secret-project')
  })

  it('never includes a command field, even when the operation carried one', () => {
    const event = buildVelarEvent({
      projectName: 'acme-corp',
      agentName: 'claude-code',
      operation: { operationType: 'bash', command: 'rm -rf /some/secret/path --with-token=abc123' },
      matchedRuleId: 'rm-rf-risky-path',
      riskLevel: 'critical',
      decision: 'approved',
      approvalMethod: 'terminal',
    })
    expect(JSON.stringify(event)).not.toContain('rm -rf')
    expect(JSON.stringify(event)).not.toContain('abc123')
    expect(Object.keys(event)).not.toContain('command')
  })

  it('produces exactly the allowed field set', () => {
    const event = buildVelarEvent({
      projectName: 'acme-corp',
      agentName: 'claude-code',
      operation: { operationType: 'file_read', path: '.env.example' },
      matchedRuleId: 'env-example-allow',
      riskLevel: 'allow',
      decision: 'allowed',
      approvalMethod: 'none',
    })
    expect(Object.keys(event).sort()).toEqual([
      'agentName',
      'approvalMethod',
      'decision',
      'fileBasename',
      'isSubagent',
      'matchedRuleId',
      'operationType',
      'projectName',
      'riskLevel',
      'timestamp',
      'unclassifiedToolName',
    ])
  })
})
