# Codex CLI PreToolUse hook — empirical verification (2026-07-31)

## Why this exists

Automated research (a subagent pass + WebSearch + WebFetch) produced three
mutually contradictory answers on whether Codex CLI's `PreToolUse` hook can
actually block an operation, or only observe it: "experimental, disabled by
default, Bash-only, no Windows" vs. "stable, covers apply_patch and MCP
tools, Windows supported" vs. "PR-fixed apply_patch coverage as of v0.146,
Windows recently hardened." None of these could be trusted for a safety
product's public capability claims, so this documents a direct, first-hand
test against a real installed Codex CLI instead of secondary sources.

## Environment

- Codex CLI `0.144.6`, Windows 11, standalone install
  (`~/.codex/packages/standalone/releases/0.144.6-x86_64-pc-windows-msvc`).
- `codex features list` (run directly): `hooks` feature is `stable` / `true`
  (enabled by default) — this alone contradicted the "disabled by default"
  claim from one secondary source.
- Test performed inside a scratch directory under an already-trusted
  private project root (removed after the test; never committed).

## Method

1. Wrote a project-local `.codex/hooks.json` registering a `PreToolUse`
   hook with `matcher: "*"`, `type: "command"`, pointing at a small Node.js
   probe script (`hook-probe.mjs`).
2. The probe script: on every invocation, appends the full JSON payload it
   receives on stdin to a marker log file, then **denies** via the
   documented mechanism (`process.exit(2)` + a reason on stderr).
3. Ran `codex exec --json` (non-interactive) with harmless prompts:
   - "Run this exact shell command: `echo <marker>`"
   - "Create a new file named `<name>` containing exactly: `<marker>`"
4. Repeated each case 2–5 times, inspecting both the `--json` event stream
   and the marker log to confirm the hook actually fired and to see whether
   the denial was honored.
5. `--dangerously-bypass-hook-trust` was required for the hook to fire at
   all under `codex exec` — without it, a brand-new project-local hook is
   silently not run (a sensible fail-closed default: an untrusted
   `hooks.json` dropped into a cloned repo shouldn't auto-execute).

## Results

| Tool call (Codex's own `tool_name`) | Hook fires? | Deny (`exit 2`) enforced? |
| --- | --- | --- |
| `Bash` (shell commands) | Yes, every time (5+/5+) | **No** — command ran anyway, `exit_code: 0`, real output captured, despite the hook denying it |
| `apply_patch` (file write) | Yes, every time (2/2) | **Yes** — `file_change` item status was `"failed"`, the file was genuinely never created, and the agent reported the write was denied |

The hook payload itself (`tool_name`, `tool_input`, `session_id`,
`transcript_path`, `permission_mode`, etc.) closely mirrors Claude Code's
own `PreToolUse` hook input shape — including the literal string
`"permission_mode":"bypassPermissions"`, a name shared with Claude Code's
own permission-mode vocabulary.

Every tested invocation carried `permission_mode: "bypassPermissions"`
regardless of `-c approval_policy=on-request` overrides — `codex exec`
appears to always run in this mode, since it's built for unattended
execution. This is very likely *why* Bash denial isn't honored there: with
approvals already bypassed, there's no gate left for a `PreToolUse` deny to
plug into for shell commands specifically, while file writes go through a
separate enforcement path that does still check the hook's decision.

## What was NOT verified (left `unsupported`, not assumed)

- **The interactive TUI session** (plain `codex`, what a normal user runs
  day to day) — could not be driven headlessly in this sandboxed shell
  (`codex doctor` itself reported `stdin/stdout is terminal: false` for
  this very shell). Its default approval policy (`on-request`) is different
  from `codex exec`'s forced `bypassPermissions`, so Bash denial may behave
  differently there. **Do not upgrade `bash` capability past `observe`
  without testing this path directly.**
- **`file_read`** — not exercised at all.
- **`git` / `deploy`** — Velar's rule catalog matches these against Bash
  command strings; in Codex's own tool model they very likely also surface
  as `tool_name: "Bash"` (there's no separate git/deploy tool), which would
  mean they inherit Bash's non-enforcement — but this is an inference, not
  a test, so both stay `unsupported` in the manifest per this project's
  "don't guess" rule for capability claims.

## Manifest values set from this

See `packages/shared/src/capability-manifest.ts` — `codex` status set to
`Preview`, `file_write: 'block'`, `bash: 'observe'`, everything else
`unsupported`.
