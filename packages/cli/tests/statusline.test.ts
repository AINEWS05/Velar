import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInit } from '../src/settings-merge'
import { runUninstall } from '../src/uninstall'
import { installStatusLine, removeVelarStatusLine, resolveStatuslineText, isVelarStatuslineCommand } from '../src/statusline'
import { statuslineRenderCommand, statuslineInstallCommand } from '../src/commands/statusline'

let tmpDir: string
let vendorBaseDir: string
let vendorCliRoot: string
let logs: string[]
let errorLogs: string[]
let originalLog: typeof console.log
let originalError: typeof console.error

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-statusline-test-'))
  vendorBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-statusline-test-vendor-'))
  vendorCliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-statusline-test-fake-cli-'))
  fs.mkdirSync(path.join(vendorCliRoot, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(vendorCliRoot, 'package.json'),
    JSON.stringify({ name: '@velar-dev/cli', version: '0.0.0-test' }),
  )
  fs.writeFileSync(path.join(vendorCliRoot, 'dist', 'index.js'), '// fake cli entry\n')

  logs = []
  errorLogs = []
  originalLog = console.log
  originalError = console.error
  console.log = (msg: string) => logs.push(msg)
  console.error = (msg: string) => errorLogs.push(msg)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(vendorBaseDir, { recursive: true, force: true })
  fs.rmSync(vendorCliRoot, { recursive: true, force: true })
  console.log = originalLog
  console.error = originalError
})

const settingsLocalPath = () => path.join(tmpDir, '.claude', 'settings.local.json')

function init() {
  return runInit(tmpDir, { vendorBaseDir, vendorCliRoot })
}

describe('installStatusLine', () => {
  it('writes a fresh statusLine entry pointing at the vendored entry point', () => {
    const result = installStatusLine(tmpDir, { vendorBaseDir, vendorCliRoot })
    expect(result.status).toBe('installed')
    const settings = JSON.parse(fs.readFileSync(settingsLocalPath(), 'utf8'))
    expect(settings.statusLine.type).toBe('command')
    expect(isVelarStatuslineCommand(settings.statusLine.command)).toBe(true)
    expect(settings.statusLine.command).toContain('statusline')
  })

  it('is idempotent — running twice reports already-installed the second time, without a new backup', () => {
    installStatusLine(tmpDir, { vendorBaseDir, vendorCliRoot })
    const second = installStatusLine(tmpDir, { vendorBaseDir, vendorCliRoot })
    expect(second.status).toBe('already-installed')
  })

  it('preserves an existing Velar hook entry and any unrelated settings', () => {
    init() // installs the PreToolUse hook first
    fs.writeFileSync(
      settingsLocalPath(),
      JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsLocalPath(), 'utf8')), model: 'opus' }, null, 2),
    )
    installStatusLine(tmpDir, { vendorBaseDir, vendorCliRoot })
    const settings = JSON.parse(fs.readFileSync(settingsLocalPath(), 'utf8'))
    expect(settings.model).toBe('opus')
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.statusLine).toBeDefined()
  })

  it('refuses to overwrite a statusLine that is not Velar\'s own', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(
      settingsLocalPath(),
      JSON.stringify({ statusLine: { type: 'command', command: 'my-other-tool render' } }, null, 2),
    )
    const result = installStatusLine(tmpDir, { vendorBaseDir, vendorCliRoot })
    expect(result.status).toBe('conflict')
    if (result.status === 'conflict') {
      expect(result.existingCommand).toBe('my-other-tool render')
    }
    const settings = JSON.parse(fs.readFileSync(settingsLocalPath(), 'utf8'))
    expect(settings.statusLine.command).toBe('my-other-tool render') // untouched
  })

  it('overwrites a conflicting statusLine when force is passed', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(
      settingsLocalPath(),
      JSON.stringify({ statusLine: { type: 'command', command: 'my-other-tool render' } }, null, 2),
    )
    const result = installStatusLine(tmpDir, { force: true, vendorBaseDir, vendorCliRoot })
    expect(result.status).toBe('installed')
    const settings = JSON.parse(fs.readFileSync(settingsLocalPath(), 'utf8'))
    expect(isVelarStatuslineCommand(settings.statusLine.command)).toBe(true)
  })
})

describe('removeVelarStatusLine', () => {
  it('removes only a Velar-recognized statusLine command', () => {
    const { settings, removed } = removeVelarStatusLine({ statusLine: { type: 'command', command: 'node x statusline' } })
    expect(removed).toBe(true)
    expect(settings.statusLine).toBeUndefined()
  })

  it('leaves a non-Velar statusLine completely untouched', () => {
    const original = { statusLine: { type: 'command', command: 'my-other-tool render' } }
    const { settings, removed } = removeVelarStatusLine(original)
    expect(removed).toBe(false)
    expect(settings).toBe(original)
  })

  it('is a no-op when there is no statusLine at all', () => {
    const original = { model: 'opus' }
    const { settings, removed } = removeVelarStatusLine(original)
    expect(removed).toBe(false)
    expect(settings).toBe(original)
  })
})

describe('velar uninstall also removes a Velar-installed statusLine', () => {
  it('round-trips cleanly: install hook + statusline, uninstall, zero residue', () => {
    init()
    installStatusLine(tmpDir, { vendorBaseDir, vendorCliRoot })
    expect(fs.existsSync(settingsLocalPath())).toBe(true)

    const result = runUninstall(tmpDir)
    expect(result.removedStatusLine).toBe(true)
    expect(fs.existsSync(settingsLocalPath())).toBe(false)
  })

  it('never removes a statusLine belonging to another tool', () => {
    init()
    const settings = JSON.parse(fs.readFileSync(settingsLocalPath(), 'utf8'))
    settings.statusLine = { type: 'command', command: 'my-other-tool render' }
    fs.writeFileSync(settingsLocalPath(), JSON.stringify(settings, null, 2))

    const result = runUninstall(tmpDir)
    expect(result.removedStatusLine).toBe(false)
    const after = JSON.parse(fs.readFileSync(settingsLocalPath(), 'utf8'))
    expect(after.statusLine.command).toBe('my-other-tool render')
  })
})

describe('resolveStatuslineText', () => {
  it('stays silent when Velar is not installed in this project at all', () => {
    expect(resolveStatuslineText(tmpDir)).toBe('')
  })

  it('shows the monitoring badge once the hook is fully installed and verified', () => {
    init()
    expect(resolveStatuslineText(tmpDir)).toBe('🛡 Velar monitoring')
  })

  it('shows a degraded warning when the hook is registered but unverifiable (receipt missing)', () => {
    init()
    fs.rmSync(path.join(tmpDir, '.velar', 'install-receipt.json'))
    expect(resolveStatuslineText(tmpDir)).toContain('velar doctor')
  })
})

describe('statuslineRenderCommand', () => {
  it('prints the monitoring badge for an installed project, reading cwd from the stdin-style payload', () => {
    init()
    const code = statuslineRenderCommand('/nonexistent-fallback', { cwd: tmpDir })
    expect(code).toBe(0)
    expect(logs).toEqual(['🛡 Velar monitoring'])
  })

  it('prefers workspace.project_dir over a bare cwd field', () => {
    init()
    const code = statuslineRenderCommand('/nonexistent-fallback', {
      cwd: '/nonexistent-cwd',
      workspace: { project_dir: tmpDir },
    })
    expect(code).toBe(0)
    expect(logs).toEqual(['🛡 Velar monitoring'])
  })

  it('prints nothing for a project with no Velar install', () => {
    const code = statuslineRenderCommand(tmpDir, null)
    expect(code).toBe(0)
    expect(logs).toEqual([])
  })
})

describe('statuslineInstallCommand', () => {
  it('reports success and the settings path on a fresh install', () => {
    const code = statuslineInstallCommand(tmpDir, [], { vendorBaseDir, vendorCliRoot })
    expect(code).toBe(0)
    expect(logs.some((l) => l.includes('Added'))).toBe(true)
  })

  it('reports a conflict and a non-zero exit code without touching the file', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(
      settingsLocalPath(),
      JSON.stringify({ statusLine: { type: 'command', command: 'my-other-tool render' } }, null, 2),
    )
    const code = statuslineInstallCommand(tmpDir, [], { vendorBaseDir, vendorCliRoot })
    expect(code).toBe(1)
    expect(errorLogs.some((l) => l.includes('already has a different statusLine'))).toBe(true)
  })

  it('--force overwrites the conflicting entry', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(
      settingsLocalPath(),
      JSON.stringify({ statusLine: { type: 'command', command: 'my-other-tool render' } }, null, 2),
    )
    const code = statuslineInstallCommand(tmpDir, ['--force'], { vendorBaseDir, vendorCliRoot })
    expect(code).toBe(0)
    const settings = JSON.parse(fs.readFileSync(settingsLocalPath(), 'utf8'))
    expect(isVelarStatuslineCommand(settings.statusLine.command)).toBe(true)
  })
})
