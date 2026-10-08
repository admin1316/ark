# ARK Full Runtime TypeScript/Rust Fit Matrix

**Snapshot:** `codex/ark-rust-knowledge-20261008` at `8de9f3b9549f24563c04f4867301f74d0d6c53eb`, 2026-10-08. This document classifies the whole runtime by responsibility; it does not enable Rust or change an existing wire contract.

## Decision rule

Language choice is based on end-to-end behavior, not on whether code looks computationally complex. Freeze the current TypeScript contract, compare an optimized TypeScript implementation, then invoke Rust through the real N-API or IPC boundary. A candidate must report latency, CPU, RSS, event-loop delay, serialization/IPC, cold and warm runs, cancellation, crash recovery, CI, package size, and platform failures. Any mismatch or lifecycle failure keeps the TypeScript fallback.

## Global matrix

| Subsystem | Current owner | Fit | Decision | Reason / gate |
| --- | --- | --- | --- | --- |
| Agent loop, Cordis, Goal, Session, ToolRuntime | `packages/core/**`, `packages/extensions/**`, `packages/goal/**` | TypeScript | **RETAIN_TS** | Mutable context, ordered events, permissions, and model callbacks make a second authority unsafe. |
| LLM providers, SSE, retries, token meter | `packages/llm/**` | TypeScript | **RETAIN_TS** | Provider wire contracts, credentials, and cancellation must stay with the existing owner. |
| MCP, tools, permissions, approvals, credentials | `packages/mcp/**`, `packages/core/tools/**`, `packages/credentials/**`, `packages/interaction/**` | TypeScript | **RETAIN_TS** | This is a security and dynamic-composition boundary, not a closed computation. |
| Knowledge governance, verifier, review, utility, authority events | `packages/host/knowledge-wiki/src/*.ts` | TypeScript | **RETAIN_TS** | Signatures, hash chains, scope/ACL, expiry, conflicts, and rollback must have one authority. |
| Wiki tokenization and BM25 | `packages/host/knowledge-wiki/src/search.ts` | TS today; Rust shadow | **SHADOW_ONLY** | Optimized TS warm p50 is about 0.665 ms, while isolated Rust IPC warm p50 is about 18.5 ms. Equal results do not imply a speedup. |
| Cosine, embeddings, hybrid search | `packages/host/knowledge-wiki/src/search.ts` | TypeScript | **RETAIN_TS** | Network embedding latency dominates; the current hybrid candidate set is still lexical top-15. |
| Wiki graph and Louvain | `packages/host/knowledge-wiki/src/graph.ts` | TypeScript | **DEFER** | Define edge-weight semantics and a replay corpus before considering Rust. |
| Persistent search/graph index | No separate owner today | Future Rust candidate | **DEFER_CANDIDATE** | Most promising direction, but it first needs a versioned immutable format, generation, checksum, rebuild, rollback, and cross-platform contract. |
| JSONL/Zstd/SQLite read-only scans | `packages/session/**`, `packages/storage/**`, `packages/session-query/**` | Existing native/TS | **RETAIN_TS** | Mature SQLite, zstd, and ripgrep paths already exist; the active profile does not justify a new Rust scanner. |
| Canonicalization, hashes, signatures | `packages/util/crypto/**` and verifier/ingest | TS/native crypto | **RETAIN_TS** | Low-cost system crypto is already bound to verifier receipts. |
| Compaction, context trimming, token budgets | `packages/compaction/**` | TypeScript | **RETAIN_TS** | These rules change model behavior and provider token semantics. |
| Subprocess/jobs, timeout, cancellation, recovery | `packages/subprocess/**`, `packages/jobs/**` | TS supervisor | **RETAIN_TS** | Existing process-group and AbortSignal ownership avoids a second supervisor and orphan risk. |
| Filesystem, sandbox, Landlock, path policy | `packages/fs/**`, `packages/sandbox/**`, `native/landlock-run/**` | TS + existing C11 native | **RETAIN_EXISTING** | The current native confinement provider is already the security boundary. |
| APIs, controllers, settings, profile loader | `packages/api/**`, `packages/settings/**`, `packages/boot/**` | TypeScript | **RETAIN_TS** | Dynamic configuration and plugin composition outweigh any local compute gain. |
| Web and HTTP search providers | `packages/web/**`, `packages/llm/**` | TypeScript | **RETAIN_TS** | Network wait and provider contracts dominate. |
| Code runtime, Python, worker threads | `packages/code-runtime/**` | Existing runtimes | **RETAIN_EXISTING** | Rust cannot replace another language runtime; only isolated pure CPU work can be considered separately. |
| Session projection, title, telemetry | `packages/session/**` | TypeScript/native backend | **RETAIN_TS** | Event schema and persistence order are compatibility surfaces. |
| UI and native API app | `packages/bundle/**`, native app | SwiftUI/AppKit + TS bridge | **RETAIN_EXISTING** | The product boundary must remain unchanged. |
| Benchmarks, differential replay, learning evaluator | `scripts/rust-migration/**` | TypeScript | **RETAIN_TS** | The evaluator must preserve the auditable evidence contract. |

## Rust work worth pursuing

Keep only three candidate classes: a persistent immutable search index, a large-corpus graph derivation index after edge semantics are fixed, and a bounded batch CPU kernel only if profiling proves it is an end-to-end bottleneck. The current BM25 shadow proves differential equality and isolation, not speed or production authorization. Candidate Ark UI smoke also exposed a profile issue: a fresh session needs an explicit default model or the UI reports that no model is available.

## Promotion gates

Moving any row to a Rust owner requires the same corpus and request sequence for current TS, optimized TS, and Rust; canonical result/error equality; candidate-profile replay; cancellation, timeout, SIGKILL recovery, and no orphan process; CPU/RSS/event-loop/IPC/package/CI/platform data; a TypeScript fallback receipt; no duplicate knowledge or session side effects; and independent review before candidate and then enforce mode.

The global conclusion is therefore: **keep dynamic authority in TypeScript and candidate only proven closed computations. The persistent-index direction is the next Rust investigation; the existing BM25 shadow remains shadow-only.**
