import type { ActionEnvelope } from '@velar-dev/shared'
import { appendToQueue, readQueue, removeFromQueue } from './queue'

export interface ReporterConfig {
  apiBaseUrl: string
  token: string
}

export type FetchFn = typeof fetch

const SEND_TIMEOUT_MS = 1500

/** One bounded-timeout attempt to send a single event. Never throws. */
export async function sendEvent(config: ReporterConfig, event: ActionEnvelope, fetchImpl: FetchFn = fetch): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${config.apiBaseUrl}/api/v1/events`, {
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

/**
 * Reports one event: durably queues it first (a synchronous, fast local
 * write — never lost even if the process is killed a moment later), then
 * makes one best-effort, bounded-timeout attempt to flush the whole queue.
 *
 * This function never throws and never affects the already-finalized local
 * allow/block decision — call it AFTER that decision and its exit code are
 * settled. If there's no config (no `velar login` yet), the event simply
 * stays queued locally.
 */
export async function reportEvent(
  velarDir: string,
  config: ReporterConfig | null,
  event: ActionEnvelope,
  fetchImpl: FetchFn = fetch,
  warn: (msg: string) => void = () => {},
): Promise<void> {
  appendToQueue(velarDir, event, warn)
  if (!config) return
  await flushQueue(velarDir, config, fetchImpl)
}

/**
 * Sends queued events oldest-first, stopping at the first failure so a
 * downed API doesn't get hammered — the rest just stay queued for next time.
 */
export async function flushQueue(
  velarDir: string,
  config: ReporterConfig,
  fetchImpl: FetchFn = fetch,
): Promise<{ sent: number; remaining: number }> {
  const queue = readQueue(velarDir)
  let sent = 0
  for (const item of queue) {
    const ok = await sendEvent(config, item, fetchImpl)
    if (!ok) break
    removeFromQueue(velarDir, item.actionId)
    sent += 1
  }
  return { sent, remaining: readQueue(velarDir).length }
}
