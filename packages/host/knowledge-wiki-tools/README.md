---
description: "Model-facing knowledge-base tools over the composed knowledgeWiki service."
kind: "package-reference"
---

# `@deepseek-ai/dsh-tool-knowledge-wiki`

English | [中文](README.zh.md)

## Summary

Model-facing knowledge-base tools over the composed `knowledgeWiki` service. By default, the plugin registers `wiki_search`, `wiki_files`, `wiki_read`, `wiki_graph`, `wiki_reviews`, `wiki_verify_candidate`, and `wiki_ingest` through the shared tool registry, and resolves the service lazily so the plugin can load before the knowledge-base provider is present. It adds no MCP bridge or desktop UI.

## Table of Contents

- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration

`exposeGovernedTools` is an optional boolean, defaulting to `true`; other value types reject plugin loading. `false` registers only `wiki_ingest` and its ingestion guidance. `true` also registers the five governed read tools and `wiki_verify_candidate`. This choice controls the model-facing catalog, not permission or verification: the knowledge service retains all authority, scope, exact-byte, and trial checks. Changing it requires reloading the plugin.

## Model Experience

### Knowledge-base tools

#### What the model sees

With `exposeGovernedTools: true`, the model receives seven tool surfaces: search, file listing, page reading, graph inspection, unresolved-review listing, candidate verification, and source ingestion. Review results contain only metadata visible to the calling session. An empty result renders `No unresolved review items are visible to this session.`; it does not certify that all project reviews are resolved. Candidate verification reports the verifier outcome, without promoting knowledge or establishing successful task use. With `false`, the model receives only ingestion. Each catalog installs its corresponding guidance below.

##### Knowledge Wiki prompt guidance

```markdown
Use wiki_search to find knowledge-base pages, wiki_read to read one Wiki-root-relative page, wiki_files to list canonical pages, wiki_graph to inspect the graph, wiki_reviews to inspect governance, wiki_verify_candidate to run the trusted verifier, and wiki_ingest to enqueue source work. Cite pages by their Wiki-root-relative path.
```

##### Ingestion-only Knowledge Wiki prompt guidance

```markdown
Use wiki_ingest to enqueue source work.
```

#### Token effect

Only registered tool schemas and their returned results add conditional request content. The package bounds common results at 8 search hits, 60 listed files, 8000 characters per page read, and 30 review items; graph queries cap the requested node count at 100.

#### KV Cache effect

The package retains no model-content cache. Each tool call can append data-dependent results, while the installed prompt guidance remains stable until this plugin's composition changes.

## Known Limitations and Deferred Work

- Calls fail with `knowledgeWiki service unavailable` when the composed `knowledgeWiki` service is absent; the plugin does not create a fallback store.
- Governed reads and candidate verification require the composed trusted verifier authority. Exposing their schemas does not prove that authority is present or that a particular record is admissible; missing authority still fails closed.

### Dev Note

None.
