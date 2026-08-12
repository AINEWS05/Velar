import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loginCommand } from '../src/commands/login'
import { loadConfig } from '../src/config'
import type { PollOutcome } from '../src/browser-login'

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

  it('prompts interactively with --manual, without touching the browser', async () => {
    const answers = ['vlr_from_prompt_123456', 'org_from_prompt']
    const code = await loginCommand(['--manual'], {
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

  it('with no flags in a non-interactive shell, fails fast instead of hanging on a browser prompt', async () => {
    const code = await loginCommand([], { configDir: tmpDir, isInteractive: false })
    expect(code).toBe(1)
    expect(loadConfig(tmpDir)).toBeNull()
    expect(errorLogs.some((l) => l.includes('No terminal to open a browser from'))).toBe(true)
  })

  it('with no flags in an interactive shell, opens a browser and saves the token once approved', async () => {
    let openedUrl = ''
    let polledSessionId = ''
    const code = await loginCommand([], {
      configDir: tmpDir,
      isInteractive: true,
      generateSessionId: () => 'fixed-session-id',
      openBrowser: (url) => {
        openedUrl = url
      },
      pollForApproval: async (apiBaseUrl, sessionId) => {
        polledSessionId = sessionId
        expect(apiBaseUrl).toBe('https://usevelar.com')
        return { token: 'vlr_from_browser_123456', orgId: 'org_from_browser' }
      },
    })
    expect(code).toBe(0)
    expect(openedUrl).toBe('https://usevelar.com/cli-login/fixed-session-id')
    expect(polledSessionId).toBe('fixed-session-id')
    expect(loadConfig(tmpDir)).toMatchObject({ token: 'vlr_from_browser_123456', orgId: 'org_from_browser' })
  })

  it('reports a clear error when the browser pairing times out', async () => {
    const outcome: PollOutcome = 'timeout'
    const code = await loginCommand([], {
      configDir: tmpDir,
      isInteractive: true,
      openBrowser: () => {},
      pollForApproval: async () => outcome,
    })
    expect(code).toBe(1)
    expect(loadConfig(tmpDir)).toBeNull()
    expect(errorLogs.some((l) => l.includes('Timed out waiting for approval'))).toBe(true)
  })

  it('reports a clear error when the browser pairing is denied', async () => {
    const outcome: PollOutcome = 'denied'
    const code = await loginCommand([], {
      configDir: tmpDir,
      isInteractive: true,
      openBrowser: () => {},
      pollForApproval: async () => outcome,
    })
    expect(code).toBe(1)
    expect(loadConfig(tmpDir)).toBeNull()
    expect(errorLogs.some((l) => l.includes('was denied'))).toBe(true)
  })

  it('reports a clear error when the browser pairing link expired', async () => {
    const outcome: PollOutcome = 'expired'
    const code = await loginCommand([], {
      configDir: tmpDir,
      isInteractive: true,
      openBrowser: () => {},
      pollForApproval: async () => outcome,
    })
    expect(code).toBe(1)
    expect(loadConfig(tmpDir)).toBeNull()
    expect(errorLogs.some((l) => l.includes('link expired'))).toBe(true)
  })
})
