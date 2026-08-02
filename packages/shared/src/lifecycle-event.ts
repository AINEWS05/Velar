import { z } from 'zod'

/**
 * Phase 4a-2 — Lifecycle Event v1.
 *
 * A SEPARATE stream from the Action Envelope (action-envelope.ts): these
 * are one-off adoption milestones ("this project got set up", "this
 * install actually blocked something for real"), not per-operation
 * classification data. Never conflate `test_pass` (a synthetic self-test
 * the user or CI ran on purpose) with `first_real_critical_block` (an
 * actual dangerous operation the hook stopped) — mixing them into one
 * "protection is working" number would overstate real-world efficacy with
 * synthetic test runs. Keep them as distinct event types, always.
 *
 * Only ever sent when the CLI is configured (`velar login` has run) — a
 * fully local, never-logged-in user is invisible to this stream by
 * construction. Any aggregate built from this data on the dashboard side
 * must therefore be labeled "connected installs", never "total installs"
 * or "all installs" — this stream structurally cannot see the
 * local-only population at all.
 */

export const LIFECYCLE_EVENT_VERSION = 1 as const

export const lifecycleEventTypeSchema = z.enum([
  'init_success',
  'doctor_pass',
  'test_pass',
  'first_real_decision',
  'first_real_critical_block',
  'uninstall_reported',
])

export const lifecycleEventSchema = z
  .object({
    lifecycleVersion: z.literal(LIFECYCLE_EVENT_VERSION),
    eventId: z.string().uuid(),
    tenantId: z.string().min(1).max(256),
    projectPseudonym: z.string().min(1).max(128),
    actor: z.string().min(1).max(256),
    eventType: lifecycleEventTypeSchema,
    occurredAt: z.string(),
    cliVersion: z.string().min(1).max(64),
  })
  .strict()

export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>

export const LIFECYCLE_EVENT_ALLOWED_KEYS: readonly string[] = Object.freeze(
  lifecycleEventSchema.keyof().options as string[],
)
