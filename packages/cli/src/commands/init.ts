import path from 'node:path'
import { runInit } from '../settings-merge'
import { loadConfig, resolveApiBaseUrl } from '../config'
import { recordLifecycleMilestone } from '../lifecycle'
import { testCommand } from './test'
import { loginCommand, type LoginOptions } from './login'
import type { FetchFn } from '../reporter'

export interface InitOptions {
  loginOptions?: LoginOptions
  /** Overridable for tests — never read/write the real user's ~/.velar/config.json during a test run. Also used as loginOptions.configDir's default when that isn't set separately. */
  configDir?: string
  /** Overridable for tests — never vendor into the real user's ~/.velar/vendor during a test run. */
  vendorBaseDir?: string
  vendorCliRoot?: string
  /** Overridable for tests — avoids a real network call when a milestone gets reported to an already-connected account. */
  fetchImpl?: FetchFn
}

export async function initCommand(cwd: string = process.cwd(), argv: string[] = [], options: InitOptions = {}): Promise<number> {
  try {
    const result = runInit(cwd, { vendorBaseDir: options.vendorBaseDir, vendorCliRoot: options.vendorCliRoot })

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

    console.log('\nVelar sees only operation metadata (tool type, file basename, command shape).')
    console.log('It never reads prompt text, file content, or secret values, and Phase 1 sends nothing to the cloud.')

    // Local blocking (below) never depends on being logged in — the rule
    // engine runs entirely on-device. An account only adds dashboard/team
    // visibility, so a failed or skipped pairing here must never fail the
    // overall `init`.
    const configDir = options.configDir
    let config = loadConfig(configDir)
    if (!config) {
      console.log("\nConnecting to your Velar account (for the dashboard — local blocking works either way)...")
      const loginExitCode = await loginCommand(argv, { configDir, ...options.loginOptions })
      if (loginExitCode === 0) {
        config = loadConfig(configDir)
      } else {
        console.log('  Skipping for now — run `velar login` any time to connect this project to your account.')
      }
    } else {
      console.log(`\n✔ Already connected to Velar (org ${config.orgId}).`)
    }

    // Don't just trust that vendoring/writing the settings file succeeded —
    // prove the exact command just written actually runs AND actually
    // decides correctly (allows a benign op, blocks a real representative
    // of every rule category). A hook that's present in settings but
    // silently fails, or runs but doesn't block anything, is worse than no
    // hook at all: the user believes they're protected when they aren't.
    // `testCommand` re-resolves the target from what runInit() just wrote
    // (not a value carried over in memory), so this is an honest end-to-end
    // check, not a self-congratulatory replay.
    console.log('\nRunning `velar test` to prove this actually protects you (not just that it\'s registered)...\n')
    const testExitCode = await testCommand(cwd, { configDir, fetchImpl: options.fetchImpl })

    if (testExitCode === 0) {
      await recordLifecycleMilestone(
        result.velarDir,
        'init_success',
        { tenantId: config?.orgId, projectName: path.basename(cwd) },
        config
          ? { reporterConfig: { apiBaseUrl: resolveApiBaseUrl(config), token: config.token }, fetchImpl: options.fetchImpl }
          : {},
      )
    } else {
      console.error('\n  Run `velar doctor` for a full diagnosis before relying on Velar in this project.')
    }

    return testExitCode
  } catch (err) {
    console.error(`✖ velar init failed: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
