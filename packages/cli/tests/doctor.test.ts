import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runDoctor } from '../src/doctor'
import type { HookSelfTestResult } from '../src/hook-selftest'

let tmpDir: string
let configDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-doctor-test-'))
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-doctor-test-config-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(configDir, { recursive: true, force: true })
})

function writeSettings(command: string) {
  fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command }] }] } }),
  )
}

const passingSelfTest = (): HookSelfTestResult => ({ ok: true, exitCode: 0, elapsedMs: 12, stderr: '' })
const failingSelfTest = (): HookSelfTestResult => ({
  ok: false,
  exitCode: 1,
  elapsedMs: 5,
  stderr: 'boom',
})
const slowSelfTest = (): HookSelfTestResult => ({ ok: true, exitCode: 0, elapsedMs: 999, stderr: '' })

describe('runDoctor — missing setup', () => {
  it('fails when .claude/settings.json does not exist', () => {
    const result = runDoctor(tmpDir, { selfTest: passingSelfTest, configDir })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.id === 'settings-exists')?.level).toBe('fail')
  })

  it('fails when settings.json is not valid JSON', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.claude', 'settings.json'), '{ not json')
    const result = runDoctor(tmpDir, { selfTest: passingSelfTest, configDir })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.id === 'settings-valid-json')?.level).toBe('fail')
  })

  it('fails when settings.json has no Velar hook entry', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }))
    const result = runDoctor(tmpDir, { selfTest: passingSelfTest, configDir })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.id === 'hook-registered')?.level).toBe('fail')
  })
})

describe('runDoctor — vendored (0.2.0+) hook command', () => {
  it('passes every check when the hook self-test succeeds quickly', () => {
    writeSettings('"/usr/bin/node" "/home/user/.velar/vendor/0.2.0/node_modules/@velar-dev/cli/dist/index.js" hook pre-tool-use')
    const result = runDoctor(tmpDir, { selfTest: passingSelfTest, configDir })
    expect(result.ok).toBe(true)
    expect(result.checks.find((c) => c.id === 'hook-command-form')?.level).toBe('pass')
    expect(result.checks.find((c) => c.id === 'hook-executes')?.level).toBe('pass')
  })

  it('fails overall when the hook self-test fails, and says so explicitly', () => {
    writeSettings('"/usr/bin/node" "/home/user/.velar/vendor/0.2.0/node_modules/@velar-dev/cli/dist/index.js" hook pre-tool-use')
    const result = runDoctor(tmpDir, { selfTest: failingSelfTest, configDir })
    expect(result.ok).toBe(false)
    const check = result.checks.find((c) => c.id === 'hook-executes')
    expect(check?.level).toBe('fail')
    expect(check?.message).toContain('NOT currently protecting')
  })

  it('warns (but does not fail) when the hook is slower than the target budget', () => {
    writeSettings('"/usr/bin/node" "/home/user/.velar/vendor/0.2.0/node_modules/@velar-dev/cli/dist/index.js" hook pre-tool-use')
    const result = runDoctor(tmpDir, { selfTest: slowSelfTest, configDir })
    expect(result.ok).toBe(true)
    expect(result.checks.find((c) => c.id === 'hook-executes')?.level).toBe('warn')
  })
})

describe('runDoctor — legacy (pre-0.2.0) bare hook command', () => {
  it('warns that the command is PATH-dependent, even if it currently works', () => {
    writeSettings('velar hook pre-tool-use')
    const result = runDoctor(tmpDir, { selfTest: passingSelfTest, configDir })
    expect(result.ok).toBe(true) // a warning alone doesn't fail doctor
    const check = result.checks.find((c) => c.id === 'hook-command-form')
    expect(check?.level).toBe('warn')
    expect(check?.message).toContain('velar init')
  })
})

describe('runDoctor — login state', () => {
  it('warns when not logged in, but does not fail', () => {
    writeSettings('velar hook pre-tool-use')
    const result = runDoctor(tmpDir, { selfTest: passingSelfTest, configDir })
    expect(result.checks.find((c) => c.id === 'login-state')?.level).toBe('warn')
    expect(result.ok).toBe(true)
  })

  it('passes when a config.json is present', () => {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ token: 'vlr_x', orgId: 'org_x' }))
    writeSettings('velar hook pre-tool-use')
    const result = runDoctor(tmpDir, { selfTest: passingSelfTest, configDir })
    expect(result.checks.find((c) => c.id === 'login-state')?.level).toBe('pass')
  })
})

describe('runDoctor — real self-test integration (no injected stub)', () => {
  it('actually spawns the registered command and detects a working hook', () => {
    const nodeQuoted = `"${process.execPath.replace(/"/g, '\\"')}"`
    writeSettings(`${nodeQuoted} -e "process.exit(0)" hook pre-tool-use`)
    // The trailing "hook pre-tool-use" here is just to satisfy the
    // extraction regex; `-e "process.exit(0)"` is what actually runs, and
    // the extra trailing words are inert argv to `node -e`.
    const result = runDoctor(tmpDir, { configDir })
    expect(result.checks.find((c) => c.id === 'hook-executes')?.level).toBe('pass')
  })
})
