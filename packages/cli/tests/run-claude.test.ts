import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runClaudeCommand, type SpawnFn } from '../src/commands/run-claude'

let tmpDir: string
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-run-test-'))
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  errorSpy.mockRestore()
})

function initProject() {
  fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, '.claude', 'settings.json'), '{}')
}

describe('runClaudeCommand — velar init precondition', () => {
  it('errors clearly and does not spawn anything when not initialized', () => {
    const spawn = vi.fn() as unknown as SpawnFn
    const code = runClaudeCommand([], tmpDir, spawn)
    expect(code).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('velar init'))
  })
})

describe('runClaudeCommand — claude binary missing', () => {
  it('gives a clear, actionable error when claude is not installed (ENOENT)', () => {
    initProject()
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    const spawn: SpawnFn = vi.fn().mockReturnValue({ error: enoent, status: null }) as unknown as SpawnFn

    const code = runClaudeCommand(['--version'], tmpDir, spawn)
    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('claude'))
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'))
  })
})

describe('runClaudeCommand — happy path', () => {
  it('spawns claude with forwarded args and inherited stdio', () => {
    initProject()
    const spawn = vi.fn().mockReturnValue({ status: 0 }) as unknown as SpawnFn

    const code = runClaudeCommand(['--foo', 'bar'], tmpDir, spawn)

    expect(code).toBe(0)
    expect(spawn).toHaveBeenCalledWith(
      'claude',
      ['--foo', 'bar'],
      expect.objectContaining({ stdio: 'inherit', cwd: tmpDir }),
    )
  })

  it('propagates a non-zero exit status from claude', () => {
    initProject()
    const spawn = vi.fn().mockReturnValue({ status: 3 }) as unknown as SpawnFn
    const code = runClaudeCommand([], tmpDir, spawn)
    expect(code).toBe(3)
  })
})
