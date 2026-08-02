import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { LIFECYCLE_EVENT_VERSION } from '@velar-dev/shared'
import type { LifecycleEvent } from '@velar-dev/shared'
import { computeUserIdHash, computeProjectPseudonym } from './wire-mapper'
import { ownCliVersion } from './cli-version'
import type { ReporterConfig, FetchFn } from './reporter'

/**
 * Phase 4a-2 — Lifecycle Event tracking and (best-effort) reporting.
 *
 * A SEPARATE stream from the per-operation Action Envelope (wire-mapper.ts)
 * — its own local queue file, its own wire shape. See lifecycle-event.ts in
 * @velar-dev/shared for the full rationale on why this must never be
 * conflated with Action Envelopes, and why any dashboard aggregate built
 * from it must say "connected installs", never "total installs".
 */

/** These fire at most once per project, ever — every other type fires every time it's called (each call is already a discrete, deliberate action). */
const FIRST_ONLY_TYPES: ReadonlySet<LifecycleEvent['eventType']> = new Set([
  'first_real_decision',
  'first_real_critical_block',
])

function stateFilePath(velarDir: string): string {
  return path.join(velarDir, 'lifecycle-state.json')
}

function lifecycleQueuePath(velarDir: string): string {
  return path.join(velarDir, 'queue', 'lifecycle-pending.jsonl')
}

function readFiredTypes(velarDir: string): Set<string> {
  const filePath = stateFilePath(velarDir)
  if (!fs.existsSync(filePath)) return new Set()
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return new Set(Array.isArray(parsed?.firedTypes) ? parsed.firedTypes : [])
  } catch {
    return new Set()
  }
}

function markFired(velarDir: string, type: string): void {
  const fired = readFiredTypes(velarDir)
  fired.add(type)
  fs.mkdirSync(velarDir, { recursive: true })
  fs.writeFileSync(stateFilePath(velarDir), JSON.stringify({ firedTypes: [...fired] }, null, 2) + '\n', 'utf8')
}

function readLifecycleQueue(velarDir: string): LifecycleEvent[] {
  const qPath = lifecycleQueuePath(velarDir)
  if (!fs.existsSync(qPath)) return []
  return fs
    .readFileSync(qPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        const parsed = JSON.parse(l)
        return parsed && typeof parsed.eventId === 'string' ? (parsed as LifecycleEvent) : null
      } catch {
        return null
      }
    })
    .filter((e): e is LifecycleEvent => e !== null)
}

function writeLifecycleQueue(velarDir: string, items: LifecycleEvent[]): void {
  const qPath = lifecycleQueuePath(velarDir)
  fs.mkdirSync(path.dirname(qPath), { recursive: true })
  fs.writeFileSync(qPath, items.length ? items.map((i) => JSON.stringify(i)).join('\n') + '\n' : '', 'utf8')
}

function appendToLifecycleQueue(velarDir: string, event: LifecycleEvent): void {
  const qPath = lifecycleQueuePath(velarDir)
  fs.mkdirSync(path.dirname(qPath), { recursive: true })
  fs.appendFileSync(qPath, JSON.stringify(event) + '\n', 'utf8')
}

export function buildLifecycleEvent(
  type: LifecycleEvent['eventType'],
  context: { tenantId: string; projectName: string },
): LifecycleEvent {
  return {
    lifecycleVersion: LIFECYCLE_EVENT_VERSION,
    eventId: randomUUID(),
    tenantId: context.tenantId,
    projectPseudonym: computeProjectPseudonym(context.tenantId, context.projectName),
    actor: computeUserIdHash(),
    eventType: type,
    occurredAt: new Date().toISOString(),
    cliVersion: ownCliVersion(),
  }
}

const SEND_TIMEOUT_MS = 1500

/**
 * One direct, bounded-timeout best-effort send — bypasses the local queue
 * entirely. Used for `uninstall_reported`: by the time it's known,
 * .velar/ (where the queue would live) is about to be deleted anyway, so
 * there's no "later" to durably retry into.
 */
export async function sendLifecycleEvent(config: ReporterConfig, event: LifecycleEvent, fetchImpl: FetchFn): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${config.apiBaseUrl}/api/v1/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(event),
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function flushLifecycleQueue(velarDir: string, config: ReporterConfig, fetchImpl: FetchFn): Promise<void> {
  const queue = readLifecycleQueue(velarDir)
  const remaining: LifecycleEvent[] = []
  let stillSending = true
  for (const item of queue) {
    if (stillSending) {
      const ok = await sendLifecycleEvent(config, item, fetchImpl)
      if (!ok) stillSending = false
    }
    if (!stillSending) remaining.push(item)
  }
  writeLifecycleQueue(velarDir, remaining)
}

/**
 * Records (and, if logged in, best-effort reports) a lifecycle milestone.
 *
 * `first_real_decision`/`first_real_critical_block` are deduplicated
 * PERMANENTLY per project via .velar/lifecycle-state.json, regardless of
 * login state at the time — this is deliberate: if a user runs Velar
 * locally-only for months, then logs in, the next real block must NOT be
 * (mis)reported as "first ever", since it isn't. The true first occurrence
 * is recorded locally the moment it happens; only the *reporting* of it is
 * gated on being logged in, and if it happened before login, it is never
 * retroactively (and misleadingly) reported as fresh.
 *
 * Nothing is queued or sent at all when `context.tenantId` is falsy (not
 * logged in) — see lifecycle-event.ts for why this is what makes any
 * server-side aggregate a count of "connected installs".
 */
export async function recordLifecycleMilestone(
  velarDir: string,
  type: LifecycleEvent['eventType'],
  context: { tenantId?: string | null; projectName: string },
  options: { reporterConfig?: ReporterConfig | null; fetchImpl?: FetchFn } = {},
): Promise<void> {
  if (FIRST_ONLY_TYPES.has(type)) {
    const fired = readFiredTypes(velarDir)
    if (fired.has(type)) return
    markFired(velarDir, type)
  }

  if (!context.tenantId) return

  const event = buildLifecycleEvent(type, { tenantId: context.tenantId, projectName: context.projectName })
  appendToLifecycleQueue(velarDir, event)
  if (options.reporterConfig) {
    await flushLifecycleQueue(velarDir, options.reporterConfig, options.fetchImpl ?? fetch)
  }
}
