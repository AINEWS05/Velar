# @velar-dev/rules

The local rule catalog powering [`@velar-dev/cli`](https://www.npmjs.com/package/@velar-dev/cli)'s pre-execution risk classification for AI coding agents.

## What is this package

`@velar-dev/rules` is a pure, dependency-light function: given a normalized operation (an operation type plus a file path or command string), it returns a rule ID and a risk level (`allow` / `warn` / `critical`). It never reads file content or prompt text — only operation metadata. See [`@velar-dev/cli`'s README](https://www.npmjs.com/package/@velar-dev/cli) for the full "what Velar sends vs. never sends" picture and how this fits into the PreToolUse hook flow.

## Usage

```ts
import { evaluate } from '@velar-dev/rules'

const result = evaluate({ operationType: 'file_read', path: '/repo/.env' })
// { ruleId: 'env-file-protection', riskLevel: 'critical' }
```

You can also evaluate against a custom rule subset (useful for testing):

```ts
import { evaluate, RULES, type Rule } from '@velar-dev/rules'

const onlySecretsRules: Rule[] = RULES.filter((r) => r.category === 'secrets')
evaluate(operation, onlySecretsRules)
```

## Rule catalog

39 detection rules total: 30 core rules across 6 categories (secrets, production_db, destructive_command, deploy, exfiltration, package_ci_config), plus MCP tool-call detection, WebFetch/WebSearch's secret-in-target check, Velar's own self-protection rule, and an `.env.example` allow carve-out — see `src/rules.ts`'s top-of-file comment for the exact breakdown. Also a `default-allow` fallback (not counted in the 39, since it's the absence of a match rather than a detection). Each `Rule` carries:

- `id` — stable identifier, e.g. `env-file-protection`
- `category` — one of the 6 categories above
- `name` — Japanese display name (dashboard)
- `pattern` — human-readable summary of what's matched (for docs; see `src/rules.ts` for the exact regex/logic)
- `riskLevel` — `allow` | `warn` | `critical`
- `reason` — Japanese explanation (Slack approval card)
- `reason_en` — English explanation

The full table with every rule's pattern and reason is documented in [`@velar-dev/cli`'s README](https://www.npmjs.com/package/@velar-dev/cli#rules-30).

## Rule ordering is part of the contract

`evaluate()` scans the catalog top-to-bottom and returns the **first** matching rule — this is deliberate, not an implementation detail. See the doc comment at the top of [`src/rules.ts`](./src/rules.ts) before reordering or inserting rules; [`tests/rules-phase3.test.ts`](./tests/rules-phase3.test.ts) enforces this ordering with regression guards.

## No-raw-data-sent contract

The 50ms local-judgement budget and the "metadata only, never content" contract are both covered by tests: [`tests/rules.test.ts`](./tests/rules.test.ts) and [`tests/rules-phase3.test.ts`](./tests/rules-phase3.test.ts) (includes the performance benchmark). The end-to-end wire-level enforcement of this contract (rejecting any field outside the allow-list) lives in `@velar-dev/cli`'s zero-knowledge-contract test suite (the real, internal name of that specific test file — see the [package page](https://www.npmjs.com/package/@velar-dev/cli)).

## Development

```bash
pnpm install
pnpm --filter @velar-dev/rules build
pnpm --filter @velar-dev/rules test
```

## License

MIT — see [LICENSE](./LICENSE).
