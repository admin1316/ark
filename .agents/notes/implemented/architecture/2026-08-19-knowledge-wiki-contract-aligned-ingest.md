# Agent Note: Knowledge-wiki contract-aligned ingest pipeline and persisted queue

Status: implemented

English | [中文](2026-08-19-knowledge-wiki-contract-aligned-ingest.zh.md)

## Problem

`dsh-knowledge-wiki` shipped as a stateless bridge over the LLM Wiki desktop API; after the engine moved in-process, four gaps blocked it from owning the corpus the desktop app leaves behind:

- **Cache poisoning**: `scanSources` wrote the content hash into `.llm-wiki/ingest-cache.json` *before* ingesting, so a failed ingest (broken LLM key, model error) was cached as done and never retried. The Remote ingest methods also swallow errors into `warnings`, so `drainQueue` never saw a failure and the error branch was dead in production.
- **Format incompatibility with the 79 existing sources/ pages**: no summary-slug derivation (FNV-1a base36 anchored on the full identity), no `sources`-field canonicalization, no sanitize/date-stamp passes, no index/log/summary fallbacks, no page merge, no review extraction.
- **No queue durability or backoff**: the ingest queue was memory-only (Ark restarts lost tasks) and failed tasks crash-looped every 60s on a broken key.
- **Dead bridge surface**: `preprocess_file` branch, `baseUrl`/`token` parameters, and 1,100 lines of unreferenced `src/graph/` + `local-search.ts` (the live `graph.ts` carries its own Louvain implementation).

## Decision

The package is now a self-contained engine. Key mechanisms:

- **Scan only enqueues; cache writes move to success.** `scanSources` compares hashes and enqueues changed files as `pending`; `markIngested` (sha256 re-read of the file) runs only after a successful ingest. `drainQueue` treats a zero-written, warnings-only outcome as the failure signal — the shape the Remote ingest methods return for an LLM error — so a broken key marks the task `error` with a `failedAt` timestamp instead of poisoning the cache.
- **Persisted queue with cooldown.** `ingest-queue.json` stores pending/running tasks only; `restoreQueue` runs on service init. Failed tasks enter a 60-minute cooldown (`FAILED_RETRY_MS`); the 60s timer now drains independently of scanning, so restored tasks resume after a restart.
- **Contract-aligned write pipeline.** New modules derive the summary-page slug from the source identity (`{structuralLength}-{readable}` segments joined by `--`, FNV-1a 32-bit base36 tail, 120-char cap — verified against the live corpus names `--1js7z6u` and `--n2u7v5`), sanitize generated content (outer fence, `frontmatter:` prefix, missing opening fence, frontmatter wikilink lists), stamp dates to the ingest day, canonicalize the `sources` field (strip `raw/sources/` prefix, filter invalid references, dedupe, force-include the identity), and merge with existing pages (whole replacement when the page is owned only by this source, conservative `sources` union otherwise). Deterministic fallbacks — index entry, log entry, source summary, review items — run regardless of model output shape.
- **Prompt contract.** The stage-2 prompt pins today's date, the exact summary-page path, the project schema, and strict frontmatter rules, so the model output lands on the existing corpus format.

## Alternatives considered

- **Throw through the Remote boundary** — having `ingestSource` rethrow LLM errors so `drainQueue`'s catch branch fires. Rejected: the Remote methods' `{ written, warnings }` contract is the UI-facing surface and its error-with-warnings shape predates the queue; the zero-written heuristic keeps the contract while fixing the cache poisoning at the drain site.
- **Filesystem watcher instead of polling** — rejected as a deployment risk: the 60s scan is process-stable, restart-safe, and matches the app-era behavior; the queue restore path makes polling lossless.
- **Keeping `src/graph/` + `local-search.ts`** — rejected: `graph.ts` (live) carries its own Louvain implementation and `search.ts` never referenced the local-search module; the 1,100 lines and `graphology`/`js-yaml`/`zod` dependencies had no importer.

## Consequences

- **Bought**: failed ingests (broken key, model error) now surface as `error` tasks with a 60-minute cooldown, a console log line, and no cache write; the queue survives restarts; new pages land on the existing corpus format (verified against the live `--1js7z6u`/`--n2u7v5` page names); 69 package tests cover the pipeline and queue.
- **Cost**: `scanSources` no longer drains synchronously, so a new file waits until the next 60s timer tick to start ingesting (previously the scan drained immediately); a warnings-only outcome with zero pages is always treated as failure, so a genuinely unchanged merge (empty sources frontmatter) enters the cooldown rather than completing instantly.
- **Deployment**: the jiuzhang-runtime rc.7 tgz must be rebuilt and re-installed; existing `.llm-wiki/ingest-cache.json` entries remain valid (same flat `{ identity: sha256 }` format), so the 79 existing pages stay untouched and only genuinely missing sources re-ingest. The Remote contract, config keys, and `.llm-wiki/` file formats are unchanged; the desktop app stays fully decoupled and is scheduled for deletion (Phase 4).
