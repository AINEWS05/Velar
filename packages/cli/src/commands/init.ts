import path from 'node:path'
import { runInit } from '../settings-merge'

export function initCommand(cwd: string = process.cwd()): number {
  try {
    const result = runInit(cwd)
    if (result.alreadyInstalled) {
      console.log(`✔ Velar hook is already installed in ${result.settingsPath}`)
    } else {
      console.log(`✔ Velar hook installed in ${result.settingsPath}`)
      if (result.backupPath) {
        console.log(`  Existing settings backed up to ${result.backupPath}`)
      }
    }
    console.log(`✔ Local event log ready at ${path.join(result.velarDir, 'events.jsonl')}`)
    console.log('\nVelar sees only operation metadata (tool type, file basename, command shape).')
    console.log('It never reads prompt text, file content, or secret values, and Phase 1 sends nothing to the cloud.')
    return 0
  } catch (err) {
    console.error(`✖ velar init failed: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
