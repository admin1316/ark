# Agent Note: Phase 1 audit remediation batch

Status: implemented

English | [中文](2026-08-16-phase1-audit-remediation.zh.md)

## Problem

The v2 enterprise audit (2026-08-16, read-only) ranked a P1 security exposure and two red gates at the top of Phase 1: the web server never validated the Host header (a DNS-rebinding page can resolve to 127.0.0.1 and read the JS-visible token cookie to drive the whole `/api` surface), `pnpm run duplication` failed on the repository's only two clones, and the `hygiene` chain's first gate short-circuited the remaining ten. A P1 performance item (synchronous SQLite log scanning stalling the event loop) completed the batch.

## Decision

Four fixes, each behavior-preserving outside its own surface:

1. **Webserver rebinding fence + HttpOnly cookie** (`packages/host/webserver`): every request and upgrade now rejects a Host header that is not a loopback literal (`127.0.0.1`/`localhost`/`[::1]`) when binding loopback; all-interfaces binding (explicit-token exposure, owned by the browser-trust fence) passes Hosts through. The planted `dsh_api_token` cookie gains `HttpOnly` — the SPA never reads it, and a rebinding page cannot exfiltrate it. The frontend-static spec's 80-char body prefix was widened (200) so its SPA-fallback assertions can see the tail the growing cookie script had been hiding — a latent test failure the audit surfaced.
2. **Duplication gate** (`cordis-host-runner/src/queries.ts`): `inventoryRows`/`snapshotRows`/`referenceFor`/`inspectPluginFor` inlined the same package-row mapping and version-pointer presence folds — the repository's only jscpd clones. Extracted `packageRows`/`versionFields`/`activeRunOf`; gate green (0 clones).
3. **Hygiene chain** (`scripts/rescope-vendor.ts`): the generated `cordis-surface` sections of `docs/subsystems/extensions.{md,zh.md}` render `cordis/*` event keys — runtime contract identifiers emitted by `gen-cordis-catalog.ts` (itself already skipped) — which the residue check misread as vendored-package references. Both files joined `GENERIC_SKIPS` for the `cordis` name; the full 11-gate chain passes again.
4. **SQLite scan yielding** (`session-persistence-sqlite`): `scanRows` (shared by `readPrefix`/`loadStoredFrom`) parsed every event row synchronously on the `DatabaseSync` connection. It is now async and yields via `scheduler.yield()` every 500ms during the JSON-parse pass — the same interval the JSONL backend already uses during decode — so long-session loads cooperate with the event loop instead of stalling the process.

## Alternatives considered

**Host-allowlist by configured address only.** Rejected: `localhost` and `[::1]` are legitimate access spellings for the same loopback bind, and rejecting them would break documented access patterns for no security gain.

**Worker-thread parsing for SQLite.** Rejected for this batch: `DatabaseSync` cannot cross threads, serializing rows would add a copy of the full log, and the yield approach removes the process stall with a one-line semantic surface. Worker offload stays a Phase 4 option if profiling shows parse cost remains material.

## Consequences

DNS rebinding can no longer reach the harness through a foreign Host on loopback bindings; the token cookie is page-JS-invisible. The duplication and hygiene gates are green (audit-fixed), the frontend-static suite passes again, and long SQLite logs load cooperatively. All four changes are covered by existing suites (webserver 7, sqlite 102, host-runner 91, frontend-static 3; typecheck/lint clean; test:gui 3853 passing with one pre-existing environment-only failure).
