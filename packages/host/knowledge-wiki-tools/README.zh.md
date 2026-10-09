---
description: "基于已组合的 knowledgeWiki 服务提供面向模型的知识库工具。"
kind: "package-reference"
---

# `@deepseek-ai/dsh-tool-knowledge-wiki`

[English](README.md) | 中文

## 概述

基于已组合的 `knowledgeWiki` 服务提供面向模型的知识库工具。默认情况下，本插件通过共享工具注册表注册 `wiki_search`、`wiki_files`、`wiki_read`、`wiki_graph`、`wiki_reviews`、`wiki_verify_candidate` 和 `wiki_ingest`，并延迟解析该服务，因此知识库 provider 尚未出现时插件也可以加载。本包不增加 MCP bridge 或桌面 UI。

## 目录

- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration"></a>
## 配置

`exposeGovernedTools` 是可选布尔值，默认为 `true`；其他值类型会使插件加载失败。`false` 只注册 `wiki_ingest` 及其摄取提示词。`true` 还注册五个受治理的读取工具和 `wiki_verify_candidate`。该选择控制面向模型的工具目录，不控制权限或验证：知识服务保留全部 authority、范围、精确字节和 trial 检查。更改该值需要重新加载插件。

<a id="model-experience"></a>
## 模型体验

### 知识库工具

#### 模型看到的内容

当 `exposeGovernedTools: true` 时，模型会看到七类工具面：搜索、文件列表、页面读取、图谱检查、未解决审查项列表、候选验证和来源摄取。审查结果仅包含调用 session 可见的元数据。空结果显示 `No unresolved review items are visible to this session.`，不能据此认证项目的所有审查项均已解决。候选验证报告 verifier 结果，不晋级知识，也不证明任务中的成功使用。为 `false` 时，模型只会看到摄取。各目录分别安装下方对应的提示词。

##### Knowledge Wiki prompt guidance

```markdown
Use wiki_search to find knowledge-base pages, wiki_read to read one Wiki-root-relative page, wiki_files to list canonical pages, wiki_graph to inspect the graph, wiki_reviews to inspect governance, wiki_verify_candidate to run the trusted verifier, and wiki_ingest to enqueue source work. Cite pages by their Wiki-root-relative path.
```

##### Ingestion-only Knowledge Wiki prompt guidance

```markdown
Use wiki_ingest to enqueue source work.
```

#### Token 影响

只有已注册工具的 schema 及其返回结果会按调用条件增加请求内容。常见结果上限为：搜索 8 个命中、文件列表 60 项、单页读取 8000 个字符、审查项 30 项；图谱查询的请求节点数上限为 100。

#### KV Cache 影响

本包不保留模型内容缓存。每次工具调用都可能追加取决于数据的结果；已安装的 prompt guidance 在本插件组合发生变化前保持稳定。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 组合中没有 `knowledgeWiki` 服务时，调用会以 `knowledgeWiki service unavailable` 失败；本插件不会创建备用存储。
- 受治理的读取和候选验证要求已组合的 trusted verifier authority。暴露其 schema 不能证明该 authority 已存在，也不能证明某条记录可被准入；缺少 authority 时仍拒绝访问。

<a id="dev-note"></a>
### 开发备注

无。
