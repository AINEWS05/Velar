# Velar

Pre-execution approval for AI coding agents. Velar blocks dangerous operations before they run — and sees nothing else.

This repo is a small pnpm workspace with two published packages:

- **[`packages/cli`](./packages/cli)** — the `velar` CLI. Start here: [what Velar is, quick start, what it sends vs. never sends, the full rule table](./packages/cli/README.md).
- **[`packages/rules`](./packages/rules)** — the local rule catalog (`@velar/rules`) that `@velar/cli` depends on.
- **[`packages/shared`](./packages/shared)** — shared types and wire schemas used by both.

## Quick start

```bash
npx @velar/cli init
```

See [`packages/cli/README.md`](./packages/cli/README.md) for the full 60-second walkthrough.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

## License

MIT — see [LICENSE](./LICENSE).
