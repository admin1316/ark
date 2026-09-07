# Agent Note: P1/P2 batch — SDK idle timeout, SSE watchdog, revision-retry caps

Status: implemented

English | [中文](2026-08-16-p1-p2-timeout-and-watchdog-batch.zh.md)

## Problem

Three unbounded-wait defects from the enterprise audit's async/concurrency list. First, `HarnessSession.run()` waited for the runtime's idle status with no deadline: a wedged runtime (hung approval, model stall, dead transport) blocked SDK automation forever, and `requestTimeoutSeconds` bounded only unary calls. Second, the fetch carrier's SSE reader had no idle watchdog and no frame-buffer bound: a half-open connection (peer vanished without EOF) held the stream "connected" silently, and a misbehaving peer streaming data without a frame boundary grew memory without limit. Third, `PersistenceCoordinator`'s prepare/load/inspect convergence loops (`for (;;)`) had no iteration cap: continuous external writers could delay convergence indefinitely.

## Decision

**`Session.run()` gains an idle deadline.** The wait is bounded by the new `run_timeout_seconds` parameter, else `DeepSeekHarnessConfig.request_timeout_seconds`; absent both, the wait stays unbounded (explicit opt-out). `NotificationSubscription.next()` accepts a timeout and raises `TimeoutError` on queue emptiness, and the run loop passes the remaining budget so a silent runtime cannot hold the loop past the deadline. The idle-timeout error names the session, the prompt message id, and the likely wedge causes. Regression: a fake runtime that never emits idle raises `TimeoutError` instead of blocking. README (en/zh) documents the parameter.

**The SSE reader is watched and bounded.** Each `reader.read()` races a 60s silence timer; a stream that exceeds it throws a half-open transport error instead of freezing. The decoded frame buffer is capped at 16 MiB; a peer that never emits a `\n\n` boundary trips the bound. Both race losers are consumed so neither surfaces as an unhandled rejection. Regressions: an endless boundary-less stream rejects with the buffer-bound error; a stream silent after one frame rejects with the half-open error under fake timers.

**Convergence loops are capped.** prepare/load/inspect retry at most 64 iterations (`MAX_REVISION_RETRIES`) and then throw a loud convergence error instead of spinning under continuous external writers. The unreachable branches are `v8 ignore`-annotated (tests cannot drive 64 serialized entry races); coordinator coverage stays 100/100/100/100.

**`waitWithSignal` propagates rejections.** The e2b wait helper previously dropped a rejected promise: the rejection went unhandled, the abort listener leaked, and the outer wait never settled. It now forwards the rejection (after removing the listener); every current caller already passes a never-rejecting promise (`commandState` always resolves, the rest are `.catch`-wrapped), so the new branch is defensive and `v8 ignore`-annotated. A failed command's `waitForExit` still resolves `true` (quiescence), asserted in the crash test.

**A due schedule reminder re-arms after a framing/followup failure.** Previously the framing catch returned `false` without re-arming, so a transient failure silently dropped a one-shot reminder. The catch now arms a 30s retry (`DISPATCH_RETRY_DELAY_MS`); the next drive re-decides and delivers. Regression: throwFollowup then recovery delivers exactly one followup.

**The SQLite search index retries a failed open.** `_ensureReady` previously cached the first `_open()` result, so a transient filesystem or lock failure wedged the index for the process lifetime. A failed open now resets `_ready` before rethrowing, so the next call retries; regression covers a read-only directory under `openAt: 'first-search'` recovering to a successful search.

**LSP rejects an empty Content-Length value.** `Number('') === 0` let a blank `Content-Length:` slip past validation into `JSON.parse('')`, killing the connection. The empty value is rejected explicitly; unit and connection regressions cover it, and a no-colon header line remains skippable.

**The header reads are byte-budgeted.** `readFirstLine` and `readFirstZstdLine` now give up (return `undefined`, so the artifact is absent from discovery) after `MAX_HEADER_READ_BYTES` (1 MiB) without a complete newline or zstd header frame; a damaged or malicious log can no longer accumulate memory without limit. Regressions cover both encodings. The readPrefix backstop rethrow (every scan-layer rejection is either typed or matches the corruption regex) is `v8 ignore`-annotated after a full trace of the reachable rejection classes.

**The revision-stable read is budgeted.** `readStableFile`'s stat/read/stat retry loop now fails loudly after a 10s wall-clock budget (`READ_STABLE_DEADLINE_MS`) instead of spinning under a continuously-appended active log; the regression drives every stat to a different revision and advances `Date.now` past the budget.

**Three audit P2s assessed as design, not defects.** (1) telemetry `handoffCursor` is deliberately module-scoped — cordis has no HMR state-handover API, keying by the store-owned Session object lets a re-adopting fiber resume instead of re-handing history, and the otel bundle instantiates live and on-demand coordinators mutually exclusively, so no two instances share a cursor in practice. (2) projection-cache `deletionEpoch` entries are never removed because epoch monotonicity is load-bearing: deleting an entry could let a stale cold read (which snapshotted the old epoch) pass a later delete's new epoch check and write back stale rows; the cost is 8 bytes per deleted id. (3) session-title's per-user-message `collectSessionTitleMessages(session.events, event.seq)` full scan is the title's inherent O(n) fold, and the schedule path short-circuits once a title exists (`this.get(session) !== undefined`), so O(n²) only occurs while fallback title creation keeps failing.

**`syncTools` registers the next generation before releasing the previous.** The swap previously disposed the old tool set first, so a registration conflict mid-swap left the server's tools gone entirely. The next generation now registers while the previous set is still live; a conflict rolls back the partial next generation and keeps the previous set (`kept the previous tool set`), while `registrationFailure: 'throw'` still rethrows for strict initial synchronization. Regression: a conflicting name fails the swap and the old tools remain registered.

**ACP `agent/error` rejects only the correlated turn.** The guard previously returned early when the error's turn matched the in-flight turn, so the correlated failure never rejected — the client wait hung — while errors for unrelated turns rejected the wrong wait. The guard now rejects when the turn is unknown (the prompt was never claimed, e.g. a turn/start failure) or matches the in-flight turn, and ignores only errors for a known different turn. Regressions: an error for a different turn is ignored and leaves the wait pending; a turn-start failure rejects.

**The workflow parentPort listener is assessed as design, not a defect.** Each workflow run spawns a fresh worker process, so the `parentPort` message listener cannot accumulate across runs and is bounded by the process lifetime; no change was made.

**`phase()`/`log()` narration is budgeted per run.** A runaway script could call the hooks in a tight loop and flood the host event bus and the session log. The worker now charges every `phase()`/`log()` call against `maxNarrationEvents` (engine Config, default 5000); the run fails loud with `NARRATION_CAP` instead of flooding. Regressions drive phase-only, log-only, and shared budgets over the cap; runtime coverage stays 100/100/100/100.

**The llm adapter disposer contains disposal failures.** `registerAdapter`'s disposer previously discarded the ctx.effect disposer result with `void dispose()`: a synchronous INVARIANT-coded `llm/adapters-updated` listener failure rethrows inside disposal and escaped the disposer call site. The handle now logs the failure instead of letting it escape. Regression: a listener installed after registration fails only at disposal and is logged.

**The llm adapter stream contains early-close cleanup failures.** When a downstream consumer breaks early, an `iterator.return()` cleanup that rejects previously propagated into the break site, masking the consumer's own completion. The finally now logs the cleanup failure; built-in adapters never trip it, and the third-party path is contained. Regression: a rejecting `return()` leaves the consumer loop completed and logs the failure.

## Alternatives considered

**Let `next()` stay blocking and check the deadline only between notifications.** Rejected: a silent runtime never delivers a notification, so the loop would sit inside `next()` past the deadline; the queue wait itself must carry the remaining budget.

**Rely on the transport's own EOF for half-open detection.** Rejected: a half-open TCP connection does not EOF; only a wall-clock watchdog can distinguish silence from death.

**Leave the convergence loops unbounded.** Rejected: the JSDoc already admitted "continuous external writers may delay completion"; a cap converts an indefinite spin into a loud, diagnosable failure.

## Consequences

SDK callers with a request timeout now get a bounded `Session.run()`; callers relying on unbounded waits must pass `run_timeout_seconds=None` on a config without a request timeout. SSE consumers see a stream error instead of a silent freeze after 60s of silence, and a pathological peer cannot balloon memory past 16 MiB of buffered frames. Coordinator callers under sustained external write pressure now fail loudly after 64 retries instead of spinning. MCP clients survive a mid-swap registration conflict with the previous tool set intact, and ACP clients are never left hanging by a correlated turn failure. Workflow scripts that exhaust the narration budget fail loud instead of flooding observers; llm adapter disposal and early-close cleanup failures are logged instead of escaping.
