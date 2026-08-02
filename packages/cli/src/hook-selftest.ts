import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fingerprintFile } from './vendor'

export interface HookSelfTestResult {
  /** true iff the command spawned and exited 0, i.e. behaved exactly like a benign, allowed file read. */
  ok: boolean
  exitCode: number | null
  elapsedMs: number
  stderr: string
  /** set when the command could not even be spawned (e.g. ENOENT) */
  spawnError?: string
  /** set when the fingerprint/containment check failed BEFORE anything was executed. */
  trustError?: string
}

export interface HookSelfTestTarget {
  executable: string
  args: string[]
  /** The file actually being executed (by convention args[0]) — must live inside vendorRoot. */
  entryPath: string
  /** Root of the vendored install this entry is expected to belong to. */
  vendorRoot: string
  /** sha256 recorded at install time — re-checked now, before executing anything. */
  expectedFingerprint: string
}

/**
 * A synthetic PreToolUse payload for a plain read of a path that matches no
 * rule — deterministically classifies as risk "allow", so the self-test
 * never blocks, never prompts, and never waits on Slack.
 */
const SELF_TEST_PAYLOAD = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: 'velar-self-test-placeholder.txt' },
})

/**
 * A synthetic PreToolUse payload for a critical-risk operation (reading a
 * real .env file). Used by `velar test` to prove the hook actually BLOCKS,
 * not just that it runs — evaluated with VELAR_HOOK_SELF_TEST=1, which
 * short-circuits the approval flow (no real terminal prompt, no real Slack
 * wait) and returns the block decision (exit 2) immediately. See
 * hookPreToolUseCommand's self-test short-circuit.
 */
const CRITICAL_SELF_TEST_PAYLOAD = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: '.env.production' },
})

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Verifies a hook target is trustworthy BEFORE executing anything:
 *   1. entryPath must resolve to somewhere inside vendorRoot (the directory
 *      `velar init` itself vendored into) — never execute an arbitrary path
 *      that happens to be recorded somewhere.
 *   2. entryPath's current sha256 must match what was fingerprinted at
 *      install time — catches tampering, corruption, or a partial/interrupted
 *      vendor copy between install and now.
 * Returns an error string to surface if either check fails, or null if the
 * target is safe to execute.
 */
export function verifyHookTrust(target: HookSelfTestTarget): string | null {
  const resolvedEntry = path.resolve(target.entryPath)
  const resolvedRoot = path.resolve(target.vendorRoot)
  if (!isPathInside(resolvedRoot, resolvedEntry)) {
    return `拒否: ${resolvedEntry} は信頼済みvendorディレクトリ (${resolvedRoot}) の外です。実行しません。`
  }
  let actualFingerprint: string
  try {
    actualFingerprint = fingerprintFile(resolvedEntry)
  } catch (err) {
    return `拒否: ${resolvedEntry} を読み込めません（${err instanceof Error ? err.message : String(err)}）。実行しません。`
  }
  if (actualFingerprint !== target.expectedFingerprint) {
    return (
      `拒否: ${resolvedEntry} のfingerprintがインストール時と一致しません ` +
      `(expected ${target.expectedFingerprint.slice(0, 12)}…, got ${actualFingerprint.slice(0, 12)}…)。` +
      `改ざんまたは破損の可能性があるため実行しません。`
    )
  }
  return null
}

function spawnHook(target: HookSelfTestTarget, payload: string, cwd: string): HookSelfTestResult {
  const trustError = verifyHookTrust(target)
  if (trustError) {
    return { ok: false, exitCode: null, elapsedMs: 0, stderr: '', trustError }
  }

  const startedAt = Date.now()
  // shell:false deliberately: `executable`/`args` are structured data we
  // built ourselves (see vendor.ts buildHookInvocation), not a string
  // re-parsed through a shell. This is the same target Claude Code's own
  // settings.local.json entry points at, just invoked directly instead of
  // through shell command-line parsing.
  const result = spawnSync(target.executable, target.args, {
    cwd,
    shell: false,
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, VELAR_HOOK_SELF_TEST: '1' },
    timeout: 5000,
  })
  const elapsedMs = Date.now() - startedAt

  if (result.error) {
    return { ok: false, exitCode: null, elapsedMs, stderr: result.stderr ?? '', spawnError: result.error.message }
  }

  return { ok: result.status === 0, exitCode: result.status, elapsedMs, stderr: result.stderr ?? '' }
}

/**
 * Actually spawns the hook target that's installed (or about to be
 * installed) in .claude/settings.local.json — the same executable/args
 * Claude Code itself would resolve from that command string — and confirms
 * it runs to completion with the expected exit code for a benign, allowed
 * read. This is what catches "the path in settings.local.json doesn't
 * actually exist/execute" instead of just checking a file exists on disk.
 */
export function runHookSelfTest(target: HookSelfTestTarget, cwd: string = os.tmpdir()): HookSelfTestResult {
  return spawnHook(target, SELF_TEST_PAYLOAD, cwd)
}

/**
 * Like runHookSelfTest, but proves the hook actually BLOCKS a critical-risk
 * operation (expects exit code 2), not just that it runs for a benign one.
 * Used by `velar test`.
 */
export function runHookCriticalBlockTest(target: HookSelfTestTarget, cwd: string = os.tmpdir()): HookSelfTestResult {
  const result = spawnHook(target, CRITICAL_SELF_TEST_PAYLOAD, cwd)
  // For this specific test, exit code 2 (blocked) IS success -- override `ok`
  // accordingly rather than the allow-test's "0 means ok" interpretation.
  if (result.trustError || result.spawnError) return result
  return { ...result, ok: result.exitCode === 2 }
}
