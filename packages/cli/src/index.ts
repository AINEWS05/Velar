#!/usr/bin/env node
import { initCommand } from './commands/init'
import { doctorCommand } from './commands/doctor'
import { hookPreToolUseCommand } from './commands/hook-pre-tool-use'
import { runClaudeCommand } from './commands/run-claude'
import { loginCommand } from './commands/login'

const USAGE = [
  'Usage:',
  '  velar login              Save a Velar Ingest Token to ~/.velar/config.json',
  '  velar init               Install the Velar PreToolUse hook in .claude/settings.json',
  '  velar doctor             Verify the installed hook is correctly configured and executable',
  '  velar run claude [...]   Launch Claude Code with Velar enabled',
  '  velar hook pre-tool-use  (internal) Invoked by Claude Code as a PreToolUse hook',
].join('\n')

export async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv

  if (cmd === 'login') {
    return loginCommand(argv.slice(1))
  }
  if (cmd === 'init') {
    return initCommand()
  }
  if (cmd === 'doctor') {
    return doctorCommand()
  }
  if (cmd === 'run' && sub === 'claude') {
    return runClaudeCommand(rest)
  }
  if (cmd === 'hook' && sub === 'pre-tool-use') {
    return hookPreToolUseCommand()
  }

  console.error(USAGE)
  return 1
}

function isHookInvocation(argv: string[]): boolean {
  return argv[0] === 'hook' && argv[1] === 'pre-tool-use'
}

export interface CrashOutcome {
  stderr: string
  exitCode: number
}

/**
 * What to print and exit with when `main()` itself throws/rejects, i.e. a
 * bug we didn't anticipate rather than a handled error path.
 *
 * For `velar hook pre-tool-use` specifically this must never look like
 * success: Claude Code's PreToolUse contract only treats exit code 2 as
 * "blocked", so an uncaught crash here fails CLOSED (exit 2, visible
 * warning) rather than risking an ambiguous exit code being treated as an
 * implicit allow. Every other subcommand just reports the error normally —
 * there's no "operation" to fail closed on.
 */
export function describeCrash(argv: string[], err: unknown): CrashOutcome {
  const message = err instanceof Error ? err.message : String(err)
  if (isHookInvocation(argv)) {
    return {
      exitCode: 2,
      stderr:
        `⚠ Velar hook crashed and could not evaluate this operation — blocking by default.\n` +
        `  ${message}\n` +
        `  Run \`velar doctor\` to diagnose.\n`,
    }
  }
  return { exitCode: 1, stderr: `✖ ${message}\n` }
}

if (require.main === module) {
  const argv = process.argv.slice(2)
  main(argv)
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      const outcome = describeCrash(argv, err)
      process.stderr.write(outcome.stderr)
      process.exitCode = outcome.exitCode
    })
}
