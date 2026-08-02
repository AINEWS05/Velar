import fs from 'node:fs'
import path from 'node:path'
import type { ActionEnvelope } from '@velar-dev/shared'

/**
 * Offline queue for events that couldn't reach apps/api. The local
 * allow/block decision has already been finalized before anything touches
 * this queue — a full outage here never affects enforcement, only how soon
 * the dashboard finds out about it.
 */
export const QUEUE_MAX = 1000

function queuePath(velarDir: string): string {
  return path.join(velarDir, 'queue', 'pending.jsonl')
}

/**
 * Skips (rather than crashes on) a line that isn't valid JSON or doesn't
 * look like an ActionEnvelope — e.g. a queue file left behind by a CLI
 * version before the 4a-2 wire-format change. Losing an already-stale,
 * already-unsendable queued event is the safe failure mode here; the local
 * allow/block enforcement decision it came from was already finalized long
 * before it ever reached this queue.
 */
function parseQueueLine(line: string): ActionEnvelope | null {
  try {
    const parsed = JSON.parse(line)
    if (parsed && typeof parsed === 'object' && typeof parsed.actionId === 'string') {
      return parsed as ActionEnvelope
    }
    return null
  } catch {
    return null
  }
}

export function readQueue(velarDir: string): ActionEnvelope[] {
  const qPath = queuePath(velarDir)
  if (!fs.existsSync(qPath)) return []
  return fs
    .readFileSync(qPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map(parseQueueLine)
    .filter((e): e is ActionEnvelope => e !== null)
}

function writeQueue(velarDir: string, items: ActionEnvelope[]): void {
  const qPath = queuePath(velarDir)
  fs.mkdirSync(path.dirname(qPath), { recursive: true })
  const body = items.map((i) => JSON.stringify(i)).join('\n')
  fs.writeFileSync(qPath, items.length ? body + '\n' : '', 'utf8')
}

export function appendToQueue(velarDir: string, event: ActionEnvelope, warn: (msg: string) => void = () => {}): void {
  const qPath = queuePath(velarDir)
  fs.mkdirSync(path.dirname(qPath), { recursive: true })
  fs.appendFileSync(qPath, JSON.stringify(event) + '\n', 'utf8')
  enforceQueueLimit(velarDir, warn)
}

export function removeFromQueue(velarDir: string, actionId: string): void {
  const remaining = readQueue(velarDir).filter((e) => e.actionId !== actionId)
  writeQueue(velarDir, remaining)
}

function enforceQueueLimit(velarDir: string, warn: (msg: string) => void): void {
  const items = readQueue(velarDir)
  if (items.length > QUEUE_MAX) {
    const trimmed = items.slice(items.length - QUEUE_MAX)
    writeQueue(velarDir, trimmed)
    warn(`⚠ Velar: local event queue exceeded ${QUEUE_MAX} items — oldest entries were discarded.\n`)
  }
}
