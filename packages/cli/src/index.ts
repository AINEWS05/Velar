#!/usr/bin/env node
import { initCommand } from './commands/init'
import { hookPreToolUseCommand } from './commands/hook-pre-tool-use'
import { runClaudeCommand } from './commands/run-claude'
import { loginCommand } from './commands/login'

const USAGE = [
  'Usage:',
  '  velar login               Save a Velar Ingest Token to ~/.velar/config.json',
  '  velar init                Install the Velar PreToolUse hook in .claude/settings.json',
  '  velar run claude [...]    Launch Claude Code with Velar enabled',
  '  velar hook pre-tool-use   (internal) Invoked by Claude Code as a PreToolUse hook',
].join('\n')

export async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv

  if (cmd === 'login') {
    return loginCommand(argv.slice(1))
  }
  if (cmd === 'init') {
    return initCommand()
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

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
