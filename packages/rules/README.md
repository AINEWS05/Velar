# @velar/rules

The local rule catalog powering [`@velar/cli`](https://www.npmjs.com/package/@velar/cli)'s pre-execution risk classification for AI coding agents.

## What is this package

`@velar/rules` is a pure, dependency-light function: given a normalized operation (an operation type plus a file path or command string), it returns a rule ID and a risk level (`allow` / `warn` / `critical`). It never reads file content or prompt text — only operation metadata. See [`@velar/cli`'s README](https://www.npmjs.com/package/@velar/cli) for the full "what Velar sends vs. never sends" picture and how this fits into the PreToolUse hook flow.

## Usage

```ts
import { evaluate } from '@velar/rules'

const result = evaluate({ operationType: 'file_read', path: '/repo/.env' })
// { ruleId: 'env-file-protection', riskLevel: 'critical' }
```

You can also evaluate against a custom rule subset (useful for testing):

```ts
import { evaluate, RULES, type Rule } from '@velar/rules'

const onlySecretsRules: Rule[] = RULES.filter((r) => r.category === 'secrets')
evaluate(operation, onlySecretsRules)
```

## Rule catalog

30 detection rules across 6 categories (secrets, production_db, destructive_command, deploy, exfiltration, package_ci_config), plus an `.env.example` allow carve-out and a default-allow fallback. Each `Rule` carries:

- `id` — stable identifier, e.g. `env-file-protection`
- `category` — one of the 6 categories above
- `name` — Japanese display name (dashboard)
- `pattern` — human-readable summary of what's matched (for docs; see `src/rules.ts` for the exact regex/logic)
- `riskLevel` — `allow` | `warn` | `critical`
- `reason` — Japanese explanation (Slack approval card)
- `reason_en` — English explanation

The full table with every rule's pattern and reason is documented in [`@velar/cli`'s README](https://www.npmjs.com/package/@velar/cli#rules-30).

## Rule ordering is part of the contract

`evaluate()` scans the catalog top-to-bottom and returns the **first** matching rule — this is deliberate, not an implementation detail. See the doc comment at the top of [`src/rules.ts`](./src/rules.ts) before reordering or inserting rules; [`tests/rules-phase3.test.ts`](./tests/rules-phase3.test.ts) enforces this ordering with regression guards.

## Zero-knowledge contract

The 50ms local-judgement budget and the "metadata only, never content" contract are both covered by tests: [`tests/rules.test.ts`](./tests/rules.test.ts) and [`tests/rules-phase3.test.ts`](./tests/rules-phase3.test.ts) (includes the performance benchmark). The end-to-end wire-level enforcement of this contract (rejecting any field outside the allow-list) lives in `@velar/cli`'s [zero-knowledge-contract test suite](https://www.npmjs.com/package/@velar/cli).

## Development

```bash
pnpm install
pnpm --filter @velar/rules build
pnpm --filter @velar/rules test
```

## License

MIT — see [LICENSE](./LICENSE).
