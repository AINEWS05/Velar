import path from 'node:path'
import { runInit } from '../settings-merge'
import { runHookSelfTest } from '../hook-selftest'

export function initCommand(cwd: string = process.cwd()): number {
  try {
    const result = runInit(cwd)

    if (result.alreadyInstalled) {
      console.log(`✔ Velar hook is already installed in ${result.settingsPath}`)
    } else if (result.upgraded) {
      console.log(`✔ Velar hook upgraded in ${result.settingsPath}`)
      if (result.backupPath) {
        console.log(`  Existing settings backed up to ${result.backupPath}`)
      }
    } else {
      console.log(`✔ Velar hook installed in ${result.settingsPath}`)
      if (result.backupPath) {
        console.log(`  Existing settings backed up to ${result.backupPath}`)
      }
    }
    console.log(`✔ Local event log ready at ${path.join(result.velarDir, 'events.jsonl')}`)

    // Prove the exact command just written to settings.json actually runs —
    // don't just trust that vendoring/writing the file succeeded. A hook
    // that's present in settings.json but silently fails to execute is
    // worse than no hook at all: the user believes they're protected when
    // they aren't.
    const selfTest = runHookSelfTest(result.hookCommand, cwd)
    if (selfTest.ok) {
      console.log(`✔ Hook self-test passed (${selfTest.elapsedMs}ms)`)
    } else {
      console.error('')
      console.error('⚠ WARNING: the installed hook command did not run successfully.')
      console.error(`  Velar is NOT currently protecting this project, despite being listed in ${result.settingsPath}.`)
      if (selfTest.spawnError) console.error(`  Spawn error: ${selfTest.spawnError}`)
      if (selfTest.exitCode !== null && selfTest.exitCode !== 0) console.error(`  Exit code: ${selfTest.exitCode}`)
      if (selfTest.stderr.trim()) console.error(`  stderr: ${selfTest.stderr.trim()}`)
      console.error('  Run `velar doctor` for a full diagnosis before relying on Velar in this project.')
      console.error('')
    }

    console.log('\nVelar sees only operation metadata (tool type, file basename, command shape).')
    console.log('It never reads prompt text, file content, or secret values, and Phase 1 sends nothing to the cloud.')

    return selfTest.ok ? 0 : 1
  } catch (err) {
    console.error(`✖ velar init failed: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
