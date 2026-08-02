import path from 'node:path'
import { evaluate } from '@velar-dev/rules'
import type { Decision } from '@velar-dev/shared'
import { classifyCodexPayload } from '../adapters/codex-classify'
import { appendVelarEvent } from '../log'
import { loadConfig, resolveApiBaseUrl, type VelarConfig } from '../config'
import { reportEvent, type FetchFn } from '../reporter'
import { buildActionEnvelope } from '../wire-mapper'
import { recordLifecycleMilestone } from '../lifecycle'

export interface CodexHookOptions {
  /** Defaults to process.stdin — override in tests. */
  input?: NodeJS.ReadableStream
  /** Defaults to the payload's `cwd`, then process.cwd(). */
  cwd?: string
  /** Defaults to console.error / process.stderr.write — override in tests to silence output. */
  warn?: (msg: string) => void
  /** Defaults to loadConfig() (reads ~/.velar/config.json) — override in tests. */
  config?: VelarConfig | null
  /** Defaults to global fetch — override in tests to avoid real network calls. */
  fetchImpl?: FetchFn
}

function readAllStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    stream.setEncoding?.('utf8')
    stream.on('data', (chunk: string) => {
      data += chunk
    })
    stream.on('end', () => resolve(data))
    stream.on('error', reject)
  })
}

/** Only `apply_patch` denial is actually honored by Codex today — see codex-hook-verification.md. Everything else (Bash, and any future/unknown tool_name) is detect-only: Codex runs the tool call regardless of this hook's exit code. */
function canActuallyEnforce(codexToolName: string): boolean {
  return codexToolName === 'apply_patch'
}

/**
 * Codex CLI PreToolUse hook entry point.
 *
 * Deliberately narrower than the Claude Code hook (hook-pre-tool-use.ts):
 * no Slack/terminal approval flow, no temp-allow. This is a first, verified
 * pass — file_write blocking is real and immediate (deny-by-default, no
 * approval UX yet); everything else is observe-only and always exits 0
 * regardless of risk level, matching what Codex actually does with the
 * decision. See packages/cli/docs/design/codex-hook-verification.md for the
 * empirical basis, and packages/shared/src/capability-manifest.ts for the
 * public capability claim this code must not exceed.
 *
 * Exit code contract (same convention Codex documents for Claude Code):
 *   0 -> tool call proceeds
 *   2 -> tool call is blocked (only actually enforced for apply_patch)
 */
export async function hookCodexPreToolUseCommand(options: CodexHookOptions = {}): Promise<number> {
  const hookStartedAt = Date.now()
  const warn = options.warn ?? ((msg: string) => process.stderr.write(msg))
  const fetchImpl = options.fetchImpl ?? fetch

  let raw = ''
  try {
    raw = await readAllStdin(options.input ?? process.stdin)
  } catch {
    raw = ''
  }

  let payload: unknown = {}
  try {
    payload = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    payload = {}
  }

  const { operation, cwd: payloadCwd, codexToolName } = classifyCodexPayload(payload)
  const projectCwd = options.cwd ?? payloadCwd ?? process.cwd()
  const projectName = path.basename(projectCwd) || 'unknown-project'
  const agentName = 'codex'
  const velarDir = path.join(projectCwd, '.velar')
  const isSelfTest = process.env.VELAR_HOOK_SELF_TEST === '1'

  const config = options.config !== undefined ? options.config : loadConfig()
  const reporterConfig = config ? { apiBaseUrl: resolveApiBaseUrl(config), token: config.token } : null

  async function finalize(params: { decision: Decision; ruleId: string; riskLevel: 'allow' | 'warn' | 'critical' }): Promise<void> {
    if (isSelfTest) return

    appendVelarEvent(velarDir, {
      projectName,
      agentName,
      operation,
      matchedRuleId: params.ruleId,
      riskLevel: params.riskLevel,
      decision: params.decision,
      approvalMethod: 'none',
    })

    await recordLifecycleMilestone(
      velarDir,
      'first_real_decision',
      { tenantId: config?.orgId, projectName },
      { reporterConfig: reporterConfig ?? undefined, fetchImpl },
    )
    if (params.riskLevel === 'critical' && params.decision === 'blocked') {
      await recordLifecycleMilestone(
        velarDir,
        'first_real_critical_block',
        { tenantId: config?.orgId, projectName },
        { reporterConfig: reporterConfig ?? undefined, fetchImpl },
      )
    }

    if (config && reporterConfig) {
      const envelope = buildActionEnvelope({
        tenantId: config.orgId,
        projectName,
        agentName,
        operation,
        matchedRuleId: params.ruleId,
        riskLevel: params.riskLevel,
        decision: params.decision,
        approvalMethod: 'none',
        requestedAt: hookStartedAt,
        durationMs: Date.now() - hookStartedAt,
        resultStatus: 'decided',
      })
      await reportEvent(velarDir, reporterConfig, envelope, fetchImpl, warn)
    }
  }

  const { ruleId, riskLevel } = evaluate(operation)

  if (riskLevel === 'allow') {
    await finalize({ decision: 'allowed', ruleId, riskLevel })
    return 0
  }

  if (riskLevel === 'warn') {
    warn(`⚠ Velar: operation flagged as warn (${ruleId}) — not blocked.\n`)
    await finalize({ decision: 'warned', ruleId, riskLevel })
    return 0
  }

  // riskLevel === 'critical'
  if (canActuallyEnforce(codexToolName)) {
    warn(`✖ Velar blocked this operation (${ruleId}).\n`)
    await finalize({ decision: 'blocked', ruleId, riskLevel })
    return 2
  }

  warn(
    `⚠ Velar: critical operation detected (${ruleId}) — Codex does not currently enforce blocking for ${codexToolName || 'this'} operations, only file writes. This ran. See https://usevelar.com/docs (Codex support) for details.\n`,
  )
  await finalize({ decision: 'allowed', ruleId, riskLevel })
  return 2
}
