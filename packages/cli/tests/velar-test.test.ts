import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runVelarTest } from '../src/velar-test'
import { writeInstallReceipt, type InstallReceipt } from '../src/install-receipt'
import { fingerprintFile } from '../src/vendor'
import type { HookSelfTestResult } from '../src/hook-selftest'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-test-cmd-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeSettingsLocal(command: string) {
  fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, '.claude', 'settings.local.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command }] }] } }),
  )
}

function writeMatchingReceipt(command: string) {
  const velarDir = path.join(tmpDir, '.velar')
  const receipt: InstallReceipt = {
    schemaVersion: 1,
    cliVersion: '0.0.0-test',
    installedAt: new Date().toISOString(),
    vendorRoot: path.join(tmpDir, 'fake-vendor-root'),
    vendorEntryPath: path.join(tmpDir, 'fake-vendor-root', 'index.js'),
    vendorEntryFingerprint: 'a'.repeat(64),
    hookExecutable: '/usr/bin/node',
    hookArgs: [path.join(tmpDir, 'fake-vendor-root', 'index.js'), 'hook', 'pre-tool-use'],
    hookCommand: command,
    settingsPath: path.join(tmpDir, '.claude', 'settings.local.json'),
  }
  writeInstallReceipt(velarDir, receipt)
}

function setUp() {
  const cmd = `"/usr/bin/node" "${path.join(tmpDir, 'fake-vendor-root', 'index.js')}" hook pre-tool-use`
  writeSettingsLocal(cmd)
  writeMatchingReceipt(cmd)
}

const pass = (): HookSelfTestResult => ({ ok: true, exitCode: 0, elapsedMs: 10, stderr: '' })
const passCritical = (): HookSelfTestResult => ({ ok: true, exitCode: 2, elapsedMs: 10, stderr: '' })
const fail = (): HookSelfTestResult => ({ ok: false, exitCode: 1, elapsedMs: 10, stderr: 'boom' })
const failCritical = (): HookSelfTestResult => ({ ok: false, exitCode: 0, elapsedMs: 10, stderr: '' }) // exit 0 = would have let it through!

describe('runVelarTest — no verified hook target', () => {
  it('fails both cases when nothing is installed', () => {
    const result = runVelarTest(tmpDir)
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.id === 'allow-case')?.level).toBe('fail')
    expect(result.checks.find((c) => c.id === 'critical-block-case')?.level).toBe('fail')
  })
})

describe('runVelarTest — happy path', () => {
  it('passes when both the allow case and the critical-block case behave correctly', () => {
    setUp()
    const result = runVelarTest(tmpDir, { allowSelfTest: pass, criticalSelfTest: passCritical })
    expect(result.ok).toBe(true)
    expect(result.checks.find((c) => c.id === 'allow-case')?.level).toBe('pass')
    expect(result.checks.find((c) => c.id === 'critical-block-case')?.level).toBe('pass')
  })
})

describe('runVelarTest — failure cases', () => {
  it('fails when a benign read is not allowed', () => {
    setUp()
    const result = runVelarTest(tmpDir, { allowSelfTest: fail, criticalSelfTest: passCritical })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.id === 'allow-case')?.level).toBe('fail')
  })

  it('fails when a critical operation is NOT blocked (the dangerous case: it would let it through)', () => {
    setUp()
    const result = runVelarTest(tmpDir, { allowSelfTest: pass, criticalSelfTest: failCritical })
    expect(result.ok).toBe(false)
    const check = result.checks.find((c) => c.id === 'critical-block-case')
    expect(check?.level).toBe('fail')
    expect(check?.message).toContain('NOT blocked')
  })

  it('surfaces a trust error distinctly for the critical case', () => {
    setUp()
    const trustFail = (): HookSelfTestResult => ({
      ok: false,
      exitCode: null,
      elapsedMs: 0,
      stderr: '',
      trustError: 'fingerprint mismatch',
    })
    const result = runVelarTest(tmpDir, { allowSelfTest: pass, criticalSelfTest: trustFail })
    expect(result.checks.find((c) => c.id === 'critical-block-case')?.message).toContain('fingerprint mismatch')
  })
})

describe('runVelarTest — real integration (no injected stubs)', () => {
  it('actually proves allow-through and critical-block against a real script', () => {
    const vendorRoot = path.join(tmpDir, 'real-vendor-root')
    fs.mkdirSync(vendorRoot, { recursive: true })
    const entryPath = path.join(vendorRoot, 'index.js')
    // Minimal fake hook: allow (exit 0) unless the payload mentions .env.production (exit 2).
    fs.writeFileSync(
      entryPath,
      'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{process.exit(d.includes(".env.production")?2:0)})\n',
    )
    const fingerprint = fingerprintFile(entryPath)
    const command = `"${process.execPath}" "${entryPath}" hook pre-tool-use`

    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command }] }] } }),
    )
    writeInstallReceipt(path.join(tmpDir, '.velar'), {
      schemaVersion: 1,
      cliVersion: '0.0.0-test',
      installedAt: new Date().toISOString(),
      vendorRoot,
      vendorEntryPath: entryPath,
      vendorEntryFingerprint: fingerprint,
      hookExecutable: process.execPath,
      hookArgs: [entryPath],
      hookCommand: command,
      settingsPath: path.join(tmpDir, '.claude', 'settings.local.json'),
    })

    const result = runVelarTest(tmpDir)
    expect(result.ok).toBe(true)
    expect(result.checks.find((c) => c.id === 'allow-case')?.level).toBe('pass')
    expect(result.checks.find((c) => c.id === 'critical-block-case')?.level).toBe('pass')
  })
})
