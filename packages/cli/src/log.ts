import fs from 'node:fs'
import path from 'node:path'
import { buildVelarEvent } from '@velar/shared'
import type { ApprovalMethod, Decision, NormalizedOperation, RiskLevel } from '@velar/shared'

/**
 * Appends one event to .velar/events.jsonl. This is the ONLY place the CLI
 * writes the local log, and it goes exclusively through buildVelarEvent() —
 * there is no code path here that could append a full path, a command
 * string, prompt text, file content, or a secret value.
 */
export function appendVelarEvent(
  velarDir: string,
  params: {
    projectName: string
    agentName: string
    operation: NormalizedOperation
    matchedRuleId: string
    riskLevel: RiskLevel
    decision: Decision
    approvalMethod: ApprovalMethod
  },
): void {
  const event = buildVelarEvent(params)
  fs.mkdirSync(velarDir, { recursive: true })
  fs.appendFileSync(path.join(velarDir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8')
}
