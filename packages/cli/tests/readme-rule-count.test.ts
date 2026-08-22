/**
 * README.md states the rule count in prose ("Rules (39)", "30 + 9 = 39") —
 * numbers a human typed by hand, not generated. This test is the guard
 * against drift: it derives the real counts from `@velar-dev/rules`' own
 * `RULES` array and fails if README.md's stated numbers (or the specific
 * "9 special rules" list it names) ever stop matching reality.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { RULES } from '@velar-dev/rules'

const README_PATH = path.join(__dirname, '..', 'README.md')
const readme = fs.readFileSync(README_PATH, 'utf8')

// The 9 rules README.md documents as running outside the core 30-rule table
// (see its "Beyond the 30" section) — kept here, by id, so a change to
// either side (the rule catalog or this list) is caught as a mismatch
// rather than silently drifting apart.
const SPECIAL_RULE_IDS = [
  'mcp-destructive-tool-name',
  'mcp-secret-like-argument',
  'mcp-env-file-argument',
  'mcp-production-db-argument',
  'mcp-unknown-tool-default',
  'unclassified-tool-default',
  'web-target-secret-like',
  'velar-self-protection',
  'env-example-allow',
]

describe('README.md rule counts vs. @velar-dev/rules RULES array', () => {
  it('RULES has exactly one default-allow catch-all, excluded from every stated count', () => {
    const defaultAllow = RULES.filter((r) => r.id === 'default-allow')
    expect(defaultAllow).toHaveLength(1)
  })

  it('total detection rules (RULES minus default-allow) is 39', () => {
    const detectionRules = RULES.filter((r) => r.id !== 'default-allow')
    expect(detectionRules).toHaveLength(39)
  })

  it('the 9 special rules README.md names all still exist in RULES', () => {
    const ids = new Set(RULES.map((r) => r.id))
    for (const id of SPECIAL_RULE_IDS) {
      expect(ids.has(id)).toBe(true)
    }
  })

  it('30 core (categorized-table) rules + 9 special rules = 39, matching README.md', () => {
    const detectionRules = RULES.filter((r) => r.id !== 'default-allow')
    const coreRules = detectionRules.filter((r) => !SPECIAL_RULE_IDS.includes(r.id))
    expect(coreRules).toHaveLength(30)
    expect(coreRules.length + SPECIAL_RULE_IDS.length).toBe(39)
  })

  it('README.md states the total as 39, not a stale count', () => {
    expect(readme).toMatch(/## Rules \(39\)/)
    expect(readme).toContain('30 + 9 = 39')
    expect(readme).not.toMatch(/## Rules \(30\)/)
  })
})
