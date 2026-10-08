# Agent Note: Governed knowledge events and evidence-gated Rust selection

Status: implemented

English | [中文](2026-10-07-knowledge-governance-and-rust-evidence.zh.md)

## Problem

The active Ark source stores Wiki candidates, reviews, verifier receipts, and utility counters, but model-visible retrieval and injection need durable provenance, scope checks, expiry, conflict handling, and replay. The repository also needs a defensible Rust decision that does not replace a working TypeScript kernel without end-to-end evidence.

## Decision

Knowledge records use explicit provenance, trust, authority, evidence, verification, scope, ACL, expiry, conflict, and utility fields. A hash-chained project journal records observation, candidacy, verification, rejection, retrieval, injection, conflict, expiry, promotion, and rollback. Candidate lifecycle events carry the complete record; promotion requires independent verification, review, and independently measured trial evidence. Model-facing Wiki tools append `knowledge/retrieved` and `knowledge/injected` session events containing call identity, scope, result hashes, and replayable JSON values. Unverified, stale, conflicting, out-of-scope, ACL-denied, or low-confidence records fail closed.

Unsigned admission cannot replace an existing identity or assign verified trust. Verification uses its authenticated complete record and rejects a changed prior admission. Ordinary model content requires canonical lifecycle; a semantically verified candidate cannot enter page recall without an authorized trial. Authenticated candidate review metadata uses the existing semantic receipt and exact-byte checks, preserving review without opening its content to ordinary recall. Native preview and Archive keep their existing rules. Historical canonical admissions bind the final content hash; model projections compare exact file bytes before search, embedding, graph derivation, listing, or page reads. One exact source string must have one authenticated identity across the complete replay, including terminal records. Competing identities deny model projections, Native search and page reads, and governed utility or outcome updates; insertion order and legacy display counters cannot select an owner. Source strings retain their existing URI semantics without filesystem alias normalization. Search replays current governance after asynchronous work, and model search rechecks confined current bytes before recording retrieval. These bindings prevent an unkeyed hash chain or a fresh file hash from masquerading as verification.

Semantic verification checks do not establish a successful trial. The current receipt contract cannot authenticate measured trial benefit, so Promote, Merge, Replace, and Deduplicate deny before mutation; prepared canonical WAL recovery also denies, including canonical operations labeled Archive. Positive UI feedback and claimed evaluator labels remain observations and cannot increase governed successful-use counters or sustain retention. Corrections retain their negative utility effect. Archive, Skip, advisory resolution, and rollback preserve their existing authority and transaction requirements.

Canonical target preparation captures candidate content, resolved target path, exact prestate or explicit absence, review time, and actor once. One pure transform retains existing action-specific timestamps and raw stamping semantics. Normalized body comparison selects retained content; it does not establish byte identity or verification. Preparation neither authenticates those inputs nor grants canonical eligibility; apply and recovery denial remain unchanged.

Candidate identity includes its path and content hash. Changed bytes create a separate review revision; observing unchanged bytes cannot reopen a resolved review or overwrite its authenticated identity.

Deletion rollback restores the previous candidate only while the path remains absent, or accepts an already restored exact prestate. Recreated divergent bytes cause a conflict and leave the prepared journal for inspection; rollback cannot overwrite another writer's content. Recovery validates the same before/after relationship before mutation.

The checkout contains the isolated [knowledge-search shadow crate](../../../../rust/knowledge-search-shadow/README.md) and a default-disabled TypeScript child boundary. Search authority, graph derivation, session persistence, and subprocess supervision retain TypeScript or existing native owners; no receipt authorizes Rust enforcement. The Rust candidate matrix requires three-way comparison, differential replay, cancellation, recovery, packaging, and platform evidence before enforcement. [Source census](../process/2026-10-08-function-language-census.md) distinguishes declared coverage from functional and performance verification.

Learning claims use paired baseline/candidate outcome records with the same model, configuration, task, goal, and policy hashes. Missing opportunities or independent verification produce `UNKNOWN`; memory volume, model-call count, or Rust line count cannot establish improvement.

## Alternatives considered

- **Unlogged Wiki recall:** rejected because model-visible input must be reconstructable from the session event log.
- **Automatic promotion from utility or model output:** rejected because low-trust and unverified content cannot change runtime policy or canonical knowledge.
- **Verification checks as successful use:** rejected because checking a candidate does not measure its effect on a subsequent task.
- **Rust-first migration:** rejected because a shadow crate and equal result digests do not prove end-to-end benefit, and mature TypeScript/native owners already provide cancellation and recovery.
- **A single aggregate score:** rejected because explicit rates and zero-leakage requirements must remain independently inspectable.

## Consequences

The Wiki event journal is auditable and replayable. Prepared canonical journals block initialization or project switching and preserve their evidence rather than roll forward without measured trial authority. Archive recovery authenticates the operation identities and records terminal rejection once; a committed marker alone cannot certify completed file state. Historical admission fixtures exercise read boundaries without enabling current promotion. Session-event additions do not change the session format version. Tool results without a calling session are still usable for non-agent callers, but no model-visible agent call can bypass session event recording. Rust enforcement stays deferred until a concrete candidate has registered corpus, boundary, and three-way evidence.

The keyless headless scenario exercises the assembled Wiki tools and cold session replay through ordinary runtime subprocesses. Source services resolve through tsconfig paths; built services resolve through package exports. Source-owned Archive, seed, and verifier fixture producers remain separate from those services. Stable transcript capture is separate from assertions over authenticated mutable Wiki state; fixture seals do not authorize current canonical promotion. `examples` is a declared workspace, so built dependency resolution uses the regular install rather than temporary resolver links.

Source-ownership regressions exercise real Loader tools, complete unchanged Wiki file state, cold session replay, and corrections during an asynchronous search. They do not cover filesystem aliases, external concurrent writers, Native raw graph/list projections, or retracting content already sent to a provider. Frozen-input preparation tests establish exact-byte determinism without enabling canonical actions.

Test authorities establish deterministic authentication and denial behavior only. Independent evaluator key separation, native provisioning, actual trial benefit, and paired real-provider learning evidence remain unverified; passing verification outcomes and UI feedback do not prove successful repair reuse.

The real Archive subprocess and YAML Loader regressions recreate a candidate after deletion and interrupt the transaction. They verify that rejected rollback and subsequent recovery preserve those bytes and the prepared journal without minting a completion event. The assembled headless transcript records a scoped empty review result and denied page read; its cold CLI process exits with the actual divergent-state error. These checks cover process interruption; they do not establish power-loss durability of rename or unlink.
