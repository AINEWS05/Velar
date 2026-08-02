import { describe, it, expect } from 'vitest'
import { lifecycleEventSchema, LIFECYCLE_EVENT_ALLOWED_KEYS, LIFECYCLE_EVENT_VERSION, lifecycleEventTypeSchema } from '../src/lifecycle-event'

const validEvent = {
  lifecycleVersion: LIFECYCLE_EVENT_VERSION,
  eventId: '123e4567-e89b-12d3-a456-426614174000',
  tenantId: 'org_abc123',
  projectPseudonym: 'a1b2c3d4e5f6a1b2',
  actor: 'a1b2c3d4e5f6',
  eventType: 'init_success',
  occurredAt: new Date().toISOString(),
  cliVersion: '0.2.0',
}

describe('lifecycleEventSchema', () => {
  it('parses a fully valid event', () => {
    expect(() => lifecycleEventSchema.parse(validEvent)).not.toThrow()
  })

  it('accepts every declared event type', () => {
    for (const t of lifecycleEventTypeSchema.options) {
      expect(() => lifecycleEventSchema.parse({ ...validEvent, eventType: t })).not.toThrow()
    }
  })

  it('rejects an event type outside the allow-list', () => {
    const result = lifecycleEventSchema.safeParse({ ...validEvent, eventType: 'something_else' })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown field', () => {
    const result = lifecycleEventSchema.safeParse({ ...validEvent, filePath: '/x' })
    expect(result.success).toBe(false)
  })

  it('keeps test_pass and first_real_critical_block as distinct, never-conflated event types', () => {
    expect(lifecycleEventTypeSchema.options).toContain('test_pass')
    expect(lifecycleEventTypeSchema.options).toContain('first_real_critical_block')
    expect('test_pass').not.toBe('first_real_critical_block')
  })
})

describe('LIFECYCLE_EVENT_ALLOWED_KEYS', () => {
  it('never contains any content-carrying field name', () => {
    const forbidden = ['filePath', 'path', 'command', 'prompt', 'content']
    for (const f of forbidden) {
      expect(LIFECYCLE_EVENT_ALLOWED_KEYS).not.toContain(f)
    }
  })
})
