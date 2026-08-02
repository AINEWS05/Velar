import path from 'node:path'
import type { Decision, NormalizedOperation, RiskLevel, ApprovalMethod, VelarEvent } from './types'

/**
 * Strips a path down to its basename. This is the ONLY thing derived from a
 * file path that is safe to log — never the full path (which can reveal
 * directory structure, usernames, project layout, etc.).
 *
 * Normalizes backslashes to forward slashes first and always splits with
 * `path.posix`, so a Windows-style path (e.g. reported by a Claude Code
 * session running on Windows) is stripped correctly even when Velar itself
 * runs on Linux/macOS — `path.basename` alone only understands `\` as a
 * separator on win32.
 */
export function toSafeBasename(p?: string): string | undefined {
  if (!p) return undefined
  return path.posix.basename(p.replace(/\\/g, '/'))
}

/**
 * Builds the single log-safe event object for an evaluated operation.
 * This function is the only place a VelarEvent should be constructed —
 * it deliberately takes no `path`/`command`/prompt/file-content parameter,
 * so it is structurally impossible to smuggle raw content into the log.
 */
export function buildVelarEvent(params: {
  timestamp?: string
  projectName: string
  agentName: string
  operation: NormalizedOperation
  matchedRuleId: string
  riskLevel: RiskLevel
  decision: Decision
  approvalMethod: ApprovalMethod
}): VelarEvent {
  return {
    timestamp: params.timestamp ?? new Date().toISOString(),
    projectName: params.projectName,
    agentName: params.agentName,
    operationType: params.operation.operationType,
    fileBasename: toSafeBasename(params.operation.path),
    unclassifiedToolName: params.operation.operationType === 'unclassified' ? params.operation.originalToolName : undefined,
    isSubagent: params.operation.isSubagent,
    matchedRuleId: params.matchedRuleId,
    riskLevel: params.riskLevel,
    decision: params.decision,
    approvalMethod: params.approvalMethod,
  }
}
