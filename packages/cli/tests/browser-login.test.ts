import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })) }))

import { spawn } from 'node:child_process'
import { generateSessionId, openBrowser, pollForApproval } from '../src/browser-login'

const mockSpawn = vi.mocked(spawn)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('generateSessionId', () => {
  it('returns a 64-character hex string (256 bits)', () => {
    const id = generateSessionId()
    expect(id).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns a different id on every call', () => {
    expect(generateSessionId()).not.toBe(generateSessionId())
  })
})

describe('openBrowser', () => {
  beforeEach(() => {
    mockSpawn.mockClear()
  })

  it('spawns the platform-appropriate opener without throwing', () => {
    expect(() => openBrowser('https://usevelar.com/cli-login/abc')).not.toThrow()
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it('never throws even if spawn itself throws', () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('no such platform opener')
    })
    expect(() => openBrowser('https://usevelar.com/cli-login/abc')).not.toThrow()
  })
})

describe('pollForApproval', () => {
  it('includes ?host=<hostname> on the polled URL when a hostname is given', async () => {
    let requestedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requestedUrl = url
        return { ok: true, json: async () => ({ success: true, status: 'approved', token: 'vlr_x', orgId: 'org_x' }) }
      }),
    )
    await pollForApproval('https://usevelar.com', 'session123', { hostname: 'my-laptop' })
    expect(requestedUrl).toBe('https://usevelar.com/api/cli-auth/session123?host=my-laptop')
  })

  it('URL-encodes a hostname with special characters', async () => {
    let requestedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requestedUrl = url
        return { ok: true, json: async () => ({ success: true, status: 'approved', token: 'vlr_x', orgId: 'org_x' }) }
      }),
    )
    await pollForApproval('https://usevelar.com', 'session123', { hostname: "My Laptop's Name" })
    expect(requestedUrl).toContain('?host=My%20Laptop')
  })

  it('omits ?host= entirely when hostname is explicitly null', async () => {
    let requestedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requestedUrl = url
        return { ok: true, json: async () => ({ success: true, status: 'approved', token: 'vlr_x', orgId: 'org_x' }) }
      }),
    )
    await pollForApproval('https://usevelar.com', 'session123', { hostname: null })
    expect(requestedUrl).toBe('https://usevelar.com/api/cli-auth/session123')
  })

  it('resolves with the token/orgId once the server reports approved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true, status: 'approved', token: 'vlr_realtoken', orgId: 'org_1' }),
      })),
    )
    const result = await pollForApproval('https://usevelar.com', 'session123', { hostname: null })
    expect(result).toEqual({ token: 'vlr_realtoken', orgId: 'org_1' })
  })

  it('resolves "denied" when the server reports denied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, status: 'denied' }) })))
    const result = await pollForApproval('https://usevelar.com', 'session123', { hostname: null })
    expect(result).toBe('denied')
  })

  it('resolves "expired" when the server reports expired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, status: 'expired' }) })))
    const result = await pollForApproval('https://usevelar.com', 'session123', { hostname: null })
    expect(result).toBe('expired')
  })

  it('keeps polling through pending statuses, then resolves once approved', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++
        if (call < 3) return { ok: true, json: async () => ({ success: true, status: 'pending' }) }
        return { ok: true, json: async () => ({ success: true, status: 'approved', token: 'vlr_x', orgId: 'org_x' }) }
      }),
    )
    const result = await pollForApproval('https://usevelar.com', 'session123', { hostname: null, intervalMs: 1 })
    expect(result).toEqual({ token: 'vlr_x', orgId: 'org_x' })
    expect(call).toBe(3)
  })

  it('survives a transient network error and keeps retrying until the deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET')
      }),
    )
    const result = await pollForApproval('https://usevelar.com', 'session123', {
      hostname: null,
      intervalMs: 1,
      timeoutMs: 10,
    })
    expect(result).toBe('timeout')
  })

  it('resolves "timeout" when the deadline passes with no approval', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, status: 'pending' }) })))
    const result = await pollForApproval('https://usevelar.com', 'session123', {
      hostname: null,
      intervalMs: 1,
      timeoutMs: 10,
    })
    expect(result).toBe('timeout')
  })

  it('defaults to the real os.hostname() when the option is omitted entirely', async () => {
    let requestedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requestedUrl = url
        return { ok: true, json: async () => ({ success: true, status: 'approved', token: 'vlr_x', orgId: 'org_x' }) }
      }),
    )
    await pollForApproval('https://usevelar.com', 'session123')
    // Whatever this machine's real hostname is, SOME ?host= param should be present
    // (unless os.hostname() itself is empty, which never happens in practice).
    expect(requestedUrl).toContain('?host=')
  })
})
