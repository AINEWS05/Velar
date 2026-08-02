# Changelog

All notable changes to `@velar-dev/shared` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 0.3.0 — 2026-08-01

Released together with `@velar-dev/cli@0.3.0` — see [its CHANGELOG](https://www.npmjs.com/package/@velar-dev/cli?activeTab=readme) for the full user-facing behavior change.

### Added

- `OperationType` gains `'unclassified'` (in addition to the existing `mcp_tool_call`).
- `NormalizedOperation` gains `originalToolName`, `webTargetText`, `isSubagent`, `agentType` (all in-memory-only, never persisted raw — see `redact.ts`).
- `VelarEvent` (local log) gains `unclassifiedToolName` (only ever populated for a non-MCP, non-user-defined built-in tool name) and `isSubagent`.
- `ActionEnvelope` (cloud-reported) gains `unclassifiedToolName`, `isSubagent`, and `subagentTypeHash` (a salted hash — the raw subagent name is never sent, same privacy treatment as MCP server/tool names).
- `CAPABILITY_MANIFEST` gains an `'unclassified'` action type entry for every adapter.

## 0.2.0 and earlier

See git history — this changelog starts at 0.3.0.
