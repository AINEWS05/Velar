#!/usr/bin/env node
import { initCommand } from './commands/init'
import { doctorCommand } from './commands/doctor'
import { testCommand } from './commands/test'
import { uninstallCommand } from './commands/uninstall'
import { hookPreToolUseCommand } from './commands/hook-pre-tool-use'
import { hookCodexPreToolUseCommand } from './commands/hook-codex-pre-tool-use'
import { codexInitCommand } from './commands/codex-init'
import { runClaudeCommand } from './commands/run-claude'
import { loginCommand } from './commands/login'

const USAGE = [
  'Usage:',
  '  velar login                    Save a Velar Ingest Token to ~/.velar/config.json',
  '  velar init                     Install the Velar PreToolUse hook in .claude/settings.local.json',
  '  velar doctor                   Verify the installed hook is correctly configured and executable',
  '  velar test                     Prove the hook actually allows safe ops and blocks dangerous ones',
  '  velar uninstall                Remove everything `velar init` added to this project',
  '  velar run claude [...]         Launch Claude Code with Velar enabled',
  '  velar codex-init               Install the Velar PreToolUse hook in .codex/hooks.json (Preview — see docs)',
  '  velar hook pre-tool-use        (internal) Invoked by Claude Code as a PreToolUse hook',
  '  velar hook codex-pre-tool-use  (internal) Invoked by Codex CLI as a PreToolUse hook',
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
  if (cmd === 'test') {
    return testCommand()
  }
  if (cmd === 'uninstall') {
    return uninstallCommand()
  }
  if (cmd === 'codex-init') {
    return codexInitCommand()
  }
  if (cmd === 'run' && sub === 'claude') {
    return runClaudeCommand(rest)
  }
  if (cmd === 'hook' && sub === 'pre-tool-use') {
    return hookPreToolUseCommand()
  }
  if (cmd === 'hook' && sub === 'codex-pre-tool-use') {
    return hookCodexPreToolUseCommand()
  }

  console.error(USAGE)
  return 1
}

function isHookInvocation(argv: string[]): boolean {
  return argv[0] === 'hook' && (argv[1] === 'pre-tool-use' || argv[1] === 'codex-pre-tool-use')
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
