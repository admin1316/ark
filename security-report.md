# ARK security evidence report

Status: `UNKNOWN` for final mission acceptance.

The knowledge governance and Rust boundary tests cover low-trust denial, independent-authority requirements, scope and ACL checks, stale/expired/conflicting records, tamper-evident replay, bounded immutable Rust DTOs, allowlisted child environment, absolute binary paths, input/result digests, timeouts, cancellation fallback, and enforce fail-closed behavior.

The report does not claim zero cross-session leakage, zero memory privilege escalation, zero high-risk UNKNOWN, or production verifier authority. The active profile has no captured signed Phase 6 behavioral receipt and no complete current utility/session outcome corpus. Those claims require an active-profile run with session events, security probes, independent review, and source/profile-bound receipts.

The external verifier adapter remains launcher-owned scaffolding and is not registered as an active production authority. The Rust candidate remains shadow-only; its current benchmark result is recorded in `rust-benchmark.json` and does not authorize enforcement.

Evidence references: `packages/host/knowledge-wiki/tests/knowledge-governance.spec.ts`, `packages/host/knowledge-wiki/tests/rust-search-candidate.spec.ts`, `scripts/rust-migration/evaluate-learning.spec.ts`, `docs/rust-migration/knowledge-runtime-report.md`, and `docs/rust-migration/rust-candidate-matrix.md`.
