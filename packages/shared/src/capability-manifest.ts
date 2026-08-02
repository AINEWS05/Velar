/**
 * Phase 4a-3 — Adapter Capability Manifest.
 *
 * The single source of truth for "which AI coding agent can Velar actually
 * hook, and what can it do for each operation type". The LP's 対応ツール
 * section, packages/cli's README, and package.json's `description` field
 * must all be GENERATED from (or checked against) this file — never
 * hand-written separately, which is exactly how "Claude Code, Codex,
 * Cursor" ended up in several places implying all three were currently
 * supported when only one was.
 *
 * `status` is one of GA / Beta / Preview / Planned / Unsupported — every
 * adapter must be classified as one of these, and nothing in public copy
 * should describe an adapter's support level using different words than
 * whatever this field says.
 */

export type AdapterId = 'claude-code' | 'codex' | 'cursor'
export type ManifestActionType = 'file_read' | 'file_write' | 'bash' | 'git' | 'deploy' | 'mcp_tool_call' | 'unclassified'
export type CapabilityLevel = 'block' | 'observe' | 'unsupported'
export type AdapterStatus = 'GA' | 'Beta' | 'Preview' | 'Planned' | 'Unsupported'

export interface AdapterCapability {
  id: AdapterId
  displayName: string
  status: AdapterStatus
  /** Per-action-type capability. 'block' = can prevent it before it runs. 'observe' = can see it happened but not stop it. 'unsupported' = no integration exists at all. */
  capabilities: Record<ManifestActionType, CapabilityLevel>
  /**
   * Free-text qualifier for a specific action type, shown alongside its
   * capability cell wherever a single block/observe/unsupported value can't
   * capture real nuance. Introduced 2026-08-01 for `mcp_tool_call`: the
   * capability cell holds the WEAKEST guarantee across all MCP tool calls
   * ('observe', since a truly unrecognized tool name is warn-only by
   * default), and the note spells out that known-dangerous name patterns and
   * secret/production-DB-like arguments DO reach 'block' via a critical
   * decision — see @velar-dev/rules' mcp-* rules.
   */
  notes?: Partial<Record<ManifestActionType, string>>
}

const ALL_ACTION_TYPES: ManifestActionType[] = ['file_read', 'file_write', 'bash', 'git', 'deploy', 'mcp_tool_call', 'unclassified']

function allUnsupported(): Record<ManifestActionType, CapabilityLevel> {
  return Object.fromEntries(ALL_ACTION_TYPES.map((t) => [t, 'unsupported'])) as Record<ManifestActionType, CapabilityLevel>
}

/**
 * codex's capabilities were empirically verified against a real, installed
 * Codex CLI (v0.144.6, Windows, `codex exec --json`) on 2026-07-31 — not
 * inferred from docs or third-party writeups, which turned out to disagree
 * with each other on exactly these facts. See packages/cli/docs/design/
 * codex-hook-verification.md for the full methodology and raw transcripts.
 *
 * Confirmed via a real PreToolUse hook (`.codex/hooks.json`, `exit code 2`
 * deny) run 5+ times for Bash and 2+ times for apply_patch:
 *   - file_write (apply_patch): deny is ENFORCED — the file genuinely does
 *     not get written. -> 'block'
 *   - bash: the hook fires and receives the full command, but `codex exec`
 *     runs the command anyway regardless of the hook's deny decision (every
 *     tool call carries permission_mode: "bypassPermissions" in `codex
 *     exec`, irrespective of `-c approval_policy=...`). -> 'observe' only.
 *   - file_read, git, deploy: NOT independently tested — git/deploy
 *     operations route through the same `Bash` tool in Codex's own tool
 *     model, so they likely inherit bash's non-enforcement, but this was
 *     not directly verified and is deliberately left 'unsupported' rather
 *     than assumed.
 *   - Only `codex exec` (non-interactive) was tested; the interactive TUI
 *     session (the default `codex` command, what most users actually run)
 *     could not be driven headlessly in this environment and remains
 *     unverified — it may enforce Bash denial differently under its
 *     default `on-request` approval policy. Do not upgrade `bash` past
 *     'observe' without verifying that path too.
 */
export const CAPABILITY_MANIFEST: readonly AdapterCapability[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    status: 'GA',
    capabilities: {
      ...(Object.fromEntries(
        ALL_ACTION_TYPES.filter((t) => t !== 'mcp_tool_call' && t !== 'unclassified').map((t) => [t, 'block']),
      ) as Record<Exclude<ManifestActionType, 'mcp_tool_call' | 'unclassified'>, CapabilityLevel>),
      // 'observe' is the weakest guarantee across all MCP tool calls — a
      // genuinely unrecognized tool name only gets a warn (not a block) by
      // default. See `notes.mcp_tool_call` below for what DOES reach block.
      mcp_tool_call: 'observe',
      // Any tool call classify.ts couldn't confidently classify into a known
      // shape (e.g. a built-in tool with no dedicated branch yet, such as
      // WebFetch/WebSearch before their own rules were added) — never
      // silently default-allowed. See `notes.unclassified` below.
      unclassified: 'observe',
    },
    notes: {
      mcp_tool_call:
        '既知の危険パターン（tool名にdelete/drop/purge/destroy/remove等）と、秘密情報・.env参照・本番DB接続文字列らしき引数はcritical判定（block相当）に到達します。それ以外の未知のツール呼び出しはwarn（observeのみ、既定）— unclassifiedToolRisk設定でcriticalに引き上げ可能です。',
      unclassified:
        '既知の型（file_read/file_write/bash/git/deploy/mcp_tool_call）のいずれにも分類できなかった操作です。既定はwarn（observeのみ）— unclassifiedToolRisk設定でcriticalに引き上げ可能です。将来Claude Codeが新しい組み込みツールを追加しても、無音でdefault-allowには落ちません。',
    },
  },
  {
    id: 'codex',
    displayName: 'OpenAI Codex',
    status: 'Preview',
    capabilities: {
      file_read: 'unsupported',
      file_write: 'block',
      bash: 'observe',
      git: 'unsupported',
      deploy: 'unsupported',
      mcp_tool_call: 'unsupported',
      unclassified: 'unsupported',
    },
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    status: 'Planned',
    capabilities: allUnsupported(),
  },
] as const

export function getAdapterCapability(id: AdapterId): AdapterCapability {
  const found = CAPABILITY_MANIFEST.find((a) => a.id === id)
  if (!found) throw new Error(`No capability entry for adapter "${id}"`)
  return found
}

/** True if the adapter can currently block OR observe at least one action type — i.e. there's a real, working integration today. */
export function isCurrentlySupported(id: AdapterId): boolean {
  const adapter = getAdapterCapability(id)
  return Object.values(adapter.capabilities).some((c) => c === 'block' || c === 'observe')
}

/** Adapter ids with at least one 'block' or 'observe' capability today — i.e. what public copy may describe as "supported" without a coming-soon qualifier. */
export function currentlySupportedAdapterIds(): AdapterId[] {
  return CAPABILITY_MANIFEST.filter((a) => isCurrentlySupported(a.id)).map((a) => a.id)
}
