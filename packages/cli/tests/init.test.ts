import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initCommand } from '../src/commands/init'
import { loadConfig, saveConfig } from '../src/config'

// initCommand's own self-test step (`velar test`, via testCommand) has no
// dependency-injection hook of its own — it always spawns the vendored
// entry point as a real subprocess to prove the rule engine actually
// decides correctly (that's the whole point of Task #24/#25). So unlike
// most other CLI unit tests, these need a REAL, already-built CLI to
// vendor — the actual repo's own packages/cli (built via `pnpm build`
// before this suite runs), not a throwaway fixture. Only the vendor
// OUTPUT location (vendorBaseDir) is isolated per test; the source
// (vendorCliRoot) is the real thing, same as clean-room-roundtrip.test.ts's
// subprocess but exercised in-process here.
const realCliRoot = path.resolve(__dirname, '..')

let tmpDir: string
let vendorBaseDir: string
let configDir: string
let logs: string[]
let errorLogs: string[]
let originalLog: typeof console.log
let originalError: typeof console.error

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-init-test-'))
  vendorBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-init-test-vendor-'))
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-init-test-config-'))

  logs = []
  errorLogs = []
  originalLog = console.log
  originalError = console.error
  console.log = (msg: string) => logs.push(String(msg))
  console.error = (msg: string) => errorLogs.push(String(msg))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(vendorBaseDir, { recursive: true, force: true })
  fs.rmSync(configDir, { recursive: true, force: true })
  console.log = originalLog
  console.error = originalError
})

describe('initCommand — login integration', () => {
  it('with no account connected and no terminal to open a browser from, skips login gracefully and still protects the project', async () => {
    const code = await initCommand(tmpDir, [], {
      configDir,
      vendorBaseDir,
      vendorCliRoot: realCliRoot,
      loginOptions: { isInteractive: false },
    })
    expect(code).toBe(0)
    expect(loadConfig(configDir)).toBeNull()
    expect(logs.some((l) => l.includes('Connecting to your Velar account'))).toBe(true)
    expect(logs.some((l) => l.includes('Skipping for now'))).toBe(true)
    expect(logs.some((l) => l.includes('protection checks passed'))).toBe(true)
  }, 30_000)

  it('when an account is already connected (config.json pre-exists), skips the login step entirely', async () => {
    saveConfig({ token: 'vlr_existing123456', orgId: 'org_existing' }, configDir)

    const code = await initCommand(tmpDir, [], {
      configDir,
      vendorBaseDir,
      vendorCliRoot: realCliRoot,
      fetchImpl: async () => ({ ok: true }) as Response,
    })
    expect(code).toBe(0)
    expect(logs.some((l) => l.includes('Already connected to Velar (org org_existing)'))).toBe(true)
    expect(logs.some((l) => l.includes('Connecting to your Velar account'))).toBe(false)
  }, 30_000)

  it('when browser pairing succeeds during init, saves the returned token/org and only ever reaches the network through the injected fetchImpl', async () => {
    let fetchCalls = 0
    const code = await initCommand(tmpDir, [], {
      configDir,
      vendorBaseDir,
      vendorCliRoot: realCliRoot,
      fetchImpl: async () => {
        fetchCalls++
        return { ok: true } as Response
      },
      loginOptions: {
        isInteractive: true,
        openBrowser: () => {},
        generateSessionId: () => 'fixed-session-id',
        pollForApproval: async () => ({ token: 'vlr_from_browser_123456', orgId: 'org_from_browser' }),
      },
    })
    expect(code).toBe(0)
    expect(loadConfig(configDir)).toMatchObject({ token: 'vlr_from_browser_123456', orgId: 'org_from_browser' })
    expect(logs.some((l) => l.includes('Opening your browser'))).toBe(true)
    expect(fetchCalls).toBeGreaterThan(0)
  }, 30_000)

  it('when browser pairing times out during init, still protects the project locally (exit 0) without an account', async () => {
    const code = await initCommand(tmpDir, [], {
      configDir,
      vendorBaseDir,
      vendorCliRoot: realCliRoot,
      loginOptions: {
        isInteractive: true,
        openBrowser: () => {},
        pollForApproval: async () => 'timeout',
      },
    })
    expect(code).toBe(0)
    expect(loadConfig(configDir)).toBeNull()
    expect(logs.some((l) => l.includes('Skipping for now'))).toBe(true)
  }, 30_000)
})
