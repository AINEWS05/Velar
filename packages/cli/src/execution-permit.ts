import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ExecutionPermit } from '@velar-dev/shared'
import { EXECUTION_PERMIT_VERSION } from '@velar-dev/shared'
import { getOrCreatePermitSecret } from './permit-secret'

type UnsignedPermit = Omit<ExecutionPermit, 'signature'>

/**
 * Canonical signing input: every field except `signature`, alphabetically
 * sorted by key, joined with a byte that can't appear in any field value.
 * Alphabetical order (rather than "whatever order the object was built in")
 * means signing and verifying can never silently diverge by construction
 * order — the same permit always canonicalizes to the same bytes.
 */
function canonicalize(permit: UnsignedPermit): string {
  return Object.keys(permit)
    .sort()
    .map((key) => `${key}=${String((permit as Record<string, unknown>)[key])}`)
    .join('')
}

function sign(permit: UnsignedPermit, secret: Buffer): string {
  return crypto.createHmac('sha256', secret).update(canonicalize(permit)).digest('hex')
}

export interface IssuePermitParams {
  ruleId: string
  canonicalizedParameterDigest: string
  targetClass: string
  environment: 'production' | 'unknown'
  agent: string
  projectPseudonym: string
  approvalMethod: 'terminal' | 'slack'
  approverId?: string | null
  /** ms from now until this permit expires. Defaults to 5 minutes — long enough to cover the immediate retry an agent does after a human approves, short enough that a stale permit isn't a standing bypass. */
  ttlMs?: number
  now?: number
  homeDir?: string
}

/** Issues a new one-time execution permit, signed with this machine's local HMAC key (see permit-secret.ts). */
export function issueExecutionPermit(params: IssuePermitParams): ExecutionPermit {
  const now = params.now ?? Date.now()
  const ttlMs = params.ttlMs ?? 5 * 60_000
  const unsigned: UnsignedPermit = {
    permitVersion: EXECUTION_PERMIT_VERSION,
    nonce: crypto.randomBytes(16).toString('hex'),
    ruleId: params.ruleId,
    canonicalizedParameterDigest: params.canonicalizedParameterDigest,
    targetClass: params.targetClass,
    environment: params.environment,
    agent: params.agent,
    projectPseudonym: params.projectPseudonym,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    approvalMethod: params.approvalMethod,
    approverId: params.approverId ?? null,
  }
  const secret = getOrCreatePermitSecret(params.homeDir)
  return { ...unsigned, signature: sign(unsigned, secret) }
}

export interface VerifyPermitContext {
  ruleId: string
  canonicalizedParameterDigest: string
  targetClass: string
  environment: 'production' | 'unknown'
  agent: string
  projectPseudonym: string
}

export type PermitRejectionReason =
  | 'invalid_signature'
  | 'expired'
  | 'already_consumed'
  | 'operation_mismatch'
  | 'environment_mismatch'
  | 'agent_mismatch'
  | 'project_mismatch'

export type VerifyPermitResult = { ok: true } | { ok: false; reason: PermitRejectionReason }

function consumedPermitsPath(velarDir: string): string {
  return path.join(velarDir, 'consumed-permits.json')
}

interface ConsumedEntry {
  nonce: string
  expiresAt: string
}

function readConsumed(velarDir: string): ConsumedEntry[] {
  const p = consumedPermitsPath(velarDir)
  if (!fs.existsSync(p)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Array.isArray(parsed) ? (parsed as ConsumedEntry[]) : []
  } catch {
    return []
  }
}

function writeConsumed(velarDir: string, entries: ConsumedEntry[]): void {
  fs.mkdirSync(velarDir, { recursive: true })
  fs.writeFileSync(consumedPermitsPath(velarDir), JSON.stringify(entries, null, 2) + '\n', 'utf8')
}

/**
 * Verifies a permit against the operation actually being evaluated right
 * now, and — only if every check passes — marks its nonce consumed so it
 * can never be presented again (one-time use). Checks run in this order:
 * signature (catches ANY tampering, including a single flipped character
 * in any field, since HMAC output is unrelated for even a 1-bit input
 * change) -> expiry -> already-consumed -> exact operation/environment/
 * agent/project match. A permit that fails any check grants nothing and is
 * NOT marked consumed (so retrying with a corrected/legitimate permit still
 * works).
 */
export function verifyAndConsumeExecutionPermit(
  permit: ExecutionPermit,
  context: VerifyPermitContext,
  velarDir: string,
  options: { now?: number; homeDir?: string } = {},
): VerifyPermitResult {
  const now = options.now ?? Date.now()
  const { signature, ...unsigned } = permit
  const secret = getOrCreatePermitSecret(options.homeDir)
  const expectedSignature = sign(unsigned, secret)

  const providedSigBuf = Buffer.from(signature, 'hex')
  const expectedSigBuf = Buffer.from(expectedSignature, 'hex')
  const signatureValid =
    providedSigBuf.length === expectedSigBuf.length && crypto.timingSafeEqual(providedSigBuf, expectedSigBuf)
  if (!signatureValid) return { ok: false, reason: 'invalid_signature' }

  if (new Date(permit.expiresAt).getTime() <= now) return { ok: false, reason: 'expired' }

  const consumed = readConsumed(velarDir).filter((e) => new Date(e.expiresAt).getTime() > now)
  if (consumed.some((e) => e.nonce === permit.nonce)) return { ok: false, reason: 'already_consumed' }

  if (
    permit.ruleId !== context.ruleId ||
    permit.canonicalizedParameterDigest !== context.canonicalizedParameterDigest ||
    permit.targetClass !== context.targetClass
  ) {
    return { ok: false, reason: 'operation_mismatch' }
  }
  if (permit.environment !== context.environment) return { ok: false, reason: 'environment_mismatch' }
  if (permit.agent !== context.agent) return { ok: false, reason: 'agent_mismatch' }
  if (permit.projectPseudonym !== context.projectPseudonym) return { ok: false, reason: 'project_mismatch' }

  consumed.push({ nonce: permit.nonce, expiresAt: permit.expiresAt })
  writeConsumed(velarDir, consumed)
  return { ok: true }
}
