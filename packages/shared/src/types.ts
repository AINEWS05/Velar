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
export type OperationType = 'file_read' | 'file_write' | 'bash' | 'git' | 'deploy' | 'mcp_tool_call' | 'unclassified'

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
  /**
   * Raw `tool_name` when applicable (mcp_tool_call), e.g.
   * `mcp__github__delete_repository`. In-memory rule-matching only, exactly
   * like `command`/`path` above — never persisted to VelarEvent. Deliberately
   * NOT split into server/tool identifiers here; that split (and whether it's
   * ever safe to report off the local machine) is a separate, still-open
   * design question — see docs/design/mcp-classification.md.
   */
  mcpToolName?: string
  /**
   * A bounded (~8KB), in-memory-only JSON.stringify of the MCP tool's raw
   * `tool_input`, used exclusively so existing secret/production-DB pattern
   * rules can also match against MCP tool arguments (an MCP tool name alone
   * can't tell you if its arguments contain a connection string or an API
   * key). Same treatment as `command`/`path`: read for pattern matching only,
   * never persisted, never sent anywhere.
   */
  mcpToolInputText?: string
  /**
   * Raw `tool_name` when classify.ts could not confidently classify the
   * operation into any known shape (operationType `'unclassified'`) — e.g. a
   * built-in tool like WebFetch/WebSearch that has no dedicated branch yet.
   * Unlike `mcpToolName`, this is safe to persist/report: it is always one of
   * Claude Code's own closed set of built-in tool names, never a user- or
   * org-defined string (MCP tool names keep going through `mcpToolName`
   * above and are deliberately never mirrored here even if classify.ts also
   * fails to recognize the specific mcp__ tool — see mcp-unknown-tool-default
   * in @velar-dev/rules, which handles that case on its own branch).
   */
  originalToolName?: string
  /**
   * URL (WebFetch) or search query text (WebSearch) — in-memory rule-matching
   * only, exactly like `command`/`mcpToolInputText`. Never persisted to
   * VelarEvent, never sent to the cloud; only used so rules can detect a
   * secret-shaped value embedded in the destination URL or query string.
   */
  webTargetText?: string
  /** True when the hook payload's `agent_id`/`agent_type` fields were present — i.e. this operation was issued by a Task-tool subagent, not the top-level session. */
  isSubagent?: boolean
  /** Raw `agent_type` from the hook payload (e.g. `general-purpose`, or a user-defined subagent name) — in-memory only. Never persisted/sent raw; see subagentTypeHash on ActionEnvelope for the cloud-safe form. */
  agentType?: string
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
  /** Only ever set when operationType is 'unclassified' — always one of Claude Code's own built-in tool names, never an MCP/user-defined string. See NormalizedOperation.originalToolName. */
  unclassifiedToolName?: string
  /** True when this operation was issued by a Task-tool subagent rather than the top-level session. The subagent's own type/name is never persisted, even locally — see ActionEnvelope.subagentTypeHash for the cloud-safe form. */
  isSubagent?: boolean
  matchedRuleId: string
  riskLevel: RiskLevel
  decision: Decision
  approvalMethod: ApprovalMethod
}
