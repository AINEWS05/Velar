import { randomUUID, createHash } from 'node:crypto'
import os from 'node:os'
import { WIRE_SCHEMA_VERSION } from '@velar-dev/shared'
import type { ApprovalMethod, Decision, NormalizedOperation, RiskLevel, VelarWireEvent } from '@velar-dev/shared'

/** Kept in sync with package.json's version by hand for this Phase 2 skeleton. */
export const CLI_VERSION = '0.1.0'

/** A stable, non-reversible-in-practice pseudonym for "who ran this" — never the actual username in the clear. */
export function computeUserIdHash(): string {
  const raw = `${os.hostname()}:${os.userInfo().username}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * A local 'warned' outcome was never blocked, so on the wire it's reported
 * as an 'allowed' decision — riskLevel: 'warn' already distinguishes it in
 * the dashboard. Every other local decision maps 1:1 onto the wire schema.
 */
function mapDecisionForWire(decision: Decision): VelarWireEvent['decision'] {
  return decision === 'warned' ? 'allowed' : decision
}

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
