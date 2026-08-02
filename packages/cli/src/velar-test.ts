import { runHookSelfTest, runHookCriticalBlockTest, type HookSelfTestResult, type HookSelfTestTarget } from './hook-selftest'
import { resolveHookTarget } from './hook-target'

export interface VelarTestCheck {
  id: string
  level: 'pass' | 'warn' | 'fail'
  message: string
}

export interface VelarTestResult {
  ok: boolean
  checks: VelarTestCheck[]
}

/**
 * `velar test` — proves the installed hook does its actual job: an allowed
 * operation passes through, AND a critical-risk operation (reading a real
 * .env file) is actually blocked (exit code 2). `velar doctor` only proves
 * the hook *runs*; this additionally proves it *decides correctly*. This is
 * the check a nervous new user (or CI) should run right after `velar init`
 * to get an unambiguous pass/fail, and what the (future) `test_pass`
 * lifecycle event is emitted from.
 */
export function runVelarTest(
  cwd: string,
  options: {
    allowSelfTest?: (target: HookSelfTestTarget, cwd: string) => HookSelfTestResult
    criticalSelfTest?: (target: HookSelfTestTarget, cwd: string) => HookSelfTestResult
  } = {},
): VelarTestResult {
  const allowSelfTest = options.allowSelfTest ?? runHookSelfTest
  const criticalSelfTest = options.criticalSelfTest ?? runHookCriticalBlockTest

  const { checks, target } = resolveHookTarget(cwd)

  if (!target) {
    checks.push({
      id: 'allow-case',
      level: 'fail',
      message: 'Skipped: no verified hook target to test. Run `velar init` first.',
    })
    checks.push({
      id: 'critical-block-case',
      level: 'fail',
      message: 'Skipped: no verified hook target to test. Run `velar init` first.',
    })
    return { ok: false, checks }
  }

  const allowResult = allowSelfTest(target, cwd)
  if (allowResult.trustError) {
    checks.push({ id: 'allow-case', level: 'fail', message: allowResult.trustError })
  } else if (allowResult.ok) {
    checks.push({
      id: 'allow-case',
      level: 'pass',
      message: `A benign read is correctly allowed (exit 0, ${allowResult.elapsedMs}ms).`,
    })
  } else {
    checks.push({
      id: 'allow-case',
      level: 'fail',
      message: `A benign read was NOT allowed as expected (exit ${allowResult.exitCode ?? 'n/a'}). Velar is misbehaving.`,
    })
  }

  const criticalResult = criticalSelfTest(target, cwd)
  if (criticalResult.trustError) {
    checks.push({ id: 'critical-block-case', level: 'fail', message: criticalResult.trustError })
  } else if (criticalResult.ok) {
    checks.push({
      id: 'critical-block-case',
      level: 'pass',
      message: `A critical operation (.env.production read) is correctly blocked (exit 2, ${criticalResult.elapsedMs}ms).`,
    })
  } else {
    checks.push({
      id: 'critical-block-case',
      level: 'fail',
      message:
        `A critical operation was NOT blocked as expected (exit ${criticalResult.exitCode ?? 'n/a'}). ` +
        `Velar is NOT protecting this project against dangerous operations.`,
    })
  }

  return { ok: checks.every((c) => c.level !== 'fail'), checks }
}
