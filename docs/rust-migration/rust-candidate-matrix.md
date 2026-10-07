# Rust candidate matrix

This reference records the Rust migration decision from the checked-out source tree. It is evidence for planning and review; it does not enable a Rust provider or change an existing wire contract.

## Source evidence

The checked-out tree at `b8adf5a7ec9c22c3f1c7958821af825bd7821d7a` and GitHub `origin/main` at `d382723905742f2b87401ad444d02756f5cb229b` have no `Cargo.toml` or Rust source files (`*.rs`). Both trees were inspected with `git ls-tree` on 2026-10-07. The native implementation that is present is a small C11 Landlock launcher in [`native/landlock-run/packages/entry/src/main.c`](../../native/landlock-run/packages/entry/src/main.c), exposed through the TypeScript entry module [`native/landlock-run/packages/entry/src/index.ts`](../../native/landlock-run/packages/entry/src/index.ts). Its contract is a process launcher and filesystem confinement probe, so it is outside the Rust kernel candidates below.

The knowledge kernels are in-process TypeScript. BM25, tokenization, and cosine similarity are implemented in [`packages/host/knowledge-wiki/src/search.ts`](../../packages/host/knowledge-wiki/src/search.ts); graph traversal and Louvain community detection are implemented in [`packages/host/knowledge-wiki/src/graph.ts`](../../packages/host/knowledge-wiki/src/graph.ts). There is no optimized TypeScript variant, Rust shadow implementation, N-API binding, or IPC protocol for these kernels in the source tree.

Cancellation and child-process recovery remain owned by the existing TypeScript runtime. [`packages/subprocess/subprocess-local`](../../packages/subprocess/subprocess-local) terminates managed process groups through `AbortSignal`, and [`packages/jobs/jobs-local`](../../packages/jobs/jobs-local) owns task cancellation and teardown. The migration boundary must preserve those owners.

## Candidate decisions

| Candidate | Current owner | Rust boundary | Evidence status | Decision |
| --- | --- | --- | --- | --- |
| Tokenization and BM25 scoring | `knowledge-wiki/search.ts` | Immutable UTF-8 request bytes and page records; deterministic result bytes | No optimized TypeScript or Rust implementation; no differential replay | **RETAIN_TS** |
| Cosine similarity | `knowledge-wiki/search.ts` | Immutable numeric vectors; deterministic scores | No optimized TypeScript or Rust implementation; embedding calls dominate hybrid search when enabled | **RETAIN_TS** |
| Wiki graph derivation and Louvain | `knowledge-wiki/graph.ts` | Immutable page/edge records; deterministic graph result | No optimized TypeScript or Rust implementation; filesystem traversal and graph semantics need a replay corpus | **RETAIN_TS** |
| Incremental search or graph index | No separate index owner; search and graph rebuild from the Wiki tree | Versioned canonical index bytes with generation and checksum | No index format or rebuild/recovery contract exists | **DEFER** |
| JSONL or compressed-frame scanning | Session persistence and query packages | Read-only byte ranges with a bounded sequence range | Existing persistence and SQLite/zstd paths are mature; no Rust comparison | **RETAIN_TS** |
| Batch hashing or summaries | `packages/util/crypto` and knowledge ingestion | Canonical bytes and bounded batch size | No workload or end-to-end benchmark | **RETAIN_TS** |
| Long-running child process | Existing subprocess and jobs packages | Request ID, generation, deadline, budget, and cancellation token only | Process-group cancellation and teardown tests already exist; a Rust child would add a second supervisor | **RETAIN_TS** |

`RETAIN_TS` means that no Rust implementation may be selected for production. `DEFER` means that an index contract and replay corpus must exist before implementation work starts. The C11 Landlock launcher remains the existing native confinement provider; this matrix does not classify it as a Rust candidate.

## Required evidence before any candidate can move

Every candidate must be registered with a fixed input corpus and compare all three implementations:

1. Current TypeScript implementation.
2. An optimized TypeScript implementation with the same observable contract.
3. A Rust implementation invoked through the real N-API or IPC path that production would use.

The benchmark record must include the repository Git SHA, profile name, corpus hash, implementation versions, and toolchain versions. It must report cold and warm p50/p95/p99 latency, CPU time, Node plus native RSS, event-loop delay, serialization and copy cost, FFI or IPC cost, cancellation latency, crash-recovery result, build time, CI time, package size, and platform failure rate. An internal Rust microbenchmark is insufficient evidence.

The differential replay must compare canonical result bytes and error classes for the same request sequence. A mismatch, timeout, version mismatch, process crash, or cancellation failure keeps the candidate in shadow mode and records a TypeScript fallback result. Shadow mode must not emit duplicate production events or repeat an external side effect. Enforce mode is only allowed after replay and reliability thresholds pass; it fails closed on any subsequent mismatch.

Learning claims use the deterministic reducer in [`scripts/rust-migration/evaluate-learning.ts`](../../scripts/rust-migration/evaluate-learning.ts) and its documented input contract in [`scripts/rust-migration/README.md`](../../scripts/rust-migration/README.md). It requires independently verified baseline/candidate records with matching model, task, goal, and policy hashes; incomplete pairs produce `UNKNOWN` instead of a pass.

Rust inputs are limited to canonical bytes or immutable DTOs plus `requestId`, `sessionId`, `generation`, capability, deadline, budget, and cancellation token. Cordis contexts, agents, sessions, tool definitions, credentials, JavaScript callbacks, mutable JavaScript objects, and global services remain outside the boundary.

## Current conclusion

No candidate has the required three-way evidence, so no Rust migration is justified by the current source tree. The safe runtime choice is to keep the existing TypeScript kernels and native C11 confinement provider, record benchmark evidence when a concrete candidate is proposed, and preserve TypeScript fallback until differential replay and end-to-end measurements establish a benefit.
