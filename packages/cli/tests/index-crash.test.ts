import { describe, it, expect } from 'vitest'
import { describeCrash } from '../src/index'

describe('describeCrash — hook pre-tool-use', () => {
  it('fails closed with exit code 2, never a silent pass-through', () => {
    const outcome = describeCrash(['hook', 'pre-tool-use'], new Error('boom'))
    expect(outcome.exitCode).toBe(2)
    expect(outcome.stderr).toContain('blocking by default')
    expect(outcome.stderr).toContain('boom')
    expect(outcome.stderr).toContain('velar doctor')
  })

  it('handles a non-Error thrown value', () => {
    const outcome = describeCrash(['hook', 'pre-tool-use'], 'some string error')
    expect(outcome.exitCode).toBe(2)
    expect(outcome.stderr).toContain('some string error')
  })
})

describe('describeCrash — every other subcommand', () => {
  it('exits 1 with a plain error message, no fail-closed language', () => {
    const outcome = describeCrash(['init'], new Error('disk full'))
    expect(outcome.exitCode).toBe(1)
    expect(outcome.stderr).toBe('✖ disk full\n')
  })

  it('treats "hook" without "pre-tool-use" as a normal (non-fail-closed) command', () => {
    const outcome = describeCrash(['hook', 'something-else'], new Error('x'))
    expect(outcome.exitCode).toBe(1)
  })

  it('treats no argv at all as a normal command', () => {
    const outcome = describeCrash([], new Error('x'))
    expect(outcome.exitCode).toBe(1)
  })
})
