# Changelog

All notable changes to `@velar-dev/rules` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 0.3.0 — 2026-08-01

Released together with `@velar-dev/cli@0.3.0` — see [its CHANGELOG](https://www.npmjs.com/package/@velar-dev/cli?activeTab=readme) for the full user-facing behavior change (unrecognized tool calls now warn instead of silently allowing).

### Added

- `velar-self-protection` (critical, evaluated first) — blocks (pending approval) writes to Velar's own hook registration and vendored code.
- `web-target-secret-like` (critical) — a secret-shaped value embedded in a WebFetch URL or WebSearch query.
- `unclassified-tool-default` (warn, unconditional catch-all) — the generalized form of the existing `mcp-unknown-tool-default`: any operation with `operationType: 'unclassified'` is now always at least warned on.

None of these three count toward the "30 rules / 6 categories" catalog (same treatment as the 5 `mcp-*` rules) — see `src/rules.ts` for the full rationale.

## 0.2.0 and earlier

See git history — this changelog starts at 0.3.0.
