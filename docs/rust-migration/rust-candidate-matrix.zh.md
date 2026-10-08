# Rust candidate matrix

[English](rust-candidate-matrix.md) | 中文

This reference records the Rust migration decision from the checked-out source tree. It is evidence for planning and review; it does not enable a Rust provider or change an existing wire contract.

**当前快照：** 矩阵已按 checkout 提交 `70977b3124e008838b3e22b9b04e824ffa82f574` 于 2026-10-08 刷新。正式 Ark 包未修改，活动生产 profile 仍只使用 TypeScript。

## Source evidence

2026-10-07 用 `git ls-tree` 检查时，历史 source-truth 基线 `b8adf5a7ec9c22c3f1c7958821af825bd7821d7a` 和 GitHub `origin/main` 的 `d382723905742f2b87401ad444d02756f5cb229b` 都没有 `Cargo.toml` 或 Rust 源文件（`*.rs`）。当前 checkout `70977b3124e008838b3e22b9b04e824ffa82f574` 在这次基线之后新增了一个隔离且不用于生产的 shadow crate：[`rust/knowledge-search-shadow`](../../rust/knowledge-search-shadow)。现有 native 实现是 C11 Landlock launcher，位于 [`native/landlock-run/packages/entry/src/main.c`](../../native/landlock-run/packages/entry/src/main.c)，通过 TypeScript 入口模块 [`native/landlock-run/packages/entry/src/index.ts`](../../native/landlock-run/packages/entry/src/index.ts) 暴露；它是进程启动与文件系统隔离探针，不属于下面的 Rust 内核候选。

知识内核仍然由进程内 TypeScript 持有。BM25、分词和余弦相似度在 [`packages/host/knowledge-wiki/src/search.ts`](../../packages/host/knowledge-wiki/src/search.ts)；图遍历和 Louvain 社区发现位于 [`packages/host/knowledge-wiki/src/graph.ts`](../../packages/host/knowledge-wiki/src/graph.ts)。当前工作树已经有确定性的优化 TypeScript 对照实现 [`scripts/rust-migration/benchmark-knowledge-search.ts`](../../scripts/rust-migration/benchmark-knowledge-search.ts)、隔离 Rust shadow 回放 [`scripts/rust-migration/differential-replay.ts`](../../scripts/rust-migration/differential-replay.ts) 和默认关闭的生产候选边界 [`packages/host/knowledge-wiki/src/rust-search-candidate.ts`](../../packages/host/knowledge-wiki/src/rust-search-candidate.ts)，但仍没有这些内核的生产 N-API provider 或 enforced Rust owner。

Cancellation and child-process recovery remain owned by the existing TypeScript runtime. [`packages/subprocess/subprocess-local`](../../packages/subprocess/subprocess-local) terminates managed process groups through `AbortSignal`, and [`packages/jobs/jobs-local`](../../packages/jobs/jobs-local) owns task cancellation and teardown. The migration boundary must preserve those owners.

## 实测候选证据

2026-10-08 的本地 benchmark 使用同一份确定性语料，current TypeScript p50 为 **12.519 ms**，优化 TypeScript p50 为 **0.500 ms**，Rust stdin/stdout IPC p50 为 **20.536 ms**；三者结果摘要一致（`current-optimized-rust-match`）。随后候选 Ark 的模型/工具 smoke 在真实 `wiki_search` 调用中 spawn 了 Rust wrapper，返回两条受治理命中，并以退出码 `0` 重现 TypeScript BM25 摘要。由于缺少 production candidate profile、签名 verifier receipt、cold/warm 与跨平台数据、子进程 CPU/RSS、取消和崩溃恢复证据，验收状态仍是 **UNKNOWN**。这些数据支持 `RETAIN_TS`，不支持开启 enforce-mode 迁移。

## Candidate decisions

| Candidate | Current owner | Rust boundary | Evidence status | Decision |
| --- | --- | --- | --- | --- |
| Tokenization and BM25 scoring | `knowledge-wiki/search.ts` | Immutable UTF-8 request bytes and page records; deterministic result bytes | 优化 TypeScript 与隔离 Rust shadow 在确定性语料上结果一致；真实 IPC 测量慢于优化 TypeScript，Ark 原生 smoke 也没有调用 Rust | **RETAIN_TS** |
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

Learning claims use the deterministic reducer in [`scripts/rust-migration/evaluate-learning.ts`](../../scripts/rust-migration/evaluate-learning.ts) and its documented input contract in [`scripts/rust-migration/README.md`](../../scripts/rust-migration/README.zh.md). It requires independently verified baseline/candidate records with matching model, task, goal, and policy hashes; incomplete pairs produce `UNKNOWN` instead of a pass.

Rust inputs are limited to canonical bytes or immutable DTOs plus `requestId`, `sessionId`, `generation`, capability, deadline, budget, and cancellation token. Cordis contexts, agents, sessions, tool definitions, credentials, JavaScript callbacks, mutable JavaScript objects, and global services remain outside the boundary.

## Current conclusion

知识搜索 shadow 已经与 TypeScript 的结果摘要一致，但仍没有候选满足三路证据要求，因此暂时不能进入生产 Rust 迁移。安全的运行时选择是保留现有 TypeScript 内核和 C11 confinement provider，同时保留 TypeScript fallback；在改变运行时归属前，还需要真实 N-API/IPC、端到端、取消、恢复和跨平台证据。
