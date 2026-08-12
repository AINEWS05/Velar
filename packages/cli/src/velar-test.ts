import {
  runHookSelfTest,
  runHookCriticalBlockTest,
  CATEGORY_BLOCK_PAYLOADS,
  type HookSelfTestResult,
  type HookSelfTestTarget,
} from './hook-selftest'
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

/** One block-case per @velar-dev/rules category — order matches rules.ts's own category ordering. */
const BLOCK_CATEGORIES = [
  'secrets',
  'production_db',
  'destructive_command',
  'deploy',
  'exfiltration',
  'package_ci_config',
] as const

/**
 * `velar test` — proves the installed hook does its actual job: a benign
 * operation passes through, AND a real, representative dangerous operation
 * from EVERY rule category is actually blocked (exit code 2) — not just one
 * example. `velar doctor` only proves the hook *runs*; this additionally
 * proves it *decides correctly*, across the board. This is the check a
 * nervous new user (or CI) should run right after `velar init` to get an
 * unambiguous pass/fail, and what the `test_pass` lifecycle event is emitted
 * from. 7 total checks: 1 allow-case + 6 category block-cases.
 */
export function runVelarTest(
  cwd: string,
  options: {
    allowSelfTest?: (target: HookSelfTestTarget, cwd: string) => HookSelfTestResult
    /** Third arg is the synthetic payload for the case being tested — see CATEGORY_BLOCK_PAYLOADS. */
    blockSelfTest?: (target: HookSelfTestTarget, cwd: string, payload: string) => HookSelfTestResult
  } = {},
): VelarTestResult {
  const allowSelfTest = options.allowSelfTest ?? runHookSelfTest
  const blockSelfTest = options.blockSelfTest ?? runHookCriticalBlockTest

  const { checks, target } = resolveHookTarget(cwd)

  if (!target) {
    checks.push({
      id: 'allow-case',
      level: 'fail',
      message: 'Skipped: no verified hook target to test. Run `velar init` first.',
    })
    for (const category of BLOCK_CATEGORIES) {
      checks.push({
        id: `block-${category}`,
        level: 'fail',
        message: 'Skipped: no verified hook target to test. Run `velar init` first.',
      })
    }
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

  for (const category of BLOCK_CATEGORIES) {
    const { payload, label } = CATEGORY_BLOCK_PAYLOADS[category]!
    const id = `block-${category}`
    const result = blockSelfTest(target, cwd, payload)
    if (result.trustError) {
      checks.push({ id, level: 'fail', message: result.trustError })
    } else if (result.ok) {
      checks.push({
        id,
        level: 'pass',
        message: `${label[0]!.toUpperCase()}${label.slice(1)} is correctly blocked (exit 2, ${result.elapsedMs}ms).`,
      })
    } else {
      checks.push({
        id,
        level: 'fail',
        message:
          `${label[0]!.toUpperCase()}${label.slice(1)} was NOT blocked as expected (exit ${result.exitCode ?? 'n/a'}). ` +
          `Velar is NOT protecting this project against dangerous operations.`,
      })
    }
  }

  return { ok: checks.every((c) => c.level !== 'fail'), checks }
}
