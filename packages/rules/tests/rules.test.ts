import { describe, it, expect } from 'vitest'
import { evaluate } from '../src/index'
import type { NormalizedOperation } from '@velar/shared'

describe('evaluate — env file rules', () => {
  it('classifies reading .env.production as critical', () => {
    const op: NormalizedOperation = { operationType: 'file_read', path: '/repo/.env.production' }
    const result = evaluate(op)
    expect(result.riskLevel).toBe('critical')
    expect(result.ruleId).toBe('env-file-protection')
  })

  it('classifies writing .env.production as critical', () => {
    const op: NormalizedOperation = { operationType: 'file_write', path: '/repo/.env.production' }
    expect(evaluate(op).riskLevel).toBe('critical')
  })

  it('classifies reading .env.example as allow', () => {
    const op: NormalizedOperation = { operationType: 'file_read', path: '/repo/.env.example' }
    const result = evaluate(op)
    expect(result.riskLevel).toBe('allow')
    expect(result.ruleId).toBe('env-example-allow')
  })

  it('classifies plain .env as critical', () => {
    const op: NormalizedOperation = { operationType: 'file_read', path: '/repo/.env' }
    expect(evaluate(op).riskLevel).toBe('critical')
  })

  it('classifies .env.local as critical (only .example/.sample/.template are allow-listed)', () => {
    const op: NormalizedOperation = { operationType: 'file_read', path: '/repo/.env.local' }
    expect(evaluate(op).riskLevel).toBe('critical')
  })
})

describe('evaluate — rm -rf template rule', () => {
  it('flags rm -rf / as critical', () => {
    const op: NormalizedOperation = { operationType: 'bash', command: 'rm -rf /' }
    const result = evaluate(op)
    expect(result.riskLevel).toBe('critical')
    expect(result.ruleId).toBe('rm-rf-risky-path')
  })

  it('flags rm -rf ~ as critical', () => {
    const op: NormalizedOperation = { operationType: 'bash', command: 'rm -rf ~/Documents' }
    expect(evaluate(op).riskLevel).toBe('critical')
  })

  it('does not flag a scoped rm -rf inside the project as critical', () => {
    const op: NormalizedOperation = { operationType: 'bash', command: 'rm -rf ./node_modules/.cache' }
    expect(evaluate(op).riskLevel).toBe('allow')
  })
})

describe('evaluate — git force-push template rule', () => {
  it('flags git push --force main as critical', () => {
    const op: NormalizedOperation = { operationType: 'bash', command: 'git push --force origin main' }
    const result = evaluate(op)
    expect(result.riskLevel).toBe('critical')
    expect(result.ruleId).toBe('git-force-push-protected-branch')
  })

  it('flags git push -f master as critical', () => {
    const op: NormalizedOperation = { operationType: 'git', command: 'git push -f origin master' }
    expect(evaluate(op).riskLevel).toBe('critical')
  })

  it('does not flag a force-push to a feature branch as critical', () => {
    const op: NormalizedOperation = { operationType: 'bash', command: 'git push --force origin feature/foo' }
    expect(evaluate(op).riskLevel).toBe('allow')
  })

  it('does not flag a normal git push to main as critical', () => {
    const op: NormalizedOperation = { operationType: 'bash', command: 'git push origin main' }
    expect(evaluate(op).riskLevel).toBe('allow')
  })
})

describe('evaluate — warn tier', () => {
  it('flags a sudo command as warn, not critical', () => {
    const op: NormalizedOperation = { operationType: 'bash', command: 'sudo apt-get update' }
    const result = evaluate(op)
    expect(result.riskLevel).toBe('warn')
    expect(result.ruleId).toBe('sudo-command-warn')
  })
})

describe('evaluate — default allow (99% silent pass-through)', () => {
  it('allows 100 ordinary safe operations with no warn/critical hits', () => {
    const safeOps: NormalizedOperation[] = Array.from({ length: 100 }, (_, i) => ({
      operationType: (['file_read', 'file_write', 'bash', 'git'] as const)[i % 4],
      path: i % 2 === 0 ? `/repo/src/file-${i}.ts` : undefined,
      command: i % 2 === 1 ? `git status` : undefined,
    }))

    const results = safeOps.map((op) => evaluate(op))
    expect(results.every((r) => r.riskLevel === 'allow')).toBe(true)
  })
})

describe('evaluate — local judgement latency', () => {
  it('evaluates 1000 operations in well under 50ms total', () => {
    const ops: NormalizedOperation[] = Array.from({ length: 1000 }, (_, i) => ({
      operationType: 'bash',
      command: `echo hello-${i}`,
    }))
    const start = performance.now()
    for (const op of ops) evaluate(op)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(50)
  })
})
