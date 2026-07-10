import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { hookPreToolUseCommand } from '../src/commands/hook-pre-tool-use'
import { WIRE_EVENT_ALLOWED_KEYS } from '@velar-dev/shared'
import type { Prompter } from '../src/approval'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-zk-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function stdinFrom(payload: unknown): Readable {
  return Readable.from([JSON.stringify(payload)])
}

const CONFIG = { token: 'vlr_test_token_zk', orgId: 'org_zk' }

const FORBIDDEN_SUBSTRINGS = [
  '/Users/dev/secret-project',
  '.env.production', // the basename itself is fine to log locally, but must NEVER appear in the wire payload sent to the cloud in a raw/full-path form beyond what the allow-list permits
  'rm -rf',
  'sk-super-secret-value',
  'ignore previous instructions',
  'DB_PASSWORD',
]

describe('zero-knowledge-contract — CLI wire payload (POST /api/v1/events)', () => {
  it('sends a body whose keys are EXACTLY the shared allow-list — for an allow decision', async () => {
    let sentBody: Record<string, unknown> | null = null
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body)
      return { ok: true }
    })

    const code = await hookPreToolUseCommand({
      input: stdinFrom({ tool_name: 'Read', tool_input: { file_path: '/repo/src/index.ts' } }),
      cwd: tmpDir,
      config: CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(code).toBe(0)
    expect(sentBody).not.toBeNull()
    expect(Object.keys(sentBody as object).sort()).toEqual([...WIRE_EVENT_ALLOWED_KEYS].sort())
  })

  it('never includes a file path, command text, prompt, or secret-looking value — critical + approved via terminal', async () => {
    let sentBody: string | null = null
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      sentBody = init.body
      return { ok: true }
    })
    const yesPrompter: Prompter = { confirm: async () => 'y' }

    await hookPreToolUseCommand({
      input: stdinFrom({
        tool_name: 'Read',
        tool_input: { file_path: '/Users/dev/secret-project/.env.production' },
      }),
      cwd: tmpDir,
      config: CONFIG,
      prompter: yesPrompter,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(sentBody).not.toBeNull()
    const parsed = JSON.parse(sentBody as unknown as string)
    expect(Object.keys(parsed).sort()).toEqual([...WIRE_EVENT_ALLOWED_KEYS].sort())
    expect(parsed).not.toHaveProperty('filePath')
    expect(parsed).not.toHaveProperty('path')
    expect(parsed).not.toHaveProperty('command')
    expect(parsed).not.toHaveProperty('prompt')
    expect(parsed).not.toHaveProperty('content')

    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(sentBody).not.toContain(forbidden)
    }
    // The wire schema has no field for a filename at all — only the ruleId.
    expect(parsed).not.toHaveProperty('fileBasename')
    expect(parsed.ruleId).toBe('env-file-protection')
  })

  it('never includes command text for a bash/rm-rf critical event', async () => {
    let sentBody: string | null = null
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      sentBody = init.body
      return { ok: true }
    })
    const noPrompter: Prompter = { confirm: async () => 'N' }

    await hookPreToolUseCommand({
      input: stdinFrom({
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf ~ --token=sk-super-secret-value-999' },
      }),
      cwd: tmpDir,
      config: CONFIG,
      prompter: noPrompter,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(sentBody).not.toBeNull()
    expect(sentBody).not.toContain('rm -rf')
    expect(sentBody).not.toContain('sk-super-secret-value-999')
    const parsed = JSON.parse(sentBody as unknown as string)
    expect(Object.keys(parsed).sort()).toEqual([...WIRE_EVENT_ALLOWED_KEYS].sort())
  })

  it('reports a local "warned" outcome on the wire as decision "allowed" (riskLevel stays "warn")', async () => {
    let sentBody: string | null = null
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      sentBody = init.body
      return { ok: true }
    })

    await hookPreToolUseCommand({
      input: stdinFrom({ tool_name: 'Bash', tool_input: { command: 'sudo apt-get update' } }),
      cwd: tmpDir,
      config: CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const parsed = JSON.parse(sentBody as unknown as string)
    expect(parsed.riskLevel).toBe('warn')
    expect(parsed.decision).toBe('allowed')
  })
})
