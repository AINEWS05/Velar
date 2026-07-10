import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loginCommand } from '../src/commands/login'
import { loadConfig } from '../src/config'

let tmpDir: string
let errorLogs: string[]
let originalError: typeof console.error

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-login-test-'))
  errorLogs = []
  originalError = console.error
  console.error = (msg: string) => errorLogs.push(msg)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.error = originalError
})

describe('loginCommand', () => {
  it('saves a valid token + orgId passed via flags, without prompting', async () => {
    const code = await loginCommand(['--token', 'vlr_abcdef123456', '--org-id', 'org_1'], { configDir: tmpDir })
    expect(code).toBe(0)
    expect(loadConfig(tmpDir)).toMatchObject({ token: 'vlr_abcdef123456', orgId: 'org_1' })
  })

  it('prompts interactively when no flags are given', async () => {
    const answers = ['vlr_from_prompt_123456', 'org_from_prompt']
    const code = await loginCommand([], {
      configDir: tmpDir,
      prompt: async () => answers.shift() as string,
    })
    expect(code).toBe(0)
    expect(loadConfig(tmpDir)).toMatchObject({ token: 'vlr_from_prompt_123456', orgId: 'org_from_prompt' })
  })

  it('rejects a token that does not start with vlr_', async () => {
    const code = await loginCommand(['--token', 'sk-not-a-velar-token', '--org-id', 'org_1'], { configDir: tmpDir })
    expect(code).toBe(1)
    expect(loadConfig(tmpDir)).toBeNull()
    expect(errorLogs.some((l) => l.includes('Invalid token'))).toBe(true)
  })

  it('rejects when org id is missing', async () => {
    const code = await loginCommand(['--token', 'vlr_abcdef123456', '--org-id', ''], {
      configDir: tmpDir,
      prompt: async () => '',
    })
    expect(code).toBe(1)
    expect(loadConfig(tmpDir)).toBeNull()
  })
})
