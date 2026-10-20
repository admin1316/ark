---
description: "万相织鉴宿主知识引擎 —— 概念图谱标签页背后的进程内引擎。"
kind: "package-reference"
---

# @deepseek-ai/dsh-knowledge-wiki

[English](README.md) | 中文

## 概述

万相织鉴宿主知识引擎 —— 概念图谱标签页背后的进程内引擎。持有 wiki 页面树（图谱 + Louvain 社区）、混合检索（BM25 + 可选向量）、页面编辑、带持久化队列的两阶段 LLM 摄取管线、评审项与深度研究，全部在 harness 进程内完成，不依赖 LLM Wiki 桌面应用。

## 目录

- [配置](#configuration)
- [持久状态（.llm-wiki/）](#durable-state-llm-wiki)
- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration"></a>
## 配置

| 键 | 含义 |
|---|---|
| `wikiRoot` | 项目 wiki 目录的绝对路径（包含 concepts/、entities/、sources/、index.md、log.md）。 |
| `mainRoot` | 主工作区根目录（固定、不可删除）；缺省为 wiki 目录的父目录。 |
| `visionProvider`、`visionModel` | 独立的已注册图片模型路由；两项均为空时不生成说明。 |
| `embeddingProvider`、`embeddingBaseUrl`、`embeddingModel`、`embeddingCredential` | 独立的 OpenAI 兼容向量连接及凭据引用；四项均为空时使用本地 BM25，启用时必须完整填写。 |
| `embeddingTimeoutMs` | 向量请求期限，单位毫秒（默认 `30000`）；所属服务退出也取消请求。 |
| `ownedStageExecutor` | 启用独占文件提取 worker，并通过已注册 LLM/web 服务执行调用（默认 `false`）。 |
| `llmProvider` | 摄取/研究的 LLM provider id（默认 `deepseek-official`）。 |
| `llmModel` | 摄取/研究的精确文本模型（默认 `deepseek-flash`）。 |
| `ingestMaxActiveTasks` | 跨项目已准入 pending/running 任务总上限（默认 `64`）。 |
| `ingestMaxBatchInputs` | 单次手动入队的输入数上限（默认 `64`）；整批准入和队列持久化原子提交。 |
| `ingestHistoryLimit` | 每项目保留的终态记录上限（默认 `128`，允许 `0`）；来源处理状态继续抑制重复执行。 |
| `ingestStateMaxBytes` | 每份队列或来源处理状态文件共用的读写字节上限（默认 `5242880`，范围 `4096`–`67108864`）；必须大于 `512 × ingestMaxActiveTasks`，为 pending 的运行租约元数据预留空间。 |
| `researchConcurrency` | 跨项目不同研究操作的并发上限（默认 `2`）；达到容量时其他主题收到忙状态。 |
| `researchTimeoutMs` | 包含搜索预检的研究总期限（默认 `600000`，最大 `3600000` 的正整数）；通过 `projectStatus` 公布，供调用方设置期限。 |

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

`knowledge-wiki` 设置命名空间通过共享设置服务的 revision/CAS 实时更新路由，包含 `textProvider`/`textModel`、`visionProvider`/`visionModel` 和上表四个 `embedding*` 字段。文本和图片调用使用所选 LLM 提供方的 prepared call，其端点、协议和凭据由该提供方持有。向量服务只解析独立声明的凭据引用，并拒绝重定向。分析/生成及扩展/综合在首次模型请求前预备两个单次调用；分析期间修改设置不会把生成阶段改送另一个端点或凭据引用。凭据值轮换仍由提供方持有。设置内不保存 Key。未配置图片连接时保留本地图片并返回警告；未配置向量连接时不发送网络请求。

所有项目级 Remote 请求必须携带 `projectContext`，可从 `listProjects().projects[]`、`currentProjectContext` 或成功的 `setProject`/`createProject` 结果获取。Host 在执行前将不透明标识解析为一个已注册项目；读取、保存、评审、队列、研究和导出均不回退到界面当前选择。切换选择保留旧项目标识；注销项目使其标识失效并取消所属任务，不删除项目文件；Host 重启也使标识失效。`projectStatus` 返回已配置的关键词/混合检索模式及各连接选择；向量请求不可用时回退到本地关键词结果。

自动会话摘要仅使用已注册的次级会话工作区，在模型执行前绑定项目生命周期；注销项目会取消摘要，并阻止后续候选页和评审发布。候选页写入拒绝配置根目录以下任一目录段中的符号链接。

<a id="durable-state-llm-wiki"></a>
## 持久状态（.llm-wiki/）

- `ingest-cache.json` —— 来源身份映射到成功的内容 hash、显式取消版本的 `{ cancelledHash, admissionId? }` 或失败冷却的 `{ retryAfter }`。终态历史回收不会使未变化的成功/取消来源重新准入，也不会绕过失败冷却。
- `ingest-queue.json` —— pending/running 任务及有界终态历史；恢复时 running 转为 pending，并移除旧租约元数据。新任务携带准入身份，显式重试不会继承旧取消记录。状态无效或超过容量时，恢复失败，不发布部分队列，也不改变项目选择。
- `review.json` —— 追加式评审项数组（按确定性 id 去重）。
- `workspaces.json` —— 已注册的次级工作区。

<a id="behavior"></a>
## 行为

- 文本源最多 5 MiB，必须为严格 UTF-8。支持 Markdown、文本、Org、JSON、YAML、HTML/XML、CSV/TSV 和日志；PDF、Office、不支持格式、无效 UTF-8、二进制控制字符和伪装二进制容器在模型分析前拒绝，原文件保留本机。
- 队列跨项目串行执行。同步文件/URL 导入只等待自己项目和任务的完成，即使其他项目恢复了相同数字 id。手动批次超过输入数、活动任务数或完整编码状态容量时整批拒绝。阶段结果超限会明确返回容量错误，保留已生成文件，不把没有可恢复回执的结果显示为完成。
- `ingestQueueCancel` 只取消 pending 任务；运行项保留所有者并继续完成。项目注销和服务卸载独立中止所属工作。显式取消持久保存来源指纹；服务卸载保留可恢复任务，不记录用户取消。Host 在持久完成前停止时，恢复尝试可能重复外部模型工作；提供方请求没有恰好一次执行保证。
- 同项目、规范化主题、连接和设置修订相同的研究请求共享操作。每个请求拥有自己的订阅：一个订阅者取消不影响其他订阅者，最后一个取消才停止共享操作；项目注销或服务卸载会取消操作。不同设置修订不加入旧的预备连接。总期限中止同一个操作；阶段清理真正结束后才释放容量并清除计时器。已有研究目标文件保持原样；同 slug 的竞争输出返回警告，完整私有暂存内容以不覆盖方式发布。
- 研究在扩展查询前检查 web 服务可用性；零个可引用 HTTP(S) 来源时不综合、不生成研究页。部分搜索失败作为警告，结果保留来源数、降级状态和错误分类；取消后不再开始后续写入。
- 每 60 秒扫描 `raw/sources/`，变更文件入队两阶段摄取。失败（LLM 错误、零页产出）进入 60 分钟冷却，绝不污染缓存。
- 源文件摘要页强制落到确定性 slug 契约（`12-ark-sessions--32-…--<fnv32 base36>.md`），与存量语料一致。
- 生成页面经 sanitize、日期戳、`sources` 字段规范化后与既有页面合并：仅本源独占的页面整体替换；共享页面保留正文并并集 `sources`。
- 无论模型输出形态如何，确定性兜底照常执行：index 条目、log 条目、源摘要页、评审项。

<a id="model-experience"></a>
## 模型体验

### 两阶段源摄取

#### 模型所见

每个变更的源文件对应两次顺序请求：阶段一分析 prompt 携带项目 purpose、wiki index 片段与源文本（上限 60000 字符）；阶段二生成 prompt 携带分析结果、项目 schema、精确摘要页路径与今日日期。两个 prompt 均由本包撰写；模型输出以 `--- FILE: … ---` 块与 `---REVIEW: …---` 块消费。

#### Token 影响

单次摄取与源大小成正比，外加内嵌的 purpose/index/schema 上下文（各上限 8000 字符）；两次请求均为一次性，不保留。

#### KV 缓存影响

独立请求：阶段二 prompt 内嵌阶段一输出，无法复用阶段一请求；跨摄取 prompt 随源变化。本包不拥有可复用的稳定前缀。

### 深度研究

#### 模型所见

一次扩展请求将主题转为搜索查询，取得可引用来源后才发出综合请求。没有搜索能力时不调用模型；零来源时不调用综合模型。

#### Token 影响

单次研究按主题规模加抓取内容计。

#### KV 缓存影响

每次研究为独立请求。

### 视觉说明（图片摄取）

#### 模型所见

被摄取媒体文件的图像字节，经配置的视觉调用生成页面说明。

#### Token 影响

按图像计，数据相关。

#### KV 缓存影响

每张图像为独立请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **长文档截断** —— 超过 60000 字符的源在分析阶段被截断；ark-sessions 源远低于此。
- **保守的共享页合并** —— 拥有其他 sources 的既有页面保留正文，仅并集 `sources` frontmatter；共享页的 LLM 正文合并未实现。
- **仅阶段二 REVIEW 块** —— 评审项从生成输出中解析，没有独立的评审建议 LLM 阶段。
- **仅文本提取** —— PDF 和 Office 解析需接入已验证提取器后开放。
- **仅在线向量** —— 向量检索按查询调用 embedding API，无持久向量库。
- **轮询监视** —— `raw/sources` 每 60 秒扫描，无文件系统 watcher。
- **范围外** —— 不提供 Web Clipper、MCP server 与桌面 UI；UI 面由 knowledgeWiki Remote 契约与 tool-knowledge-wiki 消费者覆盖。

<a id="dev-note"></a>
### 开发备注

无。
