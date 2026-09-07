# Agent Note: Phase 2/3 parallel refactor batch

Status: implemented

English | [中文](2026-08-16-phase2-3-refactor-batch.zh.md)

## Problem

The v2 audit's Phase 2 (giant-module splitting) and Phase 3 (governance) lists still had four large refactors outstanding — api-proxy's RPC groups, TrajectoryTable's component concerns, continuation's lifecycle domains, and ToolRuntime's pipeline/registry split — plus the coverage-exclude governance debt (see the dedicated note 2026-08-16-coverage-exclude-consistency-gate).

## Decision

Four behavior-preserving refactors, executed in parallel by separate agents on disjoint packages:

1. **api-proxy RPC groups** (`packages/host/apiproxy`, `cd896b4bab`): the first four groups — sessions/subagents/workspace/goals — moved into `src/handlers/` (`context.ts` with the explicit `ApiProxyContext`, `shared.ts`, plus one `register<Group>Handlers(api)` module per group, 689/192/189/68 lines). The factory keeps the state creation and assembly; unchanged groups were verified byte-identical. api-proxy.ts 3515 → 2332 lines.
2. **TrajectoryTable concerns** (`packages/client/ui-trajectory`, `f8ec462ed5` + `4a232edd49`): details-pane resize, older-history paging, and inspector selection/focus extracted into `useDetailsResize`/`useOlderLoading`/`useTrajectorySelection` with a shared `detail-tabs` module; the component drops ~138 lines. Virtualization and scroll-sync stay in the component (they share `pendingScrollRecordId`/`followsTableTail`/the virtualizer with the render closure).
3. **continuation lifecycle domains** (`packages/subagent/subagent`, `66369907aa`): `OwnershipGraph`/`ActivationMaterializer`/`SettlementWatcher`/`Disposer` extracted (136/188/171/198 lines) over a shared `continuation-state.ts` contract; the manager delegates via constructor hooks. Settlement ordering is preserved verbatim — `notifySettlement` still runs after `activations.delete` and before ownership release inside `finishDisposal`. continuation.ts 1483 → 836 lines.
4. **ToolRuntime pipeline/registry** (`packages/core/tools`, `97c65f20dc`): the execution pipeline moved into `ToolExecutor`; registration/restriction/presentation stays on `ToolRuntime` (the `ToolRegistry` surface). Cancellation fusion semantics (TOOL_ABORTED / TOOL_ABORTED_BEFORE_DISPATCH / cancelled) unchanged; the new module holds per-file 100% coverage.

## Alternatives considered

**Splitting all twelve api-proxy groups in one pass.** Rejected for review size and risk: the events/downloads/respond groups share the frame-queue subsystem (the P3-flagged part); the four-domain first batch establishes the context pattern and is independently verified.

## Consequences

Each refactor is covered by its unchanged package suite (apiproxy 398, ui-trajectory 107, subagent 249, tools green with the executor at 100% coverage); typecheck/lint/duplication/hygiene all pass. One coordination incident: a concurrent worktree reset dropped the four TrajectoryTable hook modules from the first commit; the follow-up commit restored the component and landed the modules. Remaining Phase 3 items (wire-layer cycle SCC, extensions gate) stay open for a later batch.
