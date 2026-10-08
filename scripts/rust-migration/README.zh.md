# Learning evaluation input

[English](README.md) | 中文

`evaluate-learning.ts` reduces explicit, independently verified baseline/candidate outcome records. It does not read session files, infer success from memory volume, or promote a runtime policy.

Run it with `pnpm exec tsx scripts/rust-migration/evaluate-learning.ts outcomes.json`. The input must be a JSON object with `schemaVersion: 1` and a `records` array. Each record has `pairId`, `variant` (`baseline` or `candidate`), `model`, SHA-256 strings for `modelConfigHash`, `taskHash`, `goalHash`, and `policyHash`, `producerId`, `evaluatorId`, `verificationStatus`, `evidenceRefs`, and `counts`.

`verificationStatus: "verified"` requires at least one evidence reference and different producer and evaluator IDs. Each count is `{ "numerator": number, "denominator": number }` with safe non-negative integers and numerator no greater than denominator. A metric may be omitted when there were no opportunities; the reducer reports `UNKNOWN` when a complete paired comparison cannot be made.

证据引用可以是可移植的不透明 ID、相对 artifact 路径或网络 URL。解析器会拒绝控制字符、主机绝对路径（包括 `file:` 和 UNC 形式）、路径穿越、首尾空白和重复引用，并对每条引用列表排序以保证回放确定性。完整的 verified pair 还要求两个 variant 的 producer 身份集合与 evaluator 身份集合完全不相交；任一 variant 的生产者不能成为任一 variant 的验收者。

The reducer pairs records by `pairId` and rejects duplicate variants or differences in model, model configuration, task, goal, or policy hashes. It aggregates counts before calculating rates, so a large task cannot be hidden by averaging per-task percentages. Every pair must have independently verified records for a metric to be comparable.

The output reports each required metric as `IMPROVED`, `REGRESSED`, `UNCHANGED`, or `UNKNOWN`, includes evidence references, and emits a conservative `smartnessClaim` of `SUPPORTED`, `NOT_SUPPORTED`, or `UNKNOWN`. Support requires verified-task success and knowledge utility improvement, lower repeated-error rate, zero stale recall, cross-session leakage, memory privilege escalation, memory poisoning, and false completion, plus complete repair reuse, conflict escalation, and replay explainability evidence.

The metric names are `repeatedErrorRate`, `repeatedToolCallRate`, `verifiedTaskSuccess`, `falseRecallRate`, `staleRecallRate`, `conflictDetectionRate`, `memoryCorrectionRate`, `recoverySuccess`, `knowledgeUtility`, `crossSessionLeakage`, `falseCompletionRate`, `userCorrectionFrequency`, `memoryPrivilegeEscalation`, `memoryPoisoning`, `repairReuseSuccess`, `conflictEscalationRate`, and `replayExplainability`.

## Run context 与不可变边界

`run-context.ts` 是自动运行前的只读预检。使用 `pnpm exec tsx scripts/rust-migration/run-context.ts <repo-root>` 读取 `project-manifest.json`、当前 Git SHA/profile、active profile patch、knowledge utility，以及可用的 `progress.jsonl`、`decision-log.md`、benchmark、安全和 drift 证据。它会 hash 每个证据文件，缺失证据只会被报告，不会伪造 PASS。`assertImmutableBoundaries()` 拒绝 goal、plan、scope、权限、安全门槛、验收标准、数据格式、发布策略或 state version 的变化；自动更新只能作用于单独记录的证据和排序数据。Phase 6 receipt 的 source digest 会覆盖 `packages/`、`integrations/`、`native/`、`scripts/` 和 `rust/`，包括已跟踪及未被忽略的未跟踪源文件。

`audit-acceptance.ts` 把当前证据归约为每项要求的 `PASS`、`UNKNOWN` 或 `FAIL`；只要缺少必要的运行时证据，总结果就保持 `UNKNOWN`。它保持保守：单测全绿不能把缺失的生产 utility、泄漏、verifier 或三路 benchmark 证据晋级为通过。

审计还会单独输出 `artifactCompleteness`。其中的 `PASS` 只表示所需 manifest、报告、脚本、benchmark 和 shadow crate 都存在，不代表行为验收通过。

## Rust 之前的 TypeScript 基准

`benchmark-knowledge-search.ts` 使用同一个确定性语料，运行当前 TypeScript BM25、预建索引的优化 TypeScript，以及通过 stdin/stdout 隔离运行的 Rust shadow，记录 p50/p95/p99 延迟、CPU 时间、RSS 增量、event-loop delay 和回放摘要。结果现在明确暴露四种 envelope：`typescriptCold` 每次重建索引，`typescriptWarm` 复用预建索引，`rustCold` 每次请求启动子进程，`rustWarm` 复用可选的持久 Rust 子进程（但当前 Rust 内核仍会为每个请求重建索引）。warm helper 还记录 harness 级别的 SIGKILL/重启探针；由于同步 benchmark 没有 in-flight `AbortSignal`，取消明确标记为 `not-measured`。这些只是测量辅助，不是生产 supervisor 或验收凭据。只有 Rust 路径接入生产边界并通过所需端到端检查后，记录才会离开 `UNKNOWN`。单独的 Rust 微基准更快，不足以改变迁移决策。

`differential-replay.ts` 将同一份规范语料传给 TypeScript 和隔离的 [`rust/knowledge-search-shadow`](../../rust/knowledge-search-shadow) binary。摘要一致只证明 shadow contract，不授权生产 enforce。任何构建、超时、进程或结果不一致都必须保持 `UNKNOWN` 并回退。

服务包现在提供默认关闭的候选边界，可在 candidate profile 中运行同一 child-process 契约。该边界在 `shadow` 模式仍只做观测；活动 Ark profile 仍只使用 TypeScript，也没有任何候选凭证可以授权 `enforce`。

`rust-benchmark.json.productionCandidate` 单独记录服务层 shadow 运行证据，不改变活动 profile 的决策。

隔离请求包含 `requestId`、`sessionId`、`generation`、`capability`、`deadlineMs`、`budget` 和 `cancellationToken`；Rust 端拒绝未知字段及无效控制元数据。benchmark、回放和边界进程使用 `process-isolation.ts` 的最小 allowlist 环境；生产接入、长任务取消和崩溃恢复仍是独立证据门槛。

## 隔离运行时证据

`launcher-verifier-smoke.json` 记录了通过真实 Jiuzhang source launcher 启动临时 Harness，并把 launcher-only verifier 配置传入专用 Native API runner。`native-knowledge-smoke.json` 更进一步：它用显式候选数据根启动 runner，通过 loopback 调用带认证的 `knowledgeWiki/search` Remote，记录返回页面以及生成的 utility 和 `knowledge/retrieved` 事件摘要。这些是隔离运行时 fixture，不授权生产 Ark profile，也不能替代签名的 Phase 6 acceptance receipt。
