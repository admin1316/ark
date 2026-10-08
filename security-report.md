# ARK security evidence report

Status: `UNKNOWN` for final mission acceptance.

The knowledge governance and Rust boundary tests cover low-trust denial, independent-authority requirements, scope and ACL checks, stale/expired/conflicting records, tamper-evident replay, bounded immutable Rust DTOs, allowlisted child environment, absolute binary paths, input/result digests, timeouts, cancellation fallback, and enforce fail-closed behavior.

The report does not claim zero cross-session leakage, zero memory privilege escalation, zero high-risk UNKNOWN, or production verifier authority. The active profile has no captured signed Phase 6 behavioral receipt and no complete current utility/session outcome corpus. Those claims require an active-profile run with session events, security probes, independent review, and source/profile-bound receipts.

The external verifier adapter remains launcher-owned scaffolding and is not registered as an active production authority. The Rust candidate remains shadow-only; its current benchmark result is recorded in `rust-benchmark.json` and does not authorize enforcement.

The focused knowledge audit found four source defects: unsigned observations could declare verified trust, later signed verification could bless an altered earlier record, canonical bytes were not compared with authenticated bytes, and utility events used page IDs instead of admitted candidate IDs. Current source repairs those admission, byte, and identity relations; focused regression results are recorded in `progress.jsonl`. Historical fixture receipts that omit authenticated page hashes cannot attest the repaired model path.

The [independent audit and experiment plan](scripts/rust-migration/evidence/independent-learning-audit-a08e3776.json) records the pre-repair source snapshot and remaining proof requirements; it is not a successful-learning or acceptance receipt.

Unsupported positive utility is contained in source: generic verification checks do not create successful trials; positive UI feedback and claimed evaluator labels cannot increase governed successful-use counters; all four canonical forward actions and prepared canonical WAL recovery deny without authenticated measured trial evidence. An Archive label cannot authorize canonical journal operations. Real Loader/AgentLoop/Wiki-tool/JSONL composition tests verify denial, feedback replay, and retention after restart without calling a model.

Archive recovery binds its signed operation roles to exact owned paths, immutable candidate/archive bytes, resolved review, and auxiliary identities. It appends terminal rejection once after prepared recovery or a verified committed poststate; append failures retain the WAL for retry. Local crash tests cover the committed-marker/event gap, before/after lifecycle append, idempotence, and rollback. This source repair does not establish independent evaluator ownership or broad runtime safety acceptance.

Evaluator key separation, real independently measured trial utility, authenticated per-use outcomes, deliberate Native verifier provisioning, and authenticated acceptance CLI configuration remain unresolved. The launcher accepts a private key matching the external-result public key, and the current receipt cannot authenticate measured use outcomes. These conditions prevent a claim of independent verified learning or zero memory escalation. The [historical `2268abeb` candidate build and Native API evidence](scripts/rust-migration/evidence/candidate-native-build-2268abeb.json) predates the containment repairs and does not establish their candidate UI behavior.

Evidence references: `packages/host/knowledge-wiki/tests/knowledge-governance.spec.ts`, `packages/host/knowledge-wiki/tests/rust-search-candidate.spec.ts`, `scripts/rust-migration/evaluate-learning.spec.ts`, `docs/rust-migration/knowledge-runtime-report.md`, and `docs/rust-migration/rust-candidate-matrix.md`.
