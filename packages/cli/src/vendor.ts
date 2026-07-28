import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

export interface VendorResult {
  /** Absolute path to the vendored dist/index.js entry point. */
  entryPath: string
  /** Root of this version's vendored install, e.g. ~/.velar/vendor/0.2.0 */
  vendorRoot: string
  /** false when an up-to-date vendored copy already existed and nothing was copied. */
  copied: boolean
}

export function defaultVendorBaseDir(): string {
  return path.join(os.homedir(), '.velar', 'vendor')
}

function readPackageJson(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
}

/** Walks up from a resolved file to the directory whose package.json has the given name. */
function findPackageRootFromFile(filePath: string, expectedName: string): string {
  let dir = path.dirname(filePath)
  for (let i = 0; i < 20; i++) {
    const pkgJsonPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
      if (pkg.name === expectedName) return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`Could not find the package root of "${expectedName}" above ${filePath}`)
}

function scopedDestDir(vendorRoot: string, pkgName: string): string {
  const scoped = pkgName.match(/^(@[^/]+)\/(.+)$/)
  return scoped
    ? path.join(vendorRoot, 'node_modules', scoped[1], scoped[2])
    : path.join(vendorRoot, 'node_modules', pkgName)
}

/**
 * Copies an entire package directory (minus its own node_modules, which the
 * closure walk below handles separately). Deliberately doesn't special-case
 * a "dist/" convention: our own packages happen to follow it, but a
 * transitive third-party dependency (e.g. zod) can have any layout at all
 * (root-level .cjs/.js/.d.ts files, subpath exports like "./v4", etc.) — the
 * only shape guaranteed to satisfy whatever that package's own "exports"
 * map points at is the whole directory.
 */
function copyPackage(pkgRoot: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true })
  const nodeModulesDir = path.join(pkgRoot, 'node_modules')
  fs.cpSync(pkgRoot, destDir, {
    recursive: true,
    dereference: true,
    filter: (src) => src !== nodeModulesDir && !src.startsWith(nodeModulesDir + path.sep),
  })
}

/**
 * Copies the currently-running @velar-dev/cli, plus its full runtime
 * dependency closure, into a stable, version-pinned directory under the
 * user's home dir (~/.velar/vendor/<version>/).
 *
 * Why this exists: `velar init` writes a PreToolUse hook command into
 * .claude/settings.json that Claude Code re-invokes on every tool call,
 * potentially long after `velar init` ran and in a shell that knows nothing
 * about how it was installed. A bare `velar` command depends on PATH still
 * containing it at that later time — true for a global install, but false
 * once an `npx @velar-dev/cli init` invocation exits (npx does not add
 * anything to PATH) and unreliable for a project-local devDependency
 * install (node_modules/.bin is only on PATH inside npm scripts). Vendoring
 * a copy here and pointing the hook at its absolute path removes that
 * dependency entirely, uniformly across all three install methods.
 *
 * The dependency closure is discovered by walking each package's own
 * package.json "dependencies" field and re-resolving *from that package's
 * own directory* (not the CLI's) — this mirrors how Node/npm/pnpm actually
 * resolve a dependency's own dependencies (pnpm in particular does not
 * hoist transitive deps to a requesting package that didn't declare them),
 * so no hardcoded package list needs to be kept in sync by hand as
 * packages/{rules,shared}/package.json evolve.
 */
export function vendorCli(options: { vendorBaseDir?: string; cliRoot?: string } = {}): VendorResult {
  const cliRoot = options.cliRoot ?? findPackageRootFromFile(__filename, '@velar-dev/cli')
  const cliPkg = readPackageJson(cliRoot)
  const version = cliPkg.version as string

  const vendorBaseDir = options.vendorBaseDir ?? defaultVendorBaseDir()
  const vendorRoot = path.join(vendorBaseDir, version)
  const markerPath = path.join(vendorRoot, '.velar-vendor-complete')
  const entryPath = path.join(vendorRoot, 'node_modules', '@velar-dev', 'cli', 'dist', 'index.js')

  if (fs.existsSync(markerPath) && fs.existsSync(entryPath)) {
    return { entryPath, vendorRoot, copied: false }
  }

  // Start clean in case a previous vendoring attempt was interrupted partway through.
  fs.rmSync(vendorRoot, { recursive: true, force: true })
  copyPackage(cliRoot, path.join(vendorRoot, 'node_modules', '@velar-dev', 'cli'))

  const visited = new Set<string>(['@velar-dev/cli'])
  const queue: Array<{ name: string; resolveFrom: string }> = Object.keys(
    (cliPkg.dependencies as Record<string, string> | undefined) ?? {},
  ).map((name) => ({ name, resolveFrom: cliRoot }))

  while (queue.length > 0) {
    const next = queue.shift()!
    if (visited.has(next.name)) continue
    visited.add(next.name)

    const depRequire = createRequire(path.join(next.resolveFrom, 'package.json'))
    const resolvedEntry = depRequire.resolve(next.name)
    const pkgRoot = findPackageRootFromFile(resolvedEntry, next.name)
    const pkg = readPackageJson(pkgRoot)

    copyPackage(pkgRoot, scopedDestDir(vendorRoot, next.name))

    for (const depName of Object.keys((pkg.dependencies as Record<string, string> | undefined) ?? {})) {
      queue.push({ name: depName, resolveFrom: pkgRoot })
    }
  }

  fs.writeFileSync(markerPath, new Date().toISOString())
  return { entryPath, vendorRoot, copied: true }
}

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

/**
 * Builds the exact command Claude Code should invoke for the PreToolUse
 * hook: the current Node executable running the vendored entry point
 * directly, by absolute path. No PATH lookup, no npx, no shell alias.
 */
export function buildHookCommand(entryPath: string): string {
  return `${shellQuote(process.execPath)} ${shellQuote(entryPath)} hook pre-tool-use`
}
