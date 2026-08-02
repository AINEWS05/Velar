import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runHookSelfTest, runHookCriticalBlockTest, verifyHookTrust, type HookSelfTestTarget } from '../src/hook-selftest'
import { fingerprintFile } from '../src/vendor'

let tmpDir: string
let vendorRoot: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-selftest-test-'))
  vendorRoot = path.join(tmpDir, 'vendor', '9.9.9')
  fs.mkdirSync(vendorRoot, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeScript(name: string, contents: string): string {
  const scriptPath = path.join(vendorRoot, name)
  fs.writeFileSync(scriptPath, contents)
  return scriptPath
}

function targetFor(scriptPath: string, fingerprintOverride?: string): HookSelfTestTarget {
  return {
    executable: process.execPath,
    args: [scriptPath],
    entryPath: scriptPath,
    vendorRoot,
    expectedFingerprint: fingerprintOverride ?? fingerprintFile(scriptPath),
  }
}

describe('verifyHookTrust', () => {
  it('passes when entryPath is inside vendorRoot and the fingerprint matches', () => {
    const scriptPath = writeScript('index.js', 'process.exit(0)\n')
    expect(verifyHookTrust(targetFor(scriptPath))).toBeNull()
  })

  it('rejects when entryPath is outside vendorRoot', () => {
    const outsidePath = path.join(tmpDir, 'outside.js')
    fs.writeFileSync(outsidePath, 'process.exit(0)\n')
    const target = targetFor(outsidePath, fingerprintFile(outsidePath))
    const error = verifyHookTrust(target)
    expect(error).toContain('outside')
    expect(error).toContain(vendorRoot)
  })

  it('rejects when the fingerprint does not match (tampered or corrupted file)', () => {
    const scriptPath = writeScript('index.js', 'process.exit(0)\n')
    const target = targetFor(scriptPath, 'a'.repeat(64))
    const error = verifyHookTrust(target)
    expect(error).toContain('fingerprint')
  })

  it('rejects when entryPath does not exist', () => {
    const target = targetFor(path.join(vendorRoot, 'missing.js'), 'a'.repeat(64))
    const error = verifyHookTrust(target)
    expect(error).not.toBeNull()
  })
})

describe('runHookSelfTest', () => {
  it('reports ok: true and exitCode 0 for a trusted script that exits 0', () => {
    const scriptPath = writeScript('index.js', 'process.exit(0)\n')
    const result = runHookSelfTest(targetFor(scriptPath))
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.trustError).toBeUndefined()
  })

  it('reports ok: false when the script exits non-zero', () => {
    const scriptPath = writeScript('index.js', 'process.exit(2)\n')
    const result = runHookSelfTest(targetFor(scriptPath))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(2)
  })

  it('never executes anything when the fingerprint check fails', () => {
    const scriptPath = writeScript('index.js', 'require("fs").writeFileSync(require("path").join(__dirname, "PWNED"), "x")\n')
    const target = targetFor(scriptPath, 'a'.repeat(64))
    const result = runHookSelfTest(target)
    expect(result.ok).toBe(false)
    expect(result.trustError).toContain('fingerprint')
    expect(fs.existsSync(path.join(vendorRoot, 'PWNED'))).toBe(false)
  })

  it('never executes anything when entryPath is outside vendorRoot, even if args point elsewhere', () => {
    const outsidePath = path.join(tmpDir, 'outside.js')
    fs.writeFileSync(outsidePath, 'require("fs").writeFileSync(require("path").join(__dirname, "PWNED"), "x")\n')
    const target = targetFor(outsidePath, fingerprintFile(outsidePath))
    const result = runHookSelfTest(target)
    expect(result.ok).toBe(false)
    expect(result.trustError).toContain('outside')
    expect(fs.existsSync(path.join(tmpDir, 'PWNED'))).toBe(false)
  })

  it('reports ok: false (not a thrown exception) when the executable cannot be found at all', () => {
    const scriptPath = writeScript('index.js', 'process.exit(0)\n')
    const target: HookSelfTestTarget = {
      executable: '/definitely/not/a/real/velar-self-test-binary',
      args: [scriptPath],
      entryPath: scriptPath,
      vendorRoot,
      expectedFingerprint: fingerprintFile(scriptPath),
    }
    const result = runHookSelfTest(target)
    expect(result.ok).toBe(false)
  })

  it('pipes the synthetic payload on stdin so a real velar hook invocation can read it', () => {
    const scriptPath = writeScript(
      'index.js',
      'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{process.exit(d.includes("velar-self-test-placeholder.txt")?0:1)})\n',
    )
    const result = runHookSelfTest(targetFor(scriptPath))
    expect(result.ok).toBe(true)
  })

  it('does not use a shell to spawn (no shell metacharacter injection)', () => {
    // A script whose path/args would be dangerous if shell-interpreted --
    // since we pass args as an array with shell:false, this must be treated
    // as a single literal argument, not executed as shell syntax.
    const trickyDir = path.join(vendorRoot, 'sub; touch INJECTED;')
    fs.mkdirSync(trickyDir, { recursive: true })
    const scriptPath = path.join(trickyDir, 'index.js')
    fs.writeFileSync(scriptPath, 'process.exit(0)\n')
    const result = runHookSelfTest(targetFor(scriptPath))
    expect(result.ok).toBe(true)
    expect(fs.existsSync(path.join(vendorRoot, 'INJECTED'))).toBe(false)
  })
})

describe('runHookCriticalBlockTest', () => {
  it('reports ok: true when the script exits 2 (blocked, as a critical op should be)', () => {
    const scriptPath = writeScript(
      'index.js',
      'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{process.exit(d.includes(".env.production")?2:0)})\n',
    )
    const result = runHookCriticalBlockTest(targetFor(scriptPath))
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(2)
  })

  it('reports ok: false when the script exits 0 (would have allowed a critical op through)', () => {
    const scriptPath = writeScript('index.js', 'process.exit(0)\n')
    const result = runHookCriticalBlockTest(targetFor(scriptPath))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(0)
  })

  it('still respects the trust check before executing', () => {
    const scriptPath = writeScript('index.js', 'process.exit(2)\n')
    const target = targetFor(scriptPath, 'a'.repeat(64))
    const result = runHookCriticalBlockTest(target)
    expect(result.ok).toBe(false)
    expect(result.trustError).toContain('fingerprint')
  })
})
