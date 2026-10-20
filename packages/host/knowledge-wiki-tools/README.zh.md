---
description: "基于已组合的 knowledgeWiki 服务提供面向模型的知识库工具。"
kind: "package-reference"
---

# `@deepseek-ai/dsh-tool-knowledge-wiki`

[English](README.md) | 中文

## 概述

基于已组合的 `knowledgeWiki` 服务提供面向模型的知识库工具。本插件通过共享工具注册表注册 `wiki_search`、`wiki_files`、`wiki_read`、`wiki_graph`、`wiki_reviews`、`wiki_ingest` 和 `wiki_verify_candidate`，并延迟解析该服务，因此知识库 provider 尚未出现时插件也可以加载。本包不增加 MCP bridge 或桌面 UI。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

每次工具调用从发起会话的 cwd 查找已注册项目，并携带其不透明项目标识；界面当前选择不影响所属项目。没有发起会话或项目未注册时明确拒绝，不自动切换或创建项目。

<a id="model-experience"></a>
## 模型体验

### 知识库工具

#### 模型看到的内容

模型会看到七个工具：搜索、规范页面列表、页面读取、图谱检查、未解决评审项列表、来源摄取与受信候选验证。本包还安装以下 prompt guidance：

##### Knowledge Wiki prompt guidance

```markdown
Use wiki_search to find knowledge-base pages, wiki_read to read one Wiki-root-relative page, wiki_files to list canonical pages, wiki_graph to inspect the graph, wiki_reviews to inspect governance, wiki_verify_candidate to run the trusted verifier, and wiki_ingest to enqueue source work. Cite pages by their Wiki-root-relative path.
```

#### Token 影响

工具 schema 和返回结果会按调用条件增加请求内容。常见结果上限为：搜索 8 个命中、文件列表 60 项、单页读取 8000 个字符、审查项 30 项；图谱查询的请求节点数上限为 100。

#### KV Cache 影响

本包不保留模型内容缓存。每次工具调用都可能追加取决于数据的结果；已安装的 prompt guidance 在本插件组合发生变化前保持稳定。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 组合中没有 `knowledgeWiki` 服务时，调用会以 `knowledgeWiki service unavailable` 失败；本插件不会创建备用存储。
- 工具要求发起会话的 cwd 已在知识服务注册；无会话或未注册项目时明确失败。

<a id="dev-note"></a>
### 开发备注

无。
