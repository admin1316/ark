---
description: "万相织鉴 host knowledge engine — the in-process engine behind the concept-graph tab."
kind: "package-reference"
---

# @deepseek-ai/dsh-knowledge-wiki

English | [中文](README.zh.md)

## Summary

万相织鉴 host knowledge engine — the in-process engine behind the concept-graph tab. Owns the wiki page tree (graph + Louvain communities), hybrid search (BM25 + optional embeddings), page editing, a two-stage LLM ingest pipeline with a persisted queue, review items, and deep research, all inside the harness. The LLM Wiki desktop app is not involved.

## Table of Contents

- [Configuration](#configuration)
- [Durable state (.llm-wiki/)](#durable-state-llm-wiki)
- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration

| key | meaning |
|---|---|
| `wikiRoot` | Absolute path of the project wiki directory (contains concepts/, entities/, sources/, index.md, log.md). |
| `mainRoot` | Main workspace root (fixed, non-removable); defaults to the wiki root's parent. |
| `credential` | Credential reference for semantic embeddings and image descriptions; an empty value disables embedding calls. |
| `llmProvider` | LLM provider id for ingest/research (default `deepseek-official`). |
| `llmModel` | LLM model id for ingest/research. |
| `llmBaseUrl` | Chat-completions endpoint used by the owned stage executor (default `https://api.deepseek.com`). |
| `llmCredential` | Credential reference for ingest/research; empty uses the selected provider's declared environment reference. |
| `ownedStageExecutor` | Enables the bounded owned worker for ingest/research (default `false`). |
| `knowledgeSearchCandidateMode` | Optional Rust search candidate mode: `disabled` (default), `shadow` (observe only), or `enforce` (fail closed until the full hybrid contract is verified). |
| `knowledgeSearchCandidateBinary` | Absolute path to the isolated Rust candidate binary. It is unused while the mode is `disabled`. |
| `knowledgeSearchCandidateTimeoutMs` | Per-query candidate timeout in milliseconds (default `30000`, bounded to `1..120000`). |
| `knowledgeVerifierConfig` | Launcher-only JSON for the signed external verifier authority. The empty default keeps verification unavailable; Wiki files cannot provide this value. |

```yaml
- id: knowledge-wiki
  name: '@deepseek-ai/dsh-knowledge-wiki'
  config:
    wikiRoot: '/absolute/path/to/project/wiki'
    mainRoot: '/absolute/path/to/project'
    credential: DEEPSEEK_API_KEY
    llmProvider: 'deepseek-official'
    llmModel: 'deepseek-v4-flash'
    ownedStageExecutor: true
    knowledgeSearchCandidateMode: disabled
    knowledgeSearchCandidateBinary: '/absolute/path/to/knowledge-search-shadow'
    knowledgeSearchCandidateTimeoutMs: 30000
```

## Durable state (.llm-wiki/)

- `ingest-cache.json` — flat `{ identity: sha256 }` map, written only after a successful ingest so failed tasks retry.
- `ingest-queue.json` — pending/running tasks persisted; restored on service start.
- `review.json` — append-only array of review items (deduped by deterministic id).
- `workspaces.json` — registered secondary workspaces.

## Behavior

- Sources under `raw/sources/` are scanned every 60s; changed files are enqueued for two-stage ingest. A failed ingest (LLM error, zero pages written) enters a 60-minute cooldown and never poisons the cache.
- The summary page for a source is forced onto the deterministic slug contract (`12-ark-sessions--32-…--<fnv32 base36>.md`), matching the existing corpus.
- Generated pages are sanitized, date-stamped, canonicalized (`sources` field), and merged with any existing page: pages owned only by this source are replaced whole; shared pages keep their body and union their `sources`.
- Deterministic fallbacks run regardless of model output shape: index entry, log entry, source summary page, review items.

### Rust search candidate

The production search path remains TypeScript by default. In `shadow` mode the service sends the same canonical page corpus and query to the isolated Rust candidate, checks request/result digests and byte-exact BM25 output, logs the observation, and still returns the governed TypeScript result. Candidate processes receive a minimal environment, bounded input/output, and a deadline; failure, timeout, cancellation, or divergence falls back to TypeScript. The `enforce` mode is intentionally fail-closed and currently rejected by `modelSearch` because Rust has not yet implemented the complete hybrid BM25-plus-embedding result contract.

### Governed page reads

Model Wiki projections require a registered project, the calling session, and a configured verifier authority. Unsigned observations and candidates remain low-trust; a verified event authenticates the complete record, including content, provenance, scope, ACL, and expiry. Ordinary model page recall requires canonical lifecycle and exact authenticated bytes; semantic verification alone cannot expose candidate content. Authenticated candidate review metadata remains available after receipt and current-byte checks, while Native preview and Archive retain their existing rules. Historical canonical admission binds exact page bytes with SHA-256. Search and graph admit readable bytes before deriving results or sending embedding input; modified or unbound pages fail closed. Every governed source projection requires one authenticated owner for the exact source string, including terminal records; competing identities fail closed without using legacy display counters. Retrieval and outcome events use the admitted knowledge ID, and governed utility counters replay from the journal. Search rechecks current governance after asynchronous work, and model search also rechecks confined page bytes before returning results. Positive UI feedback remains observable without granting successful-use or retention credit; corrections reduce utility and reject reuse.

Semantic verification preserves authenticated check results without creating a trial. Semantic receipts cannot authenticate measured trial benefit, and canonical action owners have no provisioned measured-trial authority. Promote, Merge, Replace, and Deduplicate deny before writes; their prepared WALs also deny roll-forward. A prepared canonical WAL therefore blocks initialization or project-switch recovery without deleting evidence or certifying completion. Archive, Skip, and rollback retain their existing rules. Canonical target preparation is a pure transform of captured candidate content, resolved target path, exact target prestate or explicit absence, review time, and actor. Identical inputs produce identical bytes; preparation grants no trial or promotion authority and writes no files or journal.

Archive recovery validates signed operation roles, candidate/review/governance paths, archive bytes, resolved review, and staging identities before mutation. It records the original Archive or Skip disposition as one rejected lifecycle event, including recovery after a committed marker but before event append. Missing-event repair requires exact committed file poststates; divergence or append failure preserves the WAL for reviewed recovery or retry. Repeated recovery does not duplicate the lifecycle event.

On POSIX, shared filesystem writes flush file bytes and affected directory entries, including provisioned ancestor entries. Review transactions flush each rename, unlink, and restoration before counting it complete; matching-state retries repeat the required barriers. Event appends flush the file and parent. Sync failure may leave new bytes or a marker visible: the operation fails, retains recovery evidence, and cannot infer durability from visibility. The legacy win32 directory-fsync `EPERM` exception preserves visibility behavior only. These checks establish requested OS flush ordering and process-crash recovery, without proving physical power-loss durability, independent evaluator custody, or exclusion of external concurrent writers.

### Read-only learning evidence

The source-facing `validateLearningReceiptChain` consumes an exact measured-trial artifact through the existing verifier owner. `createReadOnlyLearningVerifier` privately associates a strict candidate-internal descriptor, separate evaluator and journal public keys, explicit traversal budgets, the selected reducer identity, and a fresh owner capture of the protected journal and registered session contexts. Missing owner input returns `unavailable`; a different captured journal epoch cannot replace the selected fixed epoch. Descriptor parsing and public-key separation do not establish physical evaluator custody or authentic current-state capture.

The validator checks retained semantic v2 receipts, frozen canonical preparation, original learning requests, preregistered ordered task arms, captured session/provider/injection facts, complete protected journal replay, and historical promotion/WAL projections. It reconstructs reducer inputs from signed use receipts, retaining known failed tasks and unknown outcomes. The supported product-facts artifact is the measured-use projection with `oracle` and `result` omitted; oracle verdicts remain evaluator-owned. Reducer records use the selected journal signer as producer, the authenticated evaluator as evaluator, and the signed use artifact as evidence. These labels and synthetic artifacts cannot prove independent real task measurement.

`validated` reports authenticated graph relations, recomputed counts, and a trial result of `pass`, `fail`, or `unknown`; it always reports `creditCommitted: false` and `activationAllowed: false`. Validation consumes retained artifacts and journal state; it does not certify current physical Wiki bytes, target absence, compare-and-swap exclusion, or external writer ownership. This read-only factory dispatches no checks, signs no journal, exposes no trial content, and grants no canonical write authority. Shipped YAML and Native profiles do not compose it. The public Wiki service, semantic receipt format, active profiles, and canonical forward-action denial retain their existing behavior. Actual paired Ark tasks and independent evaluator provisioning remain required for capability and learning claims.

## Model Experience

### Two-stage source ingest

#### What the model sees

For every changed source file, two sequential requests: a stage-1 analysis prompt carrying the project purpose, a slice of the wiki index, and the source text (capped at 60000 characters); and a stage-2 generation prompt carrying the analysis, the project schema, the exact summary-page path, and today's date. Both prompts are written by this package; the model output is consumed as `--- FILE: … ---` blocks and `---REVIEW: …---` blocks.

#### Token effect

Per ingest, proportional to the source size plus the embedded purpose/index/schema context (each capped at 8000 characters); both requests are one-shot and not retained.

#### KV Cache effect

Independent requests: the stage-2 prompt embeds the stage-1 output, so it cannot reuse the stage-1 request; across ingests the prompt changes with the source. The package owns no stable reusable prefix.

### Deep research

#### What the model sees

An expansion request turning the topic into search queries and a synthesis request fed the fetched web results.

#### Token effect

Per research run, topic-proportional plus the fetched page content.

#### KV Cache effect

Independent requests per research run.

### Vision captions (image ingest)

#### What the model sees

The image bytes of an ingested media file, via the configured vision call, producing the page caption.

#### Token effect

Per image, data-dependent.

#### KV Cache effect

Independent request per image.

## Known Limitations and Deferred Work

- **Long-document truncation** — a source longer than 60000 characters is truncated for the analysis stage; ark-sessions sources are far below this.
- **Conservative shared-page merge** — an existing page with other sources keeps its body; only the `sources` frontmatter is unioned. LLM-body merge for shared pages is not implemented.
- **Stage-2 review blocks only** — review items are parsed from the generation output; there is no standalone review-suggestion LLM stage.
- **Online embeddings only** — vector search calls the embedding API per query; there is no persisted vector store.
- **Polling watch** — `raw/sources` is scanned every 60 seconds; there is no filesystem watcher.
- **Verifier provisioning and learning evidence** — native launch does not provision an independent evaluator or compose the read-only learning validator. Canonical forward actions remain denied; independent paired provider runs and replay evidence remain required for learning claims.
- **Out of scope** — Web Clipper, MCP server, and a desktop UI are not provided; the knowledgeWiki Remote contract and the tool-knowledge-wiki consumer cover the UI surface.

### Dev Note

None.
