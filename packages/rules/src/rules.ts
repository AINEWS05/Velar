import type { NormalizedOperation, RiskLevel } from '@velar-dev/shared'

export type RuleCategory =
  | 'secrets'
  | 'production_db'
  | 'destructive_command'
  | 'deploy'
  | 'exfiltration'
  | 'package_ci_config'

export interface Rule {
  id: string
  category: RuleCategory
  /** Japanese display name — shown in the dashboard Event Log. */
  name: string
  /** Human-readable representation of what's matched — for docs/README, not necessarily the literal regex source. */
  pattern: string
  riskLevel: RiskLevel
  /** Japanese explanation — shown on the Slack approval card. */
  reason: string
  /** English explanation — for the OSS README and English-reading operators. */
  reason_en: string
  match: (op: NormalizedOperation) => boolean
}

function basename(op: NormalizedOperation): string | undefined {
  if (!op.path) return undefined
  const parts = op.path.split(/[\\/]/)
  return parts[parts.length - 1]
}

function isFileOp(op: NormalizedOperation): boolean {
  return op.operationType === 'file_read' || op.operationType === 'file_write'
}

function isWriteOp(op: NormalizedOperation): boolean {
  return op.operationType === 'file_write'
}

/**
 * Secret-like inline patterns — API key prefixes, Bearer tokens, and
 * password/token/secret assignments. Matches command *text*, never file
 * content (which Velar never reads). Exported so the mcp-* rules below can
 * apply the exact same pattern to an MCP tool call's argument text — never
 * duplicated/reinvented.
 */
export const SECRET_LIKE_RE =
  /(?:sk-(?:proj-|ant-)?|xoxb-|xoxp-|xoxa-|xoxr-|ghp_|ghs_|github_pat_)[a-zA-Z0-9_-]{16,}|AIza[0-9A-Za-z\-_]{35}|AKIA[0-9A-Z]{16}|Bearer\s+[a-zA-Z0-9\-._~+/]+=*|(?:password|passwd|secret|token|api.?key)\s*[:=]\s*['"]?[^\s'"]{8,}/i

/** `.env`-like reference, excluding the safe template variants — same carve-out shape as `env-example-allow` below, reused for MCP argument-text scanning. */
const MCP_ENV_FILE_LIKE_RE = /\.env(?:\.[a-zA-Z0-9_-]+)?/i
const MCP_ENV_FILE_ALLOW_RE = /\.env\.(example|sample|template)/i

/** Same DROP/TRUNCATE signal as the prod-db-drop/prod-db-truncate rules below, reused for MCP argument-text scanning. */
const MCP_DESTRUCTIVE_SQL_RE = /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b|\bTRUNCATE\s+TABLE\b/i
/** A connection-string-shaped value whose host segment looks production-flagged — same "prod" signal as prod-db-direct-connection below. */
const MCP_PROD_DB_CONNECTION_RE = /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"]*prod[^\s'"]*/i

/** Destructive verbs in an MCP tool's own name — e.g. `mcp__github__delete_repository`, `mcp__filesystem__remove_directory`. Name-only; never inspects arguments. */
const MCP_DESTRUCTIVE_TOOL_NAME_RE = /delete|drop|purge|destroy|remove/i

/**
 * Velar's own footprint — the project-local `.velar/` directory (events log,
 * temp-allows, install receipt), the global `~/.velar/` directory (login
 * token, vendored CLI code), and the two Claude Code settings files that can
 * carry the PreToolUse hook registration. Matched as a plain substring
 * against a (slash-normalized) path or a bash command string — deliberately
 * broad rather than an exact allow-list of filenames, since a bash `rm`/`mv`/
 * redirect can target the directory itself, not just one file inside it.
 * `velar`/`@velar-dev` alone (e.g. `npx velar init`, `npx @velar-dev/cli
 * init`) does NOT match — only an actual `.velar` path segment or Claude
 * Code's own settings filenames do, so running Velar's own CLI commands via
 * Bash is unaffected.
 */
const VELAR_SELF_PROTECTION_RE = /\.velar\b|\.claude[\\/]settings(?:\.local)?\.json\b/i

/**
 * Phase 3 rule catalog — 30 core detection rules across 6 categories (5
 * each), plus 9 more not folded into that count: the `env-example-allow`
 * carve-out, `velar-self-protection`, 5 MCP-specific `mcp-*` rules,
 * `web-target-secret-like`, and `unclassified-tool-default` — 39 rules
 * total. `default-allow` (the unconditional catch-all `evaluate()` needs to
 * never return undefined) isn't counted either way; it's the absence of a
 * match, not a detection. See packages/cli/README.md's "Beyond the 30"
 * section for the same breakdown written for an external reader.
 *
 * ── ORDERING IS PART OF THE SPEC, NOT AN IMPLEMENTATION DETAIL ──────────────
 * `evaluate()` (see index.ts) scans this array top-to-bottom and returns the
 * FIRST rule whose `match()` returns true. Array position therefore decides
 * which `ruleId` gets attributed — and reported to the dashboard / Slack
 * card — whenever an operation happens to satisfy more than one rule's
 * pattern (this is common: e.g. a command can simultaneously look like both
 * a secret leak AND a destructive command).
 *
 * Rules within this file follow two ordering principles:
 *   1. An allow carve-out must be placed immediately before the broader
 *      rule it exempts (e.g. `env-example-allow` before `env-file-protection`).
 *   2. Categories are listed in a fixed order (secrets, production_db,
 *      destructive_command, deploy, exfiltration, package_ci_config) so a
 *      new rule added to an EXISTING category only competes for priority
 *      with rules already in that category and any category listed after
 *      it — never with a category listed before it.
 *
 * When adding a new rule:
 *   - Insert it within its category's block, not at the top or bottom of
 *     the whole array — this keeps its priority relative to other
 *     categories predictable and reviewable in a small diff.
 *   - If its pattern could also match an operation an EARLIER rule already
 *     catches, that earlier rule wins by design — prefer narrowing your new
 *     rule's regex over reordering existing categories to "fix" this.
 *   - `default-allow` must remain the last entry — it is the unconditional
 *     catch-all `evaluate()` relies on to never return undefined.
 * See "ordering is deliberate" in tests/rules-phase3.test.ts for a concrete,
 * regression-guarded example of this priority in action.
 *
 * Every rule matches only on operationType / path / command TEXT — never
 * file content or prompt text, which Velar never reads.
 */
export const RULES: Rule[] = [
  // ── Self-protection (2026-08-01, not counted in the 30, evaluated FIRST) ─
  // Velar's own hook registration and local state have no protection today —
  // an agent can freely rewrite .claude/settings.json to `{}` (disabling the
  // hook in one step, empirically verified) or tamper with ~/.velar/ (login
  // token, vendored code) or the project's .velar/ (temp-allows, install
  // receipt), and every one of the other 30 rules silently no-ops for a path
  // it doesn't recognize. This rule is placed before every other rule
  // (including env-example-allow) so nothing can out-rank it by coincidence.
  // riskLevel is 'critical', NOT a hard deny: a user legitimately editing
  // their own settings.json is a real, common case — this asks for
  // approval, it does not block unconditionally. `npx velar init` / `velar
  // uninstall` run via Bash are unaffected (see VELAR_SELF_PROTECTION_RE's
  // doc comment) since their command text never contains a `.velar` path
  // segment or a settings filename.
  {
    id: 'velar-self-protection',
    category: 'destructive_command',
    name: 'Velar自身の設定・vendorへの書き込み',
    pattern: '.claude/settings.json | .claude/settings.local.json | .velar/** (project-local or ~/.velar global)',
    riskLevel: 'critical',
    reason: 'Velar自身のフック定義・ログイン情報・vendorコードへの書き込みです。承認なしに監視対象が監視を無効化できないよう、常に承認を求めます。',
    reason_en:
      "This writes to Velar's own hook registration, login token, or vendored code. Always requires approval so the thing being monitored can't silently disable its own monitor.",
    match: (op) => {
      const pathHit = isWriteOp(op) && !!op.path && VELAR_SELF_PROTECTION_RE.test(op.path)
      const commandHit = !!op.command && VELAR_SELF_PROTECTION_RE.test(op.command)
      return pathHit || commandHit
    },
  },

  // ── Allow carve-out (not counted in the 30) ──────────────────────────────
  {
    id: 'env-example-allow',
    category: 'secrets',
    name: 'サンプルenvファイル',
    pattern: '.env.example | .env.sample | .env.template',
    riskLevel: 'allow',
    reason: 'テンプレート/サンプルのenvファイルは安全に読み書きできます。',
    reason_en: 'Template/example env files are safe to read or write.',
    match: (op) => {
      if (!isFileOp(op)) return false
      const name = basename(op)
      return !!name && /^\.env\.(example|sample|template)$/i.test(name)
    },
  },

  // ── 1. 秘密情報 (secrets) — 5 rules ───────────────────────────────────────
  {
    id: 'env-file-protection',
    category: 'secrets',
    name: '本物のenvファイル',
    pattern: '^\\.env(\\.|$) (excluding .example/.sample/.template)',
    riskLevel: 'critical',
    reason: 'テンプレートではない実際の.envファイルの読み書きは、本番の秘密情報を露出させる可能性があります。',
    reason_en: 'Reading or writing a real (non-example) .env file may expose production secrets.',
    match: (op) => {
      if (!isFileOp(op)) return false
      const name = basename(op)
      return !!name && /^\.env(\.|$)/i.test(name)
    },
  },
  {
    id: 'cloud-credentials-file',
    category: 'secrets',
    name: 'クラウド認証情報ファイル',
    pattern: '.aws/credentials, .config/gcloud/*, .azure/*, .kube/config',
    riskLevel: 'critical',
    reason: 'クラウドプロバイダーの認証情報ファイルへのアクセスは、インフラ全体への侵害につながる可能性があります。',
    reason_en: 'Accessing a cloud provider credentials file could lead to full infrastructure compromise.',
    match: (op) => {
      if (!isFileOp(op) || !op.path) return false
      return /\.aws[\\/]credentials|\.aws[\\/]config|\.config[\\/]gcloud[\\/]|\.azure[\\/]|\.kube[\\/]config/i.test(
        op.path,
      )
    },
  },
  {
    id: 'ssh-private-key',
    category: 'secrets',
    name: 'SSH秘密鍵',
    pattern: 'id_rsa | id_ed25519 | id_ecdsa | *.pem | *.pfx | *.ppk (excluding *.pub)',
    riskLevel: 'critical',
    reason: 'SSH秘密鍵の読み書きは、他システムへの不正アクセスに悪用される可能性があります。',
    reason_en: 'Reading or writing an SSH private key could be used to gain unauthorized access to other systems.',
    match: (op) => {
      if (!isFileOp(op)) return false
      const name = basename(op)
      if (!name || /\.pub$/i.test(name)) return false
      return /^id_(rsa|ed25519|ecdsa)$|\.pem$|\.pfx$|\.ppk$/i.test(name)
    },
  },
  {
    id: 'secret-in-command',
    category: 'secrets',
    name: 'コマンド内の秘密情報らしき文字列',
    pattern: 'API key prefixes (sk-/xox*/ghp_/AIza/AKIA), Bearer token, password=/token=',
    riskLevel: 'critical',
    reason: 'コマンド内に秘密情報らしき文字列が含まれています。誤ってシェル履歴やログに残る可能性があります。',
    reason_en: 'The command text contains what looks like a secret value, which could leak into shell history or logs.',
    match: (op) => {
      if (op.operationType !== 'bash' || !op.command) return false
      return SECRET_LIKE_RE.test(op.command)
    },
  },
  {
    id: 'dotfile-secret-write',
    category: 'secrets',
    name: '秘密情報系設定ファイルへの書き込み',
    pattern: '.npmrc | .netrc | secrets.json | secrets.yaml | secrets.yml | credentials.json',
    riskLevel: 'critical',
    reason: '認証トークンを保持する設定ファイルへの書き込みです。内容次第で認証情報が漏洩する可能性があります。',
    reason_en: 'Writing to a file that conventionally holds auth tokens (e.g. .npmrc, .netrc) may expose credentials.',
    match: (op) => {
      if (!isWriteOp(op)) return false
      const name = basename(op)
      return !!name && /^(\.npmrc|\.netrc|secrets\.json|secrets\.ya?ml|credentials\.json)$/i.test(name)
    },
  },

  // ── 2. 本番DB (production_db) — 5 rules ───────────────────────────────────
  {
    id: 'prod-db-drop',
    category: 'production_db',
    name: 'DB削除コマンド',
    pattern: 'DROP DATABASE | DROP TABLE | DROP SCHEMA',
    riskLevel: 'critical',
    reason: 'データベース/テーブル/スキーマを削除するコマンドです。実行すると復旧できない可能性があります。',
    reason_en: 'This command drops a database, table, or schema — likely unrecoverable once executed.',
    match: (op) => {
      if (op.operationType !== 'bash' || !op.command) return false
      return /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i.test(op.command)
    },
  },
  {
    id: 'prod-db-truncate',
    category: 'production_db',
    name: 'DB全件削除コマンド',
    pattern: 'TRUNCATE TABLE',
    riskLevel: 'critical',
    reason: 'テーブルの全データを削除するコマンドです。実行すると復旧できない可能性があります。',
    reason_en: 'This command truncates a table — all rows are removed and likely unrecoverable.',
    match: (op) => {
      if (op.operationType !== 'bash' || !op.command) return false
      return /\bTRUNCATE\s+TABLE\b/i.test(op.command)
    },
  },
  {
    id: 'prod-db-migrate-deploy',
    category: 'production_db',
    name: '本番マイグレーション実行',
    pattern: 'prisma migrate deploy | prisma migrate reset | prisma db push --force-reset',
    riskLevel: 'critical',
    reason: '本番想定のDBマイグレーションコマンドです。スキーマ変更やデータ損失のリスクがあります。',
    reason_en: 'This runs a production-oriented DB migration command — schema changes or data loss are possible.',
    match: (op) => {
      if (op.operationType !== 'bash' || !op.command) return false
      return /\bprisma\s+migrate\s+(deploy|reset)\b|\bprisma\s+db\s+push\b.*--force-reset/i.test(op.command)
    },
  },
  {
    id: 'prod-db-seed-reset',
    category: 'production_db',
    name: '本番DBシード/リセット',
    pattern: 'db:seed:prod | reset-prod-db | prisma db seed --force',
    riskLevel: 'critical',
    reason: '本番データベースを対象にしたシード/リセット操作の可能性があります。既存データを上書きする恐れがあります。',
    reason_en: 'This looks like a production database seed/reset operation, which may overwrite existing data.',
    match: (op) => {
      if (op.operationType !== 'bash' || !op.command) return false
      return /\bdb:seed:prod\b|reset-prod-db|\bprisma\s+db\s+seed\b.*--force/i.test(op.command)
    },
  },
  {
    id: 'prod-db-direct-connection',
    category: 'production_db',
    name: '本番DBへの直接接続',
    pattern: 'psql | mysql | mongosh | redis-cli (with "prod" in the command)',
    riskLevel: 'warn',
    reason: '本番データベースへ直接接続しようとしています。操作内容にご注意ください。',
    reason_en: 'Connecting directly to what looks like a production database — proceed carefully.',
    match: (op) => {
      if (op.operationType !== 'bash' || !op.command) return false
      return /\b(psql|mysql|mongosh|redis-cli)\b/i.test(op.command) && /prod/i.test(op.command)
    },
  },

  // ── 3. 破壊的コマンド (destructive_command) — 5 rules ─────────────────────
  {
    id: 'rm-rf-risky-path',
    category: 'destructive_command',
    name: '危険パスへの再帰削除',
    pattern: 'rm -rf /, ~, .., or *',
    riskLevel: 'critical',
    reason: 'ルート・ホーム・親ディレクトリ・ワイルドカードを対象にした再帰的な強制削除です。',
    reason_en: 'Recursive force-delete targeting root, home, parent, or a wildcard path.',
    match: (op) => {
      if (op.operationType !== 'bash' || !op.command) return false
      return /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b[^&|;\n]*\s(\/(\s|$)|~|\.\.|\*|\$HOME)/i.test(op.command)
    },
  },
  {
    id: 'git-force-push-protected-branch',
    category: 'destructive_command',
    name: '保護ブランチへのforce push',
    pattern: 'git push --force ... main|master',
    riskLevel: 'critical',
    reason: '保護ブランチ（main/master）へのforce pushは、共有された履歴を上書きする可能性があります。',
    reason_en: 'Force-pushing to a protected branch (main/master) can overwrite shared history.',
    match: (op) => {
      if ((op.operationType !== 'bash' && op.operationType !== 'git') || !op.command) return false
      const isPush = /\bgit\s+push\b/i.test(op.command)
      const isForce = /(--force(-with-lease)?|(?<!\w)-f(?!\w))/i.test(op.command)
      const isProtectedBranch = /\b(main|master)\b/i.test(op.command)
      return isPush && isForce && isProtectedBranch
    },
  },
  {
    id: 'sudo-command-warn',
    category: 'destructive_command',
    name: 'sudo実行',
    pattern: 'sudo ...',
    riskLevel: 'warn',
    reason: 'sudoによる特権実行です。内容に注意してください。',
    reason_en: 'sudo usage is notable but not automatically blocking.',
    match: (op) => {
      if (op.operationType !== 'bash' || !op.command) return false
      return /\bsudo\b/i.test(op.command)
    },
  },
  {
    id: 'git-reset-hard',
    category: 'destructive_command',
    name: 'git reset --hard',
    pattern: 'git reset --hard',
    riskLevel: 'warn',
    reason: 'コミットされていない変更を破棄する可能性がある操作です。',
    reason_en: 'This can discard uncommitted local changes.',
    match: (op) => {
      if (op.operationType !== 'bash' || !op.command) return false
      return /\bgit\s+reset\s+--hard\b/i.test(op.command)
    },
  },
  {
    id: 'disk-format-or-overwrite',
    category: 'destructive_command',
    name: 'ディスクフォーマット/直接書き込み',
    pattern: 'mkfs.* | format [drive]: | dd ... of=/dev/sd*|nvme*',
    riskLevel: 'critical',
    reason: 'ディスクのフォーマットや直接書き込みは、データを完全に消失させる可能性があります。',
    reason_en: 'Formatting or directly writing to a disk device can permanently destroy data.',
    match: (op) => {
      if (op.operationType !== 'bash' || !op.command) return false
      return /\bmkfs\.|(^|[;&|]\s*)format\s+[a-zA-Z]:|\bdd\b[^\n]*of=\/dev\/(sd|nvme|disk)/i.test(op.command)
    },
  },

  // ── 4. デプロイ (deploy) — 5 rules ─────────────────────────────────────────
  {
    id: 'deploy-to-production',
    category: 'deploy',
    name: '本番デプロイ',
    pattern: 'vercel --prod | netlify deploy --prod | fly deploy | git push heroku main',
    riskLevel: 'critical',
    reason: '本番環境へのデプロイコマンドです。ユーザーに影響する変更が即座に反映されます。',
    reason_en: 'This deploys to a production environment — changes take effect immediately for real users.',
    match: (op) => {
      if (!op.command) return false
      return /\bvercel\b[^\n]*--prod\b|\bnetlify\s+deploy\b[^\n]*--prod\b|\bfly\s+deploy\b|\bgit\s+push\s+heroku\s+main\b/i.test(
        op.command,
      )
    },
  },
  {
    id: 'npm-publish',
    category: 'deploy',
    name: 'npm公開',
    pattern: 'npm publish | pnpm publish | yarn publish (excluding --dry-run)',
    riskLevel: 'critical',
    reason: 'パッケージレジストリへの公開は取り消せません。公開前に内容を確認してください。',
    reason_en: 'Publishing to a package registry generally can\'t be undone — verify the contents first.',
    match: (op) => {
      if (!op.command) return false
      if (/--dry-run/i.test(op.command)) return false
      return /\b(npm|pnpm|yarn)\s+publish\b/i.test(op.command)
    },
  },
  {
    id: 'docker-push',
    category: 'deploy',
    name: 'Dockerイメージのpush',
    pattern: 'docker push',
    riskLevel: 'critical',
    reason: 'コンテナレジストリへのイメージpushです。本番環境で使われるイメージを更新する可能性があります。',
    reason_en: 'Pushing a container image to a registry may update what production actually runs.',
    match: (op) => {
      if (!op.command) return false
      return /\bdocker\s+push\b/i.test(op.command)
    },
  },
  {
    id: 'kubernetes-apply-prod',
    category: 'deploy',
    name: 'Kubernetes本番適用',
    pattern: 'kubectl apply|delete (with "prod" in the command)',
    riskLevel: 'critical',
    reason: '本番想定のKubernetesクラスタへの変更/削除コマンドです。',
    reason_en: 'This applies or deletes resources on what looks like a production Kubernetes cluster.',
    match: (op) => {
      if (!op.command) return false
      return /\bkubectl\s+(apply|delete)\b/i.test(op.command) && /prod/i.test(op.command)
    },
  },
  {
    id: 'terraform-apply-or-destroy',
    category: 'deploy',
    name: 'Terraform適用/破棄',
    pattern: 'terraform apply | terraform destroy',
    riskLevel: 'critical',
    reason: 'インフラ全体に影響するterraformの適用/破棄コマンドです。',
    reason_en: 'This applies or destroys infrastructure via Terraform — impact can be broad.',
    match: (op) => {
      if (!op.command) return false
      return /\bterraform\s+(apply|destroy)\b/i.test(op.command)
    },
  },

  // ── 5. 外部送信 (exfiltration) — 5 rules ───────────────────────────────────
  {
    id: 'external-http-high-risk-domain',
    category: 'exfiltration',
    name: '外部送信に悪用されやすいドメインへの通信',
    pattern: 'curl/wget to pastebin, ngrok, webhook.site, requestbin, transfer.sh, file.io',
    riskLevel: 'critical',
    reason: 'データ持ち出しに悪用されやすい外部サービスへの通信です。',
    reason_en: 'This talks to an external service commonly abused for exfiltrating data.',
    match: (op) => {
      if (!op.command) return false
      if (!/\b(curl|wget)\b/i.test(op.command)) return false
      return /pastebin\.|ngrok\.io|ngrok-free\.app|webhook\.site|requestbin\.|transfer\.sh|file\.io/i.test(op.command)
    },
  },
  {
    id: 'env-dump-to-network',
    category: 'exfiltration',
    name: '環境変数の外部送信',
    pattern: 'env | curl ... , cat .env | nc ...',
    riskLevel: 'critical',
    reason: '環境変数や.envファイルの内容をネットワーク経由で外部に送信しようとしています。',
    reason_en: 'This pipes environment variables or .env contents to a network tool — a classic exfiltration pattern.',
    match: (op) => {
      if (!op.command) return false
      const dumpsSecrets = /\b(env|printenv)\b|\bcat\s+\.env\S*/i.test(op.command)
      const sendsOverNetwork = /\|[^\n]*\b(curl|nc|ncat|wget)\b/i.test(op.command)
      return dumpsSecrets && sendsOverNetwork
    },
  },
  {
    id: 'reverse-shell',
    category: 'exfiltration',
    name: 'リバースシェルの兆候',
    pattern: 'nc -e, bash -i >&/dev/tcp/, ncat --exec',
    riskLevel: 'critical',
    reason: 'リバースシェルの典型的なパターンです。外部からの制御を許す可能性があります。',
    reason_en: 'This matches a classic reverse-shell pattern, which could grant remote control of this machine.',
    match: (op) => {
      if (!op.command) return false
      return /\bnc\b[^\n]*-e\s|bash\s+-i\s*>&\s*\/dev\/tcp\/|\/bin\/sh\s+-i\b|\bncat\b[^\n]*--exec\b/i.test(op.command)
    },
  },
  {
    id: 'raw-network-tool-usage',
    category: 'exfiltration',
    name: 'ネットワークツールの使用',
    pattern: 'nc | ncat | socat',
    riskLevel: 'warn',
    reason: '汎用ネットワークツールが使われています。用途を確認してください。',
    reason_en: 'A raw network tool was used — worth a glance, not necessarily malicious.',
    match: (op) => {
      if (!op.command) return false
      return /\b(nc|ncat|socat)\b/i.test(op.command)
    },
  },
  {
    id: 'external-http-generic',
    category: 'exfiltration',
    name: '外部への一般的なHTTP通信',
    pattern: 'curl | wget (excluding localhost/127.0.0.1)',
    riskLevel: 'warn',
    reason: '外部へのHTTP通信です。送信内容にご注意ください。',
    reason_en: 'A generic outbound HTTP call — worth visibility, not automatically dangerous.',
    match: (op) => {
      if (!op.command) return false
      if (!/\b(curl|wget)\b/i.test(op.command)) return false
      return !/localhost|127\.0\.0\.1|0\.0\.0\.0|::1/i.test(op.command)
    },
  },

  // ── 6. パッケージ・CI設定改変 (package_ci_config) — 5 rules ───────────────
  {
    id: 'ci-workflow-write',
    category: 'package_ci_config',
    name: 'CI設定ファイルの変更',
    pattern: '.github/workflows/*.yml | .gitlab-ci.yml | .circleci/config.yml',
    riskLevel: 'critical',
    reason: 'CI設定の変更は、シークレットの露出や不正コードの実行に悪用される可能性があります。',
    reason_en: 'CI config changes can be abused to exfiltrate secrets or run unauthorized code in the pipeline.',
    match: (op) => {
      if (!isWriteOp(op) || !op.path) return false
      return /\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$|\.gitlab-ci\.ya?ml$|\.circleci[\\/]config\.ya?ml$/i.test(
        op.path,
      )
    },
  },
  {
    id: 'git-hooks-write',
    category: 'package_ci_config',
    name: 'Gitフックの変更',
    pattern: '.git/hooks/* | .husky/*',
    riskLevel: 'critical',
    reason: 'Gitフックの変更は、以後のgit操作時に任意のコードを実行させる持続的な仕組みに悪用され得ます。',
    reason_en: 'Modifying git hooks can create a persistence mechanism that runs arbitrary code on future git operations.',
    match: (op) => {
      if (!isWriteOp(op) || !op.path) return false
      return /\.git[\\/]hooks[\\/]|\.husky[\\/]/i.test(op.path)
    },
  },
  {
    id: 'npm-install-global-or-unpinned',
    category: 'package_ci_config',
    name: 'グローバル/無制限パッケージインストール',
    pattern: 'npm install -g | yarn global add | pnpm add -g',
    riskLevel: 'warn',
    reason: 'グローバルパッケージのインストールです。サプライチェーンリスクにご注意ください。',
    reason_en: 'A global package install — worth a glance for supply-chain risk.',
    match: (op) => {
      if (!op.command) return false
      return /\bnpm\s+install\s+-g\b|\byarn\s+global\s+add\b|\bpnpm\s+add\s+-g\b/i.test(op.command)
    },
  },
  {
    id: 'package-json-write',
    category: 'package_ci_config',
    name: 'package.jsonの変更',
    pattern: 'package.json',
    riskLevel: 'warn',
    reason: '依存関係やスクリプトの変更が含まれる可能性があります。',
    reason_en: 'This may change dependencies or scripts.',
    match: (op) => {
      if (!isWriteOp(op)) return false
      return basename(op) === 'package.json'
    },
  },
  {
    id: 'lockfile-write',
    category: 'package_ci_config',
    name: 'ロックファイルの変更',
    pattern: 'package-lock.json | pnpm-lock.yaml | yarn.lock',
    riskLevel: 'warn',
    reason: '依存パッケージのバージョン変更が含まれる可能性があります。',
    reason_en: 'This may change resolved dependency versions.',
    match: (op) => {
      if (!isWriteOp(op)) return false
      const name = basename(op)
      return !!name && /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(name)
    },
  },

  // ── MCP tool-call detection (2026-08-01, not counted in the 30) ──────────
  // Added after an investigation found MCP-routed tool calls
  // (tool_name = mcp__<server>__<tool>) fell through classifyPayload() to an
  // unmatched bash operation with no command, which every rule above ignores
  // and default-allow silently accepts — a real gap, not a hypothetical one.
  // These 5 rules are deliberately NOT folded into the "30 rules / 6
  // categories / 5 each" catalog above (kept as its own dedicated, testable
  // block instead) because they match on a structurally different signal:
  // an MCP tool's own name (mcpToolName) and/or its stringified arguments
  // (mcpToolInputText) — never a file path or bash command string. Every
  // mcp_tool_call operation MUST be caught by one of these 5 (the last one
  // is an unconditional catch-all for this operationType) before it can
  // ever reach default-allow.
  {
    id: 'mcp-destructive-tool-name',
    category: 'destructive_command',
    name: 'MCP: 破壊的な名前のツール呼び出し',
    pattern: 'tool_name に delete/drop/purge/destroy/remove を含むMCPツール呼び出し',
    riskLevel: 'critical',
    reason: 'MCPツール名が削除・破棄系の操作を示唆しています。引数の中身は判定していません。',
    reason_en: "The MCP tool's own name suggests a delete/destroy-style operation. Arguments are not inspected for this rule.",
    match: (op) => {
      if (op.operationType !== 'mcp_tool_call' || !op.mcpToolName) return false
      return MCP_DESTRUCTIVE_TOOL_NAME_RE.test(op.mcpToolName)
    },
  },
  {
    id: 'mcp-secret-like-argument',
    category: 'secrets',
    name: 'MCP: 引数内の秘密情報らしき文字列',
    pattern: 'MCPツール引数に API key prefixes / Bearer token / password=,token= 等',
    riskLevel: 'critical',
    reason: 'MCPツール呼び出しの引数に秘密情報らしき文字列が含まれています。',
    reason_en: "This MCP tool call's arguments contain what looks like a secret value.",
    match: (op) => {
      if (op.operationType !== 'mcp_tool_call' || !op.mcpToolInputText) return false
      return SECRET_LIKE_RE.test(op.mcpToolInputText)
    },
  },
  {
    id: 'mcp-env-file-argument',
    category: 'secrets',
    name: 'MCP: 引数内の.envファイル参照',
    pattern: 'MCPツール引数に .env系のパス参照（.example/.sample/.templateを除く）',
    riskLevel: 'critical',
    reason: 'MCPツール呼び出しの引数が、テンプレートではない実際の.envファイルを参照している可能性があります。',
    reason_en: "This MCP tool call's arguments appear to reference a real (non-template) .env file.",
    match: (op) => {
      if (op.operationType !== 'mcp_tool_call' || !op.mcpToolInputText) return false
      return MCP_ENV_FILE_LIKE_RE.test(op.mcpToolInputText) && !MCP_ENV_FILE_ALLOW_RE.test(op.mcpToolInputText)
    },
  },
  {
    id: 'mcp-production-db-argument',
    category: 'production_db',
    name: 'MCP: 引数内の本番DB操作/接続文字列',
    pattern: 'MCPツール引数に DROP/TRUNCATE、または"prod"を含む接続文字列',
    riskLevel: 'critical',
    reason: 'MCPツール呼び出しの引数が、本番データベースへの破壊的操作または直接接続を示唆しています。',
    reason_en: "This MCP tool call's arguments suggest a destructive operation on, or a direct connection to, a production database.",
    match: (op) => {
      if (op.operationType !== 'mcp_tool_call' || !op.mcpToolInputText) return false
      return MCP_DESTRUCTIVE_SQL_RE.test(op.mcpToolInputText) || MCP_PROD_DB_CONNECTION_RE.test(op.mcpToolInputText)
    },
  },
  {
    id: 'mcp-unknown-tool-default',
    category: 'destructive_command',
    name: 'MCP: 未分類のツール呼び出し',
    pattern: '上記4件のいずれにも一致しないMCPツール呼び出し（無条件catch-all）',
    riskLevel: 'warn',
    reason: '未知のMCPツールです。既知の危険パターンには一致しませんでしたが、無音では通過させません。',
    reason_en: 'An MCP tool that matched none of the known dangerous patterns above — never silently allowed regardless. The CLI hook may escalate this to critical via the unclassifiedToolRisk config.',
    match: (op) => op.operationType === 'mcp_tool_call',
  },

  // ── Built-in web tools (2026-08-01, not counted in the 30) ───────────────
  // WebFetch/WebSearch are legitimate, high-frequency Claude Code tools —
  // general web browsing must NOT be blocked or every WebFetch call would
  // require approval and the product would be unusable for its own main use
  // case. The one real exfiltration channel here is a secret-shaped value
  // embedded in the destination URL or the search query itself (e.g.
  // `https://attacker.example.com/?leak=sk-...`) — that, specifically, goes
  // critical. Everything else WebFetch/WebSearch falls through to
  // unclassified-tool-default (warn) below, same as any other tool
  // classify.ts doesn't have a dedicated branch for.
  {
    id: 'web-target-secret-like',
    category: 'exfiltration',
    name: 'Web宛先URL/検索クエリ内の秘密情報らしき文字列',
    pattern: 'WebFetchのURLまたはWebSearchのクエリに API key prefixes / Bearer token / password=,token= 等',
    riskLevel: 'critical',
    reason: 'WebFetch/WebSearchの宛先URLまたは検索クエリに秘密情報らしき文字列が含まれています。一般的なWeb閲覧は対象外です。',
    reason_en:
      "A WebFetch URL or WebSearch query contains what looks like a secret value — the actual exfiltration channel for these tools. General web browsing is never flagged.",
    match: (op) => {
      if (op.operationType !== 'unclassified' || !op.webTargetText) return false
      return SECRET_LIKE_RE.test(op.webTargetText)
    },
  },

  // ── Unclassified fallback (2026-08-01, not counted in the 30) ────────────
  // The generalized form of mcp-unknown-tool-default above: ANY operation
  // classify.ts could not confidently place into a known shape (currently:
  // WebFetch/WebSearch minus the secret-in-target case just above, and
  // whatever future built-in tool Claude Code adds next) lands here instead
  // of silently default-allow. This is the actual fix for the root cause —
  // adding one more specific rule per tool would always leave a next unknown
  // tool falling through to default-allow again.
  {
    id: 'unclassified-tool-default',
    category: 'destructive_command',
    name: '未分類のツール呼び出し',
    pattern: 'file_read/file_write/bash/git/deploy/mcp_tool_callのいずれにも分類できない操作（無条件catch-all）',
    riskLevel: 'warn',
    reason: '未分類のツール呼び出しです。既知の危険パターンには一致しませんでしたが、無音では通過させません。',
    reason_en: 'An operation classify.ts could not place into any known shape — never silently allowed regardless. The CLI hook may escalate this to critical via the unclassifiedToolRisk config.',
    match: (op) => op.operationType === 'unclassified',
  },

  // ── Default fallback (not counted in the 30) ─────────────────────────────
  {
    id: 'default-allow',
    category: 'destructive_command',
    name: 'その他の操作',
    pattern: '*',
    riskLevel: 'allow',
    reason: 'その他の操作はすべて無音で通過します。',
    reason_en: 'Everything else passes silently — Velar stays out of the way for the 99% case.',
    match: () => true,
  },
]
