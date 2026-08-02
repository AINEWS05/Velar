import type { NormalizedOperation, OperationType } from '@velar-dev/shared'

const FILE_READ_TOOLS = new Set(['read', 'glob', 'grep', 'notebookread'])
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit'])
const BASH_TOOLS = new Set(['bash'])

/** Built-in Claude Code tools whose real exfiltration surface is the destination URL / search query text, not a file path or bash command. Still classified as `'unclassified'` (never a dedicated operationType) — see webTargetText on NormalizedOperation and web-target-secret-like / unclassified-tool-default in @velar-dev/rules. */
const WEB_FETCH_TOOLS = new Set(['webfetch'])
const WEB_SEARCH_TOOLS = new Set(['websearch'])

/** Claude Code's tool_name format for an MCP server's tool — `mcp__<server>__<tool>` (or `mcp__plugin_<plugin>_<server>__<tool>` for plugin-bundled servers). Matched case-insensitively since toolName is already lowercased below. */
const MCP_TOOL_NAME_RE = /^mcp__/

/** Upper bound on the JSON.stringify'd tool_input kept in-memory for rule matching (packages/rules' mcp-* rules) — bounds worst-case work on a pathological payload. Never persisted or transmitted; see NormalizedOperation.mcpToolInputText. */
const MCP_TOOL_INPUT_TEXT_MAX_LEN = 8192

function safeStringifyToolInput(toolInput: Record<string, unknown>): string | undefined {
  try {
    const text = JSON.stringify(toolInput)
    if (!text) return undefined
    return text.length > MCP_TOOL_INPUT_TEXT_MAX_LEN ? text.slice(0, MCP_TOOL_INPUT_TEXT_MAX_LEN) : text
  } catch {
    // Circular/non-serializable tool_input — extremely unlikely from a JSON
    // hook payload, but degrade to "no argument signal" rather than throw.
    return undefined
  }
}

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
 * expected shape is simply treated as absent.
 *
 * Root-cause fix (2026-08-01): a tool_name this function cannot confidently
 * place into a known shape (file_read/file_write/bash/git/deploy/
 * mcp_tool_call) is classified as `'unclassified'`, carrying the raw
 * tool_name in `originalToolName` — it is NEVER silently treated as an
 * unmatched bash operation that quietly reaches default-allow. Every prior
 * "silent default-allow" gap found in this codebase (MCP tool calls, then
 * WebFetch/WebSearch) was exactly this same shape: a new built-in tool
 * classify.ts had no branch for. Adding one more specific branch per tool
 * only ever fixes the LAST gap, not the next one a future Claude Code
 * release introduces — `'unclassified'` is the catch-all that makes the
 * next unknown tool warn (see unclassified-tool-default in
 * @velar-dev/rules) instead of vanishing.
 *
 * Only classification metadata is read here (tool name + a path/command
 * string) — prompt text, file contents, and any other payload field are
 * never inspected or retained. Deliberate exceptions, all in-memory-only
 * (never logged, never transmitted as-is):
 *   - An MCP tool call's `tool_input` (mcp__<server>__<tool> tool names):
 *     its stringified argument text is read into `mcpToolInputText`, reused
 *     for pattern matching by @velar-dev/rules' mcp-* rules — an MCP tool's
 *     name alone can't tell you whether its arguments hold a production
 *     connection string or an API key, unlike Bash/Read/Write/Edit where
 *     the classification signal (path/command) already includes everything
 *     needed.
 *   - WebFetch's `url` / WebSearch's `query` are read into `webTargetText`,
 *     the one real exfiltration surface for these tools (a secret-shaped
 *     value embedded in the destination or query) — general web browsing
 *     is otherwise never inspected further than that.
 *   - `agent_id`/`agent_type`, when present, mean this tool call came from
 *     a Task-tool subagent rather than the top-level session — read into
 *     `isSubagent`/`agentType` for the same in-memory-only treatment.
 */
export function classifyPayload(raw: unknown): ClassifiedPayload {
  const payload = asRecord(raw)
  const rawToolName = asString(payload.tool_name) ?? ''
  const toolName = rawToolName.toLowerCase()
  const toolInput = asRecord(payload.tool_input)
  const cwd = asString(payload.cwd)
  const agentType = asString(payload.agent_type)
  const isSubagent = asString(payload.agent_id) !== undefined || agentType !== undefined

  const filePath = asString(toolInput.file_path) ?? asString(toolInput.path) ?? asString(toolInput.notebook_path)
  const command = asString(toolInput.command)

  // Common to every branch below — spread first so a branch-specific field
  // of the same name (there are none today) would still win.
  const common = { isSubagent, agentType }

  // Checked first, ahead of every other branch below: an MCP tool call's
  // tool_input can incidentally contain a `command`-named field (e.g. a
  // hypothetical mcp__terminal__run tool), which would otherwise fall into
  // the bash-fallback branch further down and only have that one field
  // scanned instead of the full argument set. Classifying every mcp__*
  // tool_name uniformly, before anything else, is what actually closes the
  // "MCP calls silently default-allow" gap this was added for.
  if (MCP_TOOL_NAME_RE.test(toolName)) {
    return {
      operation: {
        operationType: 'mcp_tool_call',
        mcpToolName: toolName,
        mcpToolInputText: safeStringifyToolInput(toolInput),
        isSubagent,
        agentType,
      },
      cwd,
    }
  }

  if (FILE_READ_TOOLS.has(toolName)) {
    return { operation: { operationType: 'file_read', path: filePath, ...common }, cwd }
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return { operation: { operationType: 'file_write', path: filePath, ...common }, cwd }
  }
  if (BASH_TOOLS.has(toolName) || command) {
    return { operation: { operationType: classifyCommand(command), command, ...common }, cwd }
  }

  if (WEB_FETCH_TOOLS.has(toolName)) {
    return {
      operation: { operationType: 'unclassified', originalToolName: rawToolName, webTargetText: asString(toolInput.url), ...common },
      cwd,
    }
  }
  if (WEB_SEARCH_TOOLS.has(toolName)) {
    return {
      operation: { operationType: 'unclassified', originalToolName: rawToolName, webTargetText: asString(toolInput.query), ...common },
      cwd,
    }
  }

  // Unrecognized tool_name / malformed payload: no path or command signal to
  // evaluate, and no dedicated branch above claimed it. This is the
  // 'unclassified' catch-all — NEVER 'bash' with no command (that would
  // silently reach default-allow, exactly the gap this fix closes). See
  // unclassified-tool-default in @velar-dev/rules, which always matches this
  // operationType and defaults to warn, never allow.
  return {
    operation: { operationType: 'unclassified', originalToolName: rawToolName || undefined, ...common },
    cwd,
  }
}
