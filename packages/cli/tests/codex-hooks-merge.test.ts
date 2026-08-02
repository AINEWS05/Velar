import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCodexInit } from '../src/codex-hooks-merge'
import { readInstallReceipt, CODEX_RECEIPT_FILE_NAME } from '../src/install-receipt'

let tmpDir: string
let vendorBaseDir: string
let vendorCliRoot: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-codex-cli-test-'))
  vendorBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-codex-cli-test-vendor-'))
  vendorCliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-codex-cli-test-fake-cli-'))
  fs.mkdirSync(path.join(vendorCliRoot, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(vendorCliRoot, 'package.json'), JSON.stringify({ name: '@velar-dev/cli', version: '0.0.0-test' }))
  fs.writeFileSync(path.join(vendorCliRoot, 'dist', 'index.js'), '// fake cli entry for codex-hooks-merge tests\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(vendorBaseDir, { recursive: true, force: true })
  fs.rmSync(vendorCliRoot, { recursive: true, force: true })
})

function hooksPath() {
  return path.join(tmpDir, '.codex', 'hooks.json')
}

function init(dir: string = tmpDir) {
  return runCodexInit(dir, { vendorBaseDir, vendorCliRoot })
}

describe('runCodexInit — creating hooks.json', () => {
  it('creates .codex/hooks.json with an absolute, vendored hook command pointing at codex-pre-tool-use', () => {
    const result = init()
    expect(result.created).toBe(true)
    expect(result.alreadyInstalled).toBe(false)
    expect(result.upgraded).toBe(false)
    expect(fs.existsSync(hooksPath())).toBe(true)

    const written = JSON.parse(fs.readFileSync(hooksPath(), 'utf8'))
    expect(written.hooks.PreToolUse).toHaveLength(1)
    const handler = written.hooks.PreToolUse[0].hooks[0]
    expect(handler.command).toBe(result.hookCommand)
    expect(handler.commandWindows).toBe(result.hookCommand)
    expect(handler.command.endsWith('hook codex-pre-tool-use')).toBe(true)
  })

  it('writes a Codex-specific install receipt, separate from the Claude one', () => {
    const result = init()
    const receipt = readInstallReceipt(path.join(tmpDir, '.velar'), CODEX_RECEIPT_FILE_NAME)
    expect(receipt).not.toBeNull()
    expect(receipt?.settingsPath).toBe(result.hooksPath)
    expect(fs.existsSync(path.join(tmpDir, '.velar', 'install-receipt.json'))).toBe(false)
  })
})

describe('runCodexInit — idempotency', () => {
  it('running twice does not duplicate the hook entry', () => {
    init()
    const result = init()
    expect(result.alreadyInstalled).toBe(true)
    const written = JSON.parse(fs.readFileSync(hooksPath(), 'utf8'))
    expect(written.hooks.PreToolUse).toHaveLength(1)
    expect(written.hooks.PreToolUse[0].hooks).toHaveLength(1)
  })
})

describe('runCodexInit — preserves unrelated hook config', () => {
  it('keeps other PreToolUse handlers and other event types untouched', () => {
    fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true })
    fs.writeFileSync(
      hooksPath(),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'some-other-tool --check' }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo session-start' }] }],
        },
      }),
    )

    const result = init()
    expect(result.created).toBe(false)
    const written = JSON.parse(fs.readFileSync(hooksPath(), 'utf8'))
    expect(written.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'echo session-start' }] }])
    expect(written.hooks.PreToolUse).toHaveLength(2)
    const otherGroup = written.hooks.PreToolUse.find((g: { matcher: string }) => g.matcher === 'Bash')
    expect(otherGroup.hooks[0].command).toBe('some-other-tool --check')
  })
})

describe('runCodexInit — upgrade across versions', () => {
  it('replaces a stale Velar handler in place rather than duplicating it', () => {
    fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true })
    fs.writeFileSync(
      hooksPath(),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: '/old/vendor/path/index.js hook codex-pre-tool-use', commandWindows: '/old/vendor/path/index.js hook codex-pre-tool-use' }] },
          ],
        },
      }),
    )

    const result = init()
    expect(result.upgraded).toBe(true)
    expect(result.backupPath).toBeTruthy()
    expect(fs.existsSync(result.backupPath!)).toBe(true)
    const written = JSON.parse(fs.readFileSync(hooksPath(), 'utf8'))
    expect(written.hooks.PreToolUse).toHaveLength(1)
    expect(written.hooks.PreToolUse[0].hooks).toHaveLength(1)
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe(result.hookCommand)
  })
})

describe('runCodexInit — refuses to touch invalid JSON', () => {
  it('throws rather than overwriting a hooks.json that is not valid JSON', () => {
    fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true })
    fs.writeFileSync(hooksPath(), '{ this is not json')
    expect(() => init()).toThrow(/not.*valid JSON|有効なJSON/)
    expect(fs.readFileSync(hooksPath(), 'utf8')).toBe('{ this is not json')
  })
})
