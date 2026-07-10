import fs from 'node:fs'
import path from 'node:path'
import type { TempAllowGrant } from '@velar/shared'

function tempAllowsPath(velarDir: string): string {
  return path.join(velarDir, 'temp-allows.json')
}

function readAll(velarDir: string): TempAllowGrant[] {
  const p = tempAllowsPath(velarDir)
  if (!fs.existsSync(p)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Array.isArray(parsed) ? (parsed as TempAllowGrant[]) : []
  } catch {
    return []
  }
}

function writeAll(velarDir: string, grants: TempAllowGrant[]): void {
  fs.mkdirSync(velarDir, { recursive: true })
  fs.writeFileSync(tempAllowsPath(velarDir), JSON.stringify(grants, null, 2) + '\n', 'utf8')
}

/** Removes any grant whose expiresAt has already passed. */
export function pruneExpiredTempAllows(velarDir: string, now: number = Date.now()): void {
  const all = readAll(velarDir)
  const fresh = all.filter((g) => new Date(g.expiresAt).getTime() > now)
  if (fresh.length !== all.length) writeAll(velarDir, fresh)
}

export function isTempAllowed(velarDir: string, ruleId: string, projectName: string, now: number = Date.now()): boolean {
  return readAll(velarDir).some(
    (g) => g.ruleId === ruleId && g.projectName === projectName && new Date(g.expiresAt).getTime() > now,
  )
}

export function addTempAllow(velarDir: string, grant: TempAllowGrant, now: number = Date.now()): void {
  const fresh = readAll(velarDir).filter((g) => new Date(g.expiresAt).getTime() > now)
  fresh.push(grant)
  writeAll(velarDir, fresh)
}
