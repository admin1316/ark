# Knowledge Wiki (Cross-Session Memory)

English | [中文](knowledge-wiki.zh.md)

This document describes the knowledge-wiki system that runs as a dynamic Cordis plugin (`kgraph-1`) beside the web app. It gives the agent cross-session memory: conversation conclusions, a user profile, reflections on mistakes, and imported reference documents, retrieved semantically and injected back into every model step.

This is a runtime plugin, not a repo package; its code lives in the plugin registry of the running harness. This document is the durable record of its contracts so the system can be rebuilt or extended after a restart.

## Data location

The plugin resolves files relative to the harness working directory (`/Users/hui/ark/jiuzhang-runtime` in the deployed setup):

| File | Contents |
|---|---|
| `.dsh-knowledge-wiki/knowledge.jsonl` | One JSON object per line — every knowledge entry |
| `.dsh-knowledge-wiki/vectors.json` | `{ [entryId]: number[] }` — cached text-embedding-v3 vectors (1024-dim), one per entry |

Query vectors are intentionally **not** persisted: they live in a bounded in-memory LRU (24 entries) so the cache file never grows unbounded.

## Entry schema

Each line of `knowledge.jsonl`:

```json
{
  "id": "kw-session-1eb2-t273",
  "sessionId": "session-1eb247a9-...",
  "turn": 273,
  "time": 1786948578869,
  "kind": "conversation | profile | reflection | doc",
  "title": "漫剧技能训练",
  "input": "the user question (<=400 chars)",
  "output": "the assistant conclusion / profile text / lesson (<=400 chars)",
  "tools": ["run_code", "read", "..."]
}
```

`kind` semantics:

- `conversation` — one turn's question → conclusion pair.
- `profile` — per-session user profile: `语言: X；关注主题: ...；常用工具: ...` (id is `kw-profile-<sid12>`; updated in place).
- `reflection` — a lesson: `用户反馈: ...` when the genuine user text contains feedback words (`不对|错了|重来|...`), or `工具错误: ...` for a short tool error. Deduplicated by (session, output).
- `doc` — imported reference documents (e.g. the `llm_wiki` repository READMEs, chunked at 16 KB).

## Ingestion (auto-remember)

The plugin listens to the scoped `agent/turn-stopping` event (root-context listeners receive all scoped events). For each session:

1. **Cursor seeding** — on first observation, the cursor is seeded from `sessionQuery.readSurface(sessionId).capturedThroughSeq`, so an upgrade never replays history.
2. **Incremental extraction** — only events with `seq > lastSeq` are read via `sessionQuery.filterEvents(sessionId, [{ kind: 'seq', from: lastSeq + 1 }])`, which returns semantic documents (`{type, text}`). This makes each entry carry this turn's actual question and conclusion instead of the session's first message.
3. **Three artifacts per turn** — a `conversation` entry, an upserted `profile` entry, and a `reflection` entry when feedback or a tool error is detected.
4. **Vector persistence** — each new entry is embedded and written to `vectors.json` (awaited, so coverage stays 100%).

Genuine user text is filtered: system notes (`The approval policy changed...`), subagent report echoes (`Background subagent ... reported...`), goal-tool blocks (`<goal_round>...`), and >4000-char dumps are excluded from inputs and from reflection triggers.

## Retrieval (semantic search)

The model-visible tool `knowledge_search(query)` blends two scorers:

```
score = cosine(queryVec, entryVec) * 1.0
      + tfidf(query, entry)          * 6.0
      + 1.0 if the query text occurs verbatim
      + 0.05 for profile entries, + 0.02 for reflections
```

- **Semantic** — query and entries are embedded with `text-embedding-v3` (batch ≤10 per API call, dashed to dashscope via `shell` + curl with the `VISION_API_KEY` credential).
- **Lexical** — Chinese-aware tokenizer: CJK unigrams + bigrams, English words; TF-IDF with `idf = log(1 + N / (1 + df))`. Chinese and English queries both work, and Chinese queries can recall English documents semantically.
- Degrades gracefully to TF-IDF only when the embed API is unavailable.

## Automatic recall (memory becomes behavior)

A `systemPrompt.section({ name: 'knowledge-wiki-recall', order: 90 })` injects the latest two profiles and the latest four reflections into **every model step**:

```
## 用户画像（跨会话记忆）
- 语言: 中文；关注主题: 分镜, 角色, 导演...

## 过往教训（自动回想）
- 工具错误: Error: code run failed (exception): TypeError...
```

The snapshot is refreshed after every successful turn-stopping ingestion. This is the closed loop: past conclusions, preferences, and mistakes are present in the model's context without any explicit query, so behavior changes as the wiki grows.

## Concept graph

The client tab (registered on the `conversation.view` slot, `id: 'knowledge-graph'`, order 20 — third tab after 对话/轨迹) calls the `kw.graph` RPC, which computes:

1. **Semantic topic clusters** — entries are clustered by vector cosine (threshold 0.52, incremental single pass). Clusters with ≥2 members become `topic` nodes labelled by shared CJK bigrams.
2. **Cluster→concept links** — a concept shared by ≥2 cluster members links to the cluster.
3. **Cluster↔cluster links** — clusters sharing ≥2 concepts are linked.
4. **Concept co-occurrence edges** — only pairs appearing in ≥2 distinct entries survive (cuts ~85% of noise edges); edge weight = entry count.

Every non-topic node inherits a `cluster` id from its strongest topic link, so the client tints communities (10-color palette) and renders strong edges (weight ≥3) thicker. The client supports node dragging and wheel zoom.

## Client RPC surface (`harness.handle`)

| Method | Returns |
|---|---|
| `kw.list` | all entries (JSON array) |
| `kw.graph` | `{ nodes: [{id, kind, label, count, entries, cluster}], edges: [{from, to, weight}] }` |
| `kw.ingest` | manually ingest one session (`{sessionId}`) |

## Tool surface

| Tool | Purpose |
|---|---|
| `knowledge_search` | semantic + lexical retrieval over the wiki (up to 5 results) |

## Sandbox notes (gotchas we hit)

- Dynamic plugin `fs`/`shell` default to a **read-only** policy; every write must pass `sandboxPolicy.resolve({ mode: 'workspace-write' })`.
- The value-schema DSL for tool `output.schema` accepts only `type/properties/items/additionalProperties` on object nodes — no `required`, and arrays allow only `type/items`.
- `sessionQuery.listEvents` returns records without `data`; use `filterEvents` for semantic text.
- Embedding API batches are limited to 10 texts per request.
