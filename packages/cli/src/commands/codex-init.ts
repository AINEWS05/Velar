import path from 'node:path'
import { runCodexInit } from '../codex-hooks-merge'
import { runHookSelfTest, type HookSelfTestTarget } from '../hook-selftest'
import { readInstallReceipt, CODEX_RECEIPT_FILE_NAME } from '../install-receipt'
import { loadConfig, resolveApiBaseUrl } from '../config'
import { recordLifecycleMilestone } from '../lifecycle'

/**
 * `velar codex-init` — installs the Velar PreToolUse hook into
 * `.codex/hooks.json` for Codex CLI. Kept as its own command (not folded
 * into `velar init`) because Codex support is Preview-status and partial:
 * see packages/shared/src/capability-manifest.ts. Only file-write
 * (apply_patch) denial is actually enforced by Codex today; Bash detection
 * is observe-only. This command's own output says so explicitly rather
 * than implying parity with the Claude Code adapter.
 *
 * Self-test scope is narrower than `velar init`'s: only the benign
 * allow-case self-test runs here (proves the hook process spawns and
 * exits 0 for the process). There is no Codex-shaped critical-block
 * self-test wired up yet — `velar doctor`/`velar test` remain Claude-only
 * for now; extending them to Codex is a follow-up, not done in this pass.
 *
 * IMPORTANT: writing hooks.json alone does not make Codex trust and run
 * the hook. Codex requires either an interactive hook-trust review (first
 * real Codex session in this project) or `--dangerously-bypass-hook-trust`
 * — this command cannot grant that trust itself.
 */
export async function codexInitCommand(cwd: string = process.cwd()): Promise<number> {
  try {
    const result = runCodexInit(cwd)

    if (result.alreadyInstalled) {
      console.log(`✔ Velar hook is already installed in ${result.hooksPath}`)
    } else if (result.upgraded) {
      console.log(`✔ Velar hook upgraded in ${result.hooksPath}`)
    } else {
      console.log(`✔ Velar hook installed in ${result.hooksPath}`)
    }
    if (result.backupPath) {
      console.log(`  Existing hooks.json backed up to ${result.backupPath}`)
    }
    console.log(`✔ Local event log ready at ${path.join(result.velarDir, 'events.jsonl')}`)
    console.log(`✔ Install receipt written to ${result.receiptPath}`)

    const receipt = readInstallReceipt(result.velarDir, CODEX_RECEIPT_FILE_NAME)
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
      if (selfTest.trustError) console.error(`  ${selfTest.trustError}`)
      if (selfTest.spawnError) console.error(`  Spawn error: ${selfTest.spawnError}`)
      console.error('')
      return false
    })()

    console.log('')
    console.log('IMPORTANT — Codex support is Preview and partial (empirically verified, not assumed):')
    console.log('  - File writes (apply_patch): Velar can genuinely BLOCK dangerous ones.')
    console.log('  - Bash commands: Velar detects and logs risky ones, but cannot currently stop Codex from running them.')
    console.log('  Compare with Claude Code, where every operation type is blocked.')
    console.log('')
    console.log('Codex also requires you to trust this hook before it runs: start a real Codex session in this')
    console.log('project once (Codex will prompt to review the new hook), or pass --dangerously-bypass-hook-trust')
    console.log('to `codex`/`codex exec` yourself if you already vet hook sources that way.')

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
    console.error(`✖ velar codex-init failed: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
