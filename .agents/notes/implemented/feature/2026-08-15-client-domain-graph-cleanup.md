# Agent Note: Client domain-graph cleanup

Status: implemented

English | [中文](2026-08-15-client-domain-graph-cleanup.zh.md)

## Problem

`verify-client-domain-graph` reported 27 violations at the pinned baseline. Four were the gate script itself misreading imports that escape the client root (`..` popped on an empty stack), and the rest were cross-domain imports in the runtime, ui-conversation, and ui-workspace client packages that route shared API outside the contract layer or top-level shared files. A stale sidebar wordmark snapshot and unregistered event scopes in the catalog generator (from earlier framework work) also failed repository-wide checks.

## Decision

**The gate script now tracks `..` escaping the client root** and skips those imports as package-level (its documented intent); this removes the four false positives.

**Cross-domain imports are routed through contract or top-level shared files.** In `runtime`, the self-contained scope, notifier, pending, context-provenance, and conversation modules moved to the client top level, and the list/row/session types (SessionSummary, SessionListState, SessionBinding, SessionProvideDescriptor, SessionProvideContribution, SessionSearchResultItem, SessionListPhase, SubagentCatalogSnapshot, WorkspaceListState, WorkspaceListPhase) moved into the contract layer, re-exported from their original files so every consumer keeps its import site. In `ui-conversation`, turn-metrics, message-chrome, StatsLine, tool-node-reader, blocks, decorations, and the queue store moved to the top level and `input/contract.ts` into the contract layer. In `ui-workspace`, the rows components moved to the top level. Behavior is unchanged; the moves are pure path/type relocations with re-exports.

**Stale artifacts are regenerated.** The sidebar wordmark snapshot was refreshed for the ARK wordmark, and `gen-cordis-catalog` gained `session-persistence → persistence.md` and `workspace → workspace.md` event-scope mappings, regenerating the committed catalog artifacts the earlier framework work left stale. The run-gates spec expects the Jiuzhang gate in the ci-consumers graph (10 → 11 gates).

## Alternatives considered

**Fixing each violation by moving types individually.** Partially used; self-contained modules moved whole, entangled type clusters moved as units into the contract with re-exports. Not moving anything: rejected, the gate exists to enforce the layering.

## Consequences

`verify-client-domain-graph` reports "client domain layering clean"; `tsc -b tsconfig.client.json` is clean; the four affected packages' 1017 tests pass; the catalog spec regenerates byte for byte; knip and package invariants conform. The remaining full-suite failures are environmental (sandboxed spawn of real shells, host CPU count, 30s timing) and untouched packages.
