# `@deepseek-ai/dsh-tool-knowledge-wiki`

[English](README.md) | 中文

基于已组合的 `knowledgeWiki` 服务提供面向模型的知识库工具。本插件通过共享工具注册表注册 `wiki_search`、`wiki_files`、`wiki_read`、`wiki_graph`、`wiki_reviews` 和 `wiki_ingest`，并延迟解析该服务，因此知识库 provider 尚未出现时插件也可以加载。本包不增加 MCP bridge 或桌面 UI。

## 模型体验

### 知识库工具

#### 模型看到的内容

模型会看到六类工具面：搜索、文件列表、页面读取、图谱检查、未解决审查项列表和来源摄取。本包还安装以下 prompt guidance：

##### Knowledge Wiki prompt guidance

```markdown
Use wiki_search to find knowledge-base pages, wiki_read to read one page, wiki_files to list pages, wiki_graph to inspect the knowledge graph, and wiki_reviews to check pending review items. Cite pages by their wiki path.
```

#### Token 影响

工具 schema 和返回结果会按调用条件增加请求内容。常见结果上限为：搜索 8 个命中、文件列表 60 项、单页读取 8000 个字符、审查项 30 项；图谱查询的请求节点数上限为 100。

#### KV Cache 影响

本包不保留模型内容缓存。每次工具调用都可能追加取决于数据的结果；已安装的 prompt guidance 在本插件组合发生变化前保持稳定。

## 已知限制与暂缓事项

- 组合中没有 `knowledgeWiki` 服务时，调用会以 `knowledgeWiki service unavailable` 失败；本插件不会创建备用存储。
- `wiki_ingest` 接受项目相对来源路径或 `http(s)` URL，并已注册到工具面，但当前安装的 prompt guidance 只点名了其他五个工具。
