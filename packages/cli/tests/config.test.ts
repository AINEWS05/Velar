import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveConfig, loadConfig, resolveApiBaseUrl } from '../src/config'

let tmpDir: string
const originalEnv = process.env.VELAR_API_URL

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-config-test-'))
  delete process.env.VELAR_API_URL
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (originalEnv === undefined) delete process.env.VELAR_API_URL
  else process.env.VELAR_API_URL = originalEnv
})

describe('saveConfig / loadConfig', () => {
  it('round-trips a config through the real filesystem', () => {
    saveConfig({ token: 'vlr_abc123', orgId: 'org_1' }, tmpDir)
    const loaded = loadConfig(tmpDir)
    expect(loaded).toMatchObject({ token: 'vlr_abc123', orgId: 'org_1' })
  })

  it('returns null when no config file exists', () => {
    expect(loadConfig(tmpDir)).toBeNull()
  })

  it('returns null when the file is not valid JSON', () => {
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{ not json')
    expect(loadConfig(tmpDir)).toBeNull()
  })

  it('writes the config file with restrictive (600) permissions on POSIX', () => {
    saveConfig({ token: 'vlr_abc123', orgId: 'org_1' }, tmpDir)
    if (process.platform === 'win32') return // POSIX mode bits don't map 1:1 on Windows
    const stat = fs.statSync(path.join(tmpDir, 'config.json'))
    expect(stat.mode & 0o777).toBe(0o600)
  })
})

describe('resolveApiBaseUrl', () => {
  it('prefers VELAR_API_URL env var over everything else', () => {
    process.env.VELAR_API_URL = 'https://env-override.example.com'
    expect(resolveApiBaseUrl({ token: 't', orgId: 'o', apiBaseUrl: 'https://config.example.com' })).toBe(
      'https://env-override.example.com',
    )
  })

  it('falls back to the config file value when no env var is set', () => {
    expect(resolveApiBaseUrl({ token: 't', orgId: 'o', apiBaseUrl: 'https://config.example.com' })).toBe(
      'https://config.example.com',
    )
  })

  it('falls back to the built-in default when neither is set', () => {
    expect(resolveApiBaseUrl(null)).toBe('http://localhost:4000')
  })
})
