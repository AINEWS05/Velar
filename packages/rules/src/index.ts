import type { NormalizedOperation, RuleMatch } from '@velar-dev/shared'
import { RULES, type Rule, type RuleCategory } from './rules'

export type { Rule, RuleCategory } from './rules'
export { RULES } from './rules'

/**
 * Evaluates a normalized operation against the rule catalog (30 detection
 * rules across 6 categories, plus the env-example allow carve-out and the
 * default-allow fallback). Pure, synchronous, and intentionally cheap —
 * this is the "local judgement within 50ms" decision path. First matching
 * rule wins; RULES always ends with a catch-all allow rule, so this never
 * returns undefined.
 */
export function evaluate(operation: NormalizedOperation, rules: Rule[] = RULES): RuleMatch {
  for (const rule of rules) {
    if (rule.match(operation)) {
      return { ruleId: rule.id, riskLevel: rule.riskLevel }
    }
  }
  // Unreachable while RULES keeps its default-allow catch-all, but fail
  // safe to 'critical' rather than silently allowing if it's ever removed.
  return { ruleId: 'no-rule-matched-fail-safe', riskLevel: 'critical' }
}
