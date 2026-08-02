import fs from 'node:fs'
import path from 'node:path'
import { runHookSelfTest, type HookSelfTestResult, type HookSelfTestTarget } from './hook-selftest'
import { resolveHookTarget } from './hook-target'
import { defaultConfigDir } from './config'
import { readInstallReceipt } from './install-receipt'
import { fetchLatestPublishedVersion, isOlderVersion, type VersionCheckFetchFn } from './version-check'

export interface DoctorCheck {
  id: string
  level: 'pass' | 'warn' | 'fail'
  message: string
}

export interface DoctorResult {
  /** true iff no check has level "fail" — a "warn" alone does not fail doctor. */
  ok: boolean
  checks: DoctorCheck[]
}

/** Above this, the hook still "works" but a warning is worth surfacing. */
const SLOW_HOOK_THRESHOLD_MS = 200

/**
 * Verifies that a project's Velar hook is registered AND actually works —
 * not just that a settings file mentions one, but that the exact
 * registered command executes, and (when an install receipt is available)
 * that it's still the exact trusted file `velar init` vendored, unmodified.
 * Used by `velar doctor` and safe to call repeatedly; makes no writes.
 */
export async function runDoctor(
  cwd: string,
  options: {
    selfTest?: (target: HookSelfTestTarget, cwd: string) => HookSelfTestResult
    configDir?: string
    /** Defaults to global fetch — override in tests to avoid a real network call. */
    versionFetchImpl?: VersionCheckFetchFn
    /** Defaults to true — set false in tests that don't care about the version-currency check at all. */
    checkVersion?: boolean
  } = {},
): Promise<DoctorResult> {
  const selfTest = options.selfTest ?? runHookSelfTest
  const { checks, target } = resolveHookTarget(cwd)

  if (!target) {
    if (checks.some((c) => c.level === 'fail')) return { ok: false, checks }
    checks.push({
      id: 'hook-executes',
      level: 'warn',
      message: 'Skipped: cannot safely execute an unverified hook target. Run `velar init` to restore a verified install receipt.',
    })
  } else {
    const selfTestResult = selfTest(target, cwd)

    if (selfTestResult.trustError) {
      checks.push({ id: 'hook-executes', level: 'fail', message: selfTestResult.trustError })
    } else if (selfTestResult.ok) {
      checks.push({
        id: 'hook-executes',
        level: selfTestResult.elapsedMs > SLOW_HOOK_THRESHOLD_MS ? 'warn' : 'pass',
        message:
          selfTestResult.elapsedMs > SLOW_HOOK_THRESHOLD_MS
            ? `Hook executed successfully but took ${selfTestResult.elapsedMs}ms (target: well under 50ms warm).`
            : `Hook executed successfully in ${selfTestResult.elapsedMs}ms. Fingerprint verified against install receipt.`,
      })
    } else {
      checks.push({
        id: 'hook-executes',
        level: 'fail',
        message:
          `Hook command failed to execute correctly` +
          `${selfTestResult.exitCode !== null ? ` (exit code ${selfTestResult.exitCode})` : ''}` +
          `${selfTestResult.spawnError ? ` — ${selfTestResult.spawnError}` : ''}. ` +
          'Velar is NOT currently protecting this project, despite being listed in settings.',
      })
    }
  }

  const configDir = options.configDir ?? defaultConfigDir()
  const configPath = path.join(configDir, 'config.json')
  if (fs.existsSync(configPath)) {
    checks.push({
      id: 'login-state',
      level: 'pass',
      message: `Logged in (${configPath}). Slack approval and dashboard reporting are enabled.`,
    })
  } else {
    checks.push({
      id: 'login-state',
      level: 'warn',
      message: `Not logged in (${configPath} not found). Local blocking still works; run \`velar login\` to enable Slack approval and dashboard reporting.`,
    })
  }

  // Version-currency check (2026-08-01): vendoring is version-pinned by
  // design (see vendor.ts) — publishing a fix to npm does nothing for a
  // project until `velar init` is re-run there. A security-relevant fix
  // that never reaches an existing install is the same as not having
  // shipped it at all, so `doctor` is the one place that can proactively
  // surface "you're on an old, vendored version" instead of leaving it to
  // chance whether anyone notices. Best-effort and non-fatal: a failed
  // registry lookup (offline, npm down, timeout) degrades to a soft skip,
  // never a 'fail' — this is reporting on an optional signal, not
  // core hook integrity.
  if (options.checkVersion !== false) {
    const receipt = readInstallReceipt(path.join(cwd, '.velar'))
    const installedVersion = receipt?.cliVersion
    if (installedVersion) {
      const latest = await fetchLatestPublishedVersion(options.versionFetchImpl)
      if (!latest) {
        checks.push({
          id: 'version-currency',
          level: 'warn',
          message: `Could not check npm for a newer @velar-dev/cli version (currently ${installedVersion}) — no network, or the registry was unreachable.`,
        })
      } else if (isOlderVersion(installedVersion, latest.version)) {
        if (latest.securityAdvisory) {
          checks.push({
            id: 'version-currency',
            level: 'warn',
            message:
              `🔒 SECURITY UPDATE AVAILABLE: this project is running @velar-dev/cli ${installedVersion}; ` +
              `${latest.version} fixes a security-relevant issue and is available now. ` +
              `${latest.securityAdvisory} Run \`npx @velar-dev/cli@latest init\` in this project to upgrade.`,
          })
        } else {
          checks.push({
            id: 'version-currency',
            level: 'warn',
            message:
              `A newer @velar-dev/cli version is available: ${installedVersion} -> ${latest.version}. ` +
              'Run `npx @velar-dev/cli@latest init` in this project to upgrade.',
          })
        }
      } else {
        checks.push({
          id: 'version-currency',
          level: 'pass',
          message: `Running the latest published @velar-dev/cli version (${installedVersion}).`,
        })
      }
    }
    // No receipt / no cliVersion recorded: version-currency simply isn't
    // checked (nothing to compare) — the 'install-receipt' check above
    // already covers surfacing that gap.
  }

  return { ok: checks.every((c) => c.level !== 'fail'), checks }
}
