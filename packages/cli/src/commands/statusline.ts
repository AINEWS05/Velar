import fs from 'node:fs'
import { resolveStatuslineText, installStatusLine } from '../statusline'

interface StatuslineStdinPayload {
  cwd?: string
  workspace?: { project_dir?: string; current_dir?: string }
}

/**
 * Claude Code invokes the statusLine command with the render JSON on stdin
 * (see https://docs.claude.com/.../statusline — `workspace.project_dir` is
 * the project root regardless of which subdirectory the session's `cwd`
 * has since moved into). Reading stdin synchronously is safe here: this
 * process is spawned fresh per render with the payload already fully
 * written by the time it starts, and the whole point of this command is to
 * finish fast, well inside Claude Code's 300ms debounce window.
 */
function readStdinPayload(): StatuslineStdinPayload | null {
  if (process.stdin.isTTY) return null
  try {
    const raw = fs.readFileSync(0, 'utf8')
    if (!raw.trim()) return null
    return JSON.parse(raw) as StatuslineStdinPayload
  } catch {
    return null
  }
}

/** `velar statusline` — prints the live "🛡 Velar monitoring" segment for Claude Code's statusLine setting. Never fails: an unreadable/missing stdin payload just falls back to process.cwd(). */
export function statuslineRenderCommand(fallbackCwd: string = process.cwd(), payload: StatuslineStdinPayload | null = readStdinPayload()): number {
  const cwd = payload?.workspace?.project_dir ?? payload?.cwd ?? fallbackCwd
  const text = resolveStatuslineText(cwd)
  if (text) console.log(text)
  return 0
}

/** `velar statusline install` — opts this project into the live status-line segment. Conflict-safe: refuses to clobber a statusLine that isn't already Velar's own unless `--force` is passed. */
export function statuslineInstallCommand(
  cwd: string = process.cwd(),
  args: string[] = [],
  options: { vendorBaseDir?: string; vendorCliRoot?: string } = {},
): number {
  const force = args.includes('--force')
  const result = installStatusLine(cwd, { force, ...options })

  if (result.status === 'already-installed') {
    console.log(`✔ Status line already shows Velar's live status in ${result.settingsPath}.`)
    return 0
  }
  if (result.status === 'conflict') {
    console.error(
      `✖ ${result.settingsPath} already has a different statusLine configured ` +
        `(command: ${JSON.stringify(result.existingCommand)}).\n` +
        '  Claude Code only supports one statusLine at a time, so Velar left it untouched.\n' +
        '  Re-run with `velar statusline install --force` to overwrite it, or configure it by hand — see `velar statusline --help`.',
    )
    return 1
  }
  console.log(`✔ Added Velar's live status ("🛡 Velar monitoring") to the status line in ${result.settingsPath}.`)
  if (result.backupPath) {
    console.log(`  Existing settings backed up to ${result.backupPath}`)
  }
  console.log('  Restart Claude Code (or start a new session) to see it.')
  return 0
}
