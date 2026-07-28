# @velar-dev/cli

Pre-execution approval for AI coding agents. Velar blocks dangerous operations before they run — and sees nothing else.

## What is Velar

Velar sits between an AI coding agent (Claude Code, Codex, Cursor) and your machine as a `PreToolUse` hook. It classifies every file/bash/git operation locally, blocks or asks for Slack approval on anything dangerous, and stays silently out of the way for everything else. It never reads your prompts, your file contents, or your API keys.

## Quick Start

Get a first blocked-operation demo running in about 60 seconds.

```bash
# 1. Install (no global install needed)
npx @velar-dev/cli init

# 2. Log in with the Ingest Token from your Velar dashboard
npx @velar-dev/cli login --token vlr_xxxxxxxx --org-id org_xxxxxxxx

# 3. Run Claude Code through Velar
npx @velar-dev/cli run claude
```

`init` writes a `PreToolUse` hook into `.claude/settings.json` for the current project. From then on, every file write, bash command, and git operation Claude Code attempts is classified before it runs. Try asking it to read `.env` or run `rm -rf ~` — Velar blocks it, no dashboard required for local-only mode.

## What Velar sends vs. NEVER sends

| Sends | Never sends |
|---|---|
| Rule ID that matched (e.g. `env-file-protection`) | File contents |
| Risk level (`allow` / `warn` / `critical`) | Prompt text |
| Operation type (`file_read`, `bash`, `git`, `deploy`) | Full file paths (only the basename, if anything) |
| Decision (`allowed` / `blocked` / `approved`) | Command arguments or flags |
| Project/agent name, approval method, latency | Environment variables or secret values |

Velar's local rule engine (`@velar-dev/rules`) matches on operation type, file basename, and command text — entirely in-process. Only the classification result above is ever reported to the dashboard or posted to Slack. This contract is enforced by an explicit Zod `.strict()` schema at the wire boundary and is covered by the [zero-knowledge-contract test suite](./tests/zero-knowledge-contract.test.ts) — any field outside the allow-list is rejected, not silently dropped.

## How it works

1. **Hook registration** — `velar init` adds a `PreToolUse` entry to `.claude/settings.json`, so Claude Code pipes every tool call through `velar hook pre-tool-use` before executing it.
2. **Local classification** — the hook normalizes the tool call (path, command, or git operation) and evaluates it against `@velar-dev/rules`' 30-rule catalog. This step is synchronous, in-process, and completes in well under 50ms.
3. **Decision**:
   - `allow` → the operation proceeds immediately, silently.
   - `warn` → the operation proceeds, but is logged for visibility.
   - `critical` → the operation is blocked pending approval. If a terminal is attached, Velar prompts `[y/N]` locally. If a Slack workspace is configured, Velar posts an approval card instead and polls for a decision (approve / deny / allow for 10 minutes), with a 120-second fail-closed timeout.
4. **Event log** — every decision (never the underlying content) is appended to a local redacted JSONL log and, if configured, reported to the Velar dashboard for team-wide visibility and audit.

## Rules (30)

Every rule matches on operation type, file basename/path, or command text only — never file content or prompt text. See [`src/rules.ts`](./src/rules.ts) for the exact matching logic; `pattern` below is a human-readable summary, not always the literal regex.

### 秘密情報 / Secrets

| ID | Risk | Pattern | Reason |
|---|---|---|---|
| `env-file-protection` | critical | ^\.env(\.\|$) (excluding .example/.sample/.template) | Reading or writing a real (non-example) .env file may expose production secrets. |
| `cloud-credentials-file` | critical | .aws/credentials, .config/gcloud/*, .azure/*, .kube/config | Accessing a cloud provider credentials file could lead to full infrastructure compromise. |
| `ssh-private-key` | critical | id_rsa \| id_ed25519 \| id_ecdsa \| *.pem \| *.pfx \| *.ppk (excluding *.pub) | Reading or writing an SSH private key could be used to gain unauthorized access to other systems. |
| `secret-in-command` | critical | API key prefixes (sk-/xox*/ghp_/AIza/AKIA), Bearer token, password=/token= | The command text contains what looks like a secret value, which could leak into shell history or logs. |
| `dotfile-secret-write` | critical | .npmrc \| .netrc \| secrets.json \| secrets.yaml \| secrets.yml \| credentials.json | Writing to a file that conventionally holds auth tokens (e.g. .npmrc, .netrc) may expose credentials. |

### 本番DB / Production DB

| ID | Risk | Pattern | Reason |
|---|---|---|---|
| `prod-db-drop` | critical | DROP DATABASE \| DROP TABLE \| DROP SCHEMA | This command drops a database, table, or schema — likely unrecoverable once executed. |
| `prod-db-truncate` | critical | TRUNCATE TABLE | This command truncates a table — all rows are removed and likely unrecoverable. |
| `prod-db-migrate-deploy` | critical | prisma migrate deploy \| prisma migrate reset \| prisma db push --force-reset | This runs a production-oriented DB migration command — schema changes or data loss are possible. |
| `prod-db-seed-reset` | critical | db:seed:prod \| reset-prod-db \| prisma db seed --force | This looks like a production database seed/reset operation, which may overwrite existing data. |
| `prod-db-direct-connection` | warn | psql \| mysql \| mongosh \| redis-cli (with "prod" in the command) | Connecting directly to what looks like a production database — proceed carefully. |

### 破壊的コマンド / Destructive Commands

| ID | Risk | Pattern | Reason |
|---|---|---|---|
| `rm-rf-risky-path` | critical | rm -rf /, ~, .., or * | Recursive force-delete targeting root, home, parent, or a wildcard path. |
| `git-force-push-protected-branch` | critical | git push --force ... main\|master | Force-pushing to a protected branch (main/master) can overwrite shared history. |
| `sudo-command-warn` | warn | sudo ... | sudo usage is notable but not automatically blocking. |
| `git-reset-hard` | warn | git reset --hard | This can discard uncommitted local changes. |
| `disk-format-or-overwrite` | critical | mkfs.* \| format [drive]: \| dd ... of=/dev/sd*\|nvme* | Formatting or directly writing to a disk device can permanently destroy data. |

### デプロイ / Deploy

| ID | Risk | Pattern | Reason |
|---|---|---|---|
| `deploy-to-production` | critical | vercel --prod \| netlify deploy --prod \| fly deploy \| git push heroku main | This deploys to a production environment — changes take effect immediately for real users. |
| `npm-publish` | critical | npm publish \| pnpm publish \| yarn publish (excluding --dry-run) | Publishing to a package registry generally can't be undone — verify the contents first. |
| `docker-push` | critical | docker push | Pushing a container image to a registry may update what production actually runs. |
| `kubernetes-apply-prod` | critical | kubectl apply\|delete (with "prod" in the command) | This applies or deletes resources on what looks like a production Kubernetes cluster. |
| `terraform-apply-or-destroy` | critical | terraform apply \| terraform destroy | This applies or destroys infrastructure via Terraform — impact can be broad. |

### 外部送信 / Exfiltration

| ID | Risk | Pattern | Reason |
|---|---|---|---|
| `external-http-high-risk-domain` | critical | curl/wget to pastebin, ngrok, webhook.site, requestbin, transfer.sh, file.io | This talks to an external service commonly abused for exfiltrating data. |
| `env-dump-to-network` | critical | env \| curl ... , cat .env \| nc ... | This pipes environment variables or .env contents to a network tool — a classic exfiltration pattern. |
| `reverse-shell` | critical | nc -e, bash -i >&/dev/tcp/, ncat --exec | This matches a classic reverse-shell pattern, which could grant remote control of this machine. |
| `raw-network-tool-usage` | warn | nc \| ncat \| socat | A raw network tool was used — worth a glance, not necessarily malicious. |
| `external-http-generic` | warn | curl \| wget (excluding localhost/127.0.0.1) | A generic outbound HTTP call — worth visibility, not automatically dangerous. |

### パッケージ・CI設定 / Package & CI Config

| ID | Risk | Pattern | Reason |
|---|---|---|---|
| `ci-workflow-write` | critical | .github/workflows/*.yml \| .gitlab-ci.yml \| .circleci/config.yml | CI config changes can be abused to exfiltrate secrets or run unauthorized code in the pipeline. |
| `git-hooks-write` | critical | .git/hooks/* \| .husky/* | Modifying git hooks can create a persistence mechanism that runs arbitrary code on future git operations. |
| `npm-install-global-or-unpinned` | warn | npm install -g \| yarn global add \| pnpm add -g | A global package install — worth a glance for supply-chain risk. |
| `package-json-write` | warn | package.json | This may change dependencies or scripts. |
| `lockfile-write` | warn | package-lock.json \| pnpm-lock.yaml \| yarn.lock | This may change resolved dependency versions. |

## Self-hosting

By default, `velar login` and `velar run claude` talk to `https://usevelar.com`. To point the CLI at a self-hosted or local instance of the Velar dashboard/API instead, override the base URL — no rebuild needed:

```bash
# Per-invocation, via flag (saved into ~/.velar/config.json on login)
velar login --token vlr_xxxxxxxx --org-id org_xxxxxxxx --api-url http://localhost:4000

# Or via environment variable — takes priority over both the saved config
# value and the https://usevelar.com default, useful for CI or one-off runs
VELAR_API_URL=http://localhost:4000 velar run claude
```

Resolution order (highest priority first): `VELAR_API_URL` env var → `apiBaseUrl` saved in `~/.velar/config.json` (via `--api-url` at login) → `https://usevelar.com`.

## Development

```bash
pnpm install
pnpm --filter @velar-dev/cli build
pnpm --filter @velar-dev/cli test
```

## License

MIT — see [LICENSE](./LICENSE).
