# Learning evaluation input

English | [中文](README.zh.md)

`evaluate-learning.ts` reduces explicit, independently verified baseline/candidate outcome records. It does not read session files, infer success from memory volume, or promote a runtime policy.

The CLI parser calls the pure [package evaluator](../../packages/host/knowledge-wiki/src/learning-evaluation.ts), which is also used by the source-only [read-only learning validator](../../packages/host/knowledge-wiki/README.md#read-only-learning-evidence). Sharing the reducer preserves one numerical interpretation; it does not authenticate the CLI's input records or establish independent evaluator custody.

Run it with `pnpm exec tsx scripts/rust-migration/evaluate-learning.ts outcomes.json`. The input must be a JSON object with `schemaVersion: 1` and a `records` array. Each record has `pairId`, `variant` (`baseline` or `candidate`), `model`, SHA-256 strings for `modelConfigHash`, `taskHash`, `goalHash`, and `policyHash`, `producerId`, `evaluatorId`, `verificationStatus`, `evidenceRefs`, and `counts`.

`verificationStatus: "verified"` requires at least one evidence reference and different producer and evaluator IDs. Each count is `{ "numerator": number, "denominator": number }` with safe non-negative integers and numerator no greater than denominator. A metric may be omitted when there were no opportunities; the reducer reports `UNKNOWN` when a complete paired comparison cannot be made.

Evidence references are portable opaque IDs, relative artifact paths, or network URLs. The parser rejects control characters, absolute host paths (including `file:` and UNC forms), traversal segments, surrounding whitespace, and duplicate references, then sorts each reference list for deterministic replay. For a complete verified pair, the producer identities and evaluator identities must be disjoint across both variants; a producer from either variant cannot also act as the evaluator of either variant.

The reducer pairs records by `pairId` and rejects duplicate variants or differences in model, model configuration, task, goal, or policy hashes. It aggregates counts before calculating rates, so a large task cannot be hidden by averaging per-task percentages. Every pair must have independently verified records for a metric to be comparable. Aggregate counts must remain safe integers. Exact integer cross-products determine rate equality and improvement direction; the displayed rates and `delta` approximate the rational values. Separately rounded rates can be equal while `delta` remains nonzero. These comparisons establish numerical ordering, not statistical significance.

The output reports each required metric as `IMPROVED`, `REGRESSED`, `UNCHANGED`, or `UNKNOWN`, includes evidence references, and emits a conservative `smartnessClaim` of `SUPPORTED`, `NOT_SUPPORTED`, or `UNKNOWN`. Support requires verified-task success and knowledge utility improvement, lower repeated-error rate, zero stale recall, cross-session leakage, memory privilege escalation, memory poisoning, and false completion, plus complete repair reuse, conflict escalation, and replay explainability evidence.

The metric names are `repeatedErrorRate`, `repeatedToolCallRate`, `verifiedTaskSuccess`, `falseRecallRate`, `staleRecallRate`, `conflictDetectionRate`, `memoryCorrectionRate`, `recoverySuccess`, `knowledgeUtility`, `crossSessionLeakage`, `falseCompletionRate`, `userCorrectionFrequency`, `memoryPrivilegeEscalation`, `memoryPoisoning`, `repairReuseSuccess`, `conflictEscalationRate`, and `replayExplainability`.

## Run context and immutable boundaries

`run-context.ts` is a read-only preflight for automatic runs. Run `pnpm exec tsx scripts/rust-migration/run-context.ts <repo-root>` to read `project-manifest.json`, the current Git SHA/profile, active profile patches, knowledge utility, and available `progress.jsonl`, `decision-log.md`, benchmark, security, and drift evidence. It hashes each evidence file and reports missing evidence without fabricating a pass. `assertImmutableBoundaries()` rejects changes to goal, plan, scope, permissions, security thresholds, acceptance criteria, data format, publish policy, or state version; automatic updates may only operate on separately recorded evidence and ranking data. Phase 6 receipts bind the source digest across `packages/`, `integrations/`, `native/`, `scripts/`, and `rust/`, including tracked and non-ignored untracked source files.

`audit-acceptance.ts` reduces the current evidence to per-requirement `PASS`, `UNKNOWN`, or `FAIL` and keeps the overall result `UNKNOWN` whenever required runtime evidence is absent. It is deliberately conservative: a green unit suite cannot promote missing production utility, leakage, verifier, or three-way benchmark evidence.

Run `pnpm exec tsx scripts/rust-migration/audit-acceptance.ts <repo-root> [receipt-path] --trusted-authority-keys <caller-file>` to authenticate a receipt with explicitly selected public keys. The trust file is a JSON object mapping authority IDs to SPKI PEM public-key strings. Relative trust paths resolve from the caller's working directory; receipt paths remain relative to the audited repository. The caller owns authority selection and protection of this file. The CLI does not discover keys, accept keys embedded in receipts, or establish independent evaluator custody. Omitting the option or supplying `{}` keeps unauthenticated checks `UNKNOWN`; a valid but incorrect key also leaves them `UNKNOWN`.

Trust configuration is limited to a regular file of 64 KiB, 64 authorities, 256 characters per non-whitespace authority ID, and 8 KiB per public key. Final-component symbolic links, malformed configuration, missing explicit files, and invalid CLI arguments fail with a nonzero exit and no audit JSON. Configuration loads before audit reduction. The CLI preserves all 16 checks and their source, profile, manifest, goal, and artifact bindings; its JSON `overall` field carries the acceptance result. A signed test fixture proves authentication behavior only.

The audit also reports `artifactCompleteness` separately. A `PASS` there means the requested manifests, reports, scripts, benchmark, and shadow crate are present; it is not a behavioral acceptance result.

## Function-level source census

Run `pnpm exec tsx scripts/rust-migration/inventory-language-fit.ts` to refresh `function-language-inventory.json`. It reuses repository discovery and catalogs, lists source-located TS/JS callable declarations and registration sites, preserves excluded code paths, and records inert Jiuzhang/Native preset composition. Missing function selectors, empty required areas, or incomplete package discovery reject generation. The script writes audit evidence without loading the active user profile or changing runtime language selection.

Declared-scope source coverage is separate from partial semantic review and unconfirmed runtime/performance evidence. Internal functions and overloads are not user features. Swift/C/Rust/Python files are enumerated without parsing individual functions; dynamic MCP schemas, user plugins, settings, and environment expressions remain runtime gaps. See the [language review](../../docs/rust-migration/full-runtime-language-matrix.md).

`feature-language-review.json` preserves manual source-operation observations for the census package set, individually reviewed or pending tool/Remote/command sites, candidate declaration selectors, cited file hashes, and coverage limits. Its census hash identifies the reviewed snapshot; regeneration of the census does not redo manual review. A complete record set means no census package or detected entrypoint is omitted. It does not establish that all internal functions, live features, provider paths, or language benefits are verified.

## TypeScript baseline before Rust

`benchmark-knowledge-search.ts` runs the same deterministic corpus through the current TypeScript BM25 implementation, a pre-indexed optimized TypeScript implementation, and an optional isolated Rust shadow over stdin/stdout. It records p50/p95/p99 latency, CPU time, RSS delta, event-loop delay, and replay digests. The result now exposes four explicit envelopes: `typescriptCold` rebuilds the index, `typescriptWarm` reuses its prepared index, `rustCold` starts a child for every request, and `rustWarm` reuses an opt-in persistent Rust child while still rebuilding the current Rust index per request. The warm helper also records a harness-level SIGKILL/restart probe; cancellation remains explicitly `not-measured` because the synchronous benchmark has no in-flight `AbortSignal`. These are measurement aids, not a production supervisor or acceptance receipt. The record remains `UNKNOWN` until the Rust path is integrated at the production boundary and passes the required end-to-end checks. A faster Rust-only microbenchmark is not sufficient evidence to change the migration decision.

`differential-replay.ts` feeds that canonical corpus to both TypeScript and the isolated [`rust/knowledge-search-shadow`](../../rust/knowledge-search-shadow) binary. A verified digest proves only the shadow contract; it does not authorize production enforcement. Any build, timeout, process, or result mismatch must remain `UNKNOWN`/fallback.

The service package now has a default-disabled candidate seam that can exercise the same child-process contract in a candidate profile. This seam is still observational in `shadow` mode; the active Ark profile remains TypeScript-only, and no candidate receipt authorizes `enforce`.

A service-level model/tool smoke requires a separate receipt bound to its source and profile. The three-way fixture is not that receipt and does not change the active profile decision.

The isolated request carries `requestId`, `sessionId`, `generation`, `capability`, `deadlineMs`, `budget`, and `cancellationToken`; the Rust side rejects unknown fields and invalid control metadata. Benchmark, replay, and boundary processes use the minimal allowlisted environment in `process-isolation.ts`; production integration, long-task cancellation, and crash recovery remain separate evidence gates.

## Isolated runtime evidence

`launcher-verifier-smoke.json` records a temporary Harness launched through the real Jiuzhang source launcher with the launcher-only verifier configuration forwarded to a dummy child; it does not run the Native API service. The requested `native-knowledge-smoke.json` receipt is absent. That receipt requires the real runner, explicit candidate data roots, an authenticated loopback `knowledgeWiki/search` call, and hashes of the returned page, generated utility, and `knowledge/retrieved` event. An isolated fixture does not authorize the production Ark profile or replace the signed Phase 6 acceptance receipt.
