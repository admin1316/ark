---
description: "Model-facing knowledge-base tools over the composed knowledgeWiki service."
kind: "package-reference"
---

# `@deepseek-ai/dsh-tool-knowledge-wiki`

English | [中文](README.zh.md)

## Summary

Model-facing knowledge-base tools over the composed `knowledgeWiki` service. The plugin registers `wiki_search`, `wiki_files`, `wiki_read`, `wiki_graph`, `wiki_reviews`, `wiki_ingest`, `wiki_verify_candidate`, and `wiki_propose_repair` through the shared tool registry, and resolves the service lazily so the plugin can load before the knowledge-base provider is present. It adds no MCP bridge or desktop UI.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Knowledge-base tools

#### What the model sees

The model receives eight tool surfaces: search, file listing, page reading, graph inspection, unresolved-review listing, source ingestion, independent Candidate verification, and a guarded correction-proposal flow. The package also installs this prompt guidance:

##### Knowledge Wiki prompt guidance

```markdown
Use wiki_search to find knowledge-base pages, wiki_read to read one page, wiki_files to list pages, wiki_graph to inspect the knowledge graph, and wiki_reviews to check pending review items. If the user corrects a Wiki-backed claim, read the complete verified source in this conversation and quote the rule exactly from the current direct user message when calling wiki_propose_repair. The host verifies the direct message and matching tool arguments in the session log. The repair remains untrusted until independent verification and an explicit review; never claim it was learned before a later conversation demonstrates reuse. Cite pages by their Wiki-relative path.
```

#### Token effect

Tool schemas and returned results add conditional request content. The package bounds common results at 8 search hits, 60 listed files, 8000 characters per page read, and 30 review items; graph queries cap the requested node count at 100. Repair proposals require a same-session complete read, are bound to the verified source hash, and can neither verify nor promote themselves.

#### KV Cache effect

The package retains no model-content cache. Each tool call can append data-dependent results, while the installed prompt guidance remains stable until this plugin's composition changes.

## Known Limitations and Deferred Work

- Calls fail with `knowledgeWiki service unavailable` when the composed `knowledgeWiki` service is absent; the plugin does not create a fallback store.
- A repair proposal only creates an untrusted Candidate and blocks the stale source. The later-conversation learning effect remains unproven until the candidate Ark passes matched fresh-session tests.

### Dev Note

None.
