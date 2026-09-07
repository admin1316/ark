# Agent Note: File architecture P1 — pure-function extraction across eight hotspots

Status: implemented

English | [中文](2026-08-16-file-architecture-p1-extraction.zh.md)

## Problem

The enterprise file-architecture audit (`enterprise-architecture-report.md`) flagged eighteen files over 1,000 lines. None was a must-split blocker except one: `host/apiproxy/src/api-proxy.ts` (3,996 lines, 357 commits, 43 cross-package imports) — the largest hand-written file, the most frequently modified, and the host of five duplicated domain rules. Every other hotspot was already partially modularized with a clear pure-function remainder; the audit's Phase 1 was defined as verbatim extraction with zero behavior change.

## Decision

Phase 1 extracted only stateless pure-function clusters — no shared mutable state moved, no signatures changed, no behavior touched:

- **api-proxy.ts → 8 modules** (`frame-queue.ts` / `wire.ts` / `errors.ts` / `session-summaries.ts` / `pagination.ts` / `image-refs.ts` / `catalog.ts` / `views.ts`): 3,996 → ~3,510 lines. The extracted modules leave the file's coverage exemption (vitest.config.ts had excluded `api-proxy.ts`), so a new `api-proxy-modules.spec.ts` plus models-fixture branches (effort description, absent default-effort, non-Error provider rejection) brought every module to 100/100/100/100. The remaining closure-internal domain handlers stay for Phase 2.
- **session/src/index.ts → validation.ts + fork.ts**: the twelve header/event validators and the fork vocabulary; `_forkSeed`/`_resolveForkSource` lowered to stateless `forkSeed`/`resolveForkSource`.
- **session-persistence coordinator → errors.ts + migrate.ts**: the three typed persistence errors plus the legacy v0 vocabulary migration functions.
- **session-persistence-jsonl → lock.ts**: `withSessionIdLock`/`isStaleSessionLock`/`isEEXISTError`; new tests closed the previously-uncovered live-holder timeout, non-EEXIST, and unreadable/corrupt lock-pid branches (the EPERM branch is a portably-unconstructible v8 ignore).
- **session-query-sqlite → query.ts**: the `selectedDocumentsSql` CTE moved beside the other predicate builders.
- **llm → adapter.ts + error.ts**: the adapter contract surface (LlmAdapter, both registration handles, PreparedLlmCall) and LlmError/assertUsableApiKey consolidated into the existing error module.
- **ui-trajectory layout → content.ts / placement.ts / durations.ts**: content vocabulary, placement strategies, and duration arithmetic (the package stays in its coverage-exemption lane).
- **cordis-host-runner → steering.ts + queries.ts**: the six model-steering templates become pure functions over injected agents/registry (the runtime-failure dedup claim stays with callers), and the six read projections get one-line @Remote delegates.

Every commit is a move-only refactor with its own gates (typecheck, contracts-ready lint, the package suites, `git diff --check`); the api-proxy extraction is the only one that needed new tests, because it moved code out of a coverage-exempt file.

## Alternatives considered

**Move the extracted modules back under the exemption.** Rejected: the exemption existed because the 3,996-line file was impractical to cover; the modules are small and the per-file gate is the point of the extraction.

**Split the api-proxy closure (domain handlers) in the same batch.** Rejected: P1 is defined as zero-risk pure moves; the closure shares pending/mux/lifecycle state (pendingApprovals/pendingQuestions/muxQueues/sessionCreations/hostAgentHandles) whose split needs a ProxyState design and the full approval-replay regression matrix — that is Phase 2.

**Extract by line numbers.** Rejected after two mis-extractions (multi-line signatures and string-literal braces broke naive brace counting): all extractions use anchor-based or hand-written moves, verified by tsc before any commit.

## Consequences

Eight hotspot files lost 300–500 lines each of pure-function remainder; api-proxy.ts is now an orchestration shell around extracted modules and the remaining closure. The moved code gained per-file coverage enforcement where it previously hid under an exemption (the api-proxy modules' previously-untested branches — live-holder lock timeouts, non-EEXIST lock failures, error-mapping fallbacks, image-carrier shapes — are now regression-covered). No public API, wire shape, error code, or disk format changed; all suites pass. Phase 2 (api-proxy domain handlers + ProxyState, manager.ts cluster split, jsonl delete/discovery/fs-ops/decode, SQLite medium helper) and Phase 3 (CoordinatorState, ActivationForest, analyzer TypeGraphBuilder) remain per the audit roadmap.
