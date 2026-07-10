import type { NormalizedOperation, OperationType } from '@velar-dev/shared'

const FILE_READ_TOOLS = new Set(['read', 'glob', 'grep', 'notebookread'])
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit'])
const BASH_TOOLS = new Set(['bash'])

export interface ClassifiedPayload {
  operation: NormalizedOperation
  /** Project working directory, if the payload provided one. */
  cwd?: string
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function classifyCommand(command: string | undefined): OperationType {
  if (!command) return 'bash'
  const trimmed = command.trim()
  if (/^git\b/i.test(trimmed)) return 'git'
  if (/\b(vercel|netlify)\s+deploy\b|\bnpm\s+publish\b|\bdocker\s+push\b/i.test(trimmed)) return 'deploy'
  return 'bash'
}

/**
 * Normalizes a Claude Code PreToolUse hook payload of *unknown* shape into a
 * NormalizedOperation. Never throws — any field that doesn't match the
 * expected shape is simply treated as absent, which naturally falls through
 * to the rule engine's default-allow rule (Velar stays silent by default;
 * it never fails on shape drift by guessing something is dangerous).
 *
 * Only classification metadata is read here (tool name + a path/command
 * string) — prompt text, file contents, and any other payload field are
 * never inspected or retained.
 */
export function classifyPayload(raw: unknown): ClassifiedPayload {
  const payload = asRecord(raw)
  const toolName = (asString(payload.tool_name) ?? '').toLowerCase()
  const toolInput = asRecord(payload.tool_input)
  const cwd = asString(payload.cwd)

  const filePath = asString(toolInput.file_path) ?? asString(toolInput.path) ?? asString(toolInput.notebook_path)
  const command = asString(toolInput.command)

  if (FILE_READ_TOOLS.has(toolName)) {
    return { operation: { operationType: 'file_read', path: filePath }, cwd }
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return { operation: { operationType: 'file_write', path: filePath }, cwd }
  }
  if (BASH_TOOLS.has(toolName) || command) {
    return { operation: { operationType: classifyCommand(command), command }, cwd }
  }

  // Unrecognized tool_name / malformed payload: no path or command signal to
  // evaluate. operationType is a required field on NormalizedOperation, so we
  // pick 'bash' with no command — every Phase 1 rule that requires a command
  // simply won't match, and this falls through to default-allow.
  return { operation: { operationType: 'bash' }, cwd }
}
