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

const BLOCK_IDS = [
  'block-secrets',
  'block-production_db',
  'block-destructive_command',
  'block-deploy',
  'block-exfiltration',
  'block-package_ci_config',
]

const pass = (): HookSelfTestResult => ({ ok: true, exitCode: 0, elapsedMs: 10, stderr: '' })
const passBlock = (): HookSelfTestResult => ({ ok: true, exitCode: 2, elapsedMs: 10, stderr: '' })
const fail = (): HookSelfTestResult => ({ ok: false, exitCode: 1, elapsedMs: 10, stderr: 'boom' })
const failBlock = (): HookSelfTestResult => ({ ok: false, exitCode: 0, elapsedMs: 10, stderr: '' }) // exit 0 = would have let it through!

describe('runVelarTest — no verified hook target', () => {
  it('fails the allow case and all 6 category block cases when nothing is installed', () => {
    const result = runVelarTest(tmpDir)
    expect(result.ok).toBe(false)
    // resolveHookTarget contributes its own pre-checks ahead of these 7 —
    // assert our 7 are present and failed, not the array's total length.
    expect(result.checks.find((c) => c.id === 'allow-case')?.level).toBe('fail')
    for (const id of BLOCK_IDS) {
      expect(result.checks.find((c) => c.id === id)?.level).toBe('fail')
    }
  })
})

describe('runVelarTest — happy path', () => {
  it('passes with the allow case and every category block case correct (7 of our own checks, plus resolveHookTarget\'s pre-checks)', () => {
    setUp()
    const result = runVelarTest(tmpDir, { allowSelfTest: pass, blockSelfTest: passBlock })
    expect(result.ok).toBe(true)
    expect(result.checks.find((c) => c.id === 'allow-case')?.level).toBe('pass')
    for (const id of BLOCK_IDS) {
      expect(result.checks.find((c) => c.id === id)?.level).toBe('pass')
    }
  })
})

describe('runVelarTest — failure cases', () => {
  it('fails when a benign read is not allowed', () => {
    setUp()
    const result = runVelarTest(tmpDir, { allowSelfTest: fail, blockSelfTest: passBlock })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.id === 'allow-case')?.level).toBe('fail')
  })

  it('fails when a category operation is NOT blocked (the dangerous case: it would let it through)', () => {
    setUp()
    const result = runVelarTest(tmpDir, { allowSelfTest: pass, blockSelfTest: failBlock })
    expect(result.ok).toBe(false)
    for (const id of BLOCK_IDS) {
      const check = result.checks.find((c) => c.id === id)
      expect(check?.level).toBe('fail')
      expect(check?.message).toContain('NOT blocked')
    }
  })

  it('surfaces a trust error distinctly for a block case', () => {
    setUp()
    const trustFail = (): HookSelfTestResult => ({
      ok: false,
      exitCode: null,
      elapsedMs: 0,
      stderr: '',
      trustError: 'fingerprint mismatch',
    })
    const result = runVelarTest(tmpDir, { allowSelfTest: pass, blockSelfTest: trustFail })
    expect(result.checks.find((c) => c.id === 'block-secrets')?.message).toContain('fingerprint mismatch')
  })

  it('passes the actual per-category payload through to blockSelfTest', () => {
    setUp()
    const seenPayloads: string[] = []
    const spy = (_target: HookSelfTestTarget, _cwd: string, payload: string): HookSelfTestResult => {
      seenPayloads.push(payload)
      return passBlock()
    }
    runVelarTest(tmpDir, { allowSelfTest: pass, blockSelfTest: spy })
    expect(seenPayloads).toHaveLength(6)
    // Each category's payload must be distinct and shaped like a real PreToolUse payload.
    expect(new Set(seenPayloads).size).toBe(6)
    for (const p of seenPayloads) {
      expect(JSON.parse(p)).toHaveProperty('hook_event_name', 'PreToolUse')
    }
  })
})

describe('runVelarTest — real integration (no injected stubs)', () => {
  it('actually proves allow-through and blocks a real representative of every category', () => {
    const vendorRoot = path.join(tmpDir, 'real-vendor-root')
    fs.mkdirSync(vendorRoot, { recursive: true })
    const entryPath = path.join(vendorRoot, 'index.js')
    // Minimal fake hook: allow (exit 0) for the benign placeholder, block (exit 2) for anything else.
    fs.writeFileSync(
      entryPath,
      'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{process.exit(d.includes("velar-self-test-placeholder.txt")?0:2)})\n',
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
    for (const id of BLOCK_IDS) {
      expect(result.checks.find((c) => c.id === id)?.level).toBe('pass')
    }
  })
})
