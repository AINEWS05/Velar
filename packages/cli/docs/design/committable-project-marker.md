# Design note: a committable "this project requires Velar" marker

**Status: design only.** Not implemented in 4a-1. Earliest reasonable
implementation point is 4a-3 (Adapter Capability Manifest), since the marker's
`requiredRules`/`minVersion` fields want to reference the same
capability/version vocabulary that work introduces.

## Problem

4a-1 moves the hook registration from `.claude/settings.json` (shared, git-
committed) to `.claude/settings.local.json` (per-machine, conventionally
git-ignored) — necessary, because the hook command embeds an absolute path
into a per-machine vendored CLI copy that would be silently wrong on anyone
else's machine if committed.

But that means **protection is now entirely local state**. A teammate who
clones a Velar-protected repo gets zero protection until they personally run
`velar init` — and nothing tells them they should. The previous
(settings.json-based) design at least had the property that cloning the repo
cloned the hook registration, even though the actual command inside it was
broken for anyone but the original installer.

## Proposed shape

A small, deliberately non-machine-specific file, committed to the repo:

```jsonc
// .velar/project.json — committed, not .gitignored
{
  "schemaVersion": 1,
  "requiredRules": ["env-file-protection", "rm-rf-risky-path", "..."],
  // or, more simply for a v1: just "protected": true, with the rule set
  // implicitly "whatever this CLI version's default catalog is" — avoids
  // needing to keep this file in sync with packages/rules by hand.
  "minVersion": "0.2.0",
  "addedAt": "2026-07-31T00:00:00.000Z",
  "addedBy": "alice@example.com"  // informational only, not an auth mechanism
}
```

Nothing here is machine-specific: no absolute paths, no vendored-copy
references, no fingerprints. It's safe and meaningful to commit.

### What reads it

- **`velar doctor`** (and, on session start, `run claude`): if
  `.velar/project.json` exists but there's no working hook currently
  registered for this project (no matching `settings.local.json` entry, or
  the entry fails its self-test), print a clear, hard-to-miss warning —
  "this project declares itself Velar-protected, but protection is NOT
  currently active on this machine — run `velar init`." This is the
  actual point of the marker: closing the gap where a teammate has no idea
  they're expected to run `init`.
- **`velar init`**: if `.velar/project.json` exists, read `requiredRules`
  (if present) and use it to decide what to install/verify, rather than
  silently defaulting to "the whole catalog, whatever it is this version."
  Gives a project a way to say "we specifically require the secrets-related
  rules" without every contributor needing to know that out of band.
- **Nothing else** reads or trusts it for anything security-relevant. It is
  purely a *signal*, never a *credential* — a hand-edited or missing
  `.velar/project.json` must never be treated as proof that protection is
  (or isn't) real; `velar doctor`'s actual hook self-test remains the only
  source of truth for "is this machine currently protected."

### Why this doesn't reintroduce the settings.json problem

The whole reason settings.json was wrong for the hook entry is that it
contains a *machine-specific absolute path* that breaks for other people.
`.velar/project.json` contains no such thing — it's a flag plus a rule-name
list, both of which are identical no matter who reads them or on what
machine. That's the dividing line to hold going forward: **anything
machine-specific stays in settings.local.json; anything project-wide and
portable can go in a committed `.velar/` file.**

### Open questions for 4a-3

- Exact `requiredRules` format — rule IDs (coupled to `@velar-dev/rules`'
  internal naming) vs. a category-level ("secrets", "destructive-commands")
  abstraction that's more stable across rule catalog changes.
- Whether `velar doctor`'s "not protected but should be" warning needs a
  way to be silenced for someone who's deliberately opted out on their own
  machine (e.g. `VELAR_SKIP_PROJECT_MARKER=1`), vs. always nagging.
- Whether CI should be able to assert "every contributor's local checkout
  that touches this repo has Velar active" — almost certainly out of scope
  (CI can't observe a contributor's laptop), but worth explicitly deciding
  it's out of scope rather than leaving it ambiguous.
