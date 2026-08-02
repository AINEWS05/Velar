import { z } from 'zod'

/**
 * Phase 4a-6 — One-time execution permit.
 *
 * A cryptographically signed, single-use grant that authorizes exactly one
 * previously-approved operation to proceed — not "this rule, for N minutes"
 * (that's the coarser, already-shipped temp-allow.ts grant), but "this
 * exact operation, once". Bound to the operation's own
 * canonicalizedParameterDigest/targetClass/environment/agent/project so a
 * permit approved for one thing cannot be replayed against a
 * similar-but-different one, a different environment, or a different agent.
 *
 * `.strict()` — any field outside this allow-list is rejected, same
 * zero-knowledge posture as action-envelope.ts and wire-event.ts. Never
 * carries a raw path/command, only the digest of one.
 */

export const EXECUTION_PERMIT_VERSION = 1 as const

export const executionPermitSchema = z
  .object({
    permitVersion: z.literal(EXECUTION_PERMIT_VERSION),
    /** Unique per issued permit — consumed (never reusable) on first successful verification. */
    nonce: z.string().min(16),
    ruleId: z.string().min(1),
    /** Binds this permit to the exact operation it was approved for — never a raw path/command. */
    canonicalizedParameterDigest: z.string().length(64),
    targetClass: z.string().min(1),
    environment: z.enum(['production', 'unknown']),
    /** Which agent may consume this permit — rejects cross-agent reuse (e.g. issued for claude-code, presented by codex). */
    agent: z.string().min(1),
    projectPseudonym: z.string().min(1),
    issuedAt: z.string(),
    expiresAt: z.string(),
    approvalMethod: z.enum(['terminal', 'slack']),
    approverId: z.string().nullable(),
    /** hex HMAC-SHA256 over every other field, canonically ordered — see execution-permit.ts (packages/cli). Any single-character tamper of any field invalidates this. */
    signature: z.string().length(64),
  })
  .strict()

export type ExecutionPermit = z.infer<typeof executionPermitSchema>

export const EXECUTION_PERMIT_ALLOWED_KEYS: readonly string[] = Object.freeze(executionPermitSchema.keyof().options as string[])
