# Agent Note: Reuse one BM25 index per Knowledge Wiki root

Status: implemented

English | [中文](2026-10-11-knowledge-search-index-cache.zh.md)

## Problem

Each distinct search query traversed the same Wiki files, tokenized every page, and rebuilt BM25 term frequencies and document frequencies. The existing query-result cache helped only when the exact query repeated; a sequence of different questions paid the page and index construction cost over and over.

## Decision

`KnowledgeWikiService` now prepares a `KnowledgeSearchIndex` once for each Wiki root through its existing `WikiSnapshotStore`. `modelSearch()` and the public `search()` path share that root-local projection. Wiki writes already invalidate all snapshots for the affected root, and the recursive file watcher does the same for external edits. Index data remains derived from Wiki files and is never persisted as a separate source of truth.

The cache contains only page/token scoring data. Every request still reads current governed Knowledge records and applies the existing verifier and access checks after ranking. Rust shadow comparison receives the same cached page snapshot and computes the same TypeScript BM25 oracle; production search remains TypeScript.

## Alternatives considered

**Keep only the per-query result cache.** Rejected because different queries still reread and reindex the same Wiki corpus.

**Add a second persistent or service-specific cache.** Rejected because it would duplicate ownership and invalidation already provided by `WikiSnapshotStore`.

**Move BM25 to Rust.** Rejected for the active path because the measured Rust process route is slower than TypeScript and does not implement the full hybrid embedding contract.

## Verification

## Verification

The focused search and service-surface suites pass 26/26 tests, including prepared-index differential checks and a write-then-search regression proving that stale terms disappear and new terms become searchable. Package typecheck passes. The [five-query cache benchmark](../../../../scripts/rust-migration/historical-evidence-index.tsv) uses a source-hashed synthetic 240-page corpus, three independent runs, and 30 batches per run; result equality and explicit write invalidation pass in all three runs. Warm-batch p50/p95/p99 fall from 48.988/53.216/54.600 ms to 0.559/0.696/1.528 ms. Parent CPU falls 98.95%; the cold index build median is 9.496 ms and the first batch median is 11.758 ms. The reproducible [single-query TypeScript/Rust comparison](../../../../scripts/rust-migration/knowledge-search-cache-vs-rust-reproduction-20261011.json) runs three independent 30-sample measurements over the same file-backed synthetic Wiki. Exact result bytes match in all runs and all three Rust workers exit cleanly. Median p50/p95/p99 are 10.109/11.072/11.577 ms for file-reparse TypeScript, 2.172/3.024/4.048 ms for optimized TypeScript rebuilding from parsed pages, 0.095/0.127/0.195 ms for the production warm-cache lookup plus scoring, 6.631/6.881/7.032 ms for fresh-child Rust IPC, and 4.079/4.595/5.554 ms for persistent Rust. The warm-cache p50 is about 43× faster than persistent Rust; Rust remains slower than optimized TypeScript and the actual warm path. Event-loop-delay p95 is now sampled at 1 ms resolution, with uneven sample counts; Rust child CPU/RSS remain excluded. These source-level measurements omit model/provider latency, embeddings, verifier/ACL work, total child resources, stress, cancellation, and recovery; they do not establish Ark UI or real-Wiki end-to-end speed or stability.

## Consequences

Multiple distinct searches over one unchanged Wiki avoid repeated file traversal, tokenization, and BM25 index construction. A first query still pays the cold index build, and edits trigger a rebuild. Existing query result caching, governance replay, verifier authority, and ACL behavior retain their prior owners and boundaries. This change establishes no crash-recovery, stress, long-run, or candidate stability percentage.
