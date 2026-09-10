# Agent Note: Session archive (registry-global set)

Status: implemented

English | [中文](2026-07-31-session-archive-global-set.zh.md)

## Problem

The session row menu in the sidebar workspace browser carried a purely visual "Delete session" placeholder (no handler). The product decision is **archive**, not delete: the session log and its workspace accounting stay untouched; the session merely disappears from every grouping surface (workspace groups, Ungrouped, search, the flat list). The archive record needs a home: an Ungrouped session belongs to no workspace entity, so a per-workspace field cannot carry it.

## Decision

**The archive set is a new field on the workspace domain's global singleton (`workspaceDomainState.archivedSessionIds`), layered over workspace accounting; display filtering converges entirely in the client's `tree.ts` derivation layer; the wire surface uses the full-snapshot posture.**

- Storage: `archivedSessionIds: z.array(sessionId).default([])`, domain version stays 2 — a purely additive field; pre-field media parse to an empty set through the schema default, no migration code. An archived session keeps its `sessionIds` slot (a future unarchive restores its position), so the set never touches the one-owner accounting invariant.
- Registry: `ctx.workspaceRegistry.archiveSession(id)` rides `enqueueOperation`, serialized with create/delete; a session neither live nor persisted throws `WorkspaceUnknownSessionError`; an already archived id neither writes nor emits. The `archivedSessionIds` getter exposes the read-only set.
- RPC: `workspace.archiveSession({sessionId}) → {archivedSessionIds}` (answers the full updated set); the `workspace.list` response carries the set as the reconnect baseline; a new host frame `host/archived-sessions-changed` pushes the full snapshot after every durable change (same posture as `host/workspace-changed`, emitted from the `domain/changed` global-put branch by set comparison). Unknown sessions reuse the `session-not-found` error code.
- Client runtime: `WorkspaceListState.archivedSessionIds` (a `readonly SessionId[]` in Host order, reference replaced only on membership change — public snapshot state stays in the store engine's plain-data vocabulary since immer drafts reject Sets without the MapSet plugin; membership lookups build a transient Set in the derivation, the expandedProjects pattern); the list baseline, the unary echo, and the changed frame each install the complete set. the projection sweep clears the current selection whenever it lands in the archive set, returning to the New Session view (user decision: archiving the open session sends the main view back to the hero) — one rule covering the local unary echo, another tab's changed frame, and a reconnect baseline restoring a selection archived while this client was away; a frame or echo landing during an in-flight `workspace.list` also shields the newer set from the stale baseline.
- UI: the `delete` menu row (visual-only) becomes `archive` (label "Archive session", non-danger styling, no confirmation dialog — a non-destructive action whose worst misfire is list hiding); filtering is one extra arm in `tree.ts`'s `sessionVisible` predicate, with `deriveGroups`/`deriveFlat` taking an `archived` set parameter so all four surfaces (group loop, stray bucket, search, flat) share one source.
- Archive lifecycle: the counted Archive header opens an explicit list that never navigates into an archived Session. `workspace.unarchiveSession` restores a retained log to its existing accounting slot. Permanent deletion is a separate, named confirmation for an archived Session and its complete retained descendant tree. The registry repeatedly discovers and fences that tree, rejects conflicting or cyclic lineage, retires every Host-owned idle resident, and deletes descendants before their parent; running, foreign, queued, open-turn, job-owning, interaction-waiting, or resume-reserved identities remain blocked. Public attachments shared with other Sessions are deliberately retained.
- Durable deletion: `SessionPersistence.delete()` is serialized with every load/append/preparation for that id. SQLite deletes in a transaction. JSONL first renames the whole Session directory to the deterministic project-local `~delete/<encoded-id>` tombstone, fsyncs the participating directories, then recursively removes the tombstone. A cleanup or post-rename fsync failure is reported while the archive marker remains, so the same operation can finish idempotently after retry or restart.
- Committed projection: the persistence-level deletion event only removes derived caches. One `host/session-deleted` frame per removed identity is emitted after every workspace account and the final archive snapshot commit; the client purges selection, summaries, pending interactions, jobs, catalogs, scopes, and projections before it installs that final archive set. Unary-first and Host-frame-first delivery are therefore both idempotent and cannot briefly resurrect a deleted row.

## Alternatives considered

**Per-workspace archivedSessionIds (the original phrasing).** Rejected: Ungrouped sessions have no home; the user switched to global.

**An archived flag on SessionSummary (session.list layer).** Rejected: it joins a workspace-domain fact into the sessions-domain projection, summaries have no incremental frame so a separate notification would still be needed — cross-domain coupling outweighs the saving.

**Host-side filtering in `workspaceView`/the `sessionIds` getter.** Rejected: archiving ≠ changing accounting, and filtering the projection muddles the two concepts; a future restore surface also needs the client to see full accounting.

**Incremental frames (single archived/removed rows).** Rejected: the set is tiny and changes rarely; full snapshots spare the client merge logic and dedup state and match the existing workspace-changed posture.

## Consequences

Archived Sessions now remain discoverable through one explicit Archive surface, can be restored without opening them, and can be permanently deleted only through the fail-closed path above. A stale archive id is shown as a cleanup record: restore stays disabled while permanent-delete retry remains available. The `workspace.list` response shape change remains a pre-release direct edit (no compatibility layer). The workspace-management e2e pins archive → hide → reload → restore → re-archive → confirmed permanent delete → reload absence; domain, gateway, and client tests pin idempotence, unknown-id rejection, descendant-first subtree deletion, cold/reserved preconditions, cyclic-lineage refusal, crash retry, cache cleanup, event ordering, and the pre-field media default upgrade.
