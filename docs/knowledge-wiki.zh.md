# 知识库（跨会话记忆）

[English](knowledge-wiki.md) | 中文

本文描述以动态 Cordis 插件（`kgraph-1`）形式运行在 Web 应用旁的知识库系统。它赋予智能体跨会话记忆：会话结论、用户画像、对错误的反思，以及导入的参考文档，通过语义检索取回，并在每个模型步骤中自动注入。

这是一个运行时插件，不是仓库包；其代码存在于运行中 harness 的插件注册表中。本文是它契约的持久记录，以便系统在重启后可以重建或扩展。

## 数据位置

插件相对 harness 工作目录解析文件（部署环境中为 `/Users/hui/ark/jiuzhang-runtime`）：

| 文件 | 内容 |
|---|---|
| `.dsh-knowledge-wiki/knowledge.jsonl` | 每行一个 JSON 对象——每条知识条目 |
| `.dsh-knowledge-wiki/vectors.json` | `{ [entryId]: number[] }`——缓存的 text-embedding-v3 向量（1024 维），每条目一个 |

查询向量有意**不持久化**：它们存在于有界内存 LRU（24 条）中，缓存文件因此不会无限增长。

## 条目结构

`knowledge.jsonl` 的每一行：

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

`kind` 语义：

- `conversation` —— 一轮的 提问 → 结论 对。
- `profile` —— 每会话的用户画像：`语言: X；关注主题: ...；常用工具: ...`（id 为 `kw-profile-<sid12>`；原地更新）。
- `reflection` —— 一条教训：当真实用户文本包含反馈词（`不对|错了|重来|...`）时为 `用户反馈: ...`，或短工具错误时为 `工具错误: ...`。按（会话, 输出）去重。
- `doc` —— 导入的参考文档（如 `llm_wiki` 仓库的 README，按 16 KB 分块）。

## 沉淀（自动记忆）

插件监听 scoped 的 `agent/turn-stopping` 事件（root 上下文监听器接收所有 scoped 事件）。对每个会话：

1. **游标播种** —— 首次观察时，游标从 `sessionQuery.readSurface(sessionId).capturedThroughSeq` 播种，升级因此不会重放历史。
2. **增量提取** —— 只通过 `sessionQuery.filterEvents(sessionId, [{ kind: 'seq', from: lastSeq + 1 }])` 读取 `seq > lastSeq` 的事件，该方法返回语义文档（`{type, text}`）。这让每条目携带本轮真实的提问与结论，而非会话的第一条消息。
3. **每轮三件产物** —— 一条 `conversation` 条目、一条 upsert 的 `profile` 条目，以及检测到反馈或工具错误时的一条 `reflection` 条目。
4. **向量持久化** —— 每条新条目都被嵌入并写入 `vectors.json`（await，覆盖保持 100%）。

真实用户文本经过过滤：系统注记（`The approval policy changed...`）、子代理报告回声（`Background subagent ... reported...`）、goal 工具块（`<goal_round>...`）以及超过 4000 字符的转储都被排除在 inputs 和反思触发之外。

## 检索（语义搜索）

模型可见的工具 `knowledge_search(query)` 混合两个打分器：

```
score = cosine(queryVec, entryVec) * 1.0
      + tfidf(query, entry)          * 6.0
      + 1.0 if the query text occurs verbatim
      + 0.05 for profile entries, + 0.02 for reflections
```

- **语义** —— 查询与条目用 `text-embedding-v3` 嵌入（每次 API 调用批量 ≤10，通过 `shell` + curl 携带 `VISION_API_KEY` 凭据发往 dashscope）。
- **词法** —— 中文感知分词器：CJK 单字 + 双字 bigram、英文单词；TF-IDF 使用 `idf = log(1 + N / (1 + df))`。中文与英文查询都可用，中文查询可以语义召回英文文档。
- 当嵌入 API 不可用时优雅降级为仅 TF-IDF。

## 自动回想（记忆变成行为）

一个 `systemPrompt.section({ name: 'knowledge-wiki-recall', order: 90 })` 把最新的两条画像和最新的四条反思注入**每个模型步骤**：

```
## 用户画像（跨会话记忆）
- 语言: 中文；关注主题: 分镜, 角色, 导演...

## 过往教训（自动回想）
- 工具错误: Error: code run failed (exception): TypeError...
```

快照在每次成功的 turn-stopping 沉淀后刷新。这是闭环：过去的结论、偏好与错误无需显式查询就出现在模型上下文中，因此行为会随知识库增长而改变。

## 概念图谱

客户端标签页（注册于 `conversation.view` 槽，`id: 'knowledge-graph'`，order 20——对话/轨迹之后的第三个标签）调用 `kw.graph` RPC，它计算：

1. **语义主题簇** —— 条目按向量余弦聚类（阈值 0.52，增量单遍）。≥2 成员的簇成为 `topic` 节点，以共享 CJK bigram 命名。
2. **簇→概念链接** —— 被簇内 ≥2 条目共享的概念链接到该簇。
3. **簇↔簇链接** —— 共享 ≥2 个概念的簇互连。
4. **概念共现边** —— 只有出现在 ≥2 个不同条目中的配对保留（削减约 85% 噪声边）；边权重 = 条目数。

每个非 topic 节点从其最强 topic 链接继承 `cluster` id，客户端据此给社区着色（10 色调色板），并把强边（权重 ≥3）渲染得更粗。客户端支持节点拖拽与滚轮缩放。

## 客户端 RPC 面（`harness.handle`）

| 方法 | 返回 |
|---|---|
| `kw.list` | 全部条目（JSON 数组） |
| `kw.graph` | `{ nodes: [{id, kind, label, count, entries, cluster}], edges: [{from, to, weight}] }` |
| `kw.ingest` | 手动沉淀一个会话（`{sessionId}`） |

## 工具面

| 工具 | 用途 |
|---|---|
| `knowledge_search` | 对知识库做语义 + 词法检索（最多 5 条结果） |

## 沙箱注记（我们踩过的坑）

- 动态插件的 `fs`/`shell` 默认是**只读**策略；每次写入都必须传 `sandboxPolicy.resolve({ mode: 'workspace-write' })`。
- 工具 `output.schema` 的值 schema DSL 只接受 object 节点上的 `type/properties/items/additionalProperties`——不接受 `required`，且数组只允许 `type/items`。
- `sessionQuery.listEvents` 返回的记录不含 `data`；语义文本请用 `filterEvents`。
- 嵌入 API 每次请求批量上限为 10 条文本。
