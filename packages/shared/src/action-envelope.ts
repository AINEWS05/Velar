import { z } from 'zod'

/**
 * Phase 4a-2 — Action Envelope v1.
 *
 * Replaces the ad-hoc VelarWireEvent (wire-event.ts, still exported/valid —
 * NOT removed, so nothing that already sends/validates it breaks) as the
 * CLI's primary per-operation report shape. Same zero-knowledge contract as
 * before (`.strict()` allow-list schema — any field not named here is a
 * validation error, never silently dropped), restructured around a few new
 * ideas:
 *
 *  - `projectPseudonym` is a HASH, not the project directory name in the
 *    clear (see computeProjectPseudonym() in the CLI's wire-mapper.ts) —
 *    the old `projectName` field sent the real name verbatim.
 *  - `canonicalizedParameterDigest` replaces sending any raw path/command:
 *    a hash of the (locally-canonicalized, never-transmitted) operation
 *    target, letting the dashboard notice "the same target was hit again"
 *    without ever learning what that target actually was.
 *  - `targetClass`/`riskFactors` are coarse, rule-category-derived tags
 *    (see @velar-dev/rules' RuleCategory) — safe to send because they
 *    describe a CLASS of thing, never the specific instance.
 *  - `resultStatus`/`durationMs`/`errorClass` describe the outcome of
 *    VELAR'S OWN evaluation (did the hook finish deciding, or did it
 *    error?), not the downstream tool call's execution result — a
 *    PreToolUse hook runs BEFORE the tool executes and has no visibility
 *    into what the tool actually did afterward. Do not populate these as
 *    if they describe the tool's own success/failure; that data doesn't
 *    exist on this side of the hook boundary.
 *  - `expiry`/`nonce` exist for the approval-flow and (future, 4a-6)
 *    one-time-execution-permit machinery — `nonce` is per-envelope random,
 *    `expiry` is the approval timeout deadline when one is in flight (null
 *    otherwise).
 */

export const ACTION_ENVELOPE_VERSION = 1 as const

export const actionEnvelopeActionTypeSchema = z.enum(['file_read', 'file_write', 'bash', 'git', 'deploy', 'mcp_tool_call', 'unclassified'])
export const actionEnvelopeRiskLevelSchema = z.enum(['allow', 'warn', 'critical'])
export const actionEnvelopeDecisionSchema = z.enum(['allowed', 'blocked', 'approved', 'temp_allowed'])

/** How the decision was actually reached — a finer-grained replacement for the old approvalMethod. */
export const actionEnvelopeDecisionSourceSchema = z.enum([
  'local_rule_engine', // allow/warn — decided in-process, no human involved
  'terminal_prompt',
  'slack_approval',
  'timeout_fail_closed',
  'temp_allow_grant',
])

/**
 * Coarse category of what the action targeted — derived from
 * @velar-dev/rules' RuleCategory of the matched rule (see
 * classifyTargetClass() in the CLI). 'generic' covers allow-tier
 * operations that matched no specific category (the overwhelming majority
 * of traffic).
 */
export const actionEnvelopeTargetClassSchema = z.enum([
  'secrets',
  'production_database',
  'destructive_command',
  'deploy_target',
  'exfiltration_target',
  'package_ci_config',
  'generic',
])

/** Best-effort, conservative: only ever 'production' when a rule specifically detected a production marker; never guessed as 'development'. */
export const actionEnvelopeEnvironmentSchema = z.enum(['production', 'unknown'])

/** Outcome of Velar's own evaluation process — see the module doc above for why this is NOT the downstream tool's execution result. */
export const actionEnvelopeResultStatusSchema = z.enum(['decided', 'hook_error'])

export const actionEnvelopeSchema = z
  .object({
    envelopeVersion: z.literal(ACTION_ENVELOPE_VERSION),
    actionId: z.string().uuid(),
    tenantId: z.string().min(1).max(256),
    projectPseudonym: z.string().min(1).max(128),
    actor: z.string().min(1).max(256),
    agent: z.string().min(1).max(256),
    /** null: Claude Code does not currently expose its own version to a PreToolUse hook payload. Not guessed. */
    agentVersion: z.string().max(64).nullable(),
    actionType: actionEnvelopeActionTypeSchema,
    /**
     * Only ever populated when actionType is 'unclassified' — the raw
     * tool_name Claude Code sent. Safe to send in the clear: this field is
     * populated only for Claude Code's own closed set of built-in tool
     * names (e.g. WebFetch, WebSearch), never for an MCP tool name or any
     * other user-/org-defined string. Null otherwise, or when classify.ts
     * had no tool name to report at all.
     */
    unclassifiedToolName: z.string().max(128).nullable(),
    targetClass: actionEnvelopeTargetClassSchema,
    environment: actionEnvelopeEnvironmentSchema,
    /** null only when the operation carried no path/command to digest at all (e.g. a payload classify() couldn't derive anything from). */
    canonicalizedParameterDigest: z.string().max(128).nullable(),
    riskFactors: z.array(z.string().max(64)).max(16),
    riskLevel: actionEnvelopeRiskLevelSchema,
    /** Always exactly 1 element today — the rule engine is first-match-wins by design (see packages/rules/src/rules.ts). Plural because the schema shouldn't have to change if that's ever revisited. */
    matchedRuleIds: z.array(z.string().max(256)).min(1).max(16),
    /** @velar-dev/rules' package version at evaluation time. */
    policyVersion: z.string().min(1).max(64),
    requestedAt: z.string(),
    /** Approval timeout deadline (ISO) when a Slack approval is in flight; null otherwise. */
    expiry: z.string().nullable(),
    nonce: z.string().min(1).max(128),
    decision: actionEnvelopeDecisionSchema,
    decisionSource: actionEnvelopeDecisionSourceSchema,
    approver: z.string().max(256).nullable(),
    /** True when the hook payload carried agent_id/agent_type (Task-tool subagent), false for the top-level session. */
    isSubagent: z.boolean(),
    /**
     * Salted hash of the subagent's `agent_type` (e.g. `general-purpose`, or
     * a user-defined subagent name like `acme-billing-reviewer`) — never the
     * raw string, since it can embed org-internal naming, same concern as
     * MCP server names (deliberately not sent raw either). Null when
     * isSubagent is false, or when the payload carried no agent_type.
     */
    subagentTypeHash: z.string().max(64).nullable(),
    resultStatus: actionEnvelopeResultStatusSchema,
    /** Time Velar's own hook took to evaluate + decide, in ms — not the downstream tool's run time. */
    durationMs: z.number().int().nonnegative().nullable(),
    /** Coarse category of what went wrong when resultStatus is 'hook_error'; null when 'decided'. */
    errorClass: z.string().max(128).nullable(),
    cliVersion: z.string().min(1).max(64),
  })
  .strict()

export type ActionEnvelope = z.infer<typeof actionEnvelopeSchema>

/** The exact, and only, field names an Action Envelope may contain. */
export const ACTION_ENVELOPE_ALLOWED_KEYS: readonly string[] = Object.freeze(
  actionEnvelopeSchema.keyof().options as string[],
)
