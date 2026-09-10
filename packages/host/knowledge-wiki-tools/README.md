# `@deepseek-ai/dsh-tool-knowledge-wiki`

English | [中文](README.zh.md)

Model-facing knowledge-base tools over the composed `knowledgeWiki` service. The plugin registers `wiki_search`, `wiki_files`, `wiki_read`, `wiki_graph`, `wiki_reviews`, and `wiki_ingest` through the shared tool registry, and resolves the service lazily so the plugin can load before the knowledge-base provider is present. It adds no MCP bridge or desktop UI.

## Model Experience

### Knowledge-base tools

#### What the model sees

The model receives six tool surfaces: search, file listing, page reading, graph inspection, unresolved-review listing, and source ingestion. The package also installs this prompt guidance:

##### Knowledge Wiki prompt guidance

```markdown
Use wiki_search to find knowledge-base pages, wiki_read to read one page, wiki_files to list pages, wiki_graph to inspect the knowledge graph, and wiki_reviews to check pending review items. Cite pages by their wiki path.
```

#### Token effect

Tool schemas and returned results add conditional request content. The package bounds common results at 8 search hits, 60 listed files, 8000 characters per page read, and 30 review items; graph queries cap the requested node count at 100.

#### KV Cache effect

The package retains no model-content cache. Each tool call can append data-dependent results, while the installed prompt guidance remains stable until this plugin's composition changes.

## Known Limitations and Deferred Work

- Calls fail with `knowledgeWiki service unavailable` when the composed `knowledgeWiki` service is absent; the plugin does not create a fallback store.
- `wiki_ingest` accepts a project-relative source path or an `http(s)` URL and is registered in the tool surface, but the installed prompt guidance currently names the other five tools only.
