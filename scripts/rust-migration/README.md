# Learning evaluation input

English | [中文](README.zh.md)

`evaluate-learning.ts` reduces explicit, independently verified baseline/candidate outcome records. It does not read session files, infer success from memory volume, or promote a runtime policy.

Run it with `pnpm exec tsx scripts/rust-migration/evaluate-learning.ts outcomes.json`. The input must be a JSON object with `schemaVersion: 1` and a `records` array. Each record has `pairId`, `variant` (`baseline` or `candidate`), `model`, SHA-256 strings for `modelConfigHash`, `taskHash`, `goalHash`, and `policyHash`, `producerId`, `evaluatorId`, `verificationStatus`, `evidenceRefs`, and `counts`.

`verificationStatus: "verified"` requires at least one evidence reference and different producer and evaluator IDs. Each count is `{ "numerator": number, "denominator": number }` with safe non-negative integers and numerator no greater than denominator. A metric may be omitted when there were no opportunities; the reducer reports `UNKNOWN` when a complete paired comparison cannot be made.

Evidence references are portable opaque IDs, relative artifact paths, or network URLs. The parser rejects control characters, absolute host paths (including `file:` and UNC forms), traversal segments, surrounding whitespace, and duplicate references, then sorts each reference list for deterministic replay. For a complete verified pair, the producer identities and evaluator identities must be disjoint across both variants; a producer from either variant cannot also act as the evaluator of either variant.

The reducer pairs records by `pairId` and rejects duplicate variants or differences in model, model configuration, task, goal, or policy hashes. It aggregates counts before calculating rates, so a large task cannot be hidden by averaging per-task percentages. Every pair must have independently verified records for a metric to be comparable.

The output reports each required metric as `IMPROVED`, `REGRESSED`, `UNCHANGED`, or `UNKNOWN`, includes evidence references, and emits a conservative `smartnessClaim` of `SUPPORTED`, `NOT_SUPPORTED`, or `UNKNOWN`. Support requires verified-task success and knowledge utility improvement, lower repeated-error rate, zero stale recall, cross-session leakage, memory privilege escalation, memory poisoning, and false completion, plus complete repair reuse, conflict escalation, and replay explainability evidence.

The metric names are `repeatedErrorRate`, `repeatedToolCallRate`, `verifiedTaskSuccess`, `falseRecallRate`, `staleRecallRate`, `conflictDetectionRate`, `memoryCorrectionRate`, `recoverySuccess`, `knowledgeUtility`, `crossSessionLeakage`, `falseCompletionRate`, `userCorrectionFrequency`, `memoryPrivilegeEscalation`, `memoryPoisoning`, `repairReuseSuccess`, `conflictEscalationRate`, and `replayExplainability`.

## Run context and immutable boundaries

`run-context.ts` is a read-only preflight for automatic runs. Run `pnpm exec tsx scripts/rust-migration/run-context.ts <repo-root>` to read `project-manifest.json`, the current Git SHA/profile, active profile patches, knowledge utility, and available `progress.jsonl`, `decision-log.md`, benchmark, security, and drift evidence. It hashes each evidence file and reports missing evidence without fabricating a pass. `assertImmutableBoundaries()` rejects changes to goal, plan, scope, permissions, security thresholds, acceptance criteria, data format, publish policy, or state version; automatic updates may only operate on separately recorded evidence and ranking data. Phase 6 receipts bind the source digest across `packages/`, `integrations/`, `native/`, `scripts/`, and `rust/`, including tracked and non-ignored untracked source files.

`audit-acceptance.ts` reduces the current evidence to per-requirement `PASS`, `UNKNOWN`, or `FAIL` and keeps the overall result `UNKNOWN` whenever required runtime evidence is absent. It is deliberately conservative: a green unit suite cannot promote missing production utility, leakage, verifier, or three-way benchmark evidence.

The audit also reports `artifactCompleteness` separately. A `PASS` there means the requested manifests, reports, scripts, benchmark, and shadow crate are present; it is not a behavioral acceptance result.

## TypeScript baseline before Rust

`benchmark-knowledge-search.ts` runs the same deterministic corpus through the current TypeScript BM25 implementation, a pre-indexed optimized TypeScript implementation, and an optional isolated Rust shadow over stdin/stdout. It records p50/p95/p99 latency, CPU time, RSS delta, event-loop delay, and replay digests. The result now exposes four explicit envelopes: `typescriptCold` rebuilds the index, `typescriptWarm` reuses its prepared index, `rustCold` starts a child for every request, and `rustWarm` reuses an opt-in persistent Rust child while still rebuilding the current Rust index per request. The warm helper also records a harness-level SIGKILL/restart probe; cancellation remains explicitly `not-measured` because the synchronous benchmark has no in-flight `AbortSignal`. These are measurement aids, not a production supervisor or acceptance receipt. The record remains `UNKNOWN` until the Rust path is integrated at the production boundary and passes the required end-to-end checks. A faster Rust-only microbenchmark is not sufficient evidence to change the migration decision.

`differential-replay.ts` feeds that canonical corpus to both TypeScript and the isolated [`rust/knowledge-search-shadow`](../../rust/knowledge-search-shadow) binary. A verified digest proves only the shadow contract; it does not authorize production enforcement. Any build, timeout, process, or result mismatch must remain `UNKNOWN`/fallback.

The service package now has a default-disabled candidate seam that can exercise the same child-process contract in a candidate profile. This seam is still observational in `shadow` mode; the active Ark profile remains TypeScript-only, and no candidate receipt authorizes `enforce`.

`rust-benchmark.json.productionCandidate` records a service-level shadow exercise separately from the three-way benchmark; it does not change the active profile decision.

The isolated request carries `requestId`, `sessionId`, `generation`, `capability`, `deadlineMs`, `budget`, and `cancellationToken`; the Rust side rejects unknown fields and invalid control metadata. Benchmark, replay, and boundary processes use the minimal allowlisted environment in `process-isolation.ts`; production integration, long-task cancellation, and crash recovery remain separate evidence gates.

## Isolated runtime evidence

`launcher-verifier-smoke.json` records a temporary Harness launched through the real Jiuzhang source launcher with the launcher-only verifier configuration forwarded into the dedicated Native API runner. `native-knowledge-smoke.json` goes one step further: it starts that runner with explicit candidate data roots, calls the authenticated `knowledgeWiki/search` Remote over loopback, and records the returned page plus the generated utility and `knowledge/retrieved` event hashes. These are isolated runtime fixtures; they do not authorize the production Ark profile or replace the signed Phase 6 acceptance receipt.
