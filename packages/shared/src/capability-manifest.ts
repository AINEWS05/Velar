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
 * Codex CLI (v0.144.6, Windows) on 2026-07-31 (`codex exec --json`) and
 * again on 2026-08-21 (the plain interactive `codex` TUI, driven headlessly
 * via node-pty/ConPTY so the process saw a real terminal — `codex doctor`
 * confirmed `stdin/stdout/stderr is terminal: true` under this harness) —
 * not inferred from docs or third-party writeups, which turned out to
 * disagree with each other on exactly these facts. See
 * packages/cli/docs/design/codex-hook-verification.md for the full
 * methodology and raw transcripts of both passes.
 *
 * Confirmed via a real PreToolUse hook (`.codex/hooks.json`, `exit code 2`
 * deny), 5+ times for Bash and 2+ times for apply_patch in EACH mode:
 *   - bash: the hook fires and receives the full command in both modes, but
 *     the command runs anyway regardless of the hook's deny decision.
 *     `codex exec` always carries `permission_mode: "bypassPermissions"`;
 *     the interactive TUI's default (`on-request`) session instead carries
 *     `permission_mode: "default"` — a genuinely different mode string —
 *     yet the outcome is identical: still no enforcement. -> 'observe' only,
 *     now cross-verified rather than assumed to generalize from exec mode.
 *   - file_write (apply_patch): deny is enforced BY DEFAULT in both modes —
 *     the file genuinely does not get written, confirmed across repeated
 *     agent retries in the interactive TUI that all hit the same block.
 *     BUT the interactive TUI surfaces the denial as a generic sandbox
 *     failure ("Reason: command failed; retry without sandbox?") with a
 *     human prompt whose DEFAULT-highlighted option is "1. Yes, proceed" —
 *     selecting it (a bare Enter suffices) genuinely bypasses the hook and
 *     the file IS written. `codex exec` has no such override path since
 *     nothing is unattended there. -> stays 'block' (that's the enforced
 *     default outcome), see `notes.file_write` for the override caveat.
 *   - file_read, git, deploy: still NOT independently tested in either
 *     mode — git/deploy operations route through the same `Bash` tool in
 *     Codex's own tool model, so they likely inherit bash's
 *     non-enforcement, but this remains an inference, not a test, and is
 *     deliberately left 'unsupported' rather than assumed.
 *
 * Interactive-TUI-only UX, absent from `codex exec` entirely: a
 * per-directory "Do you trust the contents of this directory?" dialog, and
 * (separately) a "Hooks need review" dialog requiring an explicit `t`
 * (trust all) / Enter (review hooks) / Esc (continue without trusting —
 * hook won't run) decision before ANY hook — trusted or not — runs at all.
 * `codex exec` has neither gate; it silently skips an unreviewed hook
 * unless `--dangerously-bypass-hook-trust` is passed. Both dialogs' choices
 * persist per-directory across separate `codex` launches.
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
    notes: {
      file_write:
        '既定では拒否が有効（何度エージェントが再試行しても書き込みは発生しない、対話型TUIで実測済み）。ただしCodex自身が汎用のサンドボックス失敗として提示する「retry without sandbox?」プロンプトで、デフォルトでハイライトされた「1. Yes, proceed」を選ぶ（Enter一つで足りる）と、フックを回避してファイルが実際に書き込まれる — 2026-08-21の対話型TUI実機検証で確認済み。人間が誤ってEnterを押すだけで無効化され得るため、静かな監視ではなく能動的な確認が必要。',
      bash: 'codex exec（permission_mode: bypassPermissions）と対話型TUIの既定on-requestセッション（permission_mode: default）の両方で、フックの拒否がコマンド実行を止めないことを実機で確認済み（2026-07-31・2026-08-21）。',
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
