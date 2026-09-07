# Agent Note: P0 concurrency and corruption boundary fixes

Status: implemented

English | [中文](2026-08-16-p0-concurrency-corruption-boundaries.zh.md)

## Problem

A static audit (two-model cross-review: gpt-5.6-sol-ultra and gpt-5.5-xhigh, two rounds each) converged on four P0 defects, and the rework feedback added three more failure modes before the batch passed:

1. The `run_code` sub-dispatch lane never settles its bindings when `scheduler.dispatch`/`prepare` rejects or a commit-stage call throws: `drainDispatches` never converges, so the run hangs even after abort. Review additionally found that a lane failure left `exclusiveActive` stuck (a program catching the failed binding and calling again wedges) and skipped in-flight/settle-log drainage, breaking the in-turn settlement guarantee.
2. `wakeDriver` throws synchronously while the initiator scope is closing (teardown/HMR): the driver promise stays pending forever, the phase is stuck `running`, and `whenIdle()`/disposal deadlock.
3. JSONL plaintext treated a damaged row in the committed region as a torn tail and silently truncated it — valid committed events were physically deleted with no warning. Review additionally found the zstd path's bare corruption errors bypassed the typed wrapper, losing `SessionPersistenceCorruptionError`, the raw path, and the cause.
4. `retireCore` kept the `states` owner claim when the drain flush failed, wedging the id (delete and same-id recreation refused forever). Review additionally found ownerless state admitted every controller: with two same-id lifecycles both failing retirement, the older controller's teardown retry could win the serialize race and persist stale events, and after `delete()` an old controller could resurrect the id through `adopt()`.

## Decision

**A — lane terminality.** `laneFailure` is captured as `Error`; the driver catch resets `exclusiveActive`, tracks the in-commit head separately (cleared only after a successful commit, failed via `fail(error)` on a throw), settles every still-pending head (queued-unstarted abandoned, started failed), and clears the queues. `drainDispatches` drains the live pool and the settle-event work BEFORE surfacing the failure, so in-turn settlement holds on the failure path too. The `binding` entry checks the terminal flag: a dead lane rejects new calls immediately instead of queueing them. A dispatch rejection folds into an error result committed in submission order; a prepare rejection is caught in the driver and fails the head (binding rejects, failure logged as `tool/code-dispatch`).

**B — wakeDriver convergence.** The `withInitiator` call is wrapped: a synchronous throw rolls the phase back to idle and resolves the driver promise. Dropping the wake during teardown matches the existing `disposed`-cause semantics; `whenIdle()` never hangs. The regression test awaits `agent.whenIdle()` directly (proving `activityDone` settled), asserts zero adapter requests inside the close window, then asserts EXACTLY one more request for a fresh wake after recovery.

**C — corruption contract alignment.** The scanner reports a `corruption` context (message + droppedRows/droppedEvents, counting the rolled-back seq-gap row itself). `readPrefix` rejects committed damage on BOTH the raw and zstd paths with `SessionPersistenceCorruptionError` (raw-log path + cause); only a never-fully-written torn EOF fragment produces a tornMarker (truncate + synthetic closers). The scanner's bare throws (corruption followed by a committed `turn/end`, torn records inside complete zstd frames) are wrapped at the read boundary into the typed error. Two pre-existing crash-tail tests whose `'\n{"partial…'` simulation produced an artificial empty line (impossible for a real torn write) were corrected to the canonical fragment shape. The rejection regression test asserts the artifact bytes are identical after the rejected load.

**D — exact ownership.** `retireCore` on a failed drain clears only `state.owner` (the state entry and live write-behind stay so the pinned teardown-retry contract holds). `appendLiveBatch` gates on exact ownership: a batch is dropped when the state is missing or owned by a different session. `delete()` removes every stale controller for the id (its guard already excluded live owners). `onCreated` drops predecessor controllers when a successor claims the ownerless state. Regression tests: successor data survives the predecessor's teardown retry with no duplicates; delete does not resurrect the id; delete+create cannot leak old pending events through a fresh ownerless state; unrelated live controllers survive a delete untouched.

## Alternatives considered

**Fail the lane without settling pending heads.** Rejected: the program may be awaiting any of them, and a never-settling binding hangs the run itself — the same defect class as the original bug.

**Keep tolerating damaged plaintext rows and only warn.** Rejected (by review): the README contract requires committed corruption to reject; warn-and-truncate would codify the wrong behavior.

**Keep the `states` owner after a failed retire so delete's live guard still sees it.** Rejected: the guard is exactly what wedges the id; clearing the owner and gating stale writers by exact ownership in `appendLiveBatch` closes the same hole without the wedge.

## Consequences

The batch converts three silent-hang/data-loss paths into loud, typed failures and un-wedges session ids after I/O failures. The cost: two pinned scanner-level tolerances remain at the scanner layer only (the read boundary rejects), the `delete()` path now also clears retained controllers (a behavior delete already implied), and the `run_code` lane gained terminal-state bookkeeping that any future scheduler change must respect. Coverage gates required narrow `v8 ignore` notes for two unreachable defensive branches (a failed drain whose claim a successor already took; a retained controller whose state was deleted by the delete path).
