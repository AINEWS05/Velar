# CLI test matrix — 4a-1

What's covered, by which test file, and what's explicitly NOT covered by
automated tests in this environment (Windows-only CI machine — no macOS/Linux
runner available here).

## Commands × scenarios

| Scenario | init | doctor | test | uninstall |
|---|---|---|---|---|
| Fresh project, nothing exists yet | `settings-merge.test.ts` | `doctor.test.ts` | `velar-test.test.ts` | `uninstall.test.ts` |
| `settings.local.json` exists, has unrelated content | `settings-merge.test.ts` | — (same code path as fresh) | — | `uninstall.test.ts` |
| `settings.local.json` exists, has a stale (pre-current-version) Velar entry | `settings-merge.test.ts` | — | — | — |
| `settings.local.json` exists, has a pre-0.2.0 bare `velar hook pre-tool-use` entry | `settings-merge.test.ts` | `doctor.test.ts` | — | — |
| Velar entry only in the legacy shared `settings.json` (pre-4a install) | `settings-merge.test.ts` (migrates it out) | `doctor.test.ts` (warns) | — | `uninstall.test.ts` |
| `settings.json` and `settings.local.json` both exist, only one has Velar | `settings-merge.test.ts` | — | — | `uninstall.test.ts` |
| No install receipt (deleted, or truly pre-4a with no upgrade run yet) | — | `doctor.test.ts` (skips execution, warns — does not blindly execute) | `velar-test.test.ts` (fails both cases, explains why) | — |
| Install receipt present but stale (doesn't match registered command) | — | `doctor.test.ts` | — | — |
| Hook target fingerprint tampered/corrupted | `hook-selftest.test.ts` (`verifyHookTrust`) | `doctor.test.ts` (via injected trust-erroring selfTest) | `velar-test.test.ts` | — |
| Hook target path outside the trusted vendor root | `hook-selftest.test.ts` | — | — | — |
| Full round trip against the REAL built CLI, fresh `$HOME` | `clean-room-roundtrip.test.ts` — init → doctor → test → uninstall, asserts the project directory is byte-identical before/after (zero residue), and that `$HOME/.velar/vendor/` is the one intentional survivor | | | |
| npx / global / local install method differences | Covered structurally by `vendor.test.ts`'s dependency-closure walk (same code path regardless of how `velar` itself was invoked) — not re-verified per install method in 4a-1; this was the focus of the P0-1 session's E2E work (`npx init` → real production Slack block, confirmed then). Not re-run here since nothing in 4a-1 touches the vendoring/install-method logic itself beyond what's covered above. | | | |

## Explicitly not covered here

- **macOS / Linux execution.** This environment is Windows-only. `path.sep`,
  `isPathInside()`, and the shell-quoting in `vendor.ts` are written to be
  platform-neutral and are exercised on Windows paths throughout, but no
  test in this matrix has actually run on POSIX. Flag for CI once a
  Linux/macOS runner is available for this package.
- **Concurrent `velar init` runs** (two processes racing to write
  `settings.local.json` at once). Not tested; `fs.writeFileSync` is not
  atomic across processes. Low real-world likelihood (a human runs `init`
  once), noting as a residual risk rather than blocking 4a-1 on it.
- **Multi-GB or permission-denied vendor directories** (disk-full,
  read-only `$HOME`). `vendorCli()`/`writeInstallReceipt()` let `fs` errors
  propagate rather than swallowing them; `initCommand()`'s top-level
  try/catch turns that into a clean `✖ velar init failed: ...` message and
  exit 1, but no test asserts this specific path.
