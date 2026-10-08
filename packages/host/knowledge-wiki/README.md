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

Model Wiki projections require a registered project, the calling session, and a configured verifier authority. Unsigned observations and candidates remain low-trust; a verified event authenticates the complete record, including content, provenance, scope, ACL, and expiry. Promotion binds the final page bytes with SHA-256. Search and graph admit exact readable bytes before deriving results or sending embedding input; modified or unbound pages fail closed. Retrieval and outcome events use the admitted knowledge ID, and governed utility counters are replayed from the journal. UI feedback is an observation, not independent evidence of successful reuse or learning improvement.

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
- **Verifier provisioning and learning evidence** — native launch does not provision an independent evaluator. Passing verifier checks and UI utility feedback do not establish measured trial benefit; independent paired provider runs and replay evidence are required for learning claims.
- **Out of scope** — Web Clipper, MCP server, and a desktop UI are not provided; the knowledgeWiki Remote contract and the tool-knowledge-wiki consumer cover the UI surface.

### Dev Note

None.
