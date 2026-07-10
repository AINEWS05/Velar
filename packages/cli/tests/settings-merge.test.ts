import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInit, VELAR_HOOK_COMMAND } from '../src/settings-merge'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-cli-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function settingsPath() {
  return path.join(tmpDir, '.claude', 'settings.json')
}

describe('runInit — creating settings.json', () => {
  it('creates .claude/settings.json with the Velar hook when none existed', () => {
    const result = runInit(tmpDir)
    expect(result.created).toBe(true)
    expect(result.alreadyInstalled).toBe(false)
    expect(fs.existsSync(settingsPath())).toBe(true)

    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    expect(written.hooks.PreToolUse).toHaveLength(1)
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe(VELAR_HOOK_COMMAND)
  })

  it('creates the .velar directory', () => {
    const result = runInit(tmpDir)
    expect(fs.existsSync(result.velarDir)).toBe(true)
  })

  it('does not create a backup file when there was nothing to back up', () => {
    const result = runInit(tmpDir)
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

    const result = runInit(tmpDir)
    expect(result.created).toBe(false)
    expect(result.alreadyInstalled).toBe(false)

    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    expect(written.model).toBe('opus')
    expect(written.permissions).toEqual({ allow: ['Bash(git *)'] })
    expect(written.hooks.PostToolUse).toEqual(existing.hooks.PostToolUse)
    // Existing PreToolUse guard must still be present, plus our new entry.
    expect(written.hooks.PreToolUse).toHaveLength(2)
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('existing-guard')
    expect(written.hooks.PreToolUse[1].hooks[0].command).toBe(VELAR_HOOK_COMMAND)
  })

  it('creates a timestamped backup of the pre-existing settings.json', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    const originalContent = JSON.stringify({ model: 'opus' }, null, 2)
    fs.writeFileSync(settingsPath(), originalContent)

    const result = runInit(tmpDir)
    expect(result.backupPath).toBeDefined()
    expect(path.basename(result.backupPath!)).toMatch(/^settings\.json\.velar-backup-.+$/)
    expect(fs.readFileSync(result.backupPath!, 'utf8')).toBe(originalContent)
  })

  it('refuses to touch a settings.json that is not valid JSON', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(settingsPath(), '{ this is not valid json')

    expect(() => runInit(tmpDir)).toThrow()
    // Original broken file must be untouched.
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{ this is not valid json')
  })
})

describe('runInit — idempotency', () => {
  it('does not duplicate the Velar hook when run twice', () => {
    runInit(tmpDir)
    const second = runInit(tmpDir)

    expect(second.alreadyInstalled).toBe(true)

    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    expect(written.hooks.PreToolUse).toHaveLength(1)
  })

  it('does not create a second backup file on the idempotent second run', () => {
    runInit(tmpDir)
    const filesAfterFirst = fs.readdirSync(path.join(tmpDir, '.claude'))
    const second = runInit(tmpDir)
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
    runInit(tmpDir)
    const second = runInit(tmpDir)
    expect(second.alreadyInstalled).toBe(true)

    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    expect(written.hooks.PreToolUse).toHaveLength(2)
  })
})
