# Agent Note: P0 batch B — SDK start race, web API token default, PTY helper guard

Status: implemented

English | [中文](2026-08-16-p0-batch-b-sdk-web-pty.zh.md)

## Problem

The enterprise audit (phase two, P0 implementation) surfaced three launch-scoped defects. First, `HarnessClient.start()` in the Python SDK runs its check-then-act (`if self._proc is not None` then `Popen`) outside the lock: two concurrent `start()` calls each spawn a subprocess, the second `Popen` overwrites `_proc` and strands the first unreaped, and a racing `close()` can terminate the process a concurrent `start()` just spawned. `DeepSeekHarness.start()` guards `_initialized` the same way. A close→start reuse also leaves the previous close's sentinels in the notification/request queues, so `next_notification()` immediately raises a stale `TransportClosedError` against a healthy runtime. Second, the webserver's API gate was disabled by default: with no `DSH_API_TOKEN` exported, every `/api` request was allowed, so any local process could drive the full harness without credentials, and the webserver config schema still accepted `0.0.0.0`, making remote exposure a one-line composition change. Third, the pinned `node-pty` patch made `DSH_NODE_PTY_SPAWN_HELPER` an unvalidated path that the native `pty.fork` executes as a helper: anyone who can inject `process.env` (a launch shell, a `.env` on the `loadEnv` track) can make the PTY backend run an arbitrary binary with the user's permissions, and the subprocess environment scrub does not cover this surface because node-pty reads the parent process environment.

## Decision

**The Python SDK serializes start/close and resets reuse queues.** `HarnessClient.start()` moves the whole check-then-act — the `_proc is None` test, `_session_parents.clear()`, the `Popen`, and both reader-thread starts — under `self._lock`, and replaces `_notifications`/`_requests` with fresh queues so a close→start reuse never resurrects the previous close's sentinels. `close()` releases the claim atomically under the same lock (`if self._proc is proc: self._proc = None`) after terminate/wait, so a concurrent `start()` cannot observe a half-closed process and a concurrent `close()` cannot double-terminate; the shutdown request, stdin close, terminate/wait, and thread joins stay outside the lock to avoid reentrant deadlock with `_fail_waiters`. `DeepSeekHarness` gains its own `_start_lock` (the client lock is not reentrant — `client.start()` re-enters it internally). Regressions: a two-thread barrier `start()` asserts exactly one live process; a close→start reuse asserts the queues are not pre-poisoned.

**The webserver API gate is never disabled by default.** The token resolves from the new config `apiToken` field, then `DSH_API_TOKEN`, and otherwise a fresh `randomBytes(32)` value is minted per launch; the effective token reads back through the `apiToken` property. Binding `0.0.0.0` requires an explicit token (config or environment) and refuses to start without one — a random per-launch value would be unknowable to legitimate remote clients and only masks the exposure. The browser keeps authenticating through the SameSite cookie the index tap plants; unauthenticated `/api` requests now answer 401 where they previously passed. The `stays open when no token is exported` test became `generates a launch-scoped token and rejects /api without it`, and a new test asserts the `0.0.0.0` refusal.

**The node-pty helper override is trusted-roots guarded.** The patch (regenerated through `pnpm patch-commit`, lockfile hash updated) accepts `DSH_NODE_PTY_SPAWN_HELPER` only when it resolves to the executable's own `-spawn-helper` sibling or a path under the node-pty package directory (`path.resolve(__dirname, native.dir)`); anything else is ignored and the default resolution (executable sibling, then packaged helper) runs. The visible repository sets this variable nowhere — the Python runtime packaging uses the executable sibling, which is inside the allowlist — so no existing path regresses.

## Alternatives considered

**Keep the gate opt-in (export `DSH_API_TOKEN` to enable).** Rejected: the whole point of the P0 was that the default was open; a random per-launch mint keeps the browser flow unchanged while closing the credential-free local RCE.

**Strip `DSH_NODE_PTY_SPAWN_HELPER` from the environment at startup.** Rejected: node-pty reads the variable at module load from the parent process, so stripping would have to happen before the import — the patch is the single enforcement point, and the trusted-roots guard preserves the intended override for consumers whose helper lives outside the package while rejecting injection.

**Put the Python start/close under one coarse lock including I/O.** Rejected: the shutdown request and process reaping are slow and re-enter `_lock` through `_fail_waiters`; only the claim transitions need mutual exclusion.

## Consequences

The webserver behavior change is visible to hand-rolled local clients: they must now send the bearer or cookie from `webServer.apiToken`. The Python SDK's public surface is unchanged; concurrent `start()` no longer strands a process. The node-pty patch guards the override channel without affecting packaged runtimes (the macOS builders' helper-absence failure remains). The 2026-07-29 persistent-bash note's override description is updated to the guarded mechanism; the 2026-08-15 launch-scoped security hardening note's token-gate decision is extended by the default-mint and `0.0.0.0` rules recorded here.
