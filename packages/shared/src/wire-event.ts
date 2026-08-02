import { z } from 'zod'

/**
 * Phase 2 — the wire contract between the Velar CLI and apps/api.
 *
 * This is the single most important artifact of Phase 2: an ALLOW-LIST
 * schema. `.strict()` means any field not named here is a validation error,
 * not silently dropped — so this file is also the enforcement point for the
 * zero-knowledge promise on the network boundary. There is deliberately no
 * field here for a file path, command text, prompt, or file content.
 *
 * Note: the local-only Phase 1 `Decision` type (in types.ts) includes
 * 'warned', because a warn is its own local outcome. On the wire, a warn
 * is reported as `decision: 'allowed'` (it was never blocked) with
 * `riskLevel: 'warn'` preserved — see mapDecisionForWire() in the CLI
 * reporter. This file does not redefine or import that local type.
 */

export const WIRE_SCHEMA_VERSION = 1 as const

export const wireOperationTypeSchema = z.enum(['file_read', 'file_write', 'bash', 'git', 'deploy', 'mcp_tool_call', 'unclassified'])
export const wireRiskLevelSchema = z.enum(['allow', 'warn', 'critical'])
export const wireDecisionSchema = z.enum(['allowed', 'blocked', 'approved', 'temp_allowed'])
export const wireApprovalMethodSchema = z.enum(['slack', 'terminal', 'timeout', 'none'])

export const velarWireEventSchema = z
  .object({
    schemaVersion: z.literal(WIRE_SCHEMA_VERSION),
    eventId: z.string().uuid(),
    timestamp: z.string(),
    orgId: z.string().min(1).max(256),
    userIdHash: z.string().min(1).max(256),
    projectName: z.string().min(1).max(256),
    agentName: z.string().min(1).max(256),
    operationType: wireOperationTypeSchema,
    ruleId: z.string().min(1).max(256),
    riskLevel: wireRiskLevelSchema,
    decision: wireDecisionSchema,
    approverId: z.string().max(256).nullable(),
    approvalMethod: wireApprovalMethodSchema,
    approvalLatencyMs: z.number().int().nonnegative().nullable(),
    cliVersion: z.string().min(1).max(64),
  })
  .strict()

export type VelarWireEvent = z.infer<typeof velarWireEventSchema>

/** The exact, and only, field names a wire event may contain. */
export const WIRE_EVENT_ALLOWED_KEYS: readonly string[] = Object.freeze(
  velarWireEventSchema.keyof().options as string[],
)
