/**
 * 4a-1 completion condition: using a temp HOME, run
 * `init -> doctor -> test -> uninstall` end to end against the REAL built
 * CLI (dist/index.js, spawned as a real subprocess — not the in-process
 * functions the other unit tests call directly) and verify the project
 * directory's file tree + content hashes are identical before and after
 * (zero residue), except for one explicitly documented exception: the
 * per-user vendor cache under $HOME/.velar/vendor/, which is deliberately
 * shared across projects and NOT torn down by a single project's uninstall.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const CLI_ENTRY = path.resolve(__dirname, '../dist/index.js')

beforeAll(() => {
  if (!fs.existsSync(CLI_ENTRY)) {
    throw new Error(`${CLI_ENTRY} does not exist — run \`pnpm --filter @velar-dev/cli build\` before this test.`)
  }
})

interface TreeEntry {
  relPath: string
  type: 'file' | 'dir'
  sha256?: string
}

/** Recursively snapshots a directory: every file/dir path (sorted) plus a content hash per file. */
function snapshotTree(root: string): TreeEntry[] {
  if (!fs.existsSync(root)) return []
  const entries: TreeEntry[] = []
  function walk(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      const relPath = path.relative(root, full).split(path.sep).join('/')
      const stat = fs.statSync(full)
      if (stat.isDirectory()) {
        entries.push({ relPath, type: 'dir' })
        walk(full)
      } else {
        entries.push({ relPath, type: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') })
      }
    }
  }
  walk(root)
  return entries
}

function runCli(args: string[], cwd: string, home: string) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 30_000,
  })
}

describe('clean-room round-trip: init -> doctor -> test -> uninstall', () => {
  it('leaves the project directory with zero residue (identical file tree + hashes before/after)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-roundtrip-home-'))
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-roundtrip-project-'))

    try {
      const before = snapshotTree(tmpProject)
      expect(before).toEqual([]) // sanity: truly empty to start

      const initResult = runCli(['init'], tmpProject, tmpHome)
      expect(initResult.status, `init stderr: ${initResult.stderr}\nstdout: ${initResult.stdout}`).toBe(0)

      const doctorResult = runCli(['doctor'], tmpProject, tmpHome)
      expect(doctorResult.status, `doctor stderr: ${doctorResult.stderr}\nstdout: ${doctorResult.stdout}`).toBe(0)

      const testResult = runCli(['test'], tmpProject, tmpHome)
      expect(testResult.status, `test stderr: ${testResult.stderr}\nstdout: ${testResult.stdout}`).toBe(0)

      // Confirm real state got created before we assert it's gone afterward
      // (otherwise "zero residue" would be trivially true for a broken init).
      expect(fs.existsSync(path.join(tmpProject, '.claude', 'settings.local.json'))).toBe(true)
      expect(fs.existsSync(path.join(tmpProject, '.velar', 'install-receipt.json'))).toBe(true)

      const uninstallResult = runCli(['uninstall'], tmpProject, tmpHome)
      expect(uninstallResult.status, `uninstall stderr: ${uninstallResult.stderr}\nstdout: ${uninstallResult.stdout}`).toBe(0)

      const after = snapshotTree(tmpProject)
      expect(after).toEqual(before) // zero residue: byte-for-byte identical to the pre-init state
    } finally {
      fs.rmSync(tmpProject, { recursive: true, force: true })
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  }, 60_000)

  it('init + codex-init together also leave zero residue after uninstall (both adapters)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-roundtrip-home-'))
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-roundtrip-project-'))

    try {
      const before = snapshotTree(tmpProject)

      const initResult = runCli(['init'], tmpProject, tmpHome)
      expect(initResult.status, `init stderr: ${initResult.stderr}`).toBe(0)
      const codexInitResult = runCli(['codex-init'], tmpProject, tmpHome)
      expect(codexInitResult.status, `codex-init stderr: ${codexInitResult.stderr}\nstdout: ${codexInitResult.stdout}`).toBe(0)

      expect(fs.existsSync(path.join(tmpProject, '.codex', 'hooks.json'))).toBe(true)
      expect(fs.existsSync(path.join(tmpProject, '.velar', 'codex-install-receipt.json'))).toBe(true)

      const uninstallResult = runCli(['uninstall'], tmpProject, tmpHome)
      expect(uninstallResult.status, `uninstall stderr: ${uninstallResult.stderr}`).toBe(0)

      const after = snapshotTree(tmpProject)
      expect(after).toEqual(before)
    } finally {
      fs.rmSync(tmpProject, { recursive: true, force: true })
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  }, 60_000)

  it('documents the one intentional exception: the per-user vendor cache under $HOME persists after uninstall', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-roundtrip-home-'))
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'velar-roundtrip-project-'))

    try {
      runCli(['init'], tmpProject, tmpHome)
      runCli(['uninstall'], tmpProject, tmpHome)

      const vendorDir = path.join(tmpHome, '.velar', 'vendor')
      expect(fs.existsSync(vendorDir)).toBe(true)
      const versions = fs.readdirSync(vendorDir)
      expect(versions.length).toBeGreaterThan(0)

      // Nothing else under $HOME/.velar/ besides the vendor cache — no stray
      // config.json (never logged in), no leftover per-project state.
      const homeVelarContents = fs.readdirSync(path.join(tmpHome, '.velar')).sort()
      expect(homeVelarContents).toEqual(['vendor'])
    } finally {
      fs.rmSync(tmpProject, { recursive: true, force: true })
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  }, 60_000)
})
