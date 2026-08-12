import path from 'node:path'
import { runUninstall } from '../uninstall'
import { loadConfig, resolveApiBaseUrl } from '../config'
import { buildLifecycleEvent, sendLifecycleEvent } from '../lifecycle'

export async function uninstallCommand(cwd: string = process.cwd()): Promise<number> {
  // Load config (and build the lifecycle event) BEFORE runUninstall — it's
  // about to delete .velar/, which is where a normal recordLifecycleMilestone()
  // call would durably queue this. There's no "later" to retry into once
  // .velar/ is gone, so this one is sent directly, best-effort, and never
  // touches the filesystem at all (keeping the zero-residue guarantee from
  // the round-trip test intact).
  const config = loadConfig()
  const projectName = path.basename(cwd)

  try {
    const result = runUninstall(cwd)

    if (result.nothingToDo) {
      console.log('✔ Nothing to remove — Velar is not installed in this project.')
      return 0
    }

    if (result.removedFromLocalSettings) {
      console.log(
        result.deletedLocalSettingsFile
          ? '✔ Removed the Velar hook and deleted .claude/settings.local.json (it had nothing else in it).'
          : '✔ Removed the Velar hook from .claude/settings.local.json.',
      )
    }
    if (result.removedFromLegacySettings) {
      console.log('✔ Removed a stale Velar hook entry from the legacy .claude/settings.json.')
    }
    if (result.removedStatusLine) {
      console.log('✔ Removed Velar\'s statusLine entry.')
    }
    if (result.removedVelarDir) {
      console.log('✔ Removed .velar/ (event log, install receipt, temporary allows).')
    }
    if (result.removedEmptyClaudeDir) {
      console.log('✔ Removed .claude/ (it was left completely empty).')
    }
    for (const backupPath of result.backupPaths) {
      console.log(`  Pre-change backup saved to ${backupPath}`)
    }

    console.log('\nVelar no longer protects this project. The vendored CLI copy under ~/.velar/vendor/ was left in')
    console.log('place — it may still be in use by other projects on this machine.')

    if (config) {
      const event = buildLifecycleEvent('uninstall_reported', { tenantId: config.orgId, projectName })
      await sendLifecycleEvent({ apiBaseUrl: resolveApiBaseUrl(config), token: config.token }, event, fetch)
    }

    return 0
  } catch (err) {
    console.error(`✖ velar uninstall failed: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
