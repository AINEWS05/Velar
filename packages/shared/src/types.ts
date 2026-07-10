/**
 * Zero-knowledge pivot — Phase 1 shared types.
 *
 * Velar never reads full prompts, file contents, or secret values. These
 * types intentionally have no field for any of that — only classification
 * metadata that is safe to keep in a local log.
 */

/** How risky Velar's local rules judged an operation to be. */
export type RiskLevel = 'allow' | 'warn' | 'critical'

/**
 * What ultimately happened to the operation. 'temp_allowed' (Phase 2) means
 * a prior Slack "10-minute allow" grant covered this operation silently.
 */
export type Decision = 'allowed' | 'warned' | 'blocked' | 'approved' | 'temp_allowed'

/** Coarse classification of the tool call being evaluated. */
export type OperationType = 'file_read' | 'file_write' | 'bash' | 'git' | 'deploy'

/**
 * How a `critical` decision was resolved. Phase 1 only ever produces
 * 'terminal' (or 'none' when no interactive terminal is available to ask).
 * Phase 2 adds 'slack' (resolved via a Slack approval card) and 'timeout'
 * (no one resolved the Slack card within 120s — fails closed to blocked).
 */
export type ApprovalMethod = 'none' | 'terminal' | 'slack' | 'timeout'

/**
 * The input to rule evaluation. `path`/`command` are used in-memory for
 * pattern matching only — they must never be written to the local log.
 * Only `fileBasename` (derived via toSafeBasename) is safe to persist.
 */
export interface NormalizedOperation {
  operationType: OperationType
  /** Full path when applicable (file_read/file_write). Not logged. */
  path?: string
  /** Full command string when applicable (bash/git/deploy). Not logged. */
  command?: string
}

export interface RuleMatch {
  ruleId: string
  riskLevel: RiskLevel
}

/**
 * A single local log line. This is the ENTIRE set of fields Velar is
 * allowed to persist for an operation — see toSafeBasename() /
 * buildVelarEvent() in redact.ts for the only supported way to construct one.
 */
export interface VelarEvent {
  timestamp: string
  projectName: string
  agentName: string
  operationType: OperationType
  fileBasename?: string
  matchedRuleId: string
  riskLevel: RiskLevel
  decision: Decision
  approvalMethod: ApprovalMethod
}
