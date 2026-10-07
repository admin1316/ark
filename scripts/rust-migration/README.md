# Learning evaluation input

`evaluate-learning.ts` reduces explicit, independently verified baseline/candidate outcome records. It does not read session files, infer success from memory volume, or promote a runtime policy.

Run it with `pnpm exec tsx scripts/rust-migration/evaluate-learning.ts outcomes.json`. The input must be a JSON object with `schemaVersion: 1` and a `records` array. Each record has `pairId`, `variant` (`baseline` or `candidate`), `model`, SHA-256 strings for `modelConfigHash`, `taskHash`, `goalHash`, and `policyHash`, `producerId`, `evaluatorId`, `verificationStatus`, `evidenceRefs`, and `counts`.

`verificationStatus: "verified"` requires at least one evidence reference and different producer and evaluator IDs. Each count is `{ "numerator": number, "denominator": number }` with safe non-negative integers and numerator no greater than denominator. A metric may be omitted when there were no opportunities; the reducer reports `UNKNOWN` when a complete paired comparison cannot be made.

The reducer pairs records by `pairId` and rejects duplicate variants or differences in model, model configuration, task, goal, or policy hashes. It aggregates counts before calculating rates, so a large task cannot be hidden by averaging per-task percentages. Every pair must have independently verified records for a metric to be comparable.

The output reports each required metric as `IMPROVED`, `REGRESSED`, `UNCHANGED`, or `UNKNOWN`, includes evidence references, and emits a conservative `smartnessClaim` of `SUPPORTED`, `NOT_SUPPORTED`, or `UNKNOWN`. Support requires verified-task success and knowledge utility improvement, lower repeated-error rate, zero stale recall, cross-session leakage, memory privilege escalation, memory poisoning, and false completion, plus complete repair reuse, conflict escalation, and replay explainability evidence.

The metric names are `repeatedErrorRate`, `repeatedToolCallRate`, `verifiedTaskSuccess`, `falseRecallRate`, `staleRecallRate`, `conflictDetectionRate`, `memoryCorrectionRate`, `recoverySuccess`, `knowledgeUtility`, `crossSessionLeakage`, `falseCompletionRate`, `userCorrectionFrequency`, `memoryPrivilegeEscalation`, `memoryPoisoning`, `repairReuseSuccess`, `conflictEscalationRate`, and `replayExplainability`.
