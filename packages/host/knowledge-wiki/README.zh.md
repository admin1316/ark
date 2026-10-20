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

- `ingest-cache.json` —— 来源身份映射到成功的内容 hash、显式取消的 `{ cancelledHash, admissionId? }`、暂时失败冷却的 `{ retryAfter }`，或永久本地提取拒绝的 `{ permanentFailure: { code, sourceHash, policyHash }, admissionId? }`。这些处理状态跨终态历史回收和重启保留；新手动准入不会继承旧拒绝。
- `ingest-queue.json` —— pending/running 任务及有界终态历史；恢复时 running 转为 pending，并移除旧租约元数据。新任务携带准入身份，显式重试不会继承旧取消记录。永久拒绝的来源缺失或不可读时，不丢弃其他恢复任务。只有队列文件不存在才表示空队列；状态无效或超过容量时，恢复失败，不发布部分队列，也不改变项目选择。
- `review.json` —— 追加式评审项数组（按确定性 id 去重）。
- `workspaces.json` —— 已注册的次级工作区。

<a id="behavior"></a>
## 行为

- 文本源最多 5 MiB，必须为严格 UTF-8。支持 Markdown、文本、Org、JSON、YAML、HTML/XML、CSV/TSV 和日志；PDF、Office、不支持格式、空文本、无效 UTF-8、二进制控制字符和伪装二进制容器在模型分析前拒绝，原文件保留本机。
- 队列跨项目串行执行。同步文件/URL 导入只等待自己项目和任务的完成，即使其他项目恢复了相同数字 id。手动批次超过输入数、活动任务数或完整编码状态容量时整批拒绝。阶段结果超限会明确返回容量错误，保留已生成文件，不把没有可恢复回执的结果显示为完成。
- `ingestQueueCancel` 只取消 pending 任务；运行项保留所有者并继续完成。项目注销和服务卸载独立中止所属工作。显式取消持久保存来源指纹；服务卸载保留可恢复任务，不记录用户取消。Host 在持久完成前停止时，恢复尝试可能重复外部模型工作；提供方请求没有恰好一次执行保证。
- 同项目、规范化主题、连接和设置修订相同的研究请求共享操作。每个请求拥有自己的订阅：一个订阅者取消不影响其他订阅者，最后一个取消才停止共享操作；项目注销或服务卸载会取消操作。不同设置修订不加入旧的预备连接。总期限中止同一个操作；阶段清理真正结束后才释放容量并清除计时器。已有研究目标文件保持原样；同 slug 的竞争输出返回警告，完整私有暂存内容以不覆盖方式发布。
- 研究在扩展查询前预检搜索；零个不带凭据的 HTTP(S) 来源时不综合。来源 URL 在保留路径和查询语义的前提下规范化；只能引用实际搜索结果。Host 解析 Markdown 链接及引用式链接，拒绝未知或危险链接，要求至少一个引用，并强制候选/研究身份、日期和实际引用的 `sources`。结果保留每页 `sourceURLs`、标记为 `search-snippet` 的真实搜索 `sources`、数量、警告和降级状态。没有有效输出返回 `invalid-output`，引用被拒绝返回 `invalid-citations`，全部碰撞或写入失败返回 `no-pages`；部分成功保留警告。取消后不再开始后续写入。
- 每 60 秒扫描 `raw/sources/`。暂时失败及没有类型化提取分类的旧错误保留 60 分钟冷却。永久本地提取错误携带错误码和失败内容指纹跨独占 worker 传递；内容及解码策略指纹未变化时，即使历史回收或重启也不自动重试。修改内容、修改解码策略或显式手动重试才允许再次准入。失败和取消均不记录成功摄取 hash。
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

扩展请求将主题转为搜索查询；只有真实可引用搜索结果才允许综合。综合 prompt 将标题、URL 和搜索摘要标为不完整证据，禁止虚构引用并要求至少一个 Markdown 引用。没有搜索能力时不调用模型；零来源时不调用综合模型。Host 独立于模型指令校验引用。

#### Token 影响

单次研究按主题规模加搜索结果标题、URL 和摘要计；研究不抓取网页全文。

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
- **搜索摘要研究** —— 引用成员校验只证明 URL 来自搜索，不证明主张为真或已读全文。原生候选仍需审阅，已记录来源可在隔离的 HTTP(S) 工作台浏览器中打开。
- **仅在线向量** —— 向量检索按查询调用 embedding API，无持久向量库。
- **轮询监视** —— `raw/sources` 每 60 秒扫描，无文件系统 watcher。
- **范围外** —— 不提供 Web Clipper、MCP server 与桌面 UI；UI 面由 knowledgeWiki Remote 契约与 tool-knowledge-wiki 消费者覆盖。

<a id="dev-note"></a>
### 开发备注

无。
