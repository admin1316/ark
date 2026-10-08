# Rust candidate matrix

English | [中文](rust-candidate-matrix.zh.md)

This reference records the Rust migration decision from the checked-out source tree. It is evidence for planning and review; it does not enable a Rust provider or change an existing wire contract.

**Current snapshot.** The matrix was refreshed against checkout commit `02bf7ebc7f973b35e298bcd4121199f0ab81683c` on 2026-10-08. The official Ark bundle remains untouched and the active production profile remains TypeScript-only.

## Source evidence

The historical source-truth baseline at `b8adf5a7ec9c22c3f1c7958821af825bd7821d7a` and GitHub `origin/main` at `d382723905742f2b87401ad444d02756f5cb229b` had no `Cargo.toml` or Rust source files (`*.rs`) when inspected with `git ls-tree` on 2026-10-07. The current checkout at `02bf7ebc7f973b35e298bcd4121199f0ab81683c` contains an isolated, non-production shadow crate at [`rust/knowledge-search-shadow`](../../rust/knowledge-search-shadow), added after that baseline. The native implementation that is present is a small C11 Landlock launcher in [`native/landlock-run/packages/entry/src/main.c`](../../native/landlock-run/packages/entry/src/main.c), exposed through the TypeScript entry module [`native/landlock-run/packages/entry/src/index.ts`](../../native/landlock-run/packages/entry/src/index.ts). Its contract is a process launcher and filesystem confinement probe, so it is outside the Rust kernel candidates below.

The knowledge kernels remain in-process TypeScript. BM25, tokenization, and cosine similarity are implemented in [`packages/host/knowledge-wiki/src/search.ts`](../../packages/host/knowledge-wiki/src/search.ts); graph traversal and Louvain community detection are implemented in [`packages/host/knowledge-wiki/src/graph.ts`](../../packages/host/knowledge-wiki/src/graph.ts). The current working tree has a deterministic optimized TypeScript comparison in [`scripts/rust-migration/benchmark-knowledge-search.ts`](../../scripts/rust-migration/benchmark-knowledge-search.ts), an isolated Rust shadow replay in [`scripts/rust-migration/differential-replay.ts`](../../scripts/rust-migration/differential-replay.ts), and a default-disabled production candidate seam in [`packages/host/knowledge-wiki/src/rust-search-candidate.ts`](../../packages/host/knowledge-wiki/src/rust-search-candidate.ts). It still has no production N-API provider or enforced Rust owner for these kernels.

Cancellation and child-process recovery remain owned by the existing TypeScript runtime. [`packages/subprocess/subprocess-local`](../../packages/subprocess/subprocess-local) terminates managed process groups through `AbortSignal`, and [`packages/jobs/jobs-local`](../../packages/jobs/jobs-local) owns task cancellation and teardown. The migration boundary must preserve those owners.

## Measured candidate evidence

The 2026-10-08 local benchmark used the same deterministic corpus. The latest three-iteration envelope sample measured current TypeScript cold p50 **19.8 ms**, optimized TypeScript warm p50 **1.16 ms**, Rust cold stdin/stdout p50 **24.1 ms**, and Rust warm persistent-child p50 **32.3 ms**; all result digests matched (`current-optimized-rust-match`). The warm harness observed a SIGKILL followed by a successful restart, while cancellation, child CPU/RSS, cross-platform behavior, and production-boundary evidence remain missing. A separate candidate Ark model/tool smoke spawned the Rust wrapper from a real `wiki_search` call, returned the two governed hits, and reproduced the TypeScript BM25 digest with exit code `0`. The record remains **UNKNOWN** for acceptance because it lacks a production candidate profile, signed verifier receipt, and end-to-end cancellation/recovery evidence. These measurements support `RETAIN_TS`, not an enforce-mode migration.

## Candidate decisions

| Candidate | Current owner | Rust boundary | Evidence status | Decision |
| --- | --- | --- | --- | --- |
| Tokenization and BM25 scoring | `knowledge-wiki/search.ts` | Immutable UTF-8 request bytes and page records; deterministic result bytes | Optimized TypeScript and isolated Rust shadow match the deterministic corpus; the real IPC measurement is slower than optimized TypeScript and the Ark native smoke did not invoke Rust | **RETAIN_TS** |
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

The knowledge-search shadow now matches the TypeScript result digest, but no candidate has the required three-way evidence. No Rust migration is justified for production yet. The safe runtime choice is to keep the existing TypeScript kernels and native C11 confinement provider, preserve TypeScript fallback, and collect the real N-API/IPC, end-to-end, cancellation, recovery, and cross-platform evidence before changing the runtime owner.
