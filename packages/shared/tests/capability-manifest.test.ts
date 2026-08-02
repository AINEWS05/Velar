import { describe, it, expect } from 'vitest'
import {
  CAPABILITY_MANIFEST,
  getAdapterCapability,
  isCurrentlySupported,
  currentlySupportedAdapterIds,
  type ManifestActionType,
} from '../src/capability-manifest'

const ALL_ACTION_TYPES: ManifestActionType[] = ['file_read', 'file_write', 'bash', 'git', 'deploy']

describe('capability manifest', () => {
  it('every adapter declares a capability for every action type', () => {
    for (const adapter of CAPABILITY_MANIFEST) {
      for (const actionType of ALL_ACTION_TYPES) {
        expect(adapter.capabilities[actionType]).toBeDefined()
      }
    }
  })

  it('every adapter has a unique id', () => {
    const ids = CAPABILITY_MANIFEST.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('getAdapterCapability throws for an unknown id', () => {
    expect(() => getAdapterCapability('not-a-real-adapter' as never)).toThrow()
  })

  it('claude-code is GA and can block every action type', () => {
    const claudeCode = getAdapterCapability('claude-code')
    expect(claudeCode.status).toBe('GA')
    for (const actionType of ALL_ACTION_TYPES) {
      expect(claudeCode.capabilities[actionType]).toBe('block')
    }
  })

  it('cursor is Planned and unsupported for every action type today', () => {
    const adapter = getAdapterCapability('cursor')
    expect(adapter.status).toBe('Planned')
    for (const actionType of ALL_ACTION_TYPES) {
      expect(adapter.capabilities[actionType]).toBe('unsupported')
    }
  })

  it('codex is Preview: file_write blocks, bash only observes, everything else unsupported (empirically verified — see packages/cli/docs/design/codex-hook-verification.md)', () => {
    const codex = getAdapterCapability('codex')
    expect(codex.status).toBe('Preview')
    expect(codex.capabilities.file_write).toBe('block')
    expect(codex.capabilities.bash).toBe('observe')
    expect(codex.capabilities.file_read).toBe('unsupported')
    expect(codex.capabilities.git).toBe('unsupported')
    expect(codex.capabilities.deploy).toBe('unsupported')
  })

  it('isCurrentlySupported / currentlySupportedAdapterIds agree with each other', () => {
    const supported = currentlySupportedAdapterIds()
    for (const adapter of CAPABILITY_MANIFEST) {
      expect(supported.includes(adapter.id)).toBe(isCurrentlySupported(adapter.id))
    }
    expect(supported).toEqual(['claude-code', 'codex'])
  })
})
