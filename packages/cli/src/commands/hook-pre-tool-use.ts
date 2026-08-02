import path from 'node:path'
import { evaluate, RULES } from '@velar-dev/rules'
import type { ApprovalMethod, Decision } from '@velar-dev/shared'
import { classifyPayload } from '../classify'
import { appendVelarEvent } from '../log'
import { createTtyPrompter, decideFromAnswer, type Prompter } from '../approval'
import { loadConfig, resolveApiBaseUrl, resolveUnclassifiedToolRisk, type VelarConfig } from '../config'
import { isTempAllowed, addTempAllow, pruneExpiredTempAllows } from '../temp-allow'
import { requestSlackApproval } from '../approval-client'
import { reportEvent, type FetchFn } from '../reporter'
import { buildActionEnvelope } from '../wire-mapper'
import { recordLifecycleMilestone } from '../lifecycle'

export interface HookOptions {
  /** Defaults to process.stdin — override in tests. */
  input?: NodeJS.ReadableStream
  /** Defaults to a real TTY prompter — override in tests. */
  prompter?: Prompter | null
  /** Defaults to the payload's `cwd`, then process.cwd(). */
  cwd?: string
  /** Defaults to console.error / process.stderr.write — override in tests to silence output. */
  warn?: (msg: string) => void
  /** Defaults to loadConfig() (reads ~/.velar/config.json) — override in tests. */
  config?: VelarConfig | null
  /** Defaults to global fetch — override in tests to avoid real network calls. */
  fetchImpl?: FetchFn
  /** Defaults to a real setTimeout-based sleep — override in tests to skip real waiting. */
  sleepImpl?: (ms: number) => Promise<void>
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

/**
 * Claude Code PreToolUse hook entry point.
 *
 * Exit code contract (Claude Code convention):
 *   0 -> tool call proceeds
 *   2 -> tool call is blocked, stderr is shown back to the model
 *
 * Never throws on unexpected payload shape — classifyPayload() always
 * degrades to a safe, allow-able NormalizedOperation instead. Cloud
 * reporting/approval failures never affect the local decision, which is
 * always finalized before any network call is attempted.
 */
export async function hookPreToolUseCommand(options: HookOptions = {}): Promise<number> {
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

  const { operation, cwd: payloadCwd } = classifyPayload(payload)
  const projectCwd = options.cwd ?? payloadCwd ?? process.cwd()
  const projectName = path.basename(projectCwd) || 'unknown-project'
  const agentName = 'claude-code'
  const velarDir = path.join(projectCwd, '.velar')
  const isSelfTest = process.env.VELAR_HOOK_SELF_TEST === '1'

  const config = options.config !== undefined ? options.config : loadConfig()
  const reporterConfig = config ? { apiBaseUrl: resolveApiBaseUrl(config), token: config.token } : null

  async function finalize(params: {
    decision: Decision
    approvalMethod: ApprovalMethod
    ruleId: string
    riskLevel: 'allow' | 'warn' | 'critical'
    approverId?: string | null
    approvalLatencyMs?: number | null
    expiryMs?: number | null
  }): Promise<void> {
    // `velar init`/`velar doctor`/`velar test` spawn the real, resolved
    // hook command to prove it actually runs (see ../hook-selftest.ts) —
    // this must never write to the real local event log or report to the
    // dashboard.
    if (isSelfTest) return

    appendVelarEvent(velarDir, {
      projectName,
      agentName,
      operation,
      matchedRuleId: params.ruleId,
      riskLevel: params.riskLevel,
      decision: params.decision,
      approvalMethod: params.approvalMethod,
    })

    // Lifecycle milestones (first_real_decision / first_real_critical_block)
    // — a SEPARATE stream from the per-operation Action Envelope below, and
    // only ever fires once per project (see lifecycle.ts). Never derived
    // from a self-test run (already excluded above) — these specifically
    // mean "a real operation was really decided/blocked".
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
        approvalMethod: params.approvalMethod,
        approverId: params.approverId,
        requestedAt: hookStartedAt,
        expiryMs: params.expiryMs,
        durationMs: Date.now() - hookStartedAt,
        resultStatus: 'decided',
      })
      await reportEvent(velarDir, reporterConfig, envelope, fetchImpl, warn)
    }
  }

  const { ruleId, riskLevel: matchedRiskLevel } = evaluate(operation)
  let riskLevel = matchedRiskLevel

  // packages/rules stays pure/config-agnostic (no I/O, no org policy) — the
  // one place Velar's unclassified-tool severity is actually configurable is
  // here, applied as a post-evaluate() override, never inside the rule
  // engine itself. Both mcp-unknown-tool-default and unclassified-tool-default
  // always evaluate to 'warn' on their own; this can only ever escalate to
  // 'critical', never relax any other rule's outcome. One config knob
  // (unclassifiedToolRisk) covers both ruleIds — an org that wants every
  // unrecognized tool call (MCP or otherwise) to require approval sets it
  // once, rather than needing a separate knob for the next unknown-tool rule.
  if (
    (ruleId === 'mcp-unknown-tool-default' || ruleId === 'unclassified-tool-default') &&
    resolveUnclassifiedToolRisk(config) === 'critical'
  ) {
    riskLevel = 'critical'
  }

  if (riskLevel === 'allow') {
    await finalize({ decision: 'allowed', approvalMethod: 'none', ruleId, riskLevel })
    return 0
  }

  if (riskLevel === 'warn') {
    warn(`⚠ Velar: operation flagged as warn (${ruleId}) — not blocked.\n`)
    await finalize({ decision: 'warned', approvalMethod: 'none', ruleId, riskLevel })
    return 0
  }

  // riskLevel === 'critical'
  if (isSelfTest) {
    // `velar test` proves the block decision + exit code contract for a
    // critical-risk operation without exercising the real approval UX (no
    // real terminal wait, no real Slack call/timeout) — finalize() above
    // already no-ops for local-log/dashboard reporting under this flag.
    return 2
  }
  pruneExpiredTempAllows(velarDir)
  if (isTempAllowed(velarDir, ruleId, projectName)) {
    await finalize({ decision: 'temp_allowed', approvalMethod: 'slack', ruleId, riskLevel })
    return 0
  }

  const ruleDescription = RULES.find((r) => r.id === ruleId)?.reason ?? ruleId
  const approvalStartedAt = Date.now()
  const APPROVAL_TIMEOUT_MS = 120_000

  // Try the Slack/cloud approval path first when Velar is configured.
  if (config && reporterConfig) {
    const outcome = await requestSlackApproval(
      reporterConfig,
      {
        ruleId,
        riskLevel: 'critical',
        projectName,
        agentName,
        operationType: operation.operationType,
        ruleDescription,
      },
      fetchImpl,
      options.sleepImpl,
    )

    if (outcome.status !== 'unavailable') {
      const approvalLatencyMs = Date.now() - approvalStartedAt
      const expiryMs = approvalStartedAt + APPROVAL_TIMEOUT_MS

      if (outcome.status === 'approved') {
        if (outcome.tempAllow) addTempAllow(velarDir, outcome.tempAllow)
        warn(`✔ Velar approved this operation via Slack (${ruleId}).\n`)
        await finalize({
          decision: 'approved',
          approvalMethod: 'slack',
          ruleId,
          riskLevel,
          approverId: outcome.approverId,
          approvalLatencyMs,
          expiryMs,
        })
        return 0
      }

      if (outcome.status === 'blocked') {
        warn(`✖ Velar blocked this operation via Slack (${ruleId}).\n`)
        await finalize({
          decision: 'blocked',
          approvalMethod: 'slack',
          ruleId,
          riskLevel,
          approverId: outcome.approverId,
          approvalLatencyMs,
          expiryMs,
        })
        return 2
      }

      // timed_out — fail closed.
      warn(`✖ Velar: approval timed out after 120s — blocking by default (${ruleId}).\n`)
      await finalize({
        decision: 'blocked',
        approvalMethod: 'timeout',
        ruleId,
        riskLevel,
        approvalLatencyMs,
        expiryMs,
      })
      return 2
    }
    // outcome.status === 'unavailable' — Slack not configured for this org,
    // or apps/api unreachable. Fall through to the terminal prompt below,
    // exactly like Phase 1 (no regression).
  }

  // Terminal fallback — identical to Phase 1 behavior.
  const prompter = options.prompter !== undefined ? options.prompter : createTtyPrompter()

  let approved = false
  let approvalMethod: ApprovalMethod

  if (!prompter) {
    approved = false
    approvalMethod = 'none'
    warn('✖ Velar: no interactive terminal available to confirm a critical operation — blocking by default.\n')
  } else {
    approvalMethod = 'terminal'
    const answer = await prompter.confirm(
      `\n🛑 Velar: critical operation detected\n   rule: ${ruleId} — ${ruleDescription}\n   Allow? [y/N] `,
    )
    approved = decideFromAnswer(answer)
  }

  const decision: Decision = approved ? 'approved' : 'blocked'
  await finalize({ decision, approvalMethod, ruleId, riskLevel, approvalLatencyMs: Date.now() - approvalStartedAt })

  if (!approved) {
    warn(`✖ Velar blocked this operation (${ruleId}).\n`)
    return 2
  }
  warn(`✔ Velar approved this operation (${ruleId}).\n`)
  return 0
}
