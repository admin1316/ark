# Phase 0 knowledge/runtime report

[English](knowledge-runtime-report.md) | 中文

**当前知识观察 — 2026-10-13。** [已安装候选身份和已完成任务](source-truth-report.zh.md)与学习要求分别绑定。新的 3.1.41 代码任务中，知识日志保留五条发生在任务前的初始化 `knowledge/injected` 记录，任务期间没有新增事件；这些记录不能证明已认证的使用、utility 提升或新对话复用。[受限任务检查点](../../scripts/rust-migration/candidate341-real-native-code-task-result-20261013.json)保留只读测试前置数据的失败与实际代码修复前后测试，没有将此证据晋级为完整学习验收。已批准的验证器 factory／配置迁移尚未安装到该候选，真实受保护 authority 的部署也未获证明。

**2026-10-12 候选观察（历史）。** 隔离候选 Ark 3.1.35/build `2026101235` 打包的 Knowledge Wiki 模块由 SHA-256 `86a726fa0f0172a9e1e9f415f76e1ceb1e21f9bc31e1468b6fdee58a5de970ab` 标识。Native first-final 任务记录 24,893 个事件；完整会话重放无需修补其私有副本（`repairedPrivateCopy=false`）；详见[first-final 会话重放快照](/Users/hui/ark-test/evidence/candidate335-native-code-first-final-20261012.json)。首次运行结果为 1 项通过／5 项失败，随后记录的复测为 6／0。完整报告因 `validate-throws` 是否执行的陈述相互矛盾而判定 `FAIL`。没有触发 child 或 job 调用。Loader test key 仅供测试；没有证据表明生产 authority 已激活或被真实使用。Rust 决策仍为 `RETAIN_TS`；正式 Ark 3.1.0 未变更，原始 learning 验收仍为 `UNKNOWN`。详见[2026-10-12 候选回执](../../scripts/rust-migration/candidate335-summary-admission-native-result-20261012.json)。

**2026-10-08 源码观察快照（历史）。** 当时源码发现按 checkout 提交 `02bf7ebc7f973b35e298bcd4121199f0ab81683c` 刷新。运行时观察区分隔离候选 Ark 与未修改的正式包；更早的 `b8adf5a7ec` 是历史基线。

## What the model can actually see

当前源码没有自动 Knowledge Wiki recall 区块。`tool-knowledge-wiki` 只在系统提示中简要说明可调用 `wiki_search`、`wiki_read`、`wiki_files`、`wiki_graph`、`wiki_reviews`、`wiki_verify_candidate` 和 `wiki_ingest`（[`packages/host/knowledge-wiki-tools/src/index.ts:64-69`](../../packages/host/knowledge-wiki-tools/src/index.ts)）。模型只有调用已注册工具时才能看到 Wiki 内容：`wiki_search` 返回排序后的路径，`wiki_read` 读取指定路径（[`index.ts:71-165`](../../packages/host/knowledge-wiki-tools/src/index.ts)）。被审计的 package 没有 `knowledge-wiki-recall` 区块、profile/reflection 选择器，也没有逐个 provider 请求自动注入最新知识的代码。

服务中受治理的模型方法要求真实 Session 的 `cwd`／project scope 和 verifier authority；只有记录通过门控后才会写入 retrieval event（[`packages/host/knowledge-wiki/src/index.ts`](../../packages/host/knowledge-wiki/src/index.ts)）。单独调用 `recordKnowledgeOutcome({ outcome: 'successful' })` 返回零；成功生命周期事件不会获得 replay credit，utility projection 也不能自行生成正的 `successfulUses` 或 utility。Wiki 工具会先向 Session 日志写入包含 source hash、authority、trust、evidence、freshness 和 conflict provenance 的 `knowledge/retrieved` event，再把最终渲染的 `tools/result` 原样追加为 `knowledge/injected`（[`packages/host/knowledge-wiki-tools/src/index.ts`](../../packages/host/knowledge-wiki-tools/src/index.ts)、[`session-events.ts`](../../packages/host/knowledge-wiki-tools/src/session-events.ts)）。paired-trial receipt reader 尚未配置，因此这些观察仍不能证明 utility 实测提升，也不能授权 canonical review。

## Write/verification path

| 阶段 | 当前证据 | 状态 |
| --- | --- | --- |
| Observe | `summarizeSession()` 在 `agent/disposed` 触发时调用 `sessionQuery.readSession(sessionId)`（[`packages/host/knowledge-wiki/src/index.ts:296-323`](../../packages/host/knowledge-wiki/src/index.ts)）。 | 仅按 Session 汇总；没有逐 turn observer。 |
| Candidate | LLM summary 将内容写入 `_candidates/{topics,reflections,incidents}`，并追加 `.llm-wiki/review.json`（[`index.ts:326-397`](../../packages/host/knowledge-wiki/src/index.ts)）。 | stage executor 和 project target 均通过时启用。 |
| Provenance / hash | Candidate review 含 candidate hash；verifier 类型包含 source identity/build digest 和 review hash（[`packages/host/knowledge-wiki/src/types.ts:78-129`](../../packages/host/knowledge-wiki/src/types.ts)）。 | Candidate review 路径已具备。 |
| 独立验证 | `verifyCandidate()` 要求注入 `knowledgeWikiVerifierAuthority`，先持久化 receipt，再将 receipt 绑定到 review（[`index.ts:1225-1257`](../../packages/host/knowledge-wiki/src/index.ts)）。 | 基线中未找到生产 authority provider；verifier authority unavailable 是明确阻塞项。 |
| Review / promotion | `resolveReview(s)` 调用 advisory resolution 或 `applyCandidateReview()`（[`index.ts:1264-1318`](../../packages/host/knowledge-wiki/src/index.ts)）。 | 必须显式操作；canonical 内容变更受治理。 |
| Utility | Retrieval 和 correction 计数投影到 `.llm-wiki/knowledge-utility.json`；独立成功反馈会被忽略，语义验证会重置 use 计数，replay 不给旧 success event 记分。面向模型读取前，若已验证记录达到既定的三次 retrieval／utility 非正阈值，就会通过 journaled expiry transition 过期。 | **源码回归覆盖 projection 显示、replay 和 service expiry。目前没有已认证的 paired-trial reader，也没有实测 utility lift。** |
| Expiry/conflict/rollback | `KnowledgeRecord` 字段和 `knowledge-governance.ts` 状态转换落实 expiry、scope、ACL、conflict、downgrade、promotion 和 rollback。Replay 将孤立的 retrieval/injection event 保留为审计事实，但若没有准入记录，则拒绝其他所有 lifecycle transition。 | **当前源码回归通过；Ark 3.1.24 候选早于这项仅源码改动，打包后的行为仍未验证。** |

旧的 auto-sediment module 含可复用的 turn 提取和页面构建 helper，但 service 没有注册它声明的 `agent/turn-stopping` listener。模块注释也说明 turn-level Markdown 已关闭（[`packages/host/knowledge-wiki/src/auto-sediment.ts:1-14`](../../packages/host/knowledge-wiki/src/auto-sediment.ts)、[`index.ts:291-300`](../../packages/host/knowledge-wiki/src/index.ts)）。单元测试会运行这些纯 helper，但不能证明生产环境已注册该 listener。

## Session persistence/query/cache runtime

- JSONL 是当前持久化事件的权威来源。Base profile 将其挂载在 `dshHomePath('sessions')` 下（[`packages/bundle/base/cordis.patch.yml:105-108`](../../packages/bundle/base/cordis.patch.yml)）。Provider 默认以每个 Session 一个只追加文件的方式存储，并使用带校验和的 Zstandard frame 和无损 packed delta row（[`packages/session/session-persistence-jsonl/src/index.ts:1-6`](../../packages/session/session-persistence-jsonl/src/index.ts)、[`:64-88`](../../packages/session/session-persistence-jsonl/src/index.ts)）。
- Base 和 Jiuzhang overlay 都挂载 SQLite query provider，配置为 `path: ':memory:'`、`openAt: never`（[`base/cordis.patch.yml:124-128`](../../packages/bundle/base/cordis.patch.yml)、[`integrations/jiuzhang/profile/cordis.patch.yml:40-43`](../../integrations/jiuzhang/profile/cordis.patch.yml)）。其代码保留精确读取、筛选和 trace，同时关闭全文搜索，且不会打开或导入 SQLite（[`packages/session-query/session-query-sqlite/src/index.ts:85-103`](../../packages/session-query/session-query-sqlite/src/index.ts)、[`:251-255`](../../packages/session-query/session-query-sqlite/src/index.ts)）。
- Native API 挂载 projection cache，并按每 200 个 event 或 5000 ms 触发写入（[`packages/bundle/native-api-app/cordis.patch.yml:96-100`](../../packages/bundle/native-api-app/cordis.patch.yml)）。该 cache 是派生数据、fail-soft 且绑定 identity；在 Session 创建、`turn/end` 和 disposal 时必须写入（[`packages/session/session-projection-cache/src/index.ts:1-16`](../../packages/session/session-projection-cache/src/index.ts)、[`:41-75`](../../packages/session/session-projection-cache/src/index.ts)、[`:220-270`](../../packages/session/session-projection-cache/src/index.ts)）。

## Runtime evidence inspected

1. **正式 Harness** `/Users/hui/Library/Application Support/Ark/Harness`：profile overlay 和 bundle 列表与源码相符；`settings.yaml` 选择 DeepSeek 官方 Flash 和 max reasoning；`storages/session_projcache/sessions/` 下有 16 条 projection-cache 记录。记录含 Session 统计、模型选择、标题、token 使用量、上下文压力、goal 和 seq 水位；其中一个样本记录 seq `155930`、3 个 turn、153 个 step、158,460 个输出 token 和 26,989,696 个 cache-read token。这些都是元数据计数，本报告不重现任何消息内容。旁边的正式 `Knowledge` 根目录只有 purpose/schema/index/log 和 Workspace registry，没有候选页面或 utility 文件。
2. **正式 Session 文件**：对应的 `Harness/sessions` 目录目前只有 `~locks`／`~delete` 子目录，没有 `session.jsonl.zstd` 文件。因此当前磁盘证据能证明曾存在 projection-cache 记录，但没有这些记录可回放的事件日志。这是需要调查的重要恢复缺口，并不能证明删除操作有误。
3. **隔离候选 runtime** `/Users/hui/ark-test/candidate-home-2026092701`：有两份合成 JSONL/Zstandard 日志（约 1.6 MiB 和 48 KiB）及两条 projection row；`Knowledge/wiki` 只有 `index.md` 和 `log.md`，没有生成的候选页面。`/Users/hui/ark/releases/2026092701/evidence/provider-live-v3.jsonl` 中的 provider 日志显示监听中的合成 provider 收到了流式 `ARK_SYNTH_BURST` 请求；`/Users/hui/ark/releases/2026092701/REPORT.md` 记录 19,993-event／169-event 合成 Session 回放和最终 UI/provider 标记。这些是合成可靠性证据，不能证明 Knowledge Wiki 写入或自动召回。
4. **候选 Ark 实时 smoke（2026-10-08）** `/Users/hui/ark-test/candidate-20261008/Ark.app` 使用隔离 home `/Users/hui/ark-test/candidate-home-20261008` 运行。带认证的 loopback `knowledgeWiki/search` 返回预置候选页面，carrier/domain 结果正确。这证明候选 Ark 原生 TypeScript 路径可在隔离数据上工作。回执明确记录 `mode: typescript-authoritative`、`rustShadowInvoked: false`：原生路由没有调用模型／工具 Rust 路径，而且该候选 home 未配置模型。因此这不是 Rust 性能或正式验收结果。回执：`/Users/hui/ark-test/candidate-ark-20261008-live-baseline.json`。
5. **候选 Ark 模型／工具 shadow smoke（2026-10-08）** 同一候选 app 使用本地 DeepSeek 兼容 mock SSE provider 和独立隔离 home，受治理的 event log 绑定到了对应 project 路径。真实 `wiki_search` 工具调用了 Rust wrapper；wrapper 以 `0` 退出，返回两条预置命中，请求摘要和独立 TypeScript BM25 结果摘要都逐字节一致。修正后的回执为 `/Users/hui/ark-test/candidate-ark-20261008-rust-model-shadow-smoke-scoped.json`；源码提交为 `9563cbe8801c847ac51a376929bc8cdc149d37ac`；Rust binary SHA-256 为 `6c35da217bb5f5b207e10a38f1d8cdbe805ab43746b06500c25791bd94bd81fa`。这次 smoke 证明候选路径被调用且结果一致，不证明有提速。

## Drift and required follow-up

- 旧文档声称每个 turn 都会创建 conversation/profile/reflection 条目、每个模型 step 都会召回这些内容；源码和 runtime 产物与此相矛盾，标记为 **DRIFT: confirmed**。
- Review 已实现并挂载，但基线正式组合没有提供独立 verifier authority（只有测试中提供）。在该 owner 完成组合前，release profile 没有已验证的晋级路径。Candidate lifecycle、project audit、Session 检索／注入事件已经实现；逐 step 通用自动 recall 未启用。标记为 **PARTIAL / VERIFIER BLOCKED**。
- Session 持久化使用 JSONL 和 projection cache；SQLite query search 有意保持关闭。标记为 **CONFIRMED**；在 `openAt` 配置改变前，不要把 SQLite search 当作活动路径进行基准测试。
- 合成 provider 日志和正式 projection counter 中有模型请求相关证据，但没有捕获的 request payload 能证明 Wiki 内容注入。对于“每个模型 step 都注入知识”，标记为 **NOT VERIFIED**。
- 保留 replay 测试；只有结果由独立验证的配对样本支持后，才运行 learning evaluator 并讨论 utility 或智能水平提升。独立验证和 review 完成前，候选知识不得提升到 canonical trust。

<a id="当前-rust-候选路径"></a>

## 源码快照中的 Rust 候选路径

当前工作树在 `KnowledgeWikiService` 中提供可选且默认关闭的 Rust search 候选。Shadow 模式只观察：它将有界、不可变的页面／query DTO 发送到隔离子进程，校验输入和结果 digest 以及 canonical BM25 是否一致，并保留 TypeScript 结果。候选失败、取消、超时或结果分歧时会回退到 TypeScript。Rust 尚未覆盖完整的 hybrid BM25＋embedding 契约，因此 Enforce 模式会被明确拒绝。该路径可在候选 profile 中测试，但活动 Ark profile 仍只使用 TypeScript；缺少生产边界回执时，验收审计仍为 `UNKNOWN`。


Rust 内核会在一次请求的 query batch 中复用预建 BM25 index。维护的三轮基准每轮有 30 个样本；维护的每次回放中 TypeScript 与 Rust 结果 digest 均一致，独立差分回放也完全相同。对 Ark `modelSearch` 的基于文件、单 query 路径，新建 Rust 子进程 IPC p50 为 16.953–17.466 ms，current TypeScript 为 10.653–10.865 ms，每个样本重建索引的优化 TypeScript 为 9.097–9.259 ms。因此 Rust 在此生产形态路径上比 current TypeScript 慢约 59–62%，比优化 TypeScript 慢约 86–90%；生产决策仍为 `RETAIN_TS`，Rust enforcement 继续关闭。另一个内存五 query batch 中，Rust 为 7.253–7.285 ms，current TypeScript 为 12.113–12.197 ms；但重建索引的优化 TypeScript 为 2.983–3.016 ms，热索引 TypeScript 为 0.508–0.513 ms，因此该 batch 不代表 Ark 的单 query 调用形态。以上合成结果不能证明生产语料或长时间运行性能。跨平台运行、常驻 worker 生命周期、子进程 CPU/RSS、取消和崩溃恢复都未测量。详见[可重复性回执](../../scripts/rust-migration/knowledge-search-benchmark-repeatability-20261010.json)、[差分回放回执](../../scripts/rust-migration/knowledge-search-differential-replay-20261010.json)和[Rust 候选矩阵](rust-candidate-matrix.zh.md#current-benchmark-snapshot--2026-10-10)。

工作树还包含由 launcher 管理、返回签名子进程结果和 promotion seal 的外部 verifier adapter。它通过受管理的 `ctx.subprocess` owner 运行、限制输出，并在返回前等待整个进程树退出。profile 只暴露由 launcher 持有的 `knowledgeVerifierConfig` 配置入口，当前值为空；因此当前产品明确无法执行候选验证。隔离 fixture 验证配置绑定和进程清理，但不声称通过正式验收。

## 以往候选的路由证据 — 2026-10-10

Ark 3.1.13 候选配置为 `gpt-6-luna`、推理强度 `max`。只读设置快照声明了 `max`，并将 `openai` provider 路由到自定义 OpenAI 兼容主机。较早的本地 `UNSUPPORTED_REASONING_EFFORT` 会话早于该设置快照；之后一项已到达 provider 的请求使用 `gpt-6-luna/max`，返回 HTTP 404 `model_not_found`。OpenAI 的[官方 API 模型页面](https://developers.openai.com/api/docs/models/gpt-6-luna)列明该模型支持 `max`，因此这次失败来自已配置的自定义 endpoint／账号路由；但已保存凭据是否能用于 OpenAI 官方 endpoint 仍未知。两次请求都没有产生助手文本，也都不计入语义、完整答复或学习验收。当时切换 endpoint 会把已保存凭据发送给另一台主机，因此仅隔离候选的切换操作当时等待用户明确选择；当时没有修改候选或正式 profile。

[候选持久会话审计](../../scripts/rust-migration/candidate-session-audit-20261010.json)确认，原发票任务 prompt 曾在目标 Workspace 的两个会话中提交，但都没有产生助手文本：一个 provider 请求以 `model_not_found` 结束，另一个在发出 provider 请求前因 `max` 推理强度不受支持而被拒绝。3.1.13 候选的项目级 Wiki journal 含有五条 `knowledge/injected` 记录，但只保存项目／可见性范围、路径和内容 hash；它没有 Session ID 或渲染后的工具值。两个失败的 Session 日志都没有 session 级 Wiki 检索或注入事件，所以这些 journal 行不能证明 session recall 或回放。

当前源码会在调用方 Session 中记录 `knowledge/retrieved` 和 `knowledge/injected`，包括 Session ID 和精确渲染的工具结果。定向工具套件覆盖搜索、文件列表、页面读取、图谱和 review 结果；它通过默认 Zstandard JSONL backend 写入检索／注入事件，释放 writer，再用全新的 persistence context 冷加载，通过 `Session.fromRestore` 恢复，并逐项比较事件、范围、来源记录和渲染后的工具值。全部 19 项工具测试通过；[机器可读回放回执](../../scripts/rust-migration/knowledge-session-event-zstd-all-tools-replay-20261010.json)把结果绑定到测试源码文件。这证明五类 Wiki 工具结果可在本地持久回放，但不证明跨会话复用、效用提升或候选实时行为。3.1.15 和 3.1.16 候选打包了相同 runtime 源码快照；3.1.16 安装态 E2E 在两次进程运行中通过 121 项检查、失败 0 项。它在目标发票 Workspace 中发起的全新只读 GPT-6 Luna/max 任务，在任何助手答复或工具调用前返回 `API credentials rejected · AUTH`。这些源码测试和安装结果没有证明实时知识行为。3.1.16 的机器证据位于 `/Users/hui/ark-test/evidence/current-source-candidate-3.1.16-20261010.json`。

### Ark 3.1.22 候选结果与 Knowledge 边界 — 2026-10-10

隔离的 3.1.22 候选在两次进程运行中通过 121 项安装态 E2E 检查。三次全新只读发票对话都生成完整的五键 JSON，并与独立精确算术 oracle 相符（approved 为 6，pending 为 1，拒绝 `I007`／`I008`，总额为 26,598 美分）；最终答复面板的结构与算术通过 3/3。但其中两轮在任务运行中出现旁白，所以严格的“整轮只输出 JSON”显示要求仍有 2/3 失败。该候选发票任务的中位耗时为 15.135 秒；3.1.21 为 14.4 秒（每个候选仅三个样本），样本太少，不能宣称速度变化稳定。这些任务没有测试 Knowledge 修正或跨对话复用，活动 profile 的 verifier authority 仍不可用。

另一项合成只读范围探测选中 Workspace B，并确认 `pwd` 位于该目录；随后仍能通过绝对路径读取 Workspace A 中的 canary，没有观察到写入。这符合当前 `fs-sandbox` 契约：所有模式都允许读取，只读模式只拒绝变更。因此，所选 Workspace 并非文件系统读取边界。单次未签名探测不能证明 verifier 管理的跨会话 Knowledge 泄漏，但也不能支持读取隔离声明。参见[3.1.22 实时发票回执](../../scripts/rust-migration/candidate322-live-invoice-20261010.json)和[范围探测回执](../../scripts/rust-migration/candidate322-cross-workspace-isolation-20261010.json)。

### 修正修复源码变更 — 2026-10-10

`wiki_propose_repair` 工具接受用户纠正过的已验证 Wiki 页面提案。它要求同一对话中有完整、未截断的 `wiki_read`；service 还要求并消费一次性、进程内 capability，该 capability 绑定当前 project、Session、路径和源内容 hash，15 分钟后过期，且内容仍受 8000 字符限制。提交不可信且绑定 hash 的 Candidate 前，旧记录会先被拒绝。一个真实 Loader composition 测试将修正后的规则依次通过独立 verifier 回执、明确的 Replace resolution 和全新 Session 检索。定向 service、tool 和真实 composition 测试通过 40/40。

这证明了测试 fixture 中受门控的源码路径和 review 状态转换，却不能证明 Ark 实时学习：3.1.16 候选包含相同 runtime 快照，但其 GPT-6 Luna/max 请求在任何助手答复前被 `AUTH` 拒绝。正式 Ark 安装没有被替换，该源码快照也没有上传；验收审计仍为 `UNKNOWN`。

目前没有由独立可信 evaluator 签名的 GPT-6 Luna 基线／候选配对结果，也没有全新对话重复结果。学习归约器现在要求规范 Ed25519 attestations，并会因任何已测质量退化而阻止 `SUPPORTED`；受信任公钥必须从结果文件之外配置。因此，修正迁移、重复错误下降、智能提升和知识复用都尚未测量；治理和检索事件的单测通过并不证明这些用户可见结果。不同的源码和安装状态记录于[source-truth 报告](source-truth-report.zh.md#observation-snapshot--2026-10-10)。

### Ark 3.1.19 候选的 Workspace 范围失败基线 — 2026-10-10

Ark 3.1.19 使用 `deepseek-official/deepseek-v4-flash/max` 完成了发票任务；五键答案与根据任务 CSV 独立执行的 `Fraction` 计算相符。持久化 Session 的 CWD 是候选的 `Default Workspace`，而不是 UI 显示的发票 Workspace；发票 Workspace registry 也没有该 Session ID。模型调用了 11 次 Bash，其中包括对 `/Users/hui/ark-test` 的宽范围搜索，并读取了 `Knowledge/purpose.md`、`schema.md` 和 `wiki/index.md`。没有观察到写入或最终答案泄漏。这些 Knowledge 页面在任务项目之外，也没有被独立验证为任务证据，所以本次运行不能证明正确复用 Knowledge、学习效用或范围隔离。native composer 会在 Host 所有权或 CWD 与所选 Workspace 不一致时阻止首次 prompt 派发；此检查不会在只读模式下限制读取范围。必须用重建后的候选确认实时行为。参见[3.1.19 审计回执](/Users/hui/ark-test/evidence/candidate-3.1.19-deepseek-v4-flash-output-audit-20261010.json)。

### Ark 3.1.20 的实时 Knowledge 与 Workspace 结果 — 2026-10-10

3.1.20 的只读发票任务使用了所选 Workspace，持久化 Session 的 CWD 和 Workspace registry 条目相符。它读取两份 fixture CSV，返回的最终 JSON 对象与独立精确有理数计算一致；有一项行内计算最初差 2 美分，并在同一轮中修正。Wiki search 工具报告 `knowledge verifier authority is unavailable`，所以发票答复正确并不证明检索到了已验证知识。同一候选的第二个全新对话再次绑定到所选 Workspace，并返回相同精确有理数结果和合法五键 JSON。该轮读取了两份 CSV 以及项目的 `purpose.md` 和 `schema.md`；持久化记录中没有写入／编辑调用，也没有最终答复以外的助手纯文本消息。UI 上独立的进程卡片使整轮 JSON-only 验收仍无法判定。两次 Wiki 搜索都因没有配置 verifier authority 而失败。这两份匹配的最终答复不能证明持久化修正迁移、效用提升、重复错误减少或文件系统读取隔离。15.266 秒和 19.044 秒只是两个任务样本，不能证明提速。参见[首次实时审计回执](/Users/hui/ark-test/evidence/candidate320-deepseek-v4-flash-output-audit-20261010.json)和[重复审计回执](../../scripts/rust-migration/candidate320-repeat-live-audit-20261010.json)。

### 效用结果回放门控 — 2026-10-10

`recordKnowledgeOutcome()` 只允许在项目 hash-chain journal 中存在该页面尚未消费的 retrieval 时记录非中性 outcome。它会将 retrieval、success 和 correction 计数与 JSON projection 对账，避免在 projection 写入中断后重放旧 outcome 而虚增效用。只有同一 Session 读过已验证源内容并消费一次性 source-hash capability 后，`wiki_propose_repair` 才会记录修正 outcome。在下一次面向模型的查询前，若已验证记录至少被检索三次且 utility 不大于零，`modelRecords()` 就会追加 `knowledge/expired`；待审候选保持不变。service-surface 回归确认过期事件已持久化，并阻止后续搜索和页面读取。这些机制不会认证主观成功报告，也不证明实测效用提升。

### 修正反馈来源门控 — 2026-10-10

修复路径现在会在消费 source-read capability 前，读取已通过回放验证的 SessionQuery 记录。只有 Session CWD 解析到项目根目录、同一 turn 中有直接用户消息，并且最近一次 `wiki_propose_repair` tool call 的源路径、标题和修正规则都与 service 提案完全一致时，操作才可通过。修正规则还必须在 NFC 和空白归一化后出现在该用户消息中。Service 回归会拒绝模型生成的文本、被改动的 tool 参数和不匹配的 CWD；验证页面读取后，则允许符合条件的直接用户修正。定向 service、tool 和 canonical-composition 套件通过 42/42；Knowledge Wiki 和工具包完整测试共 76 个文件、687 项通过；ACP snapshot 通过 16/16；Knowledge Wiki typecheck 通过。这仅证明测试中的受门控源码行为。没有当前 Ark 候选是根据此改动重建或进行实时测试的，因此不能据此证明持久化修正复用或实测效用提升。

### Ark 3.1.21 发票重复测试 — 2026-10-10

重建的 3.1.21 候选通过安装态 E2E，并在 DeepSeek V4 Flash/max 上完成三次全新的只读发票对话。三份最终 JSON 都符合独立精确有理数 oracle。其中一轮在 JSON 前显示了英文助手旁白，因此整轮严格 JSON-only 输出仍失败。发票任务没有调用 Wiki 修复或过期路径，也没有验证修正来源、verifier authority 或跨对话复用；这些仍只是源码测试结果。没有进行晋级或 GitHub 发布。参见[3.1.21 实时发票回执](/Users/hui/ark-test/evidence/candidate321-live-invoice-20261010.json)。

<a id="ark-3123-live-candidate-and-output-result--2026-10-11"></a>

### Ark 3.1.23 实时候选与输出结果 — 2026-10-11

隔离的 3.1.23 候选在预期 Workspace 中使用 `deepseek-official / deepseek-v4-flash / max` 完成三次全新的只读发票对话。根据任务 CSV 独立执行精确有理数计算，三次结果都一致：6 行有效 approved、1 行 pending、拒绝 `I007` 和 `I008`，总计 26,598 美分。事件级审计从每条持久化助手消息中解析面向用户的最终 `text` 部分；三条都是含预期五个键和值的合法 JSON 对象。空白格式不同，但解析后的对象相同。三个已完成答复面板都没有助手前言。一张运行中截图显示工具进度且未显示助手旁白；另两轮只在完成后截图。候选 `settings.yaml` 含 `jsonOutput: true`，打包的 serializer 也有条件式 `response_format: { type: 'json_object' }` 分支；由于未捕获实际 provider 请求体，不能证明实时请求确实带有该字段。

观察到的任务耗时为 13.7、16.3 和 19.8 秒，中位数 16.3 秒；3.1.22 同题三次的中位数是 15.135 秒。3.1.23 候选在小样本中慢 1.165 秒／7.7%；这既不能证明稳定退化，也不能证明提速。结果没有测量 Rust 内核。有一条扩展 Wiki trace 返回 `knowledge verifier authority is unavailable`；实时 Jiuzhang runtime 没有活动 verifier authority。只读审计解码了三个 Session 文件中全部串接的 Zstandard 帧（78、87、104 帧；分别有 163、180、191 条存储记录）。由 package 管理的 `JsonlSessionPersistence.inspect` 分别读取了 2,553、2,681 和 3,205 条逻辑事件，其中每轮有一条 `turn/end` 和最终 JSON 文本。正常退出并重启候选后，UI 无需重新提交就恢复了第三个对话和最终答复；日志在 sequence 3,204 处包含预期的 `session/end-seed` 边界。这只验证了一条正常进程重启／UI 恢复路径，不代表崩溃恢复、长时间稳定性或 verifier 管理的 Knowledge 回放。[机器可读的实时回执](../../scripts/rust-migration/candidate323-live-invoice-20261011.json)关联了 prompt hash、Session ID、截图、Session 日志 hash 和安装回执。

安装态 E2E 在两次进程运行中通过 121 项检查、失败为 0。这是安装／启动回归结果，不是长时间运行或压力可靠性的量化提升。这些发票任务没有测试修正迁移、过期、已验证 Knowledge 复用或效用提升。实时观察未经签名，不满足 Phase 6 验收；正式 Ark app 未更改。

### 外部 verifier 进程生命周期测试 — 2026-10-11

在 macOS arm64、Node 24.19.0 上，对检出源码运行 `external-verifier-adapter.spec.ts`，7/7 项通过。测试生成临时 Ed25519 fixture，并使用受管理的子进程，覆盖请求绑定签名、晋级 seal、无效结果、超时、取消、格式错误和非零退出码、stdout/stderr 上限，以及在成功结果返回前等待受管理的整个进程树退出。输出超限场景还确认其子进程 helper 已退出。这仅是源码测试证据：fixture 密钥是临时的，活动 Jiuzhang runtime 仍报告 Knowledge verifier authority 不可用，该套件也未验证候选学习行为或 Phase 6 验收。[生命周期测试回执](../../scripts/rust-migration/external-verifier-adapter-lifecycle-20261011.json)绑定了测试源码和 spec hash。

### Native verifier 环境转发与 subprocess 清理 — 2026-10-11

Native Jiuzhang launcher 现在只会在固定的子进程环境边界转发专用的 `ARK_KNOWLEDGE_VERIFIER_CONFIG`。共享 subprocess 环境清理会从普通模型可调用的 shell、terminal 和 MCP 子进程中移除该变量，因为它的 JSON payload 可能含有私有签名密钥。定向 subprocess 测试通过 88/88，Jiuzhang Node 套件通过 97/97，native shell contract 可执行文件触达全部 53/53 组并报告成功。这只关闭了源码层面的传输和 secret 边界缺口。实时 profile 仍未配置 verifier authority，且运行中的 Ark 3.1.23 候选早于本次源码修复；没有因此证明候选学习、速度、稳定性或 Phase 6 有提升。参见[仅源码的回归回执](../../scripts/rust-migration/native-verifier-config-forwarding-20261011.json)。

### 页面读取面的 verifier 失败关闭回归 — 2026-10-11

Service-surface 回归重现了一个缺口：可信 verifier 不可用时，通用 `search` 和 `pageContent` 仍会回放 hash 有效的 journal，却不认证 `knowledge/verified` 和 `knowledge/promoted` seal；面向模型的 search/read 方法则已通过必需 authority 门控拒绝同一状态。现在页面读取路径共用一个 guard：只要存在已签名的生命周期事件而 verifier 不可用，就失败关闭。空 journal 或无签名 journal 保持原有行为。回归同时通过 service 测试和真实 Knowledge Wiki Cordis Loader composition，其中包括面向模型的 `wiki_read` 错误场景。受影响的两个测试文件共通过 24/24 项；两个 package typecheck 均通过。该源码修复没有更改运行中的 3.1.23 候选，也没有提供缺失的生产 verifier；必须先组合可信 authority，已签名 Wiki 记录才能变为可用。

### 每个 Wiki 根目录复用搜索索引 — 2026-10-11

当前 TypeScript service 通过 `WikiSnapshotStore`，为每个 Wiki 根目录只准备一次 BM25 索引；写入和外部文件 watcher 事件会使该根目录的派生 snapshot 失效，排序后仍会对每个请求执行 verifier／ACL 检查。在一份 240 页合成 Wiki 上，三个独立运行各测量 30 个五 query 批次；热批次 p50／p95／p99 从索引复用前的 48.988／53.216／54.600 ms 降至 0.559／0.696／1.528 ms，降幅为 98.86%／98.69%／97.20%。父进程 CPU 降低 98.95%；冷索引构建中位数为 9.496 ms，首个五 query 批次中位数为 11.758 ms。结果一致性和显式写入失效检查均通过 3/3，每个热批次只构建一次索引。这是源码基准，不代表 Ark 实时或生产 Wiki 延迟，也不建立总体稳定性百分比。参见[当前源码绑定回执](../../scripts/rust-migration/knowledge-search-index-cache-current-20261011.json)，其中记录 benchmark、search 和 snapshot store 的 hash。

### 缓存单 query 对照 — 2026-10-11

可复现的[基于文件的单 query 对照](../../scripts/rust-migration/knowledge-search-cache-vs-rust-reproduction-20261011.json)在同一份 240 页合成 Wiki 上运行三轮独立 30 样本测试。p50／p95／p99 中位数为：每次重读文件并重建索引的 TypeScript 10.109／11.072／11.577 ms；从已解析页面重建索引的优化 TypeScript 2.172／3.024／4.048 ms；生产 `WikiSnapshotStore.get` 热命中加评分 0.095／0.127／0.195 ms；新建子进程 Rust IPC 6.631／6.881／7.032 ms；仅供基准使用的常驻 Rust worker 4.079／4.595／5.554 ms。生产索引未命中耗时为 11.126–12.902 ms。三轮字节级差分均一致，所有 Rust worker 都正常退出。Rust 只比每次重读文件的 TypeScript 路径快，仍慢于优化 TypeScript 和生产热路径，而且每个 query 都要传输页面记录。1 ms 直方图分辨率下，当前 TypeScript、重建索引 TypeScript、热缓存、新建 Rust 子进程、常驻 Rust 的 event-loop delay p95 依次为 12.403／2.517／1.020／6.885／1.596 ms；样本数不均（29／29／3／29／93），只能作为诊断值。Rust 子进程 CPU／RSS 未计入总量。这些耗时不包括模型／provider 延迟、embeddings、verifier／ACL 和真实 Wiki 数据，不能证明 Ark 端到端提速或 runtime 稳定性。Rust profile 仍禁用，生产决策继续为 `RETAIN_TS`。

### Ark 3.1.24 实时任务与 verifier 边界 — 2026-10-11

Ark 3.1.24/build `2026101124` 在两次进程运行中通过 121 项安装态 E2E 检查，失败为 0。`deepseek-official / deepseek-v4-flash / max` 下三次全新的只读发票 Session 都返回与精确有理数 oracle 一致的严格 JSON，结果为 3/3。任务耗时中位数是 13.895 秒；3.1.23 同题中位数是 16.286 秒。每个候选各运行三次，观察到中位耗时降低 2.391 秒／14.68%。两版的严格 JSON 和算术都通过 3/3，因此 fixture 没有显示任务成功率提升；该计时也不能证明存在因果或普遍的 Ark 提速。

Ark 3.1.24 候选包含 Native verifier 配置转发源码修复，但直接检查进程发现 Ark app、runtime 和 API runner 都没有 `ARK_KNOWLEDGE_VERIFIER_CONFIG`。发票任务没有调用 Wiki 检索工具，因此本次测试没有覆盖 verifier 管理的学习、修复迁移、过期、效用提升或 Knowledge 回放。Phase 6 的 16 项行为检查仍全部为 `UNKNOWN`；压力测试、崩溃恢复和长时间可靠性仍未测量。参见[实时任务回执](../../scripts/rust-migration/candidate324-live-invoice-20261011.json)、[verifier 进程回执](../../scripts/rust-migration/candidate324-verifier-runtime-20261011.json)和[安装态 E2E 回执](../../scripts/rust-migration/candidate324-installed-e2e-20261011.json)。

### 无配对成功反馈门控 — 2026-10-11

Service 现在拒绝单独的成功反馈参与效用记账：`recordKnowledgeOutcome()` 对 `successful` 返回零，生命周期回放只将这类事件保留为审计数据，`knowledgeUtility()` 从事件 journal 派生 retrieval／correction 计数，并报告零次 successful uses。Observation 和 semantic-verification 状态转换会清除继承计数，因此候选 metadata 或语义回执不能把效用带入 verified knowledge。定向 service 和治理回归通过 38/38。这是源码层面失败关闭的规则；正向效用仍要求认证的配对试用回执，但目前没有配置其 authority 和 artifact resolver。

### 面向模型 Wiki 工具的规范内容门控 — 2026-10-11

此前，普通模型内容读取路径会接纳任意有效 verifier 签名的 `verified` 记录，即使其生命周期仍是 `candidate`。现在源码要求 `modelSearch`、`modelPageContent`、`modelList`、`modelGraph` 和 `proposeKnowledgeRepair` 使用的源读取都满足 `lifecycle: canonical`，同时保留既有的 signed-verifier、scope、ACL、过期、冲突、confidence 和 utility 门控。Candidate review metadata 仍走独立 governance 路径；候选页面正文既不会产生 retrieval event，也不会产生 injection event。

一项回归提供了只有 `knowledge/verified`、没有 `knowledge/promoted` 的完整签名记录，确认该记录不会出现在普通 search/read/list/graph 中，也不能授权 repair source；已有的规范签名记录仍可读取。较早的门控回执记载 Wiki/tools 测试通过 684 项；之后重新运行全部 76 个文件，通过 693 项，两个 package typecheck 也都通过。语义验证不能证明观察到任务复用或效用，因此在没有独立 measured-trial receipt reader 时，Promote、Merge、Replace 和 Deduplicate 都返回 false。Archive 仍可通过认证 WAL 和恢复路径使用；仅有语义验证的预备 canonical journal 会回滚。Measured-trial denial 回归通过，`git diff --check` 也通过。参见[规范内容门控回执](../../scripts/rust-migration/knowledge-canonical-content-gate-20261011.json)和[实测试用拒绝回执](../../scripts/rust-migration/knowledge-measured-trial-gate-20261011.json)。

Ark 3.1.24/build `2026101124` 候选包不含这些源码变更。`2026-10-10T23:38:18Z` 的本机进程扫描未发现候选 app、runtime 或 API runner 进程；app bundle 仍在候选槽。源码测试不能推出候选已重建、实时行为已验证、正式版已发布或 GitHub 已收到内容。记录中的 3.1.24 启动也没有 verifier authority，独立 Knowledge 复用仍未测试。参见[最新本机进程观察](../../scripts/rust-migration/candidate324-process-observation-20261011.json)。

### 以执行对象绑定 Wiki 来源信息 — 2026-10-11

以前 Wiki 工具根据模型提供的 `callId` 暂存 retrieval 来源信息。并发 Session 可能重复使用 call ID，造成一个 Session 的来源信息被附到另一个 Session 的渲染注入事件上。现在交接按 registry 拥有的 `ToolExecution` object 绑定；同一个执行对象也会交给最终 `tools/result` observer，并会在检索时捕获所属 `Session` 和 scope。一项 barrier 回归并发运行两次使用相同 ID 的调用，确认来源信息仍属于各自 Session；另一项测试在发布结果前更改 Agent 的 Session，确认进行中的结果仍绑定原 Session。Wiki tool 单元和 Loader composition 套件共通过 22/22 项；package typecheck 通过，doc-sync 通过 30/30。以上只证明检出源码。Ark 3.1.24 的打包模块早于此修复，因此候选行为、实时 Knowledge 复用和 Phase 6 验收仍未验证。参见[机器可读源码回执](../../scripts/rust-migration/wiki-tool-provenance-binding-20261011.json)。

### 语义验证后的 review 操作门控 — 2026-10-11

候选通过语义验证后，review options 现在只暴露 `Archive`，包括旧持久化 review row 仍含有 canonical 操作的情况。独立、认证的配对实测试用回执读取器建立前，Promote、Merge、Replace 和 Deduplicate 仍会隐藏，直接调用也会失败关闭；正确性签名本身不能证明真实任务复用或效用。三个定向的 lifecycle、verification 和真实 Cordis Loader 测试文件通过 67/67 项；两个 Knowledge Wiki package typecheck 通过。这些只是检出源码的证据；Ark 3.1.24 尚未包含此更改，也没有已验证的实时测量复用。参见[机器可读 review 门控回执](../../scripts/rust-migration/canonical-review-options-20261011.json)。

当前工作树还包含带有子进程签名结果和晋级 seal 的 launcher-owned external verifier adapter。profile 只暴露 launcher-owned 的 `knowledgeVerifierConfig` 接缝，活动值为空，因此当前产品的 candidate verification 仍明确不可用；隔离 service fixture 已证明子进程绑定路径，但不宣称 production acceptance。

### Ark 3.1.25 实时观察与 3.1.26 暂存候选 — 2026-10-11

Ark 3.1.25/build `2026101125` 通过暂存和安装态 E2E 回执（各 121 项；安装态运行包含两次进程启动，失败为 0）。一项只读实时发票任务得出了正确的精确有理数结果：批准 6 张、待处理 1 张、拒绝行 I007/I008、总计 26,598 美分。持久化的原始 assistant 消息可解析为严格 ASCII JSON，但界面显示把直引号变成了弯引号，因此违反严格 JSON 输出约束。这是实际呈现失败，不能算通过。源码现已关闭 Markdown 智能标点并逐字呈现模型字符串；Native 合同检查通过 53/53 组，Jiuzhang Node 阶段通过 97/97。修复后的 UI 尚未在重建候选中完成实时复测。该候选没有可用的 Wiki verifier authority，因此这项任务没有测试经验证的 Knowledge 复用。

Ark 3.1.26/build `2026101126` 是单独签名的暂存应用。静态检查和严格深度代码签名验证通过；安装态 E2E 在两次进程运行中通过 121 项，失败为 0。记录这项结果时 3.1.25 候选仍在运行，因此 3.1.26 尚未切换到唯一候选槽，也没有实时 UI／模型回归结果。本地 CI 为部分通过：调整一项受资源影响的测试超时后，重型覆盖门禁通过；严格覆盖门禁仍因 `packages/host/knowledge-wiki/src/reviews.ts` 的单文件阈值失败，因为认证实测回执尚未接入，canonical review 路径仍保持失败关闭。GitHub 检查来自 2026-10-08，早于当前未提交工作树且包含失败，不能代表这些本地改动已通过远端 CI。

正式 Ark 仍为 3.1.0/build `2026092701`，未改动；没有发布到 GitHub，也没有晋级。Phase 6 审计仍为 0 项 `PASS`／16 项 `UNKNOWN`；暂存应用和源码回归不能关闭行为验收。参见 [3.1.25 实时任务观察](../../scripts/rust-migration/candidate325-live-invoice-20261011.json)、[3.1.26 构建安装回执](../../scripts/rust-migration/candidate326-build-and-staged-install-20261011.json)、[3.1.26 安装态回执](../../scripts/rust-migration/candidate326-staged-install-e2e-20261011.json) 和[本地 CI 回执](../../scripts/rust-migration/candidate326-source-ci-local-20261011.json)。

<a id="当前源码的实测试用读取器接线--2026-10-11"></a>

### 实测试用读取器接线源码观察 — 2026-10-11

当前源码现在接受一个可选的、由 launcher 所有的 `knowledgeWikiMeasuredTrialReader`，并增加 `recordCandidateMeasuredTrial` RPC。它会把经过认证、内容寻址的试用结果绑定到独立的试用 authority、语义 verifier 回执、精确的 review 与候选操作，以及当前目标字节。只有该操作对应的 utility 结果为正时，才会开放对应的规范 review 操作；有效试验若没有正向提升，仍只开放 Archive。Review 提交会写入认证回执中冻结的原始字节；sealed journal 和崩溃恢复路径会再次校验试验及目标 hash。缺失、不匹配、过期或未授权的回执都会失败关闭；现有 `resolveReview(s)` RPC 形状保持兼容。

定向回归通过 71/71 项。Wiki/tools 整包此前通过 78 个文件／717 项，Knowledge Wiki 与 Wiki tools 两个 package typecheck 均通过。这只能证明源码测试行为，不能证明实时学习或实际提升。Jiuzhang launcher 现在会把专用公钥与 artifact-root 变量映射到 measured-trial reader，但活动环境没有传入受信值，因此 Ark 中的规范 Promote、Merge、Replace 和 Deduplicate 仍不可用。新增配置与文件 resolver 回归通过 34/34 项；Jiuzhang Node runtime 测试通过 24/24 项；接入后重新运行全部 Wiki/tools 套件，通过 78 个文件／719 项。正在运行的候选是 3.1.25/build `2026101125`；暂存的 3.1.26/build `2026101126` 早于本次改动，尚未激活，也未用本次改动测试。正式 Ark 仍为 3.1.0/build `2026092701`；没有更新 GitHub 或晋级。Phase 6 仍为 0 项 PASS／16 项 UNKNOWN。源码接线见 [reviews.ts](../../packages/host/knowledge-wiki/src/reviews.ts)、[index.ts](../../packages/host/knowledge-wiki/src/index.ts) 和 [verification.spec.ts](../../packages/host/knowledge-wiki/tests/verification.spec.ts)。
