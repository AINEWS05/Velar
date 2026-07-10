import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process'

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer | string>

/** Quotes a single argument for cmd.exe when spawning with `shell: true`. */
function quoteForWindowsShell(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"^&|<>()]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/**
 * Thin wrapper that launches the real `claude` CLI as a child process.
 * Phase 1 does no cloud reporting here — this command only checks that
 * `velar init` has run, then hands control straight to `claude`.
 */
export function runClaudeCommand(
  args: string[],
  cwd: string = process.cwd(),
  spawn: SpawnFn = spawnSync,
): number {
  const settingsPath = path.join(cwd, '.claude', 'settings.json')
  if (!fs.existsSync(settingsPath)) {
    console.error('✖ Velar is not initialized in this project. Run `velar init` first.')
    return 1
  }

  // On Windows, global npm bins are `.cmd`/`.ps1` shims; spawnSync without a
  // shell frequently fails to resolve them via PATH (spurious ENOENT even
  // when the command is genuinely installed), so use the shell there. Args
  // are quoted ourselves since `shell: true` does not escape them for us.
  const isWin = process.platform === 'win32'
  const spawnArgs = isWin ? args.map(quoteForWindowsShell) : args
  const result = spawn('claude', spawnArgs, { stdio: 'inherit', cwd, shell: isWin })

  const err = result.error as NodeJS.ErrnoException | undefined
  if (err) {
    if (err.code === 'ENOENT') {
      console.error(
        '✖ `claude` command not found. Install Claude Code first: https://docs.claude.com/claude-code',
      )
    } else {
      console.error(`✖ Failed to launch claude: ${err.message}`)
    }
    return 1
  }

  return result.status ?? 1
}
