import path from 'node:path'
import readline from 'node:readline'
import { looksLikeIngestToken } from '@velar-dev/shared'
import { saveConfig, defaultConfigDir } from '../config'

export interface LoginOptions {
  /** Overridable for tests — never write into the real user's home directory during a test run. */
  configDir?: string
  /** Overridable for tests — avoids opening a real readline prompt. */
  prompt?: (question: string) => Promise<string>
}

function defaultPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

function parseFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  return idx !== -1 ? args[idx + 1] : undefined
}

/**
 * `velar login` — stores the Velar Ingest Token (and its org id) in
 * ~/.velar/config.json with 0600 permissions. This token is issued by Velar
 * itself; it has nothing to do with a customer's LLM provider API key.
 */
export async function loginCommand(args: string[], options: LoginOptions = {}): Promise<number> {
  const prompt = options.prompt ?? defaultPrompt
  const configDir = options.configDir ?? defaultConfigDir()

  let token = parseFlag(args, '--token')
  let orgId = parseFlag(args, '--org-id')
  const apiBaseUrl = parseFlag(args, '--api-url')

  if (!token) token = (await prompt('Velar Ingest Token (vlr_...): ')).trim()
  if (!orgId) orgId = (await prompt('Org ID: ')).trim()

  if (!token || !looksLikeIngestToken(token)) {
    console.error('✖ Invalid token — expected a Velar Ingest Token starting with "vlr_".')
    return 1
  }
  if (!orgId) {
    console.error('✖ Org ID is required.')
    return 1
  }

  const filePath = saveConfig({ token, orgId, apiBaseUrl }, configDir)
  console.log(`✔ Saved Velar Ingest Token to ${filePath} (mode 600)`)
  console.log(
    'This token authenticates the CLI to Velar — it is unrelated to your LLM provider API key, which Velar never receives, stores, or proxies.',
  )
  return 0
}

export function configFileHint(dir: string = defaultConfigDir()): string {
  return path.join(dir, 'config.json')
}
