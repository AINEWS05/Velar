import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInit } from '../src/settings-merge'
import { runCodexInit } from '../src/codex-hooks-merge'
import { runUninstall } from '../src/uninstall'
import { VELAR_HOOK_COMMAND } from '../src/settings-merge'

let tmpDir: string
let vendorBaseDir: string
let vendorCliRoot: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-uninstall-test-'))
  vendorBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-uninstall-test-vendor-'))
  vendorCliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-uninstall-test-fake-cli-'))
  fs.mkdirSync(path.join(vendorCliRoot, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(vendorCliRoot, 'package.json'),
    JSON.stringify({ name: '@velar-dev/cli', version: '0.0.0-test' }),
  )
  fs.writeFileSync(path.join(vendorCliRoot, 'dist', 'index.js'), '// fake cli entry\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(vendorBaseDir, { recursive: true, force: true })
  fs.rmSync(vendorCliRoot, { recursive: true, force: true })
})

function init() {
  return runInit(tmpDir, { vendorBaseDir, vendorCliRoot })
}

const settingsLocalPath = () => path.join(tmpDir, '.claude', 'settings.local.json')
const legacySettingsPath = () => path.join(tmpDir, '.claude', 'settings.json')
const velarDir = () => path.join(tmpDir, '.velar')

describe('runUninstall — nothing installed', () => {
  it('is a safe no-op', () => {
    const result = runUninstall(tmpDir)
    expect(result.nothingToDo).toBe(true)
    expect(result.removedFromLocalSettings).toBe(false)
    expect(result.removedVelarDir).toBe(false)
  })
})

describe('runUninstall — fresh install (settings.local.json + .velar created by init, nothing else)', () => {
  it('deletes settings.local.json entirely (it had nothing else in it) and removes .velar/', () => {
    init()
    expect(fs.existsSync(settingsLocalPath())).toBe(true)
    expect(fs.existsSync(velarDir())).toBe(true)

    const result = runUninstall(tmpDir)
    expect(result.removedFromLocalSettings).toBe(true)
    expect(result.deletedLocalSettingsFile).toBe(true)
    expect(result.removedVelarDir).toBe(true)

    expect(fs.existsSync(settingsLocalPath())).toBe(false)
    expect(fs.existsSync(velarDir())).toBe(false)
  })

  it('removes .claude/ itself when it ends up completely empty', () => {
    init()
    const result = runUninstall(tmpDir)
    expect(result.removedEmptyClaudeDir).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(false)
  })

  it('does NOT remove .claude/ if something else is left in it', () => {
    init()
    fs.writeFileSync(path.join(tmpDir, '.claude', 'unrelated-file.txt'), 'keep me')
    const result = runUninstall(tmpDir)
    expect(result.removedEmptyClaudeDir).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'unrelated-file.txt'))).toBe(true)
  })

  it('does not touch the shared vendor cache outside the project', () => {
    const before = init()
    runUninstall(tmpDir)
    expect(fs.existsSync(before.vendorEntryPath)).toBe(true)
  })
})

describe('runUninstall — settings.local.json has other content beyond Velar', () => {
  it('removes only the Velar hook entry, keeps everything else, and backs up first', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    const original = {
      model: 'opus',
      hooks: {
        PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'other-tool' }] }],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'unrelated-guard' }] },
          { matcher: '.*', hooks: [{ type: 'command', command: VELAR_HOOK_COMMAND }] },
        ],
      },
    }
    fs.writeFileSync(settingsLocalPath(), JSON.stringify(original, null, 2))

    const result = runUninstall(tmpDir)
    expect(result.removedFromLocalSettings).toBe(true)
    expect(result.deletedLocalSettingsFile).toBe(false)
    expect(result.backupPaths).toHaveLength(1)
    expect(fs.readFileSync(result.backupPaths[0], 'utf8')).toBe(JSON.stringify(original, null, 2))

    const written = JSON.parse(fs.readFileSync(settingsLocalPath(), 'utf8'))
    expect(written.model).toBe('opus')
    expect(written.hooks.PostToolUse).toEqual(original.hooks.PostToolUse)
    expect(written.hooks.PreToolUse).toHaveLength(1)
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('unrelated-guard')
  })
})

describe('runUninstall — stale entry left in the legacy settings.json', () => {
  it('removes it too, with its own backup', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    const originalLegacy = {
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: VELAR_HOOK_COMMAND }] }] },
    }
    fs.writeFileSync(legacySettingsPath(), JSON.stringify(originalLegacy, null, 2))

    const result = runUninstall(tmpDir)
    expect(result.removedFromLegacySettings).toBe(true)
    expect(result.backupPaths.some((p) => path.basename(p).startsWith('settings.json.velar-uninstall-backup-'))).toBe(true)

    const written = JSON.parse(fs.readFileSync(legacySettingsPath(), 'utf8'))
    expect(written.model).toBe('opus')
    expect(written.hooks?.PreToolUse ?? []).toHaveLength(0)
  })
})

describe('runUninstall — idempotency', () => {
  it('running twice is safe; second run reports nothingToDo', () => {
    init()
    runUninstall(tmpDir)
    const second = runUninstall(tmpDir)
    expect(second.nothingToDo).toBe(true)
  })
})

describe('runUninstall — refuses to touch invalid JSON, same policy as runInit', () => {
  it('leaves a non-JSON settings.local.json untouched', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(settingsLocalPath(), '{ not valid json')
    const result = runUninstall(tmpDir)
    expect(result.removedFromLocalSettings).toBe(false)
    expect(fs.readFileSync(settingsLocalPath(), 'utf8')).toBe('{ not valid json')
  })
})

describe('runUninstall — Codex adapter (.codex/hooks.json)', () => {
  const codexHooksPath = () => path.join(tmpDir, '.codex', 'hooks.json')

  it('removes the Velar handler from .codex/hooks.json and removes .codex/ if left empty', () => {
    const result = runCodexInit(tmpDir, { vendorBaseDir, vendorCliRoot })
    expect(fs.existsSync(codexHooksPath())).toBe(true)

    const uninstallResult = runUninstall(tmpDir)
    expect(uninstallResult.removedFromCodexHooks).toBe(true)
    expect(uninstallResult.removedEmptyCodexDir).toBe(true)
    expect(fs.existsSync(codexHooksPath())).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, '.codex'))).toBe(false)
    expect(fs.existsSync(result.vendorEntryPath)).toBe(true) // vendor cache untouched
  })

  it('keeps other event types and unrelated PreToolUse handlers in hooks.json', () => {
    runCodexInit(tmpDir, { vendorBaseDir, vendorCliRoot })
    const before = JSON.parse(fs.readFileSync(codexHooksPath(), 'utf8'))
    before.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'echo hi' }] }]
    before.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool --check' }] })
    fs.writeFileSync(codexHooksPath(), JSON.stringify(before, null, 2))

    const result = runUninstall(tmpDir)
    expect(result.removedFromCodexHooks).toBe(true)
    expect(result.removedEmptyCodexDir).toBe(false)
    const after = JSON.parse(fs.readFileSync(codexHooksPath(), 'utf8'))
    expect(after.hooks.SessionStart).toEqual(before.hooks.SessionStart)
    expect(after.hooks.PreToolUse).toHaveLength(1)
    expect(after.hooks.PreToolUse[0].hooks[0].command).toBe('other-tool --check')
  })

  it('both adapters installed: uninstall cleans up both without touching the other', () => {
    runInit(tmpDir, { vendorBaseDir, vendorCliRoot })
    runCodexInit(tmpDir, { vendorBaseDir, vendorCliRoot })
    const result = runUninstall(tmpDir)
    expect(result.removedFromLocalSettings).toBe(true)
    expect(result.removedFromCodexHooks).toBe(true)
    expect(fs.existsSync(settingsLocalPath())).toBe(false)
    expect(fs.existsSync(codexHooksPath())).toBe(false)
    expect(fs.existsSync(velarDir())).toBe(false)
  })
})
