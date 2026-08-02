import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { applySupportTableToReadme, renderSupportTableMarkdown } from '../src/docs/support-table'
import { CAPABILITY_MANIFEST, isCurrentlySupported } from '@velar-dev/shared'

const README_PATH = path.join(__dirname, '..', 'README.md')

describe('support table generation', () => {
  it('README.md contains the manifest-generated table verbatim (fails on hand-edit drift)', () => {
    const current = fs.readFileSync(README_PATH, 'utf8')
    const regenerated = applySupportTableToReadme(current)
    expect(regenerated).toBe(current)
  })

  it('lists every adapter in the manifest exactly once', () => {
    const table = renderSupportTableMarkdown()
    for (const adapter of CAPABILITY_MANIFEST) {
      const occurrences = table.split(adapter.displayName).length - 1
      expect(occurrences).toBe(1)
    }
  })

  it('Claude Code and Codex are currently supported (block/observe) — Cursor is not yet', () => {
    expect(isCurrentlySupported('claude-code')).toBe(true)
    expect(isCurrentlySupported('codex')).toBe(true)
    expect(isCurrentlySupported('cursor')).toBe(false)
  })
})
