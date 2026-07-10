import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { hookPreToolUseCommand } from '../src/commands/hook-pre-tool-use'
import type { Prompter } from '../src/approval'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-hook-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function stdinFrom(payload: unknown): Readable {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return Readable.from([text])
}

function readEvents(): unknown[] {
  const logPath = path.join(tmpDir, '.velar', 'events.jsonl')
  if (!fs.existsSync(logPath)) return []
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
}

/** A prompter that fails the test immediately if it's ever asked anything. */
const neverAskPrompter: Prompter = {
  async confirm() {
    throw new Error('prompter.confirm() should not have been called for this operation')
  },
}

function yesPrompter(): Prompter {
  return { confirm: async () => 'y' }
}
function noPrompter(): Prompter {
  return { confirm: async () => 'N' }
}
function blankPrompter(): Prompter {
  return { confirm: async () => '' }
}

const envProductionReadPayload = {
  cwd: 'placeholder', // overridden per-test via options.cwd
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: '/Users/dev/secret-project/.env.production' },
}

const envExampleReadPayload = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: '/Users/dev/secret-project/.env.example' },
}

describe('hookPreToolUseCommand — .env.production => critical', () => {
  it('blocks (exit 2) when the user answers N', async () => {
    const code = await hookPreToolUseCommand({
      input: stdinFrom(envProductionReadPayload),
      prompter: noPrompter(),
      cwd: tmpDir,
      config: null,
    })
    expect(code).toBe(2)
    const [event] = readEvents()
    expect(event).toMatchObject({ riskLevel: 'critical', decision: 'blocked', approvalMethod: 'terminal' })
  })

  it('blocks (exit 2) when the user gives no input at all', async () => {
    const code = await hookPreToolUseCommand({
      input: stdinFrom(envProductionReadPayload),
      prompter: blankPrompter(),
      cwd: tmpDir,
      config: null,
    })
    expect(code).toBe(2)
    const [event] = readEvents()
    expect(event).toMatchObject({ decision: 'blocked' })
  })

  it('blocks (exit code non-zero) when no interactive terminal is available', async () => {
    const code = await hookPreToolUseCommand({
      input: stdinFrom(envProductionReadPayload),
      prompter: null,
      cwd: tmpDir,
      config: null,
    })
    expect(code).toBe(2)
    const [event] = readEvents()
    expect(event).toMatchObject({ decision: 'blocked', approvalMethod: 'none' })
  })

  it('approves (exit 0) when the user answers y', async () => {
    const code = await hookPreToolUseCommand({
      input: stdinFrom(envProductionReadPayload),
      prompter: yesPrompter(),
      cwd: tmpDir,
      config: null,
    })
    expect(code).toBe(0)
    const [event] = readEvents()
    expect(event).toMatchObject({ riskLevel: 'critical', decision: 'approved', approvalMethod: 'terminal' })
  })
})

describe('hookPreToolUseCommand — .env.example => allow', () => {
  it('exits 0 silently and never invokes the approval prompter', async () => {
    const code = await hookPreToolUseCommand({
      input: stdinFrom(envExampleReadPayload),
      prompter: neverAskPrompter,
      cwd: tmpDir,
      config: null,
    })
    expect(code).toBe(0)
    const [event] = readEvents()
    expect(event).toMatchObject({ riskLevel: 'allow', decision: 'allowed', approvalMethod: 'none' })
  })
})

describe('hookPreToolUseCommand — warn tier', () => {
  it('exits 0 (does not block) and logs a warned decision', async () => {
    const code = await hookPreToolUseCommand({
      input: stdinFrom({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'sudo apt-get update' },
      }),
      prompter: neverAskPrompter,
      cwd: tmpDir,
      config: null,
    })
    expect(code).toBe(0)
    const [event] = readEvents()
    expect(event).toMatchObject({ riskLevel: 'warn', decision: 'warned' })
  })
})

describe('hookPreToolUseCommand — local log content redaction', () => {
  it('never persists the full path, only the basename', async () => {
    await hookPreToolUseCommand({
      input: stdinFrom(envProductionReadPayload),
      prompter: yesPrompter(),
      cwd: tmpDir,
      config: null,
    })
    const raw = fs.readFileSync(path.join(tmpDir, '.velar', 'events.jsonl'), 'utf8')
    expect(raw).not.toContain('/Users/dev/secret-project')
    expect(raw).not.toContain(tmpDir)
    expect(raw).toContain('.env.production')
  })

  it('never persists command text or secret-looking values', async () => {
    await hookPreToolUseCommand({
      input: stdinFrom({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf ~ --api-key=sk-super-secret-value-123' },
      }),
      prompter: noPrompter(),
      cwd: tmpDir,
      config: null,
    })
    const raw = fs.readFileSync(path.join(tmpDir, '.velar', 'events.jsonl'), 'utf8')
    expect(raw).not.toContain('rm -rf')
    expect(raw).not.toContain('sk-super-secret-value-123')
  })

  it('produces log lines with exactly the allowed field set', async () => {
    await hookPreToolUseCommand({
      input: stdinFrom(envExampleReadPayload),
      cwd: tmpDir,
      config: null,
    })
    const [event] = readEvents() as Record<string, unknown>[]
    expect(Object.keys(event).sort()).toEqual([
      'agentName',
      'approvalMethod',
      'decision',
      'fileBasename',
      'matchedRuleId',
      'operationType',
      'projectName',
      'riskLevel',
      'timestamp',
    ])
  })
})

describe('hookPreToolUseCommand — malformed / unexpected payloads never crash', () => {
  const malformedCases: Array<{ name: string; payload: unknown }> = [
    { name: 'empty stdin', payload: '' },
    { name: 'not valid JSON', payload: '{not json' },
    { name: 'JSON array instead of object', payload: [1, 2, 3] },
    { name: 'null payload', payload: null },
    { name: 'missing tool_name', payload: { tool_input: { file_path: '/x' } } },
    { name: 'tool_name is a number', payload: { tool_name: 42 } },
    { name: 'tool_input is a string, not an object', payload: { tool_name: 'Read', tool_input: 'oops' } },
    { name: 'completely unknown tool_name', payload: { tool_name: 'SomeFutureTool', tool_input: {} } },
  ]

  for (const { name, payload } of malformedCases) {
    it(`does not throw and fails open to allow for: ${name}`, async () => {
      const code = await hookPreToolUseCommand({
        input: stdinFrom(payload),
        prompter: neverAskPrompter,
        cwd: tmpDir,
        config: null,
      })
      expect(code).toBe(0)
    })
  }
})

describe('hookPreToolUseCommand — 100 safe operations produce zero approval prompts', () => {
  it('never calls the prompter across 100 varied safe operations', async () => {
    const payloads = Array.from({ length: 100 }, (_, i) => {
      const kind = i % 4
      if (kind === 0) return { tool_name: 'Read', tool_input: { file_path: `/repo/src/file-${i}.ts` } }
      if (kind === 1) return { tool_name: 'Write', tool_input: { file_path: `/repo/src/out-${i}.ts` } }
      if (kind === 2) return { tool_name: 'Bash', tool_input: { command: `echo hello-${i}` } }
      return { tool_name: 'Bash', tool_input: { command: 'git status' } }
    })

    let exitCodes: number[] = []
    for (const payload of payloads) {
      const code = await hookPreToolUseCommand({
        input: stdinFrom(payload),
        prompter: neverAskPrompter,
        cwd: tmpDir,
        config: null,
      })
      exitCodes.push(code)
    }

    expect(exitCodes.every((c) => c === 0)).toBe(true)
    const events = readEvents() as Record<string, unknown>[]
    expect(events).toHaveLength(100)
    expect(events.every((e) => e.riskLevel === 'allow')).toBe(true)
  })
})
