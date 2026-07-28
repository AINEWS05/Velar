import { describe, it, expect } from 'vitest'
import { runHookSelfTest } from '../src/hook-selftest'

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`
}

describe('runHookSelfTest', () => {
  it('reports ok: true and exitCode 0 for a command that exits 0', () => {
    const command = `${quote(process.execPath)} -e "process.exit(0)"`
    const result = runHookSelfTest(command)
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('reports ok: false when the command exits non-zero', () => {
    const command = `${quote(process.execPath)} -e "process.exit(2)"`
    const result = runHookSelfTest(command)
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(2)
  })

  it('reports ok: false (not a thrown exception) when the command cannot be found at all', () => {
    const command = `${quote('/definitely/not/a/real/velar-self-test-binary')} --version`
    const result = runHookSelfTest(command)
    expect(result.ok).toBe(false)
  })

  it('pipes the synthetic payload on stdin so a real velar hook invocation can read it', () => {
    const script = 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{process.exit(d.includes("velar-self-test-placeholder.txt")?0:1)})'
    const command = `${quote(process.execPath)} -e ${quote(script)}`
    const result = runHookSelfTest(command)
    expect(result.ok).toBe(true)
  })
})
