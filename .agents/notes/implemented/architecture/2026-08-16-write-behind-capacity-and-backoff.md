# Agent Note: Write-behind admission cap and failure backoff

Status: implemented

English | [中文](2026-08-16-write-behind-capacity-and-backoff.zh.md)

## Problem

The session-persistence audit finding P2-4 flagged two unbounded behaviors in `SessionWriteBehind` (packages/session/session-persistence/src/write-behind.ts). First, the `pending` event array has no capacity limit: when event production outpaces backend write throughput (slow disk, huge bursts), the queued buffer grows without bound and offers the producer no backpressure. Second, there is no retry backoff after a write failure: the failed batch stays at the queue head with `automaticPaused` set, and the next `enqueue` re-arms the fixed 200 ms window and retries the whole queue — a permanent failure (disk full) therefore costs "event rate × full-queue retries" forever, amplifying load on the failing backend.

## Decision

`SessionWriteBehind` now bounds admission and escalates retry spacing. This extends the [bounded write-batching decision](2026-08-08-bounded-session-persistence-write-batching.md): the fixed batching deadline and the flush-barrier semantics it chose are unchanged.

- **Capacity cap.** A new `maxPendingEvents` option (default `DEFAULT_MAX_PENDING_EVENTS = 100_000`) limits how many events the pending buffer admits. `enqueue` refuses admission past the cap by throwing `SessionWriteBehindOverflowError`; on the session/event path the SessionStore contains the listener throw and logs it, so the refused event is dropped with a warning instead of retained beyond the memory bound. The coordinator exposes the cap as a validated `PersistenceCoordinatorOptions.maxPendingEvents`; JSONL and SQLite keep the default.
- **Exponential backoff.** A consecutive-failure counter grows on every failed write and resets on any successful write. The next automatic retry window doubles per consecutive failure (200 → 400 → 800 → …) and is capped at `MAX_WRITE_RETRY_BACKOFF_MS = 5_000`, never below the base batching delay. The `automaticPaused` semantics are unchanged: a failure pauses automatic retries until the next `enqueue` (or explicit flush/teardown), which now re-arms the backed-off window.

## Alternatives considered

**Byte-budget cap instead of an event-count cap.** Rejected: estimating the serialized size of every enqueued event costs a JSON pass on the hot session/event path; an event-count bound is a predictable admission gate and matches the audit's suggested `MAX_PENDING_BATCHES` shape.

**Spill overflow to disk.** Rejected as over-engineering for P2-4: a spill file plus merge-on-recovery doubles the backend surface for a case that fail-loud admission already covers.

**Cap only at the coordinator, not in the unit.** Rejected: the bound belongs in the class that owns the buffer, so every direct construction (tests, future embedders) inherits it.

## Consequences

A producer that outpaces the backend now receives backpressure at the admission point: the queue stops growing past `maxPendingEvents`, and the refused event is dropped with a logged warning (a durability gap only under sustained overflow, surfaced loudly rather than silently). Permanent failures now cost at most one retry per doubled window instead of retrying the whole queue on every enqueue, bounded at 5 s spacing. Normal-path behavior is unchanged: healthy batching still writes one fixed window, and all existing contract, crash-recovery, and write-race tests pass unmodified except the write-behind spec constructions, which now pass the option explicitly.
