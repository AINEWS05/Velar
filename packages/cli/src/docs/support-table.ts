/**
 * Generates the "supported tools" table for packages/cli/README.md from the
 * Adapter Capability Manifest (@velar-dev/shared). This is the single
 * source of truth — the README table, the LP's 対応ツール section, and any
 * future docs surface must all read from CAPABILITY_MANIFEST rather than
 * being hand-written, which is how "Claude Code / Codex / Cursor" ended up
 * implying three supported adapters when only one actually was.
 *
 * `packages/cli/tests/support-table.test.ts` asserts the README's generated
 * block matches this function's current output — a hand-edit of the table
 * that drifts from the manifest fails the test.
 */
import { CAPABILITY_MANIFEST, type AdapterCapability, type CapabilityLevel } from '@velar-dev/shared'

export const SUPPORT_TABLE_START_MARKER = '<!-- SUPPORT-TABLE:START (generated from packages/shared/src/capability-manifest.ts — do not hand-edit; run `pnpm --filter @velar-dev/cli run gen:support-table`) -->'
export const SUPPORT_TABLE_END_MARKER = '<!-- SUPPORT-TABLE:END -->'

const STATUS_LABEL: Record<AdapterCapability['status'], string> = {
  GA: '✅ 対応済み',
  Beta: 'Beta',
  Preview: 'Preview',
  Planned: '計画中（未対応）',
  Unsupported: '非対応',
}

const ACTION_TYPE_LABEL: Record<string, string> = {
  file_read: 'ファイル読み取り',
  file_write: 'ファイル書き込み',
  bash: 'bashコマンド',
  git: 'git操作',
  deploy: 'デプロイ',
}

const CAPABILITY_LABEL: Record<CapabilityLevel, string> = {
  block: '🛑 ブロック可',
  observe: '👁 検知のみ',
  unsupported: '—',
}

export function renderSupportTableMarkdown(newline: string = '\n'): string {
  const actionTypes = Object.keys(ACTION_TYPE_LABEL)
  const header = `| ツール | ステータス | ${actionTypes.map((t) => ACTION_TYPE_LABEL[t]).join(' | ')} |`
  const divider = `| --- | --- | ${actionTypes.map(() => '---').join(' | ')} |`
  const rows = CAPABILITY_MANIFEST.map((adapter) => {
    const cells = actionTypes.map((t) => CAPABILITY_LABEL[adapter.capabilities[t as keyof typeof adapter.capabilities]])
    return `| ${adapter.displayName} | ${STATUS_LABEL[adapter.status]} | ${cells.join(' | ')} |`
  })
  return [header, divider, ...rows].join(newline)
}

export function renderSupportTableBlock(newline: string = '\n'): string {
  return [SUPPORT_TABLE_START_MARKER, '', renderSupportTableMarkdown(newline), '', SUPPORT_TABLE_END_MARKER].join(newline)
}

/**
 * Replaces the marker-delimited block inside `readmeContent` with a freshly
 * generated one. Throws if the markers aren't both present. Matches the
 * file's existing line-ending style (this repo's README.md is CRLF).
 */
export function applySupportTableToReadme(readmeContent: string): string {
  const startIdx = readmeContent.indexOf(SUPPORT_TABLE_START_MARKER)
  const endIdx = readmeContent.indexOf(SUPPORT_TABLE_END_MARKER)
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('README is missing the SUPPORT-TABLE markers — cannot regenerate.')
  }
  const newline = readmeContent.includes('\r\n') ? '\r\n' : '\n'
  const before = readmeContent.slice(0, startIdx)
  const after = readmeContent.slice(endIdx + SUPPORT_TABLE_END_MARKER.length)
  return `${before}${renderSupportTableBlock(newline)}${after}`
}
