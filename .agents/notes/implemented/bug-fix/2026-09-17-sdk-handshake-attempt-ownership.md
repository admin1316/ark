# Agent Note: SDK handshake attempt ownership

Status: implemented

English | [中文](2026-09-17-sdk-handshake-attempt-ownership.zh.md)

## Problem

`DeepSeekHarness` memoizes one `start()` attempt so concurrent callers share a single runtime handshake. The attempt released that memo before awaiting the failed client's `close()`, which opened two defects. A `start()` arriving inside the cleanup window opened a competing attempt against the client that was already closing: a second client, a second `client.start()` call, and a `TransportClosedError` that replaced the original handshake failure; when cleanup also failed, the caller received an `AggregateError` whose first cause was that spurious transport error instead of the initialize error. A handshake that threw synchronously was worse: the reset ran while the async attempt was still in its synchronous prologue, so the memo assignment that followed reinstated the settled rejection and every later `start()` replayed it, leaving the harness permanently wedged.

## Decision

The memoized attempt owns its handshake until its cleanup settles. `start()` memoizes `handshake()` and returns the memo; `handshake()` captures `this.clientInstance` in a local reference, calls `start()` and `initialize(...)` on that captured client, and on failure awaits that client's `close()` before touching the memo. Only after cleanup settles does the attempt set `this.initialized` back to `undefined` and, when cleanup proved the old process exited and the harness is still open, install one replacement client from the factory.

Cleanup failure keeps the attempted client installed: its exit was not proved, `HarnessClient.close()` is permanent, and a retry then fails fast against that client instead of spawning a second process beside one that may still be running. That failure surfaces as `AggregateError([error, cleanupError], 'DeepSeek Harness initialization and cleanup failed')` in that order; successful cleanup re-throws the original error unchanged. `close()` stays terminal, so a later attempt never installs a replacement client.

Ownership is per instance and expressed only through the memo plus the captured client; the harness holds no global lock, singleton, or permanent registry.

## Testing

`packages/sdk/client/tests/lifecycle.spec.ts` drives a fully scripted client with deferred settlements: concurrent starts share one handshake; a start landing in the cleanup window observes the pending attempt's outcome; the post-cleanup retry creates exactly one replacement client; cleanup failure preserves both causes and retains the unproven client; close stays terminal across the window and late handshake outcomes; a synchronous throw from `start()` or `initialize()` and an asynchronous `initialize()` rejection take the same release path; two harnesses stay independent.

`packages/sdk/client/tests/sdk-client.spec.ts` repeats the cleanup-window case against a real subprocess: the fake runtime touches a marker file at stdin EOF (`FAKE_EOF_FILE`), which opens the window without a fixed sleep, and exactly one `initialize` request reaches the runtime across both starts.

Uncovered by these tests: dispose-ladder failures beyond the client's own suites, interleavings other than those exercised, and platform differences in process teardown.

## Alternatives considered

**Release the memo before cleanup.** This is the defect: a caller inside the window cannot distinguish "still cleaning up" from "ready to retry", and a synchronous handshake throw cannot be reset at all because the memo assignment has not happened yet.

**Serialize attempts with a lock, token set, or busy-wait.** A per-instance flag would duplicate the memo's ownership and still need the same release point, a process-wide lock or permanent set would couple independent harnesses, and polling trades a deterministic rejection for a wait with no upper bound.

**Keep the settled rejection memoized after cleanup failure.** A retry would replay the stored `AggregateError` without re-attempting, which hides whether the retained client is usable and makes the memo's meaning depend on which failure happened.

**Retain the failed client on every failure.** A client whose cleanup succeeded is permanently closed; keeping it would make every retry fail on a known-dead transport instead of running the fresh attempt the API promises.

## Consequences

Concurrent callers observe exactly one attempt's outcome, including during teardown, so clients, handshakes, and subprocess spawns per attempt are bounded by construction rather than by timing. A caller that retries during cleanup receives the original failure instead of a spurious transport error. The cost is that a retry waits for cleanup to settle instead of failing immediately, and that cleanup failure leaves the harness unable to start a new process until it is closed — the trade for never spawning beside a process whose exit is unproved. Future edits must keep the release point after cleanup, keep the captured client inside the attempt, preserve the `AggregateError` cause order, and keep `close()` terminal.
