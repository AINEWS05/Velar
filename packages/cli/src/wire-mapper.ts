import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { RULES } from '@velar-dev/rules'
import { WIRE_SCHEMA_VERSION, ACTION_ENVELOPE_VERSION } from '@velar-dev/shared'
import type {
  ApprovalMethod,
  Decision,
  NormalizedOperation,
  RiskLevel,
  VelarWireEvent,
  ActionEnvelope,
} from '@velar-dev/shared'
import { ownCliVersion } from './cli-version'

/** @deprecated read ownCliVersion() instead — this constant used to be hand-maintained separately from package.json and drifted. Kept only so existing imports don't break; always resolves dynamically now. */
export const CLI_VERSION = ownCliVersion()

/** A stable, non-reversible-in-practice pseudonym for "who ran this" — never the actual username in the clear. */
export function computeUserIdHash(): string {
  const raw = `${os.hostname()}:${os.userInfo().username}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * A stable-per-org pseudonym for the project directory name — never the
 * name itself. Salted with tenantId so the same project name in two
 * different orgs doesn't produce a linkable/colliding pseudonym.
 */
export function computeProjectPseudonym(tenantId: string, projectName: string): string {
  return createHash('sha256').update(`${tenantId}:${projectName}`).digest('hex').slice(0, 32)
}

/**
 * A stable-per-org hash of a subagent's `agent_type` (e.g. `general-purpose`,
 * or a user-defined subagent name like `acme-billing-reviewer`) — never the
 * raw string. Same rationale and shape as computeProjectPseudonym: an
 * org-defined subagent name can embed internal naming, exactly the concern
 * that kept MCP server/tool names off the wire entirely (see
 * classify.ts/mcpToolName) — this field exists specifically so that concern
 * doesn't also block reporting subagent-vs-parent at all.
 */
export function computeSubagentTypeHash(tenantId: string, agentType: string): string {
  return createHash('sha256').update(`${tenantId}:${agentType}`).digest('hex').slice(0, 32)
}

/**
 * A digest of the operation's raw path/command — NEVER the raw value
 * itself. Lets the dashboard notice "the same target was hit repeatedly"
 * without ever learning what that target actually was. Callers must only
 * ever pass this the in-memory NormalizedOperation, never persist the
 * pre-hash input anywhere.
 */
export function computeCanonicalizedParameterDigest(operation: NormalizedOperation): string | null {
  const raw = operation.path ?? operation.command
  if (!raw) return null
  // Canonicalize lightly (lowercase, trim) so trivial formatting
  // differences don't produce a different digest for what's effectively
  // the same target — still a one-way hash, never reversible to the raw value.
  return createHash('sha256').update(raw.trim().toLowerCase()).digest('hex').slice(0, 32)
}

let cachedPolicyVersion: string | null = null

/** @velar-dev/rules' own package version — resolved the same safe way vendor.ts resolves runtime deps (walk up from the real resolved entry file; never `require('pkg/package.json')` directly, which breaks on packages with a restrictive "exports" map). */
export function resolvePolicyVersion(): string {
  if (cachedPolicyVersion) return cachedPolicyVersion
  try {
    const req = createRequire(__filename)
    let dir = path.dirname(req.resolve('@velar-dev/rules'))
    for (let i = 0; i < 10; i++) {
      const pkgPath = path.join(dir, 'package.json')
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        if (pkg.name === '@velar-dev/rules' && typeof pkg.version === 'string') {
          cachedPolicyVersion = pkg.version
          return pkg.version
        }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // fall through to unknown
  }
  cachedPolicyVersion = 'unknown'
  return cachedPolicyVersion
}

const CATEGORY_TO_TARGET_CLASS: Record<string, ActionEnvelope['targetClass']> = {
  secrets: 'secrets',
  production_db: 'production_database',
  destructive_command: 'destructive_command',
  deploy: 'deploy_target',
  exfiltration: 'exfiltration_target',
  package_ci_config: 'package_ci_config',
}

/** Looks up the matched rule's category (from @velar-dev/rules' catalog) and maps it to a coarse, safe-to-send target class. 'generic' when the rule has no category (the allow/default-allow rules) or isn't found. */
export function classifyTargetClass(ruleId: string): ActionEnvelope['targetClass'] {
  const rule = RULES.find((r) => r.id === ruleId)
  if (!rule) return 'generic'
  return CATEGORY_TO_TARGET_CLASS[rule.category] ?? 'generic'
}

/** Same category lookup, as a list — currently always 0 or 1 entries (one matched rule has one category), kept as a list since a future multi-signal rule engine shouldn't need a schema change. */
export function deriveRiskFactors(ruleId: string): string[] {
  const rule = RULES.find((r) => r.id === ruleId)
  return rule ? [rule.category] : []
}

/**
 * Conservative, never-guessed: 'production' only when the matched rule's
 * own id signals a production marker (e.g. prod-db-drop,
 * kubernetes-apply-prod) — never asserted as 'development', since there's
 * no reliable local signal for that.
 */
export function classifyEnvironment(ruleId: string): ActionEnvelope['environment'] {
  return ruleId.includes('prod') ? 'production' : 'unknown'
}

function mapDecisionForWire(decision: Decision): VelarWireEvent['decision'] {
  return decision === 'warned' ? 'allowed' : decision
}

function mapApprovalMethodToDecisionSource(
  approvalMethod: ApprovalMethod,
  riskLevel: RiskLevel,
): ActionEnvelope['decisionSource'] {
  if (riskLevel !== 'critical') return 'local_rule_engine'
  switch (approvalMethod) {
    case 'slack':
      return 'slack_approval'
    case 'terminal':
      return 'terminal_prompt'
    case 'timeout':
      return 'timeout_fail_closed'
    case 'none':
    default:
      return 'terminal_prompt'
  }
}

/** @deprecated Phase 2 skeleton shape — superseded by buildActionEnvelope(). Still exported/valid so nothing that already sends/validates this shape breaks. */
export function buildWireEvent(params: {
  orgId: string
  projectName: string
  agentName: string
  operation: NormalizedOperation
  matchedRuleId: string
  riskLevel: RiskLevel
  decision: Decision
  approvalMethod: ApprovalMethod
  approverId?: string | null
  approvalLatencyMs?: number | null
}): VelarWireEvent {
  return {
    schemaVersion: WIRE_SCHEMA_VERSION,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    orgId: params.orgId,
    userIdHash: computeUserIdHash(),
    projectName: params.projectName,
    agentName: params.agentName,
    operationType: params.operation.operationType,
    ruleId: params.matchedRuleId,
    riskLevel: params.riskLevel,
    decision: mapDecisionForWire(params.decision),
    approverId: params.approverId ?? null,
    approvalMethod: params.approvalMethod,
    approvalLatencyMs: params.approvalLatencyMs ?? null,
    cliVersion: CLI_VERSION,
  }
}

export interface BuildActionEnvelopeParams {
  tenantId: string
  projectName: string
  agentName: string
  operation: NormalizedOperation
  matchedRuleId: string
  riskLevel: RiskLevel
  decision: Decision
  approvalMethod: ApprovalMethod
  approverId?: string | null
  requestedAt: number
  /** Approval timeout deadline, ms since epoch — only when a Slack approval is/was in flight. */
  expiryMs?: number | null
  durationMs: number
  resultStatus: ActionEnvelope['resultStatus']
  errorClass?: string | null
}

/** Builds a Phase 4a-2 Action Envelope. See action-envelope.ts for the full field-by-field rationale. */
export function buildActionEnvelope(params: BuildActionEnvelopeParams): ActionEnvelope {
  return {
    envelopeVersion: ACTION_ENVELOPE_VERSION,
    actionId: randomUUID(),
    tenantId: params.tenantId,
    projectPseudonym: computeProjectPseudonym(params.tenantId, params.projectName),
    actor: computeUserIdHash(),
    agent: params.agentName,
    // Claude Code does not currently expose its own version to a
    // PreToolUse hook payload — reported as null rather than guessed.
    agentVersion: null,
    actionType: params.operation.operationType,
    // Safe by construction: 'unclassified' is never used for an MCP tool
    // call (those keep their own dedicated mcp_tool_call/mcpToolName
    // branch in classify.ts), so a tool name reported here is always one
    // of Claude Code's own built-in tool names, never an MCP/user string.
    unclassifiedToolName:
      params.operation.operationType === 'unclassified' ? (params.operation.originalToolName ?? null) : null,
    targetClass: classifyTargetClass(params.matchedRuleId),
    environment: classifyEnvironment(params.matchedRuleId),
    canonicalizedParameterDigest: computeCanonicalizedParameterDigest(params.operation),
    riskFactors: deriveRiskFactors(params.matchedRuleId),
    riskLevel: params.riskLevel,
    matchedRuleIds: [params.matchedRuleId],
    policyVersion: resolvePolicyVersion(),
    requestedAt: new Date(params.requestedAt).toISOString(),
    expiry: params.expiryMs ? new Date(params.expiryMs).toISOString() : null,
    nonce: randomUUID(),
    decision: mapDecisionForWire(params.decision),
    decisionSource: mapApprovalMethodToDecisionSource(params.approvalMethod, params.riskLevel),
    approver: params.approverId ?? null,
    isSubagent: params.operation.isSubagent ?? false,
    subagentTypeHash:
      params.operation.isSubagent && params.operation.agentType
        ? computeSubagentTypeHash(params.tenantId, params.operation.agentType)
        : null,
    resultStatus: params.resultStatus,
    durationMs: params.durationMs,
    errorClass: params.errorClass ?? null,
    cliVersion: CLI_VERSION,
  }
}
