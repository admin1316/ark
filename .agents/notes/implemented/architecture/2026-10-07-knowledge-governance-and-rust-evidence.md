# Agent Note: Governed knowledge events and evidence-gated Rust selection

Status: implemented

English | [中文](2026-10-07-knowledge-governance-and-rust-evidence.zh.md)

## Problem

The active Ark source stores Wiki candidates, reviews, verifier receipts, and utility counters, but model-visible retrieval and injection need durable provenance, scope checks, expiry, conflict handling, and replay. The repository also needs a defensible Rust decision that does not replace a working TypeScript kernel without end-to-end evidence.

## Decision

Knowledge records use explicit provenance, trust, authority, evidence, verification, scope, ACL, expiry, conflict, and utility fields. A hash-chained project journal records observation, candidacy, verification, rejection, retrieval, injection, conflict, expiry, promotion, and rollback. Candidate lifecycle events carry the complete record; promotion requires the existing independent verifier and review transaction. Model-facing Wiki tools append `knowledge/retrieved` and `knowledge/injected` session events containing call identity, scope, result hashes, and replayable JSON values. Unverified, stale, conflicting, out-of-scope, ACL-denied, or low-confidence records fail closed.

Unsigned admission cannot replace an existing identity or assign verified trust. Verification uses its authenticated complete record and rejects a changed prior admission. Promotion seals the final canonical content hash, including WAL recovery; model projections compare exact file bytes before search, embedding, graph derivation, listing, or page reads. A path resolves to the same governed identity for retrieval and utility replay, so editing the display projection cannot reset governed counters. These bindings prevent an unkeyed hash chain or a fresh file hash from masquerading as verification.

Candidate identity includes its path and content hash. Changed bytes create a separate review revision; observing unchanged bytes cannot reopen a resolved review or overwrite its authenticated identity.

The checkout contains the isolated [knowledge-search shadow crate](../../../../rust/knowledge-search-shadow/README.md) and a default-disabled TypeScript child boundary. Search authority, graph derivation, session persistence, and subprocess supervision retain TypeScript or existing native owners; no receipt authorizes Rust enforcement. The Rust candidate matrix requires three-way comparison, differential replay, cancellation, recovery, packaging, and platform evidence before enforcement. [Source census](../process/2026-10-08-function-language-census.md) distinguishes declared coverage from functional and performance verification.

Learning claims use paired baseline/candidate outcome records with the same model, configuration, task, goal, and policy hashes. Missing opportunities or independent verification produce `UNKNOWN`; memory volume, model-call count, or Rust line count cannot establish improvement.

## Alternatives considered

- **Unlogged Wiki recall:** rejected because model-visible input must be reconstructable from the session event log.
- **Automatic promotion from utility or model output:** rejected because low-trust and unverified content cannot change runtime policy or canonical knowledge.
- **Rust-first migration:** rejected because a shadow crate and equal result digests do not prove end-to-end benefit, and mature TypeScript/native owners already provide cancellation and recovery.
- **A single aggregate score:** rejected because explicit rates and zero-leakage requirements must remain independently inspectable.

## Consequences

The Wiki event journal is auditable and replayable, while canonical files remain protected by the existing review and verifier WAL. Session-event additions do not change the session format version. Tool results without a calling session are still usable for non-agent callers, but no model-visible agent call can bypass session event recording. Rust enforcement stays deferred until a concrete candidate has registered corpus, boundary, and three-way evidence.

Test authorities establish deterministic authentication and denial behavior only. Independent evaluator key separation, native provisioning, actual trial benefit, and paired real-provider learning evidence remain unverified; passing verification outcomes and UI feedback do not prove successful repair reuse.
