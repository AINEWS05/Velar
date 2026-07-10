import fs from 'node:fs'
import readline from 'node:readline'

/** Turns a raw terminal answer into an approve/deny boolean. Empty/EOF => deny. */
export function decideFromAnswer(raw: string | null | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'y'
}

export interface Prompter {
  /** Resolves with the raw answer text, or null if no answer could be obtained. */
  confirm(question: string): Promise<string | null>
}

/**
 * Opens the controlling terminal directly for the approval prompt.
 *
 * Claude Code hooks receive the JSON payload on the hook process's own
 * stdin, so that stream can't be reused for an interactive question. We
 * open the TTY directly instead (/dev/tty on POSIX, CONIN$/CONOUT$ on
 * Windows), matching how tools like `gh` or `direnv` prompt interactively
 * even when stdio is redirected.
 *
 * Returns null when no controlling terminal is available (CI, non-interactive
 * shells, etc.) — callers must treat that as "cannot ask" and fail closed.
 */
export function createTtyPrompter(): Prompter | null {
  try {
    const isWin = process.platform === 'win32'
    const inPath = isWin ? 'CONIN$' : '/dev/tty'
    const outPath = isWin ? 'CONOUT$' : '/dev/tty'
    const inFd = fs.openSync(inPath, 'r')
    const outFd = fs.openSync(outPath, 'w')

    return {
      confirm(question: string): Promise<string | null> {
        return new Promise((resolve) => {
          const input = fs.createReadStream('', { fd: inFd })
          const output = fs.createWriteStream('', { fd: outFd })
          const rl = readline.createInterface({ input, output, terminal: true })
          rl.question(question, (answer) => {
            rl.close()
            resolve(answer)
          })
        })
      },
    }
  } catch {
    return null
  }
}
