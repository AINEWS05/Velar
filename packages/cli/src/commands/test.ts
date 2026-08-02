import path from 'node:path'
import { runVelarTest } from '../velar-test'
import { loadConfig, resolveApiBaseUrl } from '../config'
import { recordLifecycleMilestone } from '../lifecycle'

const ICON = { pass: '✔', warn: '⚠', fail: '✖' } as const

export async function testCommand(cwd: string = process.cwd()): Promise<number> {
  const result = runVelarTest(cwd)

  for (const check of result.checks) {
    console.log(`${ICON[check.level]} ${check.message}`)
  }
  console.log('')
  console.log(
    result.ok
      ? '✔ velar test: Velar is actively protecting this project (allow + critical-block both verified).'
      : '✖ velar test: FAILED — Velar is not reliably protecting this project. See above.',
  )

  if (result.ok) {
    const config = loadConfig()
    // Deliberately distinct from first_real_critical_block — this is a
    // synthetic self-test the user (or CI) ran on purpose, not a real
    // dangerous operation Velar actually stopped. Never conflate the two.
    await recordLifecycleMilestone(
      path.join(cwd, '.velar'),
      'test_pass',
      { tenantId: config?.orgId, projectName: path.basename(cwd) },
      config ? { reporterConfig: { apiBaseUrl: resolveApiBaseUrl(config), token: config.token } } : {},
    )
  }

  return result.ok ? 0 : 1
}
