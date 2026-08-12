import path from 'node:path'
import readline from 'node:readline'
import { looksLikeIngestToken } from '@velar-dev/shared'
import { saveConfig, defaultConfigDir, resolveApiBaseUrl } from '../config'
import { generateSessionId, openBrowser, pollForApproval, type PollOutcome } from '../browser-login'

export interface LoginOptions {
  /** Overridable for tests — never write into the real user's home directory during a test run. */
  configDir?: string
  /** Overridable for tests — avoids opening a real readline prompt. */
  prompt?: (question: string) => Promise<string>
  /** Overridable for tests — avoids the TTY-detection heuristic depending on how the test runner attaches stdio. */
  isInteractive?: boolean
  /** Overridable for tests — avoids spawning a real browser process. */
  openBrowser?: (url: string) => void
  /** Overridable for tests — avoids a real network poll loop. */
  pollForApproval?: (apiBaseUrl: string, sessionId: string) => Promise<PollOutcome>
  /** Overridable for tests — makes the generated session id deterministic. */
  generateSessionId?: () => string
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
 *
 * With no flags, in a real terminal, this opens a browser to pair the CLI
 * with the caller's Velar account — no copy-pasting a token by hand. Pass
 * `--token`/`--org-id` (CI/scripted use) or `--manual` (paste-in prompts) to
 * skip the browser entirely.
 */
export async function loginCommand(args: string[], options: LoginOptions = {}): Promise<number> {
  const prompt = options.prompt ?? defaultPrompt
  const configDir = options.configDir ?? defaultConfigDir()
  const openBrowserFn = options.openBrowser ?? openBrowser
  const poll = options.pollForApproval ?? pollForApproval
  const genSessionId = options.generateSessionId ?? generateSessionId
  const isInteractive = options.isInteractive ?? Boolean(process.stdout.isTTY && process.stdin.isTTY)

  let token = parseFlag(args, '--token')
  let orgId = parseFlag(args, '--org-id')
  const apiBaseUrl = parseFlag(args, '--api-url')
  const manual = args.includes('--manual')

  if (!token && !manual) {
    if (!isInteractive) {
      console.error(
        '✖ No terminal to open a browser from. Run `velar login --token vlr_... --org-id org_...` ' +
          '(find both in the Velar dashboard under Settings > Ingest Tokens), or `velar login --manual` to be prompted instead.',
      )
      return 1
    }

    const apiBase = apiBaseUrl ?? resolveApiBaseUrl(null)
    const sessionId = genSessionId()
    const loginUrl = `${apiBase}/cli-login/${sessionId}`

    console.log('Opening your browser to connect this CLI to your Velar account...')
    console.log(`If it doesn't open automatically, visit:\n  ${loginUrl}\n`)
    openBrowserFn(loginUrl)
    console.log('Waiting for approval (up to 5 minutes)... press Ctrl+C to cancel.')

    const result = await poll(apiBase, sessionId)
    if (result === 'timeout') {
      console.error(
        '✖ Timed out waiting for approval. Run `velar login` again, or use `velar login --token ... --org-id ...` to skip the browser.',
      )
      return 1
    }
    if (result === 'denied' || result === 'expired') {
      console.error(`✖ Login ${result === 'denied' ? 'was denied' : 'link expired'}. Run \`velar login\` again.`)
      return 1
    }
    token = result.token
    orgId = result.orgId
  } else {
    if (!token) token = (await prompt('Velar Ingest Token (vlr_...): ')).trim()
    if (!orgId) orgId = (await prompt('Org ID: ')).trim()
  }

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
