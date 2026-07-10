import { z } from 'zod'
import { wireOperationTypeSchema } from './wire-event'

/**
 * Phase 2 approval-request wire contract. Same zero-knowledge rule as
 * wire-event.ts: no file path, no command text, no prompt/content. The
 * Slack card is built server-side from `ruleId` + `ruleDescription` only.
 */

export const approvalCreateRequestSchema = z
  .object({
    ruleId: z.string().min(1).max(256),
    riskLevel: z.literal('critical'),
    projectName: z.string().min(1).max(256),
    agentName: z.string().min(1).max(256),
    operationType: wireOperationTypeSchema,
    /** Human-readable rule description for the Slack card — not the raw operation content. */
    ruleDescription: z.string().min(1).max(512),
  })
  .strict()

export type ApprovalCreateRequest = z.infer<typeof approvalCreateRequestSchema>

export const approvalStatusValues = ['pending', 'approved', 'blocked', 'timed_out'] as const
export type ApprovalStatus = (typeof approvalStatusValues)[number]

export interface ApprovalCreateResponse {
  approvalId: string
  status: 'pending'
  expiresAt: string
  /**
   * Whether apps/api actually posted a Slack card for this request. When
   * false (org has no Slack configured, or posting failed), the CLI should
   * fall back to a local terminal prompt immediately rather than polling
   * for up to 120s for a card that will never appear.
   */
  slackPosted: boolean
}

export interface TempAllowGrant {
  ruleId: string
  projectName: string
  expiresAt: string
}

export interface ApprovalStatusResponse {
  approvalId: string
  status: ApprovalStatus
  approverId: string | null
  tempAllow: TempAllowGrant | null
}
