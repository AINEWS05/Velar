# @velar-dev/shared

Shared TypeScript types and Zod schemas used by [`@velar-dev/cli`](https://www.npmjs.com/package/@velar-dev/cli) and [`@velar-dev/rules`](https://www.npmjs.com/package/@velar-dev/rules) — normalized operation types, risk levels, and the wire-level event/approval schemas that enforce Velar's no-raw-data-sent contract (an explicit allow-list; any other field is rejected, not silently dropped).

This package is an internal dependency of `@velar-dev/cli` and `@velar-dev/rules` and isn't meant to be installed directly — see [`@velar-dev/cli`'s README](https://www.npmjs.com/package/@velar-dev/cli) for what Velar is and how it works.

## License

MIT — see [LICENSE](./LICENSE).
