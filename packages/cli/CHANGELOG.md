# Changelog

All notable changes to `@velar-dev/cli` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 0.4.0 — 2026-08-11

### Added

- **Browser-based login, merged into `velar init`.** `velar login` (and a fresh `velar init` with no account connected yet) now opens a browser to pair the CLI with your Velar account — no more copying a token out of the dashboard and pasting it into a prompt. Works by generating a random pairing session, opening `https://usevelar.com/cli-login/<session>` (falls back to printing the URL if a browser can't be opened), and polling until you click "Connect this CLI" there. In a non-interactive shell (CI, a piped/redirected invocation, no TTY) this is skipped automatically with a clear message instead of hanging — use `velar login --token <token> --org-id <org>` for scripted/CI use, or `velar login --manual` to be prompted for a token interactively instead of opening a browser. Local protection (the hook itself) has never depended on being logged in and still doesn't — an account only adds dashboard/team visibility.
- **`velar init` now proves protection on the spot.** At the end of a fresh install, `velar init` automatically runs the equivalent of `velar test` and prints a pass/fail table — 1 benign operation correctly allowed, one blocked case per rule category (6 total) — instead of just reporting that the hook was installed. A hook that's registered but silently failing (or not actually blocking anything) is worse than no hook at all; this makes that impossible to miss.
- **`velar statusline install`** — an opt-in live "🛡 Velar monitoring" segment for Claude Code's status line. Unlike a static label, it re-checks the hook installation on every render, so it goes silent or shows a warning the moment protection actually stops working, rather than just decorating the UI. Not wired into `velar init` automatically: Claude Code supports only one `statusLine` command at a time with no way to compose multiple tools' output, so auto-enabling it risked silently overwriting a statusLine you already had configured. Run it explicitly when you want it; `velar statusline install --force` overwrites an existing non-Velar statusLine if you're sure. `velar uninstall` removes a Velar-installed statusLine the same way it removes the hook.

### Upgrading

No security-relevant changes in this release — `velar doctor`'s version-currency check will still flag that a newer version is available, just without the `🔒 SECURITY UPDATE` framing 0.3.0 used. Run `npx @velar-dev/cli@latest init` in each project to pick up the new self-test-on-init and login-integration behavior (vendoring is version-pinned by design; publishing this package alone does nothing for a project until `init` is re-run there).

## 0.3.0 — 2026-08-01

### ⚠️ Behavior change you will see immediately: unrecognized tool calls now warn instead of silently passing through

**What changed:** Previously, any tool call `classify.ts` didn't have a dedicated rule for (this affected MCP tool calls first, and — before this release — also affected Claude Code's own built-in `WebFetch`/`WebSearch` tools, plus any future built-in tool Claude Code adds) was silently treated as an unmatched, no-signal operation and allowed without comment. As of 0.3.0, any such operation is classified `unclassified` and **always at least logged as a warning** — you'll start seeing lines like:

```
⚠ Velar: operation flagged as warn (unclassified-tool-default) — not blocked.
```

**Why:** This is not new caution for its own sake — it closes a real, previously-silent gap. An investigation found that MCP-routed tool calls fell through to default-allow with zero visibility; the same root cause turned out to also apply to `WebFetch`/`WebSearch` (and would apply to whatever built-in tool Claude Code ships next). Adding one more specific rule per tool only ever fixes the *last* gap found — `unclassified-tool-default` is the generalized fix that makes the *next* one warn instead of vanishing.

**What this does NOT do:** it does not block anything that wasn't already being silently allowed. `warn` means "logged, not stopped" — your existing workflows keep running exactly as before; you just now see it happening. General web browsing via `WebFetch`/`WebSearch` is explicitly never blocked (see below) — only a secret-shaped value in the destination URL/query is.

**If this is too noisy:** it isn't configurable to silence per se (by design — silence is exactly what caused the gap), but you can escalate the other direction: set `unclassifiedToolRisk: "critical"` (see below) if you want every unrecognized tool call to require approval instead of just warning.

### Added

- **`velar-self-protection` rule (critical)** — writes to Velar's own hook registration (`.claude/settings.json`/`settings.local.json`), the project-local `.velar/` directory (event log, install receipt, temp-allows), or the global `~/.velar/` directory (login token, vendored code) now require approval, the same as any other critical-risk operation. Previously nothing stopped an agent from silently rewriting its own hook config to disable Velar entirely — verified empirically before this fix (a plain `Edit` call emptying `.claude/settings.json` succeeded with zero resistance). This is a critical-risk (approval-required) rule, not a hard deny: you can still legitimately edit your own settings, and `npx velar init`/`velar uninstall` run via an agent's Bash tool are unaffected (their command text never contains a `.velar` path segment or a settings filename).
- **`web-target-secret-like` rule (critical)** — a secret-shaped value (API key prefix, Bearer token, `password=`/`token=`, etc.) embedded in a `WebFetch` URL or `WebSearch` query is now blocked. General web browsing is never affected.
- **`unclassifiedToolRisk` config** — generalizes the old `mcpUnknownToolRisk` into one knob covering both `mcp-unknown-tool-default` and `unclassified-tool-default`. Set to `"critical"` to require approval for every unrecognized tool call (MCP or otherwise) instead of just warning. The old `mcpUnknownToolRisk` field is still read as a fallback if present in an existing `~/.velar/config.json` — nothing breaks on upgrade.
- **`velar doctor`: hook-matcher-coverage check** — detects if the hook's `matcher` has been narrowed from `.*` to a subset of tools (e.g. only `Bash`), which would silently drop coverage for Read/Write/WebFetch/etc. even though the hook itself still "looks" registered.
- **`velar doctor`: version-currency check** — compares the installed (vendored) CLI version against the latest published `@velar-dev/cli` on npm and shows upgrade instructions when outdated. When the newer release fixes something security-relevant, the message is visually stronger (`🔒 SECURITY UPDATE AVAILABLE`). This check is best-effort: no network / registry-unreachable degrades to a soft warning, never a failure.
- **Subagent visibility** — when a Task-tool subagent (not the top-level session) issues a tool call, this is now recorded (`isSubagent: true` locally; a salted, non-reversible `subagentTypeHash` — never the raw subagent name — in the cloud-reported Action Envelope, matching the same privacy treatment MCP server/tool names already got).

### Fixed

- `WebFetch`/`WebSearch` (and any other unmatched built-in tool) no longer silently reaches `default-allow` — see the behavior-change note above. This is the same root cause as the MCP classification gap fixed in a prior release, generalized so it can't recur for the next new tool.
- Codex adapter: the same unmatched-tool-call gap existed in `classifyCodexPayload` and is fixed the same way.

### Upgrading

Existing installs stay on whatever version was vendored at their last `velar init` — publishing this package does nothing for a project until `velar init` is re-run there (vendoring is version-pinned by design). Run `npx @velar-dev/cli@latest init` in each project to actually pick up these fixes. `velar doctor`'s new version-currency check will tell you when this is needed going forward.

## 0.2.0 and earlier

See git history — this changelog starts at 0.3.0.
