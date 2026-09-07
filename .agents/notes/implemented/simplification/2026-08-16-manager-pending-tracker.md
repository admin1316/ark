# Agent Note: SessionManager pending cluster extraction

Status: implemented

English | [中文](2026-08-16-manager-pending-tracker.zh.md)

## Problem

`SessionManager` (packages/client/runtime) carried three independent clusters — session-list model, subagent catalog store, and the pre-instantiation pending buffer — in one 1183-line file. The pending cluster (buffer + interaction status) was the most self-contained: its state lives independent of Session instances, its wire contract is the three mux frame pairs, and its consumers are the frame entry, the list snapshot, and the connection-generation lifecycle.

## Decision

Extract the pending cluster into `pending-tracker.ts` as `PendingTracker` (231 lines): the per-session buffer of answerable frames plus the outstanding-interaction status map, with `handleUninstantiated` (buffer/remove by stable `a:`/`q:`/`queue` identity), `replayInto` (drain into a freshly instantiated session), `trackFrame`/`track`/`resolve` (list-level status, idempotent by key), `dropGeneration` (disconnect clears status and drops buffered answerable frames — reopen replay re-adds them), `clearSession` (removal), `dropQueueBaseline` (re-subscribe), and `statusesBySession` (dominant status per row, question ahead of approval). The manager composes one instance with a `markDirty` host callback; the frame entry, `get()` replay, permanent deletion, removal, disconnection, and the list snapshot now delegate. Module-level `bufferedRequestKey` and `questionInteractionStatus` moved in as private helpers. The manager dropped 112 lines.

## Alternatives considered

**Extracting all three clusters at once.** Rejected for review size and risk: the catalog cluster (refresh/inflight/debounce/stale/open/epoch state) and the list cluster (mutation replay, entry identity cache, lineage flattening) each have their own invariants and 100%-coverage surfaces; the pending cluster's wire contract (three frame pairs, stable keys) is independently testable.

## Consequences

Behavior is byte-identical — the same stable keys (`a:`/`q:`/`queue`), the same replay-before-running-sync order in `get()`, the same generation semantics. The extraction is covered through the existing manager spec (61 tests, pending-tracker at 100% statements/branches/functions/lines); no spec changes were needed. Remaining clusters (list-model, catalog-store) stay in manager.ts for a later batch.
