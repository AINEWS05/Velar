import path from 'node:path'
import { runInit } from '../settings-merge'
import { runHookSelfTest, type HookSelfTestTarget } from '../hook-selftest'
import { readInstallReceipt } from '../install-receipt'
import { loadConfig, resolveApiBaseUrl } from '../config'
import { recordLifecycleMilestone } from '../lifecycle'

export async function initCommand(cwd: string = process.cwd()): Promise<number> {
  try {
    const result = runInit(cwd)

    if (result.migratedFromSharedSettings) {
      console.log(`✔ Migrated the Velar hook out of the shared .claude/settings.json into ${result.settingsPath}`)
      console.log('  (a machine-specific path has no business in a file your teammates pull via git)')
    } else if (result.alreadyInstalled) {
      console.log(`✔ Velar hook is already installed in ${result.settingsPath}`)
    } else if (result.upgraded) {
      console.log(`✔ Velar hook upgraded in ${result.settingsPath}`)
    } else {
      console.log(`✔ Velar hook installed in ${result.settingsPath}`)
    }
    if (result.backupPath) {
      console.log(`  Existing settings backed up to ${result.backupPath}`)
    }
    console.log(`✔ Local event log ready at ${path.join(result.velarDir, 'events.jsonl')}`)
    console.log(`✔ Install receipt written to ${result.receiptPath}`)

    // Prove the exact command just written to settings.local.json actually
    // runs — don't just trust that vendoring/writing the file succeeded. A
    // hook that's present in settings but silently fails to execute is
    // worse than no hook at all: the user believes they're protected when
    // they aren't. Self-test against the receipt we just wrote (structured
    // executable/args, shell:false, fingerprint-verified) rather than
    // re-parsing the shell command string.
    const receipt = readInstallReceipt(result.velarDir)
    const selfTestOk = (() => {
      if (!receipt) {
        console.error('⚠ WARNING: could not read back the install receipt just written — skipping self-test.')
        return false
      }
      const target: HookSelfTestTarget = {
        executable: receipt.hookExecutable,
        args: receipt.hookArgs,
        entryPath: receipt.vendorEntryPath,
        vendorRoot: receipt.vendorRoot,
        expectedFingerprint: receipt.vendorEntryFingerprint,
      }
      const selfTest = runHookSelfTest(target, cwd)
      if (selfTest.ok) {
        console.log(`✔ Hook self-test passed (${selfTest.elapsedMs}ms)`)
        return true
      }
      console.error('')
      console.error('⚠ WARNING: the installed hook command did not run successfully.')
      console.error(`  Velar is NOT currently protecting this project, despite being listed in ${result.settingsPath}.`)
      if (selfTest.trustError) console.error(`  ${selfTest.trustError}`)
      if (selfTest.spawnError) console.error(`  Spawn error: ${selfTest.spawnError}`)
      if (selfTest.exitCode !== null && selfTest.exitCode !== 0) console.error(`  Exit code: ${selfTest.exitCode}`)
      if (selfTest.stderr.trim()) console.error(`  stderr: ${selfTest.stderr.trim()}`)
      console.error('  Run `velar doctor` for a full diagnosis before relying on Velar in this project.')
      console.error('')
      return false
    })()

    console.log('\nVelar sees only operation metadata (tool type, file basename, command shape).')
    console.log('It never reads prompt text, file content, or secret values, and Phase 1 sends nothing to the cloud.')

    if (selfTestOk) {
      const config = loadConfig()
      await recordLifecycleMilestone(
        result.velarDir,
        'init_success',
        { tenantId: config?.orgId, projectName: path.basename(cwd) },
        config ? { reporterConfig: { apiBaseUrl: resolveApiBaseUrl(config), token: config.token } } : {},
      )
    }

    return selfTestOk ? 0 : 1
  } catch (err) {
    console.error(`✖ velar init failed: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
