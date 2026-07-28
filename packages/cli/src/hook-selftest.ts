import { spawnSync } from 'node:child_process'
import os from 'node:os'

export interface HookSelfTestResult {
  /** true iff the command spawned and exited 0, i.e. behaved exactly like a benign, allowed file read. */
  ok: boolean
  exitCode: number | null
  elapsedMs: number
  stderr: string
  /** set when the command could not even be spawned (e.g. ENOENT) */
  spawnError?: string
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
 * Actually spawns the exact hook command string that's installed (or about
 * to be installed) in .claude/settings.json — the same way Claude Code
 * itself invokes it — and confirms it runs to completion with the expected
 * exit code. This is what catches "the path in settings.json doesn't
 * actually exist/execute" instead of just checking a file exists on disk.
 *
 * Runs with VELAR_HOOK_SELF_TEST=1 so the hook evaluates the payload above
 * without appending to the local event log or reporting anything to the
 * dashboard (see hookPreToolUseCommand's finalize()).
 */
export function runHookSelfTest(command: string, cwd: string = os.tmpdir()): HookSelfTestResult {
  const startedAt = Date.now()
  const result = spawnSync(command, {
    cwd,
    shell: true,
    input: SELF_TEST_PAYLOAD,
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
