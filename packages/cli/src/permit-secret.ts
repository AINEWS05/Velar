import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

/**
 * The HMAC key used to sign/verify execution permits (execution-permit.ts).
 * Per-machine, not per-project — stored alongside the vendor cache at
 * `~/.velar/permit-secret` (hex-encoded 32 random bytes from Node's own
 * `crypto.randomBytes`, an established primitive — never a home-grown
 * generator). Generated once on first use; every permit issued and
 * verified on this machine uses the same key.
 *
 * This is a LOCAL integrity primitive: it stops a permit approved for one
 * operation from being tampered with or replayed against a different one on
 * this machine, and it isn't defeated by an honest bug or a copy-paste
 * mistake. It does not defend against an attacker who already has
 * arbitrary read access to this machine's filesystem — the same threat
 * model the existing temp-allow.ts grant and vendored-hook trust already
 * operate under.
 */
export function permitSecretPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.velar', 'permit-secret')
}

export function getOrCreatePermitSecret(homeDir: string = os.homedir()): Buffer {
  const filePath = permitSecretPath(homeDir)
  if (fs.existsSync(filePath)) {
    const hex = fs.readFileSync(filePath, 'utf8').trim()
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex')
    // Malformed/corrupted — regenerate rather than use a weak or unusable key.
  }
  const secret = crypto.randomBytes(32)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, secret.toString('hex') + '\n', { encoding: 'utf8', mode: 0o600 })
  return secret
}
