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
- [候选实测评审](#candidate-measured-trial-review)
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
| `knowledgeVerifierConfig` | 仅由 launcher 提供的 JSON，包含验证 authority id、可执行文件、Ed25519 公钥、源码身份以及可选参数和时限；不接受 `privateKey`。非空配置要求受管 `ctx.subprocess`，并要求 Context 服务 `knowledgeWikiVerifierAuthority` 提供匹配的 id 和类型化 `sealPromotion` 方法。adapter 只保留公钥用于验证，并在返回前用它核验委派签名。若提供的有效公钥与签名 owner 不匹配，会在首次签名时拒绝。`timeoutMs` 只约束验证器子进程。签名调用会收到调用方与项目的取消信号，但时限和进程树退出由签名 owner 负责。空值默认保持验证不可用，Wiki 文件不能提供此配置。 |
| `knowledgeMeasuredTrialConfig` | 仅由 launcher 提供的 JSON，包含相互独立的 evaluator 与晋级日志签名者 Ed25519 SPKI 公钥，以及 artifact store 绝对路径。它只读取以小写 SHA-256 命名的普通唯一文件，每个文件上限 16 MiB；默认空值关闭实测试用门控，拒绝私钥和额外字段。 |

Jiuzhang launcher 会把 `ARK_KNOWLEDGE_MEASURED_TRIAL_CONFIG` 映射到此选项，Native shell 只转发这个明确允许的变量。受信公钥必须来自独立 evaluator 与晋级日志负责人；这条接线不会生成或配置 authority。自行管理 reader 的 host 仍可直接注入 `knowledgeWikiMeasuredTrialReader` Context 服务。没有受信配置时，实测试登记和 canonical 评审动作继续失败关闭。

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
- `review.json` —— 有界的评审 JSON 数组，按确定性 id 管理，并由统一 UTF-8 字节上限 owner 负责读写。
- `workspaces.json` —— 已注册的次级工作区。

<a id="behavior"></a>
## 行为

- 每 60 秒扫描 `raw/sources/`，变更文件入队两阶段摄取。失败（LLM 错误、零页产出）进入 60 分钟冷却，绝不污染缓存。
- 源文件摘要页强制落到确定性 slug 契约（`12-ark-sessions--32-…--<fnv32 base36>.md`），与存量语料一致。
- 生成页面经 sanitize、日期戳、`sources` 字段规范化后与既有页面合并：仅本源独占的页面整体替换；共享页面保留正文并并集 `sources`。
- 无论模型输出形态如何，确定性兜底照常执行：index 条目、log 条目、源摘要页、评审项。
- 启用 `ownedStageExecutor` 时，阶段超时或 owner 取消会中止阶段，并等待所有已登记的 worker join 都结束后再返回。若某个 join 永不结束，操作会继续等待；pre-worker 连接解析及不透明 provider 的终止状态尚未证明可静止。
- [持久化文件删除](src/filesystem.ts)只有在确认目录祖先后，才把缺失目标作为无操作处理。非目录祖先和检查失败仍会报错；缺失祖先的查找在文件系统根处终止。最终目标的不跟随链接、唯一文件及 inode 检查仍由删除操作执行。

### 复用搜索索引

每个 Wiki 根目录只准备一次 BM25 词频与文档频率，并通过现有 `WikiSnapshotStore` 供不同搜索查询复用。页面写入和外部文件 watcher 会与其他快照一起使该根目录的派生索引失效。Wiki 文件仍是事实来源。服务每次请求仍会回放 Knowledge 治理状态并执行模型作用域访问检查；索引缓存不会缓存授权结果。

### 自动会话摘要

收到 `agent/disposed` 后，host 可以将顶层会话汇总为其非主工作区中的未受信 topic、incident 或 reflection Candidate。完整 session-query 快照必须与请求的会话 id 匹配，没有 origin 或 parent 来源关系，delegation depth 为零或未设置，并明确记录 `workspace-write` 或 `danger-full-access` 模式。最新的文件模式记录决定是否准入；`read-only` 或缺少策略时不运行摘要阶段，approval 模式不能替代文件策略。子会话的发现保留在父会话对话中，不单独生成自动知识页。

摘要阶段结束后，host 会重新读取会话，在第一次写入前要求准入状态、cwd、文件模式、事件数量和提取的对话均保持一致。取消会拒绝发布。读取或写入失败按尽力而为处理，不阻塞 agent 销毁。这项检查不是原子文件事务，也不是逐文件任务授权；[所属决策](../../../.agents/notes/implemented/architecture/2026-10-12-session-summary-admission.zh.md) 记录了这一限制。

### 修正已使用的知识

修正 RPC 会在解析路径或读取会话前拒绝类型错误的项目、工作区或会话字段；项目和会话必须非空。被拒绝的输入不能发布 Candidate 或撤销来源。服务会在校验和异步授权读取前捕获提案与访问范围中的平面字段。输入 owner 在读取会话前统一规则的 NFC 和空白并校验非空；授权使用该规范化结果，Candidate 保留原文去除首尾空白后的正文。调用方之后修改原对象，不能改变被授权的规则、消耗另一会话的完整读取能力，或把修正来源记到另一会话。

用户纠正了基于 Wiki 的回答时，模型可通过 `wiki_propose_repair` 将修正规则暂存为不可信 Candidate。只有同一会话通过 `wiki_read` 完整读取已验证来源页，且可回放的 session 日志确认工具调用引用了该轮直接用户消息中的原文规则，才能提交；服务会保留一个最多 15 分钟、绑定会话、来源路径和内容 hash 的进程内一次性能力。超过共同 8000 字符读取上限的页面不能授权修复。完整读取会清除过期能力、刷新该会话的条目，并在达到 256 项上限时淘汰最早条目。拒绝事件持久追加成功后，旧来源先被撤销，再记录修正反馈并发布 Candidate；如果首次追加失败，操作不能声称来源已撤销。之后的反馈或 Candidate 失败不会撤销已经成功的拒绝事件。外部损坏或删除生命周期日志不在此持久化保证范围内。修正规则必须经过独立验证和明确的 Replace 评审后才可使用。这只会暂存修正，不能单凭它证明模型会在后续对话中复用。

授权工具调用必须位于日志中最新的 `turn/start` 之后。后续轮次会使此前的修正调用失效，即使数字轮次 ID 被复用；最新轮次头损坏时也不能授权修复。最新直接人类消息无法读取时会拒绝授权，不能借用此前的规则。真实 session-query provider 也会在整段日志回放时拒绝格式损坏的消息正文，先于 Wiki 授权检查。来源被替换后，必须重新完整读取当前经过认证的字节。读取会话授权后，写入方会在消耗能力前重新校验工作区注册、路径边界、当前准入、记录身份和来源字节；并发删除、撤销或替换会使写入被拒绝。

### Utility 反馈

每个独立记录的 `knowledge/retrieved` 事件最多允许该页面接收一次修正信号。单独提交 `successful` 会返回零，不会增加 `successfulUses` 或产生正向 utility；旧成功事件和 JSON 投影不会被追溯计入。`knowledgeUtility()` 从生命周期事件日志派生检索与修正计数；在有经过认证的配对实测前，不报告成功使用次数。完整 utility JSON 投影会在对应生命周期写入前按 UTF-8 字节数检查是否处于现有 5 MiB 消费上限内。修复过程中，计算出的过期状态先只保留在内存，直到最终投影符合上限；随后 owner 才持久化过期事件，并重新校验经过认证的当前来源。拒绝与修正反馈事件追加后，认证回放必须再次确认来源身份、拒绝后的生命周期状态和 utility 计数，之后才会写入投影或 Candidate。普通模型访问前，至少检索三次且 utility 不高于零的已验证记录会在日志中标记过期；未决 Candidate 不会按此规则淘汰。修复失败边界见[知识治理决策说明](../../../.agents/notes/implemented/architecture/2026-10-07-knowledge-governance-and-rust-evidence.zh.md#decision)。

<a id="candidate-measured-trial-review"></a>
### 候选实测评审

Ingest、research、session-summary、correction-repair 和带说明的图片发布路径，会在首次发布 Candidate、治理或 Review 状态前，预检完整的可能评审投影，包括部分成功结果及同路径 fallback 版本。所有 `review.json` 读取方和写入方共用完整格式化 JSON 数组的 8 MiB 上限，其中包含 JSON 转义和末尾换行。历史重复 id 会保留，更新沿用既有的首条匹配规则。提交时会比较完整 Review 字节，在同一 Wiki 根目录下重新解析 Candidate 路径并核对其字节，同时复核来源身份和当前治理决定。来源是项目内常规文件时，owner 绑定当前文件字节；外部、虚拟或当前不存在的来源路径只按路径字符串绑定，未提供来源时使用固定的 `unknown-source` 标记。research 使用的 `research:${topic}` 只绑定请求标识，不验证抓取到的事实。原始来源或媒体前置写入可能已发生，后续文件或日志 I/O 也可能留下部分结果；这不是多文件事务或跨进程锁。Wiki 页面读取仍限制为 5 MiB，晋级恢复 WAL 仍限制为 8 MiB。具体 owner 边界见[知识治理决策说明](../../../.agents/notes/implemented/architecture/2026-10-07-knowledge-governance-and-rust-evidence.zh.md#decision)。

语义验证会在写入 Review 或治理投影前，等待完整验证事件的签名并认证结果。写入前，owner 会复查完整 Review 字节、受限 Candidate 路径与字节、源码及构建身份、经过认证的事件日志，以及回执字节和绑定。等待期间取消或切换项目会拒绝发布。拒绝签名或发现变化时，本次操作不会更新这些投影。之后的投影 I/O 失败会抛错，并可能留下部分 Review 或审计状态；这不是多文件回滚，没有经过认证的事件也不能授权模型访问。

注入的 authority 只签署经过 schema 校验的验证事件、晋级事件或晋级 WAL 核心请求；任意字符串、未知操作和不匹配的 authority 标识均被拒绝。这些内部请求保留既有规范签名字节及事件、WAL 持久格式。晋级和经过授权的恢复会在应用日志操作前准备晋级事件签名，然后重新校验当前输入，再同步提交并发布事件。

服务为每个项目 generation 持有一个取消信号。切换工作区、删除当前工作区或 dispose 服务都会取消该 generation；语义验证还会合并调用方信号。验证事件、晋级事件、WAL 和恢复签名都会收到对应信号，既有的 await 后状态与 generation 检查保留。配合取消的签名 owner 必须停止并等待其进程树退出后，再结束调用。不响应信号的 owner 仍可能让调用一直等待；Wiki 的同步 dispose 只请求取消，本身不等待签名结束。adapter 不为签名增加时限。有类型的操作分发不能证明密钥已有受保护的所有权，也不代表生产 signer 已部署。

事务 owner 会按签名 WAL 顺序应用文件操作并同步其父目录，再追加匹配的生命周期事件；事件文件及其父目录同步后，才会写入 `committed` 标记。I/O 错误可能留下仍为 `prepared` 的 WAL 和已可见的操作或事件字节；rename 之后发生的错误也可能在调用失败时留下后续字节，因此不能假设错误一定回滚。恢复细节见[知识治理决策说明](../../../.agents/notes/implemented/architecture/2026-10-07-knowledge-governance-and-rust-evidence.zh.md#decision)。

完整序列化的晋级 WAL 上限为 8 MiB，与恢复读取上限一致；超限事务会在首次持久写入前拒绝。这是恢复容量边界，不代表支持任意大的输入；恢复仍会拒绝读取此前写入的超限 WAL。

完整 JSONL 事件日志的 UTF-8 字节上限为 64 MiB，读取方和追加 owner 共用此上限；会拒绝使日志超限的追加，已有超限日志仍无法读取。调用方必须串行追加同一路径；实现没有跨进程锁，批量追加多个事件也不是原子事务。

共用的 `validateKnowledgeRecord` owner 要求 `lastVerifiedAt` 与 `expiresAt` 为 `null` 或能通过现有 `Date.parse` 检查的 JavaScript 字符串，不收紧原有可解析日期格式。`claimKey` 可以缺省；若提供，必须是 JavaScript 字符串。签名编码器复用此 validator；trust 与 WAL role 的允许值匹配前也要求 JavaScript 字符串，不做强制转换。

语义验证通过后，host RPC `recordCandidateMeasuredTrial` 接受一个内容寻址的 trial hash。注入的 reader 会校验配对使用证据，并将结果绑定到当前评审、语义回执、Candidate hash、动作及 canonical 目标的前置状态。登记、授权与恢复时传给 reader 的预期绑定值固定为不可变对象；reader 不能改写用于比较其结果的值。只有经过认证的试验显示 utility 正向提升，评审项才会开放该动作。之后调用 `resolveReview` 时，服务会重新验证语义回执和实测回执，再通过签名晋级日志写入实测回执冻结的目标字节；崩溃恢复也会在完成写入前重做这些校验。缺少 authority、效用未提升、Candidate 或目标字节变化及无效回执都会使 canonical 内容保持不变。

带签名的使用回执要求 `useId` 与 `callId` 是有长度上限的非空值；有效签名不能跳过字段校验。

每个使用回执的 `evidenceArtifactReferences` 及对应 oracle 证据列表，首项必须引用规范 JSON 格式的 `knowledge-use-journal-v1` 凭据。其 `schemaVersion`、`kind`、`useFactsHash`、`journalArtifactHash`、`journalSignerAuthorityId` 和 `journalSignerSignature` 字段，通过配置的日志签名者 Ed25519 公钥绑定使用事实身份与非空日志字节快照。事实 hash 覆盖使用回执中除评估者身份及签名、oracle 结果和证据引用以外的全部字段；证据引用在日志签名后加入，避免哈希循环。缺少凭据、公钥错误、使用事实变化或日志字节变化时，即使评估者签名有效也会拒绝。签名者来源、受保护的所有权、完整一致的会话事件、独立任务正确性与真实知识复用仍分别需要检查。

配对使用包含三个哈希域：提案 `targetAfterHash`、使用回执 `contentHash` 和注入事件 `sourceContentHash` 绑定 Wiki 源页面原始字节；注入事件 `contentHash`、`resultHash` 及回执 `renderedToolResultHash` 绑定序列化后的渲染内容块。reader 会将所选 `knowledge/injected` 事件与源哈希、渲染工件、会话、调用、验证状态和字节数逐项核对。一次试验中的每个 baseline 和 candidate 使用都必须使用不同的全新 session ID，并在试验内使用唯一的 `useId`。调用 ID 和事件序号属于会话内部，可以在不同的新会话中重复。

没有签名的 Observed 和 Candidate 记录不能自行声称已验证或进入 canonical 生命周期。经过认证的验证事件必须携带完整且身份匹配的记录，并用它替换准入来源信息；仅通过语义验证仍保留 Candidate 生命周期。模型可见内容必须与签名晋级记录的 `targetAfterHash` 对应的当前文件字节一致。页面读取会再次检查最终返回的字节；来源被改动且 hash 不一致时，不能授权修复，也不会出现在 canonical 搜索、文件列表或图结果中。

### Rust 检索候选

生产检索路径默认仍由 TypeScript 执行。启用 `shadow` 后，服务把同一份规范页面语料与查询发送给隔离的 Rust 候选，校验请求/结果摘要和字节级一致的 BM25 结果，记录观测，同时仍返回经过治理的 TypeScript 结果。候选进程只获得最小环境，并受输入/输出上限和截止时间约束；失败、超时、取消或结果漂移都会回退到 TypeScript。`enforce` 模式刻意 fail-closed；由于 Rust 尚未实现完整的 BM25 加 embedding 混合结果契约，当前 `modelSearch` 会拒绝该模式。

父进程和子进程执行同样的 [UTF-8 字符串和查询 token 上限](../../../rust/knowledge-search-shadow/README.zh.md)。结果哈希使用与响应字节一致的 ECMAScript 数字表示；不能因为解析后的分数数值相等就接受不同摘要。

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

被摄取媒体文件的图像字节，经配置的视觉调用生成页面说明。用于生成说明的图片输入上限为 16 MiB。图片说明生成后、Review 预检后，写入媒体和 Candidate 页面前都会再次比较来源字节；发现来源变化会拒绝发布。

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
- **当前 Jiuzhang runtime 尚未配置实测试 authority** —— profile 已提供仅由 launcher 控制的公钥与内容寻址文件库配置通道，但当前启动没有传入受信 authority 配置或真实配对使用证据。两者完成配置并通过实时复核前，语义验证不能解锁 canonical 动作。
- **范围外** —— 不提供 Web Clipper、MCP server 与桌面 UI；UI 面由 knowledgeWiki Remote 契约与 tool-knowledge-wiki 消费者覆盖。

<a id="dev-note"></a>
### 开发备注

无。
