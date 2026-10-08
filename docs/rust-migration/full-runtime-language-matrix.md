# ARK Function-Level TypeScript/Rust Review

English | [中文](full-runtime-language-matrix.zh.md)

## Scope and status

This reference distinguishes source coverage, architectural ownership, runtime verification, and measured language benefit. The [source census](../../scripts/rust-migration/function-language-inventory.json) binds its Git snapshot, code digest, manifest hashes, profile/preset hashes, and declaration locations. It covers all 212 harness packages in 50 groups, plus vendored code, application/launcher code, Swift, Python, C, and Rust in the declared workspace areas. The census retains tests, tooling, and generated paths as explicit exclusions from runtime analysis.

**Source census is complete for that declared scope; semantic review is partial, and whole-product runtime/performance verification is UNKNOWN.** A function or method declaration is not a user feature. Counts include internal functions and overloads. Swift/C/Python/Rust files are listed, but their individual functions and UI controls are not parsed by the TS scanner. Dynamic MCP schemas, user plugins/presets, settings, and environment-dependent composition still require runtime evidence.

The existing tool catalog supplies 74 schema records with 59 distinct names. Literal source registrations add the seven Wiki tool names, giving 66 statically identified distinct names. The census also records 102 Remote decorator sites, five command registration sites, and 83 Context property declarations. These counts do not prove that a tool, Remote, or service is loaded or exercised. The inert Jiuzhang patch composition and three Native preset source files are recorded separately.

## Decision meanings

`KEEP_TS_AUTHORITY` preserves the current permission, event, callback, or lifecycle owner; it does not establish a TypeScript speed advantage or rule out an internal pure kernel. `KEEP_EXISTING_NATIVE` retains an existing system/library implementation. A kernel marked `UNMEASURED` is eligible for investigation, not migration. `KEEP_CURRENT_PENDING_REVIEW` explicitly names unfinished review, rather than treating it as a TS win. Every remaining declaration is present in the census for follow-up; unreviewed entries are not counted as verified.

## Reviewed function boundaries

The [function assessments](../../scripts/rust-migration/function-language-inventory.json) carry source selectors, resolved declaration lines, decisions, and reasons; regeneration rejects a vanished selector. The table summarizes those boundaries without restating the package catalog.

| Function or responsibility | Existing owner | Assessment and required evidence |
| --- | --- | --- |
| Tool/Remote/command dispatch and registration | TS | Keep the authority in TS. Profile an internal immutable computation separately; do not transfer Context, credentials, callbacks, or external effects. |
| Search tokenization, BM25 and scoring | TS, default-disabled Rust shadow | Keep TS. The recorded fixture favors cached TS; this is one assembled search comparison, not a benchmark of each function or all Ark features. |
| Cosine and Wiki graph derivation | TS | Pure-kernel investigation, unmeasured. Keep embedding/network work and governed filtering in TS; fix the intended weighted/unweighted graph contract before comparing a different algorithm. |
| `scanZstdFrames` | TS | Read-only byte-kernel investigation, unmeasured. Preserve ranges, frame limits, corrupt-frame errors, and torn-tail results; writers and repair retain their owner. |
| Zstd compression/decompression | Node native through TS | Keep existing native. Measure the complete scanner/decoder boundary before proposing another implementation. |
| Token-estimation helpers | TS | Pure-kernel investigation, unmeasured. Preserve UTF-16 length, block recursion, and framing constants; do not confuse a new formula with a language speedup. |
| TokenMeter session folds and reconstruction | TS | Keep the replay owner: session state, provider pricing, seq checks, and source-event reconstruction belong together. |
| SessionProjectionRegistry | TS | Keep TS. Its synchronous JS folds, same-reference semantics, and consistency cut exclude a drop-in asynchronous IPC replacement. |
| Editor match-offset and line-number scans | TS | Pure-kernel investigation, unmeasured. Preserve UTF-16 offsets and match rules; authorization and writes remain with the filesystem/tool owner. |
| UTF-8 output truncation | TS | Pure-kernel investigation, unmeasured. Measure whole-stream costs; the trailing scan already examines at most one UTF-8 sequence. |
| UUID and base64 utility | TS/system crypto | UUID uses platform random bytes; base64 can be profiled separately. This package does not own project hash/signature authority. |
| File search, images, SQLite and sandbox confinement | TS plus ripgrep, sharp/libvips, SQLite and C/native confinement | Retain existing components while profiling their adapters and workloads. Source integration alone does not prove performance. |
| Native UI, model/protocol integration, learning policy and other unreviewed functions | Existing Swift/TS/Python/native owners | Preserve the current product and authority contracts. Review remaining functions individually; no blanket best-language conclusion is recorded. |

## Measured result and next decisions

The [30-iteration search fixture](../../rust-benchmark.json), bound to source `45ea6452d11156d19568a2137ac43d57262dee38`, records current TS cold p50 11.756 ms, optimized TS cached p50 0.513 ms, Rust cold IPC p50 21.189 ms, and Rust warm child p50 18.248 ms. Rust reuses its child but rebuilds its index; optimized TS reuses its prepared index. The cached TS implementation lives in the benchmark; these numbers do not prove it is deployed in official Ark. Equal results support differential replay of this corpus. These unequal index envelopes do not isolate language cost, establish search-quality improvement, or predict whole-Ark speed. Decision: `RETAIN_TS`; acceptance remains `UNKNOWN`.

For each remaining function, first establish actual profile reachability and task frequency, then CPU/RSS/event-loop or lifecycle cost. Register a three-way comparison only for a demonstrated bottleneck or isolation need. Compare current TS, optimized TS, and Rust at the real boundary with equivalent algorithm and index reuse, result/error replay, serialization, cold/warm startup, cancellation, recovery, package/CI/platform data, and an owned fallback. A persistent index, scanner, or batch kernel remains an investigation until that evidence passes.
