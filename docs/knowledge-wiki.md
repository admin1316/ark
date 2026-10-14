# Knowledge Wiki

English | [中文](knowledge-wiki.zh.md)

`@deepseek-ai/dsh-knowledge-wiki` is the in-process Wiki service used by Ark. It owns project Markdown pages, hybrid search, graph derivation, source ingestion, candidate reviews, independent verification, promotion journals, and utility feedback. The source/profile/runtime comparison is recorded in the [Phase 0 source-truth report](rust-migration/source-truth-report.md), [profile matrix](rust-migration/profile-matrix.md), and [knowledge runtime report](rust-migration/knowledge-runtime-report.md).

## Configuration

The service validates `wikiRoot`, `mainRoot`, `credential`, `llmProvider`, `llmModel`, `llmBaseUrl`, `llmCredential`, `ownedStageExecutor`, and the optional `knowledgeSearchCandidateMode`, `knowledgeSearchCandidateBinary`, and `knowledgeSearchCandidateTimeoutMs` fields. `credential` supplies optional semantic embeddings and image descriptions; `llmCredential` supplies the owned ingest worker. The candidate mode defaults to `disabled`; `shadow` is observational and `enforce` fails closed until the complete hybrid contract is proven. The package contract and an example profile are in [`packages/host/knowledge-wiki/README.md`](../packages/host/knowledge-wiki/README.md).

## Durable state

Project state is stored below `.llm-wiki/`: `ingest-queue.json` records resumable work, `ingest-cache.json` records successful source hashes, `review.json` records advisory and candidate reviews, `knowledge-utility.json` records retrieval outcomes, and `knowledge-events.jsonl` records hash-chained lifecycle evidence. Writes use the package's confined atomic helpers and event-log append checks.

## Learning lifecycle

Knowledge follows `observed → candidate → provenance check → independent verification → review → limited use → utility measurement → promoted, downgraded, expired, or rolled back`. A `KnowledgeRecord` carries content, source and source hash, scope, trust, authority, evidence references, verification status, confidence, verification and expiry timestamps, conflicts, retrieval/use/correction counters, and utility score.

External pages, MCP results, files, and agent messages enter as low-trust observations. Scope and ACL checks run before model-visible injection; unverified, expired, conflicting, or low-confidence records are denied. Low-trust records cannot change permissions, policy, credentials, or model routing. Promotion requires the existing authority-bound verifier receipt and explicit review action.

The event journal accepts `knowledge/observed`, `knowledge/candidate`, `knowledge/verified`, `knowledge/rejected`, `knowledge/retrieved`, `knowledge/injected`, `knowledge/conflict`, `knowledge/expired`, `knowledge/promoted`, and `knowledge/rolled_back`. Replaying the hash chain reconstructs the governed record state; malformed, out-of-order, or tampered events fail closed.

Each distinct journaled `knowledge/retrieved` event permits at most one non-neutral utility outcome for its page. The service reconciles outcome counts from the hash-chained journal with the utility JSON projection before accepting feedback; a stale projection cannot replay a success or correction after interruption. `wiki_propose_repair` records a corrected outcome only after the same session reads the verified source, consumes its one-use source-hash capability, and the host confirms that the matching tool call quoted the exact rule from the direct user message in that turn. Before model-facing access, verified records with at least three retrievals and utility at or below zero receive a replayable `knowledge/expired` event. Caller-reported success remains a feedback signal, not independent task verification.

### Correction staging

If a user corrects a Wiki-backed claim, `wiki_propose_repair` can create a low-trust Candidate for a verified Markdown page under `concepts/`, `entities/`, `findings/`, `research/`, or `methodology/`. The tool requires a complete `wiki_read` in the same session, and the service independently enforces a one-use, process-local capability bound to that session, project, source path, and exact content hash. It also checks the replayable session log for a direct user message in the same turn and requires the logged tool arguments to match that user-quoted rule. The capability expires after 15 minutes and is not issued for a page longer than the shared 8000-character tool read limit. The old record is rejected before Candidate publication; the proposed rule remains hidden from model-facing Wiki reads until the independent verifier passes and an explicit Replace review is resolved. This is a safe proposal path, not evidence that the next conversation will recall the correction.

## Model-facing behavior

The `tool-knowledge-wiki` plugin adds `wiki_search`, `wiki_files`, `wiki_read`, `wiki_graph`, `wiki_reviews`, `wiki_ingest`, `wiki_verify_candidate`, and `wiki_propose_repair`. Wiki content reaches a model through these tools, and the calling session records retrieval and injection events with the tool call, scope, result hash, and JSON value needed for replay. There is no automatic unscoped recall section in every model step.

Search combines BM25 with optional online embeddings and falls back to keyword results when embeddings are unavailable. Graphs are derived from Wiki Markdown and are cached in memory. Source ingestion is serialized, bounded, cancellable, and resumable; generated pages remain candidates until verification and review complete.

## Session and runtime boundaries

Ark's active profile persists sessions through JSONL and enables the projection cache in the native API bundle. `session-query-sqlite` is mounted with `openAt: never` and an in-memory path, so exact reads and traces are available while full-text search is disabled. Knowledge events are session-log extensions and remain subject to normal session persistence and replay rules.

The current repository contains an isolated Rust shadow crate and a default-disabled Rust search candidate seam. There is no production Rust N-API provider or enforced Rust owner. Search and graph kernels remain TypeScript until a current TypeScript, optimized TypeScript, and real production-boundary Rust comparison passes the [Rust candidate matrix](rust-migration/rust-candidate-matrix.md).
