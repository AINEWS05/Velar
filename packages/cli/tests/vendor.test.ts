import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vendorCli, buildHookInvocation, defaultVendorBaseDir, fingerprintFile } from '../src/vendor'
import crypto from 'node:crypto'

let tmpDir: string
let cliRoot: string
let vendorBaseDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-vendor-test-'))
  vendorBaseDir = path.join(tmpDir, 'vendor-base')

  // Fabricate a minimal, self-contained fake install tree: a fake
  // @velar-dev/cli depending on a fake scoped dep, which itself depends on
  // an unscoped leaf dep -- mirrors the real cli -> shared -> zod shape
  // without requiring a prior `pnpm build` of the real packages.
  cliRoot = path.join(tmpDir, 'fake-cli')
  fs.mkdirSync(path.join(cliRoot, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(cliRoot, 'package.json'),
    JSON.stringify({
      name: '@velar-dev/cli',
      version: '9.9.9',
      dependencies: { '@fake-scope/dep': '1.0.0' },
    }),
  )
  fs.writeFileSync(path.join(cliRoot, 'dist', 'index.js'), '// fake cli entry\n')

  const depRoot = path.join(cliRoot, 'node_modules', '@fake-scope', 'dep')
  fs.mkdirSync(path.join(depRoot, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(depRoot, 'package.json'),
    JSON.stringify({
      name: '@fake-scope/dep',
      version: '1.0.0',
      main: 'dist/index.js',
      dependencies: { 'fake-leaf': '1.0.0' },
    }),
  )
  fs.writeFileSync(path.join(depRoot, 'dist', 'index.js'), '// fake dep entry\n')

  const leafRoot = path.join(depRoot, 'node_modules', 'fake-leaf')
  fs.mkdirSync(path.join(leafRoot, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(leafRoot, 'package.json'),
    JSON.stringify({ name: 'fake-leaf', version: '1.0.0', main: 'dist/index.js' }),
  )
  fs.writeFileSync(path.join(leafRoot, 'dist', 'index.js'), '// fake leaf entry\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('vendorCli', () => {
  it('copies the cli and its transitive dependency closure into a version-pinned dir', () => {
    const result = vendorCli({ vendorBaseDir, cliRoot })

    expect(result.copied).toBe(true)
    expect(result.vendorRoot).toBe(path.join(vendorBaseDir, '9.9.9'))
    expect(fs.existsSync(result.entryPath)).toBe(true)
    expect(fs.readFileSync(result.entryPath, 'utf8')).toBe('// fake cli entry\n')

    const depEntry = path.join(result.vendorRoot, 'node_modules', '@fake-scope', 'dep', 'dist', 'index.js')
    expect(fs.existsSync(depEntry)).toBe(true)

    const leafEntry = path.join(result.vendorRoot, 'node_modules', 'fake-leaf', 'dist', 'index.js')
    expect(fs.existsSync(leafEntry)).toBe(true)
  })

  it('copies arbitrary root-level files a dependency might have outside a dist/ convention', () => {
    // Real third-party deps (e.g. zod) ship root-level .cjs/.d.ts files and
    // subpath exports (./v4, ./mini, ...) with no "dist/" folder at all —
    // vendoring must not assume every package looks like our own tsc output.
    fs.writeFileSync(path.join(cliRoot, 'index.cjs'), 'module.exports = {}\n')
    const result = vendorCli({ vendorBaseDir, cliRoot })
    expect(fs.existsSync(path.join(result.vendorRoot, 'node_modules', '@velar-dev', 'cli', 'index.cjs'))).toBe(true)
  })

  it('excludes each copied package\'s own node_modules (handled separately by the closure walk)', () => {
    const result = vendorCli({ vendorBaseDir, cliRoot })
    const depNodeModules = path.join(
      result.vendorRoot,
      'node_modules',
      '@fake-scope',
      'dep',
      'node_modules',
    )
    expect(fs.existsSync(depNodeModules)).toBe(false)
  })

  it('is idempotent: a second call for the same version does not re-copy', () => {
    const first = vendorCli({ vendorBaseDir, cliRoot })
    expect(first.copied).toBe(true)

    // Mutate the source after the first vendor pass -- if the second call
    // were to blindly re-copy we'd see the change reflected; it shouldn't.
    fs.writeFileSync(path.join(cliRoot, 'dist', 'index.js'), '// mutated\n')

    const second = vendorCli({ vendorBaseDir, cliRoot })
    expect(second.copied).toBe(false)
    expect(fs.readFileSync(second.entryPath, 'utf8')).toBe('// fake cli entry\n')
  })

  it('re-vendors when the version changes, without touching the previous version directory', () => {
    const v1 = vendorCli({ vendorBaseDir, cliRoot })

    fs.writeFileSync(
      path.join(cliRoot, 'package.json'),
      JSON.stringify({
        name: '@velar-dev/cli',
        version: '10.0.0',
        dependencies: { '@fake-scope/dep': '1.0.0' },
      }),
    )
    fs.writeFileSync(path.join(cliRoot, 'dist', 'index.js'), '// v2 entry\n')

    const v2 = vendorCli({ vendorBaseDir, cliRoot })
    expect(v2.vendorRoot).not.toBe(v1.vendorRoot)
    expect(fs.readFileSync(v2.entryPath, 'utf8')).toBe('// v2 entry\n')
    expect(fs.readFileSync(v1.entryPath, 'utf8')).toBe('// fake cli entry\n')
  })

  it('defaults vendorBaseDir to ~/.velar/vendor', () => {
    expect(defaultVendorBaseDir()).toBe(path.join(os.homedir(), '.velar', 'vendor'))
  })

  it('returns entryFingerprint matching a fresh sha256 of the entry file', () => {
    const result = vendorCli({ vendorBaseDir, cliRoot })
    expect(result.entryFingerprint).toBe(fingerprintFile(result.entryPath))
    expect(result.entryFingerprint).toBe(
      crypto.createHash('sha256').update('// fake cli entry\n').digest('hex'),
    )
  })

  it('returns the same entryFingerprint on the idempotent (not-recopied) path', () => {
    const first = vendorCli({ vendorBaseDir, cliRoot })
    const second = vendorCli({ vendorBaseDir, cliRoot })
    expect(second.copied).toBe(false)
    expect(second.entryFingerprint).toBe(first.entryFingerprint)
  })
})

describe('buildHookInvocation', () => {
  it('quotes the node executable and script path and appends the hook subcommand', () => {
    const invocation = buildHookInvocation('C:\\Program Files\\velar\\index.js')
    expect(invocation.command).toContain('hook pre-tool-use')
    expect(invocation.command).toContain('"C:\\Program Files\\velar\\index.js"')
    expect(invocation.command.startsWith('"')).toBe(true)
  })

  it('escapes embedded double quotes in the entry path in the shell command form', () => {
    const invocation = buildHookInvocation('/tmp/weird"path/index.js')
    expect(invocation.command).toContain('\\"path')
  })

  it('exposes unquoted executable/args for direct shell:false spawning', () => {
    const invocation = buildHookInvocation('/tmp/weird"path/index.js')
    expect(invocation.executable).toBe(process.execPath)
    expect(invocation.args).toEqual(['/tmp/weird"path/index.js', 'hook', 'pre-tool-use'])
  })
})
