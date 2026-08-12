import path from 'node:path'
import { runVelarTest } from '../velar-test'
import { loadConfig, resolveApiBaseUrl } from '../config'
import { recordLifecycleMilestone } from '../lifecycle'
import type { FetchFn } from '../reporter'

const ICON = { pass: '✔', warn: '⚠', fail: '✖' } as const

export interface TestCommandOptions {
  /** Overridable for tests — never read the real user's ~/.velar/config.json during a test run. */
  configDir?: string
  /** Overridable for tests — avoids a real network call when a milestone gets reported to an already-connected account. */
  fetchImpl?: FetchFn
}

export async function testCommand(cwd: string = process.cwd(), options: TestCommandOptions = {}): Promise<number> {
  const result = runVelarTest(cwd)

  for (const check of result.checks) {
    console.log(`${ICON[check.level]} ${check.message}`)
  }
  console.log('')

  // `result.checks` mixes two things: resolveHookTarget's config/wiring
  // checks (settings-exists, hook-registered, etc.) and the 7 checks that
  // actually prove Velar decides correctly (allow-case + one block-case per
  // rule category). Summarize the 7 "does it actually protect you" checks
  // by name — that's the number a nervous new user cares about — while the
  // full table above still shows every config check too.
  const protectionChecks = result.checks.filter((c) => c.id === 'allow-case' || c.id.startsWith('block-'))
  const protectionPassed = protectionChecks.filter((c) => c.level === 'pass').length
  const total = result.checks.length
  const passed = result.checks.filter((c) => c.level === 'pass').length
  console.log(
    result.ok
      ? `✔ velar test: ${protectionPassed}/${protectionChecks.length} protection checks passed ` +
        `(1 benign operation correctly allowed, 6 dangerous operations — one per rule category — correctly blocked), ` +
        `${passed}/${total} checks passed overall. Velar is actively protecting this project.`
      : `✖ velar test: FAILED (${protectionPassed}/${protectionChecks.length} protection checks passed, ` +
        `${passed}/${total} overall) — Velar is not reliably protecting this project. See above.`,
  )

  if (result.ok) {
    const config = loadConfig(options.configDir)
    // Deliberately distinct from first_real_critical_block — this is a
    // synthetic self-test the user (or CI) ran on purpose, not a real
    // dangerous operation Velar actually stopped. Never conflate the two.
    await recordLifecycleMilestone(
      path.join(cwd, '.velar'),
      'test_pass',
      { tenantId: config?.orgId, projectName: path.basename(cwd) },
      config
        ? { reporterConfig: { apiBaseUrl: resolveApiBaseUrl(config), token: config.token }, fetchImpl: options.fetchImpl }
        : {},
    )
  }

  return result.ok ? 0 : 1
}
