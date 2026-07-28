import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInit, VELAR_HOOK_COMMAND } from '../src/settings-merge'

let tmpDir: string
let vendorBaseDir: string
let vendorCliRoot: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-cli-test-'))
  vendorBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-cli-test-vendor-'))

  // A minimal, self-contained fake @velar-dev/cli install (no runtime deps)
  // so these tests never depend on `pnpm build` having produced a real
  // packages/cli/dist beforehand.
  vendorCliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-cli-test-fake-cli-'))
  fs.mkdirSync(path.join(vendorCliRoot, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(vendorCliRoot, 'package.json'),
    JSON.stringify({ name: '@velar-dev/cli', version: '0.0.0-test' }),
  )
  fs.writeFileSync(path.join(vendorCliRoot, 'dist', 'index.js'), '// fake cli entry for settings-merge tests\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(vendorBaseDir, { recursive: true, force: true })
  fs.rmSync(vendorCliRoot, { recursive: true, force: true })
})

function settingsPath() {
  return path.join(tmpDir, '.claude', 'settings.json')
}

function init(dir: string = tmpDir) {
  return runInit(dir, { vendorBaseDir, vendorCliRoot })
}

describe('runInit — creating settings.json', () => {
  it('creates .claude/settings.json with an absolute, vendored Velar hook command when none existed', () => {
    const result = init()
    expect(result.created).toBe(true)
    expect(result.alreadyInstalled).toBe(false)
    expect(result.upgraded).toBe(false)
    expect(fs.existsSync(settingsPath())).toBe(true)

    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    expect(written.hooks.PreToolUse).toHaveLength(1)
    const command: string = written.hooks.PreToolUse[0].hooks[0].command
    expect(command).toBe(result.hookCommand)
    expect(command.endsWith('hook pre-tool-use')).toBe(true)
    // Must NOT be the bare, PATH-dependent legacy command — that's the P0-1 bug.
    expect(command).not.toBe(VELAR_HOOK_COMMAND)
    // Must reference the vendored entry point by absolute path, not `velar`.
    expect(command).toContain(result.vendorEntryPath)
    expect(fs.existsSync(result.vendorEntryPath)).toBe(true)
  })

  it('creates the .velar directory', () => {
    const result = init()
    expect(fs.existsSync(result.velarDir)).toBe(true)
  })

  it('does not create a backup file when there was nothing to back up', () => {
    const result = init()
    expect(result.backupPath).toBeUndefined()
  })
})

describe('runInit — merging with existing settings', () => {
  it('preserves unrelated top-level keys and existing hook types', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    const existing = {
      model: 'opus',
      permissions: { allow: ['Bash(git *)'] },
      hooks: {
        PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'some-other-tool' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing-guard' }] }],
      },
    }
    fs.writeFileSync(settingsPath(), JSON.stringify(existing, null, 2))

    const result = init()
    expect(result.created).toBe(false)
    expect(result.alreadyInstalled).toBe(false)

    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    expect(written.model).toBe('opus')
    expect(written.permissions).toEqual({ allow: ['Bash(git *)'] })
    expect(written.hooks.PostToolUse).toEqual(existing.hooks.PostToolUse)
    // Existing PreToolUse guard must still be present, plus our new entry.
    expect(written.hooks.PreToolUse).toHaveLength(2)
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('existing-guard')
    expect(written.hooks.PreToolUse[1].hooks[0].command).toBe(result.hookCommand)
  })

  it('creates a timestamped backup of the pre-existing settings.json', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    const originalContent = JSON.stringify({ model: 'opus' }, null, 2)
    fs.writeFileSync(settingsPath(), originalContent)

    const result = init()
    expect(result.backupPath).toBeDefined()
    expect(path.basename(result.backupPath!)).toMatch(/^settings\.json\.velar-backup-.+$/)
    expect(fs.readFileSync(result.backupPath!, 'utf8')).toBe(originalContent)
  })

  it('refuses to touch a settings.json that is not valid JSON', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(settingsPath(), '{ this is not valid json')

    expect(() => init()).toThrow()
    // Original broken file must be untouched.
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{ this is not valid json')
  })
})

describe('runInit — idempotency', () => {
  it('does not duplicate the Velar hook when run twice', () => {
    init()
    const second = init()

    expect(second.alreadyInstalled).toBe(true)
    expect(second.upgraded).toBe(false)

    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    expect(written.hooks.PreToolUse).toHaveLength(1)
  })

  it('does not create a second backup file on the idempotent second run', () => {
    init()
    const filesAfterFirst = fs.readdirSync(path.join(tmpDir, '.claude'))
    const second = init()
    const filesAfterSecond = fs.readdirSync(path.join(tmpDir, '.claude'))

    expect(second.backupPath).toBeUndefined()
    expect(filesAfterSecond).toEqual(filesAfterFirst)
  })

  it('remains idempotent even when the user has other PreToolUse groups installed', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool' }] }] },
      }),
    )
    init()
    const second = init()
    expect(second.alreadyInstalled).toBe(true)

    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    expect(written.hooks.PreToolUse).toHaveLength(2)
  })
})

describe('runInit — upgrading a stale Velar hook entry', () => {
  it('rewrites a pre-0.2.0 bare "velar hook pre-tool-use" command in place, without duplicating', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: VELAR_HOOK_COMMAND }] }] },
      }),
    )

    const result = init()
    expect(result.alreadyInstalled).toBe(false)
    expect(result.upgraded).toBe(true)
    expect(result.backupPath).toBeDefined()

    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    expect(written.hooks.PreToolUse).toHaveLength(1)
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe(result.hookCommand)
    expect(written.hooks.PreToolUse[0].hooks[0].command).not.toBe(VELAR_HOOK_COMMAND)
  })

  it('is idempotent after upgrading: a third run is a no-op', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: VELAR_HOOK_COMMAND }] }] },
      }),
    )

    init() // upgrade
    const third = init()
    expect(third.alreadyInstalled).toBe(true)
    expect(third.upgraded).toBe(false)

    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    expect(written.hooks.PreToolUse).toHaveLength(1)
  })

  it('preserves the matcher and any sibling hook entries in the same group while upgrading', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '.*',
              hooks: [
                { type: 'command', command: 'unrelated-sibling-hook' },
                { type: 'command', command: VELAR_HOOK_COMMAND },
              ],
            },
          ],
        },
      }),
    )

    const result = init()
    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    expect(written.hooks.PreToolUse).toHaveLength(1)
    expect(written.hooks.PreToolUse[0].matcher).toBe('.*')
    expect(written.hooks.PreToolUse[0].hooks).toHaveLength(2)
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('unrelated-sibling-hook')
    expect(written.hooks.PreToolUse[0].hooks[1].command).toBe(result.hookCommand)
  })
})
