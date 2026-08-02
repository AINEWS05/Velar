import { describe, it, expect } from 'vitest'
import { classifyCodexPayload } from '../src/adapters/codex-classify'

describe('classifyCodexPayload — Bash', () => {
  it('classifies a plain shell command as bash', () => {
    const { operation, codexToolName } = classifyCodexPayload({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      cwd: '/repo',
    })
    expect(operation).toEqual({ operationType: 'bash', command: 'echo hello' })
    expect(codexToolName).toBe('Bash')
  })

  it('classifies a git-prefixed command as git', () => {
    const { operation } = classifyCodexPayload({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } })
    expect(operation.operationType).toBe('git')
  })

  it('classifies a deploy-shaped command as deploy', () => {
    const { operation } = classifyCodexPayload({ tool_name: 'Bash', tool_input: { command: 'vercel deploy --prod' } })
    expect(operation.operationType).toBe('deploy')
  })
})

describe('classifyCodexPayload — apply_patch (file_write)', () => {
  it('extracts the target path from an Add File patch', () => {
    const { operation, codexToolName } = classifyCodexPayload({
      tool_name: 'apply_patch',
      tool_input: { command: '*** Begin Patch\n*** Add File: .env.production\n+SECRET=1\n*** End Patch' },
    })
    expect(operation).toEqual({ operationType: 'file_write', path: '.env.production' })
    expect(codexToolName).toBe('apply_patch')
  })

  it('extracts the target path from an Update File patch', () => {
    const { operation } = classifyCodexPayload({
      tool_name: 'apply_patch',
      tool_input: { command: '*** Begin Patch\n*** Update File: src/index.ts\n@@\n-old\n+new\n*** End Patch' },
    })
    expect(operation).toEqual({ operationType: 'file_write', path: 'src/index.ts' })
  })

  it('never leaks patch body content into the extracted path', () => {
    const { operation } = classifyCodexPayload({
      tool_name: 'apply_patch',
      tool_input: { command: '*** Begin Patch\n*** Add File: safe.txt\n+api_key=sk-super-secret-123\n*** End Patch' },
    })
    expect(JSON.stringify(operation)).not.toContain('sk-super-secret-123')
  })

  it('degrades to an undefined path when the patch body is malformed', () => {
    const { operation } = classifyCodexPayload({ tool_name: 'apply_patch', tool_input: { command: 'not a real patch' } })
    expect(operation).toEqual({ operationType: 'file_write', path: undefined })
  })
})

describe('classifyCodexPayload — malformed / unexpected payloads never throw', () => {
  const bashShapedCases: Array<{ name: string; payload: unknown }> = [
    { name: 'missing tool_input', payload: { tool_name: 'Bash' } },
    { name: 'tool_input is a string', payload: { tool_name: 'Bash', tool_input: 'oops' } },
  ]

  for (const { name, payload } of bashShapedCases) {
    it(`falls through to a safe no-signal 'bash' operation for: ${name}`, () => {
      expect(() => classifyCodexPayload(payload)).not.toThrow()
      const { operation } = classifyCodexPayload(payload)
      expect(operation.operationType).toBe('bash')
      expect(operation.command).toBeUndefined()
    })
  }

  // Root-cause fix (2026-08-01): anything that isn't apply_patch/Bash-shaped
  // is 'unclassified' (never a no-signal 'bash' op, which would silently
  // reach default-allow) — same fix as classify.ts, applied to the Codex
  // adapter too.
  const unclassifiedCases: Array<{ name: string; payload: unknown }> = [
    { name: 'empty object', payload: {} },
    { name: 'null', payload: null },
    { name: 'array', payload: [1, 2, 3] },
    { name: 'unknown tool_name, no command', payload: { tool_name: 'SomeFutureTool', tool_input: {} } },
    { name: 'tool_name is a number', payload: { tool_name: 42 } },
  ]

  for (const { name, payload } of unclassifiedCases) {
    it(`falls through to 'unclassified' (never silent default-allow) for: ${name}`, () => {
      expect(() => classifyCodexPayload(payload)).not.toThrow()
      const { operation } = classifyCodexPayload(payload)
      expect(operation.operationType).toBe('unclassified')
      expect(operation.command).toBeUndefined()
    })
  }
})
