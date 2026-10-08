# Agent Note: Governed knowledge events and evidence-gated Rust selection

Status: implemented

English | [中文](2026-10-07-knowledge-governance-and-rust-evidence.zh.md)

## Problem

The active Ark source stores Wiki candidates, reviews, verifier receipts, and utility counters, but model-visible retrieval and injection need durable provenance, scope checks, expiry, conflict handling, and replay. The repository also needs a defensible Rust decision that does not replace a working TypeScript kernel without end-to-end evidence.

## Decision

Knowledge records use explicit provenance, trust, authority, evidence, verification, scope, ACL, expiry, conflict, and utility fields. A hash-chained project journal records observation, candidacy, verification, rejection, retrieval, injection, conflict, expiry, promotion, and rollback. Candidate lifecycle events carry the complete record; promotion requires the existing independent verifier and review transaction. Model-facing Wiki tools append `knowledge/retrieved` and `knowledge/injected` session events containing call identity, scope, result hashes, and replayable JSON values. Unverified, stale, conflicting, out-of-scope, ACL-denied, or low-confidence records fail closed.

The checked-out source and current GitHub main contain no Rust crate, Rust source, N-API Rust provider, or Rust IPC worker. Knowledge search, graph derivation, session persistence, and subprocess supervision remain TypeScript or existing native C. The Rust candidate matrix requires current TypeScript, optimized TypeScript, and real N-API or IPC Rust comparisons with differential replay, cancellation, recovery, packaging, and platform evidence before enforce mode.

Learning claims use paired baseline/candidate outcome records with the same model, configuration, task, goal, and policy hashes. Missing opportunities or independent verification produce `UNKNOWN`; memory volume, model-call count, or Rust line count cannot establish improvement.

## Alternatives considered

- **Unlogged Wiki recall:** rejected because model-visible input must be reconstructable from the session event log.
- **Automatic promotion from utility or model output:** rejected because low-trust and unverified content cannot change runtime policy or canonical knowledge.
- **Rust-first migration:** rejected because no current three-way benchmark or differential replay evidence exists, and mature TypeScript/native owners already provide cancellation and recovery.
- **A single aggregate score:** rejected because explicit rates and zero-leakage requirements must remain independently inspectable.

## Consequences

The Wiki event journal is auditable and replayable, while canonical files remain protected by the existing review and verifier WAL. Session-event additions do not change the session format version. Tool results without a calling session are still usable for non-agent callers, but no model-visible agent call can bypass session event recording. Rust work stays deferred until a concrete candidate has registered corpus, boundary, and three-way evidence.
