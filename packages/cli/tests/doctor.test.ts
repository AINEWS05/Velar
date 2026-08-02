import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runDoctor } from '../src/doctor'
import { writeInstallReceipt, type InstallReceipt } from '../src/install-receipt'
import { fingerprintFile } from '../src/vendor'
import type { HookSelfTestResult, HookSelfTestTarget } from '../src/hook-selftest'
import type { VersionCheckFetchFn } from '../src/version-check'

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

function writeSettingsLocal(command: string) {
  fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, '.claude', 'settings.local.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command }] }] } }),
  )
}

function writeSettingsLocalWithMatcher(command: string, matcher: string) {
  fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, '.claude', 'settings.local.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command }] }] } }),
  )
}

function writeLegacySettings(command: string) {
  fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command }] }] } }),
  )
}

function writeMatchingReceipt(command: string, overrides: Partial<InstallReceipt> = {}) {
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
    ...overrides,
  }
  writeInstallReceipt(velarDir, receipt)
}

const passingSelfTest = (): HookSelfTestResult => ({ ok: true, exitCode: 0, elapsedMs: 12, stderr: '' })
const failingSelfTest = (): HookSelfTestResult => ({
  ok: false,
  exitCode: 1,
  elapsedMs: 5,
  stderr: 'boom',
})
const slowSelfTest = (): HookSelfTestResult => ({ ok: true, exitCode: 0, elapsedMs: 999, stderr: '' })

/** Every test below disables the version-currency check (checkVersion: false) unless it's specifically testing that feature — otherwise every test would attempt a real network call to the npm registry. */
const noVersionCheck = { checkVersion: false as const }

describe('runDoctor — missing setup', () => {
  it('fails when neither settings.local.json nor settings.json exist', async () => {
    const result = await runDoctor(tmpDir, { selfTest: passingSelfTest, configDir, ...noVersionCheck })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.id === 'hook-registered')?.level).toBe('fail')
  })

  it('fails when settings.local.json has no Velar hook entry', async () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: {} }))
    const result = await runDoctor(tmpDir, { selfTest: passingSelfTest, configDir, ...noVersionCheck })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.id === 'hook-registered')?.level).toBe('fail')
  })
})

describe('runDoctor — vendored (0.2.0+) hook command, with a matching install receipt', () => {
  function setUp() {
    const vendoredPath = path.join('home', 'user', '.velar', 'vendor', '0.2.0', 'node_modules', '@velar-dev', 'cli', 'dist', 'index.js')
    const cmd = `"/usr/bin/node" "${vendoredPath}" hook pre-tool-use`
    writeSettingsLocal(cmd)
    writeMatchingReceipt(cmd)
    return cmd
  }

  it('passes every check when the hook self-test succeeds quickly', async () => {
    setUp()
    const result = await runDoctor(tmpDir, { selfTest: passingSelfTest, configDir, ...noVersionCheck })
    expect(result.ok).toBe(true)
    expect(result.checks.find((c) => c.id === 'install-receipt')?.level).toBe('pass')
    expect(result.checks.find((c) => c.id === 'hook-command-form')?.level).toBe('pass')
    expect(result.checks.find((c) => c.id === 'hook-executes')?.level).toBe('pass')
  })

  it('fails overall when the hook self-test fails, and says so explicitly', async () => {
    setUp()
    const result = await runDoctor(tmpDir, { selfTest: failingSelfTest, configDir, ...noVersionCheck })
    expect(result.ok).toBe(false)
    const check = result.checks.find((c) => c.id === 'hook-executes')
    expect(check?.level).toBe('fail')
    expect(check?.message).toContain('NOT currently protecting')
  })

  it('fails when the self-test reports a trust error (fingerprint mismatch etc.), surfacing that message', async () => {
    setUp()
    const trustFailingSelfTest = (): HookSelfTestResult => ({
      ok: false,
      exitCode: null,
      elapsedMs: 0,
      stderr: '',
      trustError: 'fingerprint mismatch — refusing to execute',
    })
    const result = await runDoctor(tmpDir, { selfTest: trustFailingSelfTest, configDir, ...noVersionCheck })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.id === 'hook-executes')?.message).toContain('fingerprint mismatch')
  })

  it('warns (but does not fail) when the hook is slower than the target budget', async () => {
    setUp()
    const result = await runDoctor(tmpDir, { selfTest: slowSelfTest, configDir, ...noVersionCheck })
    expect(result.ok).toBe(true)
    expect(result.checks.find((c) => c.id === 'hook-executes')?.level).toBe('warn')
  })

  it('passes the exact HookSelfTestTarget from the receipt through to selfTest', async () => {
    setUp()
    let capturedTarget: HookSelfTestTarget | undefined
    await runDoctor(tmpDir, {
      configDir,
      ...noVersionCheck,
      selfTest: (target) => {
        capturedTarget = target
        return passingSelfTest()
      },
    })
    expect(capturedTarget?.executable).toBe('/usr/bin/node')
    expect(capturedTarget?.expectedFingerprint).toBe('a'.repeat(64))
    expect(capturedTarget?.vendorRoot).toBe(path.join(tmpDir, 'fake-vendor-root'))
  })
})

describe('runDoctor — no install receipt (pre-4a install or receipt deleted)', () => {
  it('skips execution rather than running an unverifiable command, and warns', async () => {
    writeSettingsLocal('"/usr/bin/node" "/some/path/index.js" hook pre-tool-use')
    // deliberately no receipt written
    let selfTestCalled = false
    const result = await runDoctor(tmpDir, {
      configDir,
      ...noVersionCheck,
      selfTest: () => {
        selfTestCalled = true
        return passingSelfTest()
      },
    })
    expect(selfTestCalled).toBe(false)
    expect(result.checks.find((c) => c.id === 'install-receipt')?.level).toBe('warn')
    expect(result.checks.find((c) => c.id === 'hook-executes')?.level).toBe('warn')
    expect(result.ok).toBe(true) // warn-only, not a hard failure
  })

  it('warns when the receipt exists but no longer matches the registered command', async () => {
    writeSettingsLocal('"/usr/bin/node" "/some/NEW/path/index.js" hook pre-tool-use')
    writeMatchingReceipt('"/usr/bin/node" "/some/OLD/path/index.js" hook pre-tool-use')
    const result = await runDoctor(tmpDir, { selfTest: passingSelfTest, configDir, ...noVersionCheck })
    expect(result.checks.find((c) => c.id === 'install-receipt')?.level).toBe('warn')
    expect(result.checks.find((c) => c.id === 'install-receipt')?.message).toContain('does not match')
  })
})

describe('runDoctor — legacy (pre-0.2.0) bare hook command', () => {
  it('warns that the command is PATH-dependent, even if it currently works', async () => {
    writeSettingsLocal('velar hook pre-tool-use')
    writeMatchingReceipt('velar hook pre-tool-use')
    const result = await runDoctor(tmpDir, { selfTest: passingSelfTest, configDir, ...noVersionCheck })
    expect(result.ok).toBe(true) // a warning alone doesn't fail doctor
    const check = result.checks.find((c) => c.id === 'hook-command-form')
    expect(check?.level).toBe('warn')
    expect(check?.message).toContain('velar init')
  })
})

describe('runDoctor — hook matcher drift (2026-08-01)', () => {
  it('passes when the matcher is exactly `.*`', async () => {
    const vendoredPath = path.join('home', 'user', '.velar', 'vendor', '0.2.0', 'node_modules', '@velar-dev', 'cli', 'dist', 'index.js')
    const cmd = `"/usr/bin/node" "${vendoredPath}" hook pre-tool-use`
    writeSettingsLocalWithMatcher(cmd, '.*')
    writeMatchingReceipt(cmd)
    const result = await runDoctor(tmpDir, { selfTest: passingSelfTest, configDir, ...noVersionCheck })
    expect(result.checks.find((c) => c.id === 'hook-matcher-coverage')?.level).toBe('pass')
    expect(result.ok).toBe(true)
  })

  it('warns (but does not fail doctor outright) when the matcher has been narrowed to a subset of tools', async () => {
    const vendoredPath = path.join('home', 'user', '.velar', 'vendor', '0.2.0', 'node_modules', '@velar-dev', 'cli', 'dist', 'index.js')
    const cmd = `"/usr/bin/node" "${vendoredPath}" hook pre-tool-use`
    writeSettingsLocalWithMatcher(cmd, 'Bash')
    writeMatchingReceipt(cmd)
    const result = await runDoctor(tmpDir, { selfTest: passingSelfTest, configDir, ...noVersionCheck })
    const check = result.checks.find((c) => c.id === 'hook-matcher-coverage')
    expect(check?.level).toBe('warn')
    expect(check?.message).toContain('Bash')
    expect(result.ok).toBe(true) // still just a warn, same policy as other drift warnings
  })
})

describe('runDoctor — legacy shared settings.json location', () => {
  it('warns that the hook is registered in the old shared-settings location', async () => {
    writeLegacySettings('"/usr/bin/node" "/some/path/index.js" hook pre-tool-use')
    const result = await runDoctor(tmpDir, { selfTest: passingSelfTest, configDir, ...noVersionCheck })
    expect(result.checks.find((c) => c.id === 'settings-exists')?.level).toBe('warn')
    expect(result.checks.find((c) => c.id === 'settings-exists')?.message).toContain('legacy')
  })
})

describe('runDoctor — login state', () => {
  it('warns when not logged in, but does not fail', async () => {
    writeSettingsLocal('velar hook pre-tool-use')
    writeMatchingReceipt('velar hook pre-tool-use')
    const result = await runDoctor(tmpDir, { selfTest: passingSelfTest, configDir, ...noVersionCheck })
    expect(result.checks.find((c) => c.id === 'login-state')?.level).toBe('warn')
    expect(result.ok).toBe(true)
  })

  it('passes when a config.json is present', async () => {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ token: 'vlr_x', orgId: 'org_x' }))
    writeSettingsLocal('velar hook pre-tool-use')
    writeMatchingReceipt('velar hook pre-tool-use')
    const result = await runDoctor(tmpDir, { selfTest: passingSelfTest, configDir, ...noVersionCheck })
    expect(result.checks.find((c) => c.id === 'login-state')?.level).toBe('pass')
  })
})

describe('runDoctor — real self-test integration (no injected stub)', () => {
  it('actually spawns the registered command, fingerprint-verified, and detects a working hook', async () => {
    const vendorRoot = path.join(tmpDir, 'real-vendor-root')
    fs.mkdirSync(vendorRoot, { recursive: true })
    const entryPath = path.join(vendorRoot, 'index.js')
    fs.writeFileSync(entryPath, 'process.exit(0)\n')
    const fingerprint = fingerprintFile(entryPath)

    const command = `"${process.execPath}" "${entryPath}" hook pre-tool-use`
    writeSettingsLocal(command)
    writeMatchingReceipt(command, {
      vendorRoot,
      vendorEntryPath: entryPath,
      vendorEntryFingerprint: fingerprint,
      hookExecutable: process.execPath,
      hookArgs: [entryPath],
    })

    const result = await runDoctor(tmpDir, { configDir, ...noVersionCheck })
    // 'pass' vs 'warn' here is purely a function of wall-clock spawn timing
    // (SLOW_HOOK_THRESHOLD_MS), which a real subprocess spawn under CI load
    // cannot be asserted on deterministically — assert what actually
    // matters instead: it ran successfully (not 'fail'), with no trust error.
    const check = result.checks.find((c) => c.id === 'hook-executes')
    expect(check?.level).not.toBe('fail')
    expect(check?.message).not.toContain('fingerprint')
    expect(result.ok).toBe(true)
  })
})

describe('runDoctor — version-currency check (2026-08-01)', () => {
  function setUpWithVersion(cliVersion: string) {
    const vendoredPath = path.join('home', 'user', '.velar', 'vendor', cliVersion, 'node_modules', '@velar-dev', 'cli', 'dist', 'index.js')
    const cmd = `"/usr/bin/node" "${vendoredPath}" hook pre-tool-use`
    writeSettingsLocal(cmd)
    writeMatchingReceipt(cmd, { cliVersion })
  }

  function fakeRegistryFetch(response: { version: string; securityAdvisory?: string } | null): VersionCheckFetchFn {
    return async () => {
      if (!response) return { ok: false, json: async () => ({}) }
      return {
        ok: true,
        json: async () => ({ version: response.version, velar: response.securityAdvisory ? { securityAdvisory: response.securityAdvisory } : undefined }),
      }
    }
  }

  it('passes when the installed version matches the latest published version', async () => {
    setUpWithVersion('0.3.0')
    const result = await runDoctor(tmpDir, {
      selfTest: passingSelfTest,
      configDir,
      versionFetchImpl: fakeRegistryFetch({ version: '0.3.0' }),
    })
    const check = result.checks.find((c) => c.id === 'version-currency')
    expect(check?.level).toBe('pass')
  })

  it('warns with upgrade instructions when a newer non-security version is available', async () => {
    setUpWithVersion('0.2.0')
    const result = await runDoctor(tmpDir, {
      selfTest: passingSelfTest,
      configDir,
      versionFetchImpl: fakeRegistryFetch({ version: '0.3.0' }),
    })
    const check = result.checks.find((c) => c.id === 'version-currency')
    expect(check?.level).toBe('warn')
    expect(check?.message).toContain('npx @velar-dev/cli@latest init')
    expect(check?.message).not.toContain('SECURITY')
    expect(result.ok).toBe(true) // an available update alone never fails doctor
  })

  it('shows a stronger security-flagged message when the latest version has a security advisory', async () => {
    setUpWithVersion('0.2.0')
    const result = await runDoctor(tmpDir, {
      selfTest: passingSelfTest,
      configDir,
      versionFetchImpl: fakeRegistryFetch({ version: '0.3.0', securityAdvisory: 'Fixes a silent default-allow gap.' }),
    })
    const check = result.checks.find((c) => c.id === 'version-currency')
    expect(check?.level).toBe('warn')
    expect(check?.message).toContain('SECURITY UPDATE AVAILABLE')
    expect(check?.message).toContain('Fixes a silent default-allow gap.')
  })

  it('degrades to a soft warn (not fail) when the registry is unreachable', async () => {
    setUpWithVersion('0.2.0')
    const result = await runDoctor(tmpDir, {
      selfTest: passingSelfTest,
      configDir,
      versionFetchImpl: fakeRegistryFetch(null),
    })
    const check = result.checks.find((c) => c.id === 'version-currency')
    expect(check?.level).toBe('warn')
    expect(check?.message).toContain('Could not check')
    expect(result.ok).toBe(true)
  })

  it('is skipped entirely (no check pushed) when checkVersion is false', async () => {
    setUpWithVersion('0.2.0')
    let called = false
    const result = await runDoctor(tmpDir, {
      selfTest: passingSelfTest,
      configDir,
      checkVersion: false,
      versionFetchImpl: async () => {
        called = true
        return { ok: true, json: async () => ({ version: '0.3.0' }) }
      },
    })
    expect(called).toBe(false)
    expect(result.checks.find((c) => c.id === 'version-currency')).toBeUndefined()
  })

  it('is skipped when there is no install receipt (nothing to compare)', async () => {
    writeSettingsLocal('"/usr/bin/node" "/some/path/index.js" hook pre-tool-use')
    // deliberately no receipt written
    const result = await runDoctor(tmpDir, {
      selfTest: passingSelfTest,
      configDir,
      versionFetchImpl: fakeRegistryFetch({ version: '0.3.0' }),
    })
    expect(result.checks.find((c) => c.id === 'version-currency')).toBeUndefined()
  })
})
