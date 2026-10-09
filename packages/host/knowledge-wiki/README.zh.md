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
| `credential` | 语义向量与图片说明使用的凭据引用；为空时不调用向量服务。 |
| `llmProvider` | 摄取/研究的 LLM provider id（默认 `deepseek-official`）。 |
| `llmModel` | 摄取/研究的 LLM model id。 |
| `llmBaseUrl` | owned stage executor 使用的 chat-completions 地址（默认 `https://api.deepseek.com`）。 |
| `llmCredential` | 摄取/研究使用的凭据引用；为空时使用所选 provider 声明的环境变量。 |
| `ownedStageExecutor` | 启用受限的摄取/研究 owned worker（默认 `false`）。 |
| `knowledgeSearchCandidateMode` | 可选 Rust 检索候选模式：`disabled`（默认）、`shadow`（仅观测）或 `enforce`（完整混合契约验证前 fail-closed）。 |
| `knowledgeSearchCandidateBinary` | 隔离 Rust 候选二进制的绝对路径；模式为 `disabled` 时不使用。 |
| `knowledgeSearchCandidateTimeoutMs` | 每次查询的候选超时毫秒数（默认 `30000`，范围 `1..120000`）。 |
| `knowledgeVerifierConfig` | 仅由 launcher 提供的签名外部验证器 JSON；空值默认保持验证不可用，Wiki 文件不能提供此配置。 |

```yaml
- id: knowledge-wiki
  name: '@deepseek-ai/dsh-knowledge-wiki'
  config:
    wikiRoot: '/absolute/path/to/project/wiki'
    mainRoot: '/absolute/path/to/project'
    credential: DEEPSEEK_API_KEY
    llmProvider: 'deepseek-official'
    llmModel: 'deepseek-v4-flash'
    ownedStageExecutor: true
    knowledgeSearchCandidateMode: disabled
    knowledgeSearchCandidateBinary: '/absolute/path/to/knowledge-search-shadow'
    knowledgeSearchCandidateTimeoutMs: 30000
```

<a id="durable-state-llm-wiki"></a>
## 持久状态（.llm-wiki/）

- `ingest-cache.json` —— 扁平 `{ identity: sha256 }` 映射，仅在摄取成功后写入，失败任务因此可重试。
- `ingest-queue.json` —— pending/running 任务持久化；服务启动时恢复。
- `review.json` —— 追加式评审项数组（按确定性 id 去重）。
- `workspaces.json` —— 已注册的次级工作区。

<a id="behavior"></a>
## 行为

- 每 60 秒扫描 `raw/sources/`，变更文件入队两阶段摄取。失败（LLM 错误、零页产出）进入 60 分钟冷却，绝不污染缓存。
- 源文件摘要页强制落到确定性 slug 契约（`12-ark-sessions--32-…--<fnv32 base36>.md`），与存量语料一致。
- 生成页面经 sanitize、日期戳、`sources` 字段规范化后与既有页面合并：仅本源独占的页面整体替换；共享页面保留正文并并集 `sources`。
- 无论模型输出形态如何，确定性兜底照常执行：index 条目、log 条目、源摘要页、评审项。

### Rust 检索候选

生产检索路径默认仍由 TypeScript 执行。启用 `shadow` 后，服务把同一份规范页面语料与查询发送给隔离的 Rust 候选，校验请求/结果摘要和字节级一致的 BM25 结果，记录观测，同时仍返回经过治理的 TypeScript 结果。候选进程只获得最小环境，并受输入/输出上限和截止时间约束；失败、超时、取消或结果漂移都会回退到 TypeScript。`enforce` 模式刻意 fail-closed；由于 Rust 尚未实现完整的 BM25 加 embedding 混合结果契约，当前 `modelSearch` 会拒绝该模式。

<a id="governed-page-reads"></a>

### 受治理的页面读取

模型 Wiki 投影要求已登记的项目、调用 session 和已配置的 verifier authority。未签名的 observation 与 candidate 保持低信任；verified 事件认证完整记录，包括正文、来源、scope、ACL 和过期时间。普通模型页面召回要求 canonical 生命周期和经过认证的实际字节；语义验证通过不能单独开放 candidate 正文。经过 receipt 和当前字节校验的 candidate 评审元数据仍可查看，Native 预览与 Archive 保留原有规则。历史 canonical 接纳用 SHA-256 绑定实际页面字节。搜索与图谱在派生结果或发送 embedding 输入前检查可读字节；被修改或未绑定的页面会 fail closed。每个受治理的 source 投影要求精确 source 字符串只有一个经过认证的 owner，terminal 记录也参与检查；竞争 identity 会 fail closed，不能回退到旧展示计数。检索和结果事件使用已接纳的知识 ID，受治理的 utility 计数由日志回放得到。搜索在异步工作后重新检查当前治理状态，模型搜索还会在返回前重新检查受路径约束的页面字节。正面 UI 反馈仍被记录，但不增加成功使用次数或保留收益；纠正反馈降低 utility 并拒绝复用。

语义验证保留经过认证的检查结果，不生成 trial。Semantic receipt 无法认证实测 trial 收益，canonical 操作的 owner 也未配置实测 trial authority。Promote、Merge、Replace 与 Deduplicate 在写入前拒绝；对应的 prepared WAL 也拒绝前向恢复。prepared canonical WAL 因而会阻止初始化或项目切换恢复，同时保留证据且不认证完成。Archive、Skip 与 rollback 保留原有规则。Canonical 目标预备是纯转换，输入为已捕获的 candidate 正文、已解析目标路径、精确目标原始状态或显式不存在、评审时间和 actor。相同输入生成相同字节；预备不授予 trial 或晋级 authority，也不写入文件或日志。

Archive 恢复在修改前校验签名操作的角色、candidate/review/governance 路径、归档字节、已解决的 review 和 staging 身份。恢复会将原始 Archive 或 Skip 处理结果记为一条 rejected 生命周期事件，包括已记录 committed 标记但尚未追加事件的情况。缺失事件的修复要求文件与已提交的 poststate 字节完全一致；状态偏离或追加失败时保留 WAL，供审查恢复或重试。重复恢复不会重复生命周期事件。

launcher 配置的语义验证器使用产品已挂载的 `subprocess` service。`createExternalVerifierAuthority(options, subprocess)` 在整棵进程树终止并静止后才返回结果或错误；service 销毁也会终止尚未结束的工作。缺少进程 owner 时，非空 launcher 配置会被拒绝。原有 schema1 `verifyCandidate` 子请求和 semantic v2 签名保持不变，终止宽限为100 ms，stdout 上限为256 KiB，诊断前缀也有界。显式删除环境变量使 provider 的 proxy overlay 不能扩展验证器的允许列表。该进程生命周期不配置独立评估者，也不启用实测 trial。

在 POSIX 上，共享文件系统写入会同步文件字节和受影响的目录项，包括创建目录时的祖先目录项。评审事务在将改名、删除或恢复操作计为完成前逐项同步；重试看到相同状态时也会重新执行必要的同步。事件追加会同步文件及其父目录。同步失败可能留下可见的新字节或标记：操作仍然失败，保留恢复证据，不能从可见性推断持久性。旧版 win32 对目录 fsync `EPERM` 的例外仅保留可见性行为。这些检查验证操作系统同步请求的顺序和进程崩溃恢复，不证明物理断电持久性、独立评估者的密钥保管或对外部并发写入者的排他控制。

<a id="read-only-learning-evidence"></a>
### 只读学习证据

仅供源码调用的 `validateLearningReceiptChain` 通过现有 verifier owner 消费精确的实测 trial artifact。`createReadOnlyLearningVerifier` 私有绑定严格的候选内部 descriptor、分离的 evaluator 与 journal 公钥、显式遍历预算、选定的归约器身份，以及 owner 每次新捕获的受保护 journal 和已登记 session context。缺少 owner 输入时返回 `unavailable`；捕获到不同 journal epoch 不能替换已选定的固定 epoch。解析 descriptor 和分离公钥不能证明评估者的实际密钥保管，也不能认证当前状态捕获的来源。

校验器检查保留的 semantic v2 receipt、冻结的 canonical 预备、原始学习请求、预登记且有序的任务组、捕获的 session/provider/injection 事实、完整受保护 journal 回放及历史 promotion/WAL 投影。它从签名 use receipt 重建归约器输入，保留已知失败任务和未知结果。受支持的产品 facts artifact 是移除 `oracle` 与 `result` 后的 measured-use 投影；oracle verdict 仍由 evaluator 负责。归约记录以选定的 journal signer 为 producer、经过认证的 evaluator 为 evaluator、签名 use artifact 为 evidence。这些标签和合成 artifact 不能证明真实任务被独立测量。

`validated` 返回经过认证的图关系、重新计算的计数和 `pass`、`fail` 或 `unknown` trial 结果；始终返回 `creditCommitted: false` 与 `activationAllowed: false`。校验消费保留的 artifact 和 journal 状态；它不认证当前物理 Wiki 字节、目标不存在、比较交换的排他性或外部写入者归属。该只读工厂不执行检查、不签署 journal、不暴露 trial 正文，也不授予 canonical 写入权限。已发布的 YAML 与 Native profile 不组装它。Wiki 公共 service、semantic receipt 格式、active profile 及 canonical 正向操作的拒绝规则保留现有行为。能力与学习结论仍需要真实 Ark 配对任务和独立 evaluator 配置。

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

一个把主题展开为搜索查询的请求，以及一个喂入抓取到的网页结果的综合请求。

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
- **仅在线向量** —— 向量检索按查询调用 embedding API，无持久向量库。
- **轮询监视** —— `raw/sources` 每 60 秒扫描，无文件系统 watcher。
- **Verifier 配置与学习证据** —— 原生启动没有配置独立评估者，也未组合只读学习校验器。canonical 前向操作仍被拒绝；学习结论仍要求独立的真实 provider 配对运行与回放证据。
- **范围外** —— 不提供 Web Clipper、MCP server 与桌面 UI；UI 面由 knowledgeWiki Remote 契约与 tool-knowledge-wiki 消费者覆盖。

<a id="dev-note"></a>
### 开发备注

无。
