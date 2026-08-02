import fs from 'node:fs'
import path from 'node:path'

/**
 * The running CLI's own package.json version, resolved by walking up from
 * this file (works identically from dist/ at runtime and from src/ under
 * vitest) — not hand-maintained as a separate constant, which drifts.
 */
export function ownCliVersion(): string {
  let dir = __dirname
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg.name === '@velar-dev/cli' && typeof pkg.version === 'string') {
        return pkg.version
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return '0.0.0-unknown'
}
