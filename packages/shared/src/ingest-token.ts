/**
 * Velar Ingest Token prefix — a token Velar itself issues (org-scoped) to
 * authenticate the CLI to apps/api. Completely unrelated to a customer's
 * LLM provider API key, which Velar never receives, stores, or proxies.
 */
export const INGEST_TOKEN_PREFIX = 'vlr_'

export function looksLikeIngestToken(value: string): boolean {
  return value.startsWith(INGEST_TOKEN_PREFIX) && value.length > INGEST_TOKEN_PREFIX.length + 8
}
