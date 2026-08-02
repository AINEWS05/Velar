import path from 'node:path'
import { runDoctor } from '../doctor'
import { loadConfig, resolveApiBaseUrl } from '../config'
import { recordLifecycleMilestone } from '../lifecycle'

const ICON = { pass: '✔', warn: '⚠', fail: '✖' } as const

export async function doctorCommand(cwd: string = process.cwd()): Promise<number> {
  const result = await runDoctor(cwd)

  for (const check of result.checks) {
    console.log(`${ICON[check.level]} ${check.message}`)
  }
  console.log('')
  console.log(result.ok ? '✔ Velar doctor: all checks passed.' : '✖ Velar doctor: one or more checks failed — see above.')

  if (result.ok) {
    const config = loadConfig()
    await recordLifecycleMilestone(
      path.join(cwd, '.velar'),
      'doctor_pass',
      { tenantId: config?.orgId, projectName: path.basename(cwd) },
      config ? { reporterConfig: { apiBaseUrl: resolveApiBaseUrl(config), token: config.token } } : {},
    )
  }

  return result.ok ? 0 : 1
}
