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
| `visionProvider`, `visionModel` | Independent registered image-capable LLM route; both empty disables captions. |
| `embeddingProvider`, `embeddingBaseUrl`, `embeddingModel`, `embeddingCredential` | Independent OpenAI-compatible vector route and credential reference; all empty keeps retrieval local (BM25). Every field is required when enabled. |
| `embeddingTimeoutMs` | Embedding request deadline in milliseconds (default `30000`); owner disposal also cancels the request. |
| `ownedStageExecutor` | Enable owned file-extraction workers and calls through the registered LLM/web services (default `false`). |
| `llmProvider` | LLM provider id for ingest/research (default `deepseek-official`). |
| `llmModel` | Exact text model for ingest/research (default `deepseek-flash`). |

```yaml
- id: knowledge-wiki
  name: '@deepseek-ai/dsh-knowledge-wiki'
  config:
    wikiRoot: '/absolute/path/to/project/wiki'
    mainRoot: '/absolute/path/to/project'
    llmProvider: 'deepseek-official'
    llmModel: 'deepseek-flash'
    ownedStageExecutor: true
```

The `knowledge-wiki` settings namespace updates routes live through the shared settings revision/CAS service. It contains `textProvider`/`textModel`, `visionProvider`/`visionModel`, and the four `embedding*` fields above. Text and image requests use the selected LLM provider's prepared call; that provider owns its endpoint, protocol, and credential. Embeddings resolve only their declared credential reference and reject redirects. Analysis/generation and expansion/synthesis prepare both one-shot calls before their first model request, so a settings change during analysis does not move generation to another endpoint or credential reference. The provider still owns credential-value rotation. Keys never belong in these settings. An unconfigured image route preserves the local media and returns a warning; an unconfigured embedding route performs no network request.

Every project-scoped Remote request carries `projectContext`. Obtain it from `listProjects().projects[]`, `currentProjectContext`, or a successful `setProject`/`createProject` result. The Host resolves that opaque identity to one registered project before any work begins; reads, writes, review actions, queue operations, research, and exports never fall back to the current UI selection. Switching selection retains earlier project identities. Removing a project revokes its identity and cancels owned work without deleting project files; restarting the Host also expires identities. `projectStatus` reports configured keyword/hybrid mode and independently selected routes; an unavailable vector request falls back to local keyword results.

Automatic session summaries use only registered secondary session workspaces. They bind the project lifetime before model execution; removal cancels the summary and prevents later candidate or review publication. Candidate-page writes reject symbolic links in every directory component beneath the configured root.

## Durable state (.llm-wiki/)

- `ingest-cache.json` — flat `{ identity: sha256 }` map, written only after a successful ingest so failed tasks retry.
- `ingest-queue.json` — pending/running tasks persisted; restored on service start.
- `review.json` — append-only array of review items (deduped by deterministic id).
- `workspaces.json` — registered secondary workspaces.

## Behavior

- Supported source text is bounded to 5 MiB and decoded as strict UTF-8. Markdown, text, Org, JSON, YAML, HTML/XML, CSV/TSV, and log files are admitted; PDF, Office, unsupported formats, malformed UTF-8, binary controls, and disguised binary containers are rejected before model analysis. Original source files remain local.
- Research preflights the configured web service before query expansion. Zero citeable HTTP(S) sources blocks synthesis and page creation. Partial search failures remain warnings; results include source count, degradation, and a stable error classification. Cancellation prevents subsequent writes.
- Sources under `raw/sources/` are scanned every 60s; changed files are enqueued for two-stage ingest. A failed ingest (LLM error, zero pages written) enters a 60-minute cooldown and never poisons the cache.
- The summary page for a source is forced onto the deterministic slug contract (`12-ark-sessions--32-…--<fnv32 base36>.md`), matching the existing corpus.
- Generated pages are sanitized, date-stamped, canonicalized (`sources` field), and merged with any existing page: pages owned only by this source are replaced whole; shared pages keep their body and union their `sources`.
- Deterministic fallbacks run regardless of model output shape: index entry, log entry, source summary page, review items.

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

An expansion request turning the topic into search queries and, only after citeable sources are available, a synthesis request fed those sources. Missing search capability spends no model request; zero-source search spends no synthesis request.

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
- **Text extraction only** — PDF and Office parsing remain unavailable until a verified extractor is integrated.
- **Online embeddings only** — vector search calls the embedding API per query; there is no persisted vector store.
- **Polling watch** — `raw/sources` is scanned every 60 seconds; there is no filesystem watcher.
- **Out of scope** — Web Clipper, MCP server, and a desktop UI are not provided; the knowledgeWiki Remote contract and the tool-knowledge-wiki consumer cover the UI surface.

### Dev Note

None.
