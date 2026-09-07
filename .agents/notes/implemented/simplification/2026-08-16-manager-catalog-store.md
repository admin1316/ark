# Agent Note: SessionManager catalog cluster extraction

Status: implemented

English | [中文](2026-08-16-manager-catalog-store.zh.md)

## Problem

After the pending cluster moved out (2026-08-16-manager-pending-tracker), `SessionManager` still carried the subagent catalog cluster — durable direct-parent addresses, per-parent snapshots, single-flight pulls, open-menu membership updates, and removal-time invalidation — as private maps with inline logic spread across selection, instance construction, the frame entry, and the list snapshot.

## Decision

Extract the catalog cluster into `catalog-store.ts` as `CatalogStore` (344 lines): addresses + snapshots + in-flight lifecycle, with a read surface (`snapshot`, `catalogOf`, `addressOf`, `hasAddress`, `navigationAddress`, `retainAddress`, `parentAvailable`, `isOpen`, `openIds`), frame-entry sinks (`markExpandable`, `scheduleRefresh`, `updateActivity`, `handleOwnerRemoved` — the removal-time parent-availability invalidation that previously spanned the removed branch), `clearSession` (permanent deletion: debounce/inflight/stale/open/catalogs/addresses plus child-address sweep and cross-catalog entry removal), and the refresh lifecycle (`refresh`, `setOpen`). The manager composes one instance with `markDirty` + `onParentAvailable` host callbacks; selection, `get()`/`createSession`, the host frame entry, `handleConnected`, and the list snapshot delegate. The manager dropped 213 lines (1071 → 858).

## Alternatives considered

**Extracting the list-model cluster first.** Rejected: the list model reads catalogs and addresses (snapshot `subagentsByParent`/`current`, selection availability) and the catalog cluster's frame-entry sinks were the largest inline blocks in `handleHostEnvelope`; extracting the store first removes the deepest coupling before the list state machine moves.

## Consequences

Behavior is byte-identical — same single-flight reuse, same request-local expandability/activity folding, same removal-time override semantics. Covered through the existing manager spec (61 tests, catalog-store at 100% statements/branches/functions/lines; no spec changes needed). The list-model cluster (mutation replay, entry identity cache, lineage flattening, completion reminders) remains in manager.ts for a final batch.
