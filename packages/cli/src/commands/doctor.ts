import { runDoctor } from '../doctor'

const ICON = { pass: '✔', warn: '⚠', fail: '✖' } as const

export function doctorCommand(cwd: string = process.cwd()): number {
  const result = runDoctor(cwd)

  for (const check of result.checks) {
    console.log(`${ICON[check.level]} ${check.message}`)
  }
  console.log('')
  console.log(result.ok ? '✔ Velar doctor: all checks passed.' : '✖ Velar doctor: one or more checks failed — see above.')

  return result.ok ? 0 : 1
}
