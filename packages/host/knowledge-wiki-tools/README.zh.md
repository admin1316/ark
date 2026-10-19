---
description: "基于已组合的 knowledgeWiki 服务提供面向模型的知识库工具。"
kind: "package-reference"
---

# `@deepseek-ai/dsh-tool-knowledge-wiki`

[English](README.md) | 中文

## 概述

基于已组合的 `knowledgeWiki` 服务提供面向模型的知识库工具。本插件通过共享工具注册表注册 `wiki_search`、`wiki_files`、`wiki_read`、`wiki_graph`、`wiki_reviews`、`wiki_ingest`、`wiki_verify_candidate` 和 `wiki_propose_repair`，并延迟解析该服务，因此知识库 provider 尚未出现时插件也可以加载。本包不增加 MCP bridge 或桌面 UI。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="model-experience"></a>
## 模型体验

### 知识库工具

#### 模型看到的内容

模型会看到八类工具面：搜索、文件列表、页面读取、图谱检查、未解决审查项列表、来源摄取、Candidate 独立验证和受限修正提案。本包还安装以下 prompt guidance：

##### Knowledge Wiki prompt guidance

```markdown
Use wiki_search to find knowledge-base pages, wiki_read to read one page, wiki_files to list pages, wiki_graph to inspect the knowledge graph, and wiki_reviews to check pending review items. If the user corrects a Wiki-backed claim, read the complete verified source in this conversation and quote the rule exactly from the current direct user message when calling wiki_propose_repair. The host verifies the direct message and matching tool arguments in the session log. The repair remains untrusted until independent verification and an explicit review; never claim it was learned before a later conversation demonstrates reuse. Cite pages by their Wiki-relative path.
```

#### Token 影响

工具 schema 和返回结果会按调用条件增加请求内容。常见结果上限为：搜索 8 个命中、文件列表 60 项、单页读取 8000 个字符、审查项 30 项；图谱查询的请求节点数上限为 100。修正提案要求同一会话完整读取页面、将修正规则逐字引用当前直接用户消息，并通过 session 日志核对当前轮工具参数；Candidate 仍需独立验证和评审才能使用。

#### KV Cache 影响

本包不保留模型内容缓存。每次工具调用都可能追加取决于数据的结果；已安装的 prompt guidance 在本插件组合发生变化前保持稳定。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 组合中没有 `knowledgeWiki` 服务时，调用会以 `knowledgeWiki service unavailable` 失败；本插件不会创建备用存储。
- 修正提案只会生成不可信 Candidate 并阻止旧来源；只有候选 Ark 通过匹配的新会话测试后，才能确认后续对话的知识复用效果。

<a id="dev-note"></a>
### 开发备注

无。
