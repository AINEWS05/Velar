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

## What was NOT verified as of 2026-07-31 (left `unsupported`, not assumed)

- ~~The interactive TUI session~~ — **verified 2026-08-21, see below.**
- **`file_read`** — still not exercised at all.
- **`git` / `deploy`** — Velar's rule catalog matches these against Bash
  command strings; in Codex's own tool model they very likely also surface
  as `tool_name: "Bash"` (there's no separate git/deploy tool), which would
  mean they inherit Bash's non-enforcement — but this is an inference, not
  a test, so both stay `unsupported` in the manifest per this project's
  "don't guess" rule for capability claims.

## Manifest values set from this (2026-07-31 pass)

See `packages/shared/src/capability-manifest.ts` — `codex` status set to
`Preview`, `file_write: 'block'`, `bash: 'observe'`, everything else
`unsupported`.

---

# Interactive TUI verification (2026-08-21)

## Why this exists

The 2026-07-31 pass above explicitly left the interactive `codex` session
(plain `codex`, no subcommand — what a normal user runs day to day)
unverified: it couldn't be driven headlessly in that sandboxed shell, and
its default approval policy (`on-request`) differs from `codex exec`'s
forced `bypassPermissions`, so Bash denial might plausibly behave
differently. This closes that gap with a direct, first-hand test instead
of continuing to infer from the exec-mode result.

## Environment

- Codex CLI `0.144.6`, Windows 11, same standalone install as the 2026-07-31
  pass.
- The interactive TUI refuses to start at all without a real terminal —
  confirmed empirically: running plain `codex` in this session's normal
  (piped, non-TTY) shell printed `Error: stdin is not a terminal` and
  exited immediately. Driving it required an actual pseudo-terminal.
- Used [`node-pty`](https://www.npmjs.com/package/node-pty) (installed in
  an isolated scratch directory, never added to this repo's dependencies)
  to spawn `codex.exe` under a real Windows ConPTY. Re-ran `codex doctor`
  under the same harness first to confirm the terminal is now genuinely
  detected: `stdin is terminal: true`, `stdout is terminal: true`, `stderr
  is terminal: true` (all `false` outside the PTY). This is the same
  technique real CI systems use to test TUIs; a plain piped shell cannot
  drive this tool at all.
- Test performed in a scratch directory outside this repository (removed
  after the test; never committed), with the same `.codex/hooks.json` /
  probe-script setup as the 2026-07-31 pass (`matcher: "*"`, a Node.js
  script that logs the full hook payload to a file and denies via
  `process.exit(2)`).
- The initial user prompt was passed as `codex "<prompt>"` (a CLI
  argument), not typed interactively, to keep the scripted part of the
  test minimal; all *subsequent* interaction (dialog responses) was real
  keystrokes sent to the live PTY, with the screen captured after each one
  to decide the next keystroke — this was not a single blind script: an
  early attempt that blindly sent a fixed key sequence without reading the
  screen state in between actually triggered Codex's own self-update
  dialog by accident (a stray Enter landed on an unrelated "Update
  available, press Enter to install" prompt). No update was actually
  applied — the process was killed mid-download and `codex --version`
  confirmed `0.144.6` unchanged afterward — but it's the reason every
  subsequent run here reads the screen before deciding what to send next,
  rather than sending a fixed sequence blind.

## Result 1 — two extra trust gates that `codex exec` does not have

Launching `codex` fresh in an untrusted directory shows, in order:

1. **Directory trust**: `Do you trust the contents of this directory?
   Working with untrusted contents comes with higher risk of prompt
   injection. Trusting the directory allows project-local config, hooks,
   and exec policies to load.` — options `1. Yes, continue` / `2. No,
   quit`, default-highlighted on option 1, confirmed with Enter.
2. **Hook review** (separate from directory trust — a new/changed hook
   still triggers this even in an already-trusted directory): `Hooks need
   review — 1 hook is new or changed. Hooks can run outside the sandbox
   after you trust them.` — options `1. Review hooks` (default-highlighted;
   opens a detail screen listing every lifecycle hook event and how many
   are installed/active/need review) / `2. Trust all and continue` / `3.
   Continue without trusting (hooks won't run)`. The detail screen's own
   footer states the actual keybinding plainly: **`Press t to trust all;
   enter to review hooks; esc to close`** — numeric keys `1`/`2`/`3` do
   *not* select the option directly in this dialog (confirmed: sending
   `"2"` did nothing, sending `t` worked).

Both choices persist per-directory across separate `codex` launches (a
second run in the same directory skipped straight past both dialogs).
`codex exec` has neither gate — it silently runs with no hook at all
unless `--dangerously-bypass-hook-trust` is passed, with no equivalent
interactive review step even when that flag is used.

## Result 2 — Bash: hook fires, deny still not enforced (same as `codex exec`)

With the hook trusted, prompting `Run this exact shell command: echo
VELAR_TUI_PROBE_BASH_3` produced (raw transcript, `probe-log.jsonl` entry
included for the actual hook payload):

```
• Running echo VELAR_TUI_PROBE_BASH_3
• PreToolUse hook (failed)
  error: hook exited with code 1
• Running echo VELAR_TUI_PROBE_BASH_3
• Ran echo VELAR_TUI_PROBE_BASH_3
  └ VELAR_TUI_PROBE_BASH_3
```

The probe script's logged payload confirms the hook fired and denied
(`process.exit(2)`, as in the 2026-07-31 pass), with
`"permission_mode":"default"` — a genuinely different value from `codex
exec`'s always-`"bypassPermissions"`. Despite that different mode string,
the outcome is identical: the command ran and its real output appears in
the transcript. No approval prompt of any kind was shown for this command
before it ran — a plain `echo` apparently needs no sandbox escalation, so
there was no human gate for the hook's denial to plug into here either.
**Bash stays `observe`, now cross-verified rather than inferred to
generalize from exec mode.**

(Note: Codex's own UI displays "hook exited with code 1" though the probe
process itself calls `process.exit(2)`, matching the same deny convention
used in the 2026-07-31 exec-mode pass, where Codex's JSON event stream did
reflect the real exit code. This looks like Codex normalizing hook
failures to a category code for TUI display rather than showing the raw
exit code, but this project's file could not independently confirm that
mapping — the point stands either way: the hook's failure is recognized
and displayed, and Bash execution proceeds regardless.)

## Result 3 — apply_patch: enforced by default, but with a human-overridable escape hatch `codex exec` doesn't have

Prompting `Create a new file named velar_probe_write.txt containing
exactly this text: VELAR_TUI_PROBE_WRITE_1` triggered the hook, which
denied. Left unanswered, the agent **retried the same write repeatedly**
(observed 5+ times across a 55-second window) — every retry hit the same
hook, was denied the same way, and the file was never created
(`ls`-confirmed absent afterward). This matches `codex exec`'s clean
`'block'` result: enforced by default, repeatable, no accidental leakage.

But each retry surfaced the same interactive prompt — one `codex exec`
cannot show, since nothing there is unattended:

```
  Would you like to make the following edits?
  Reason: command failed; retry without sandbox?

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files (a)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel
```

This is framed as a **generic sandbox-failure recovery prompt** — nothing
in the wording says a security hook denied this operation. Option 1 is
default-highlighted, so a bare Enter selects it. In a follow-up run, doing
exactly that (waiting for this prompt, then sending Enter) — **the file
WAS created**, containing exactly the requested text. The hook's denial
was real, but a human who reflexively confirms this prompt (which looks
identical to any other "retry without sandbox" recovery dialog) genuinely
bypasses it.

**`file_write` stays `'block'`** — that's the correct default, enforced,
outcome — but this is now documented as a real override path in
`capability-manifest.ts`'s `notes.file_write`, specific to the interactive
TUI. Nothing analogous exists in `codex exec`.

## Manifest values updated from this pass

`packages/shared/src/capability-manifest.ts` and its mirror in
`apps/web/lib/velar-api/capability-manifest.ts` — `codex`'s `bash` and
`file_write` levels are unchanged (`'observe'` / `'block'`), now backed by
two independent test passes instead of one, with `notes.bash` and
`notes.file_write` added to capture what a single enum value can't:
interactive-TUI-specific behavior and the human-overridable escape hatch
on `file_write`. `file_read`, `git`, `deploy` remain `'unsupported'` —
still not directly tested in either mode.
