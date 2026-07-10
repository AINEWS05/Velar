import fs from 'node:fs'
import path from 'node:path'
import type { VelarWireEvent } from '@velar-dev/shared'

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

export function readQueue(velarDir: string): VelarWireEvent[] {
  const qPath = queuePath(velarDir)
  if (!fs.existsSync(qPath)) return []
  return fs
    .readFileSync(qPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as VelarWireEvent)
}

function writeQueue(velarDir: string, items: VelarWireEvent[]): void {
  const qPath = queuePath(velarDir)
  fs.mkdirSync(path.dirname(qPath), { recursive: true })
  const body = items.map((i) => JSON.stringify(i)).join('\n')
  fs.writeFileSync(qPath, items.length ? body + '\n' : '', 'utf8')
}

export function appendToQueue(velarDir: string, event: VelarWireEvent, warn: (msg: string) => void = () => {}): void {
  const qPath = queuePath(velarDir)
  fs.mkdirSync(path.dirname(qPath), { recursive: true })
  fs.appendFileSync(qPath, JSON.stringify(event) + '\n', 'utf8')
  enforceQueueLimit(velarDir, warn)
}

export function removeFromQueue(velarDir: string, eventId: string): void {
  const remaining = readQueue(velarDir).filter((e) => e.eventId !== eventId)
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
