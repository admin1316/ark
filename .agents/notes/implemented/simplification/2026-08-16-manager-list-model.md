# Agent Note: SessionManager list-model cluster extraction

Status: implemented

English | [中文](2026-08-16-manager-list-model.zh.md)

## Problem

After the pending and catalog clusters moved out (2026-08-16-manager-pending-tracker, 2026-08-16-manager-catalog-store), `SessionManager` still held the session-list cluster — summaries, pull state/phase/error, in-flight mutation replay, the entry-identity cache, completion reminders, the notifier, and the snapshot builder — alongside the instance cluster and the frame entry.

## Decision

Extract the list cluster into `list-model.ts` as `ListModel` (527 lines): summaries with `applyMutation` replay (blank-lowers, running-as-cross-client-blank-flip, newest-wins preset, reference-preserving no-op upserts), the pull state/phase/error axis, the notifier-backed snapshot cache with entry identity preservation, completion reminders, the jobs mirror, and the list API (`refresh`, `search`, `create`, `fork`, `mergeSummary`, `noteAgentPreset`, `recordMutation`, `subscribe`, `getListSnapshot`). The manager composes one instance with `markDirty`/`notifyNow`/`ensureProjectionStore`/`projectionStoreOf`/`pushSummaries` host callbacks; selection, the frame entries, `get()`/`createSession`, and `handleConnected` delegate. The manager dropped 327 lines (858 → 531) and now contains only the instance cluster and the frame-entry orchestration.

## Alternatives considered

**Leaving the notifier in the manager.** Rejected: the notifier owns the snapshot cache lifecycle (lazy rebuild when dirty with no listeners), which is list-cluster state; splitting it would make the republish channel reach across two objects for every mutation.

## Consequences

Behavior is byte-identical — same mutation semantics (including the status blank flip and the no-op upsert reference preservation), same first-pull `pending → ready` edge, same entry-identity stability. Covered through the existing manager spec (61 tests, list-model at 100% statements/branches/functions/lines; no spec changes needed). `SessionManager` is now the instance cluster + frame entry over three composed models; the file-architecture P2-2 batch is complete.
