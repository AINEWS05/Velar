import type { NormalizedOperation, OperationType } from '@velar-dev/shared'

export interface ClassifiedCodexPayload {
  operation: NormalizedOperation
  /** Project working directory, if the payload provided one. */
  cwd?: string
  /** Codex's own tool_name, verbatim — 'Bash' | 'apply_patch' | anything else. Used to pick the enforcement path (see hook-codex-pre-tool-use.ts): only apply_patch denial is actually honored by Codex today. */
  codexToolName: string
}

const APPLY_PATCH_FILE_LINE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m

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

/** Extracts the target path from a `apply_patch` tool_input.command's `*** Begin Patch` body — never the patch content itself, only the filename on the `*** Add/Update/Delete File:` line. */
function extractApplyPatchPath(patchText: string | undefined): string | undefined {
  if (!patchText) return undefined
  const match = APPLY_PATCH_FILE_LINE.exec(patchText)
  return match?.[1]?.trim()
}

/**
 * Normalizes a Codex CLI `PreToolUse` hook payload into a NormalizedOperation.
 * Codex's payload shape (session_id, transcript_path, cwd, tool_name,
 * tool_input, permission_mode, ...) closely mirrors Claude Code's own —
 * empirically confirmed against a real installed Codex CLI, see
 * packages/cli/docs/design/codex-hook-verification.md. Never throws; any
 * unrecognized tool_name is classified `'unclassified'` (same root-cause fix
 * as classify.ts) rather than a no-signal 'bash' operation — never silently
 * default-allow.
 */
export function classifyCodexPayload(raw: unknown): ClassifiedCodexPayload {
  const payload = asRecord(raw)
  const toolName = asString(payload.tool_name) ?? ''
  const toolInput = asRecord(payload.tool_input)
  const cwd = asString(payload.cwd)
  const command = asString(toolInput.command)

  if (toolName === 'apply_patch') {
    return { operation: { operationType: 'file_write', path: extractApplyPatchPath(command) }, cwd, codexToolName: toolName }
  }
  if (toolName === 'Bash' || command) {
    return { operation: { operationType: classifyCommand(command), command }, cwd, codexToolName: toolName || 'Bash' }
  }

  return { operation: { operationType: 'unclassified', originalToolName: toolName || undefined }, cwd, codexToolName: toolName }
}
