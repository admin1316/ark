# Rust 候选矩阵

[English](rust-candidate-matrix.md) | 中文

本文记录根据当前检出源码作出的 Rust 迁移决策，供规划和审查使用；它不会启用 Rust provider，也不会更改现有 wire contract。

## 源码证据

2026-10-07 使用 `git ls-tree` 检查时，source-truth 基线 `b8adf5a7ec9c22c3f1c7958821af825bd7821d7a` 和 GitHub `origin/main` 上的 `d382723905742f2b87401ad444d02756f5cb229b` 都没有 `Cargo.toml` 或 Rust 源文件（`*.rs`）。此后，当前工作树新增了隔离的非生产 shadow crate：[`rust/knowledge-search-shadow`](../../rust/knowledge-search-shadow)。现有 native 实现是一个小型 C11 Landlock launcher，位于[`native/landlock-run/packages/entry/src/main.c`](../../native/landlock-run/packages/entry/src/main.c)，并通过 TypeScript 入口模块[`native/landlock-run/packages/entry/src/index.ts`](../../native/landlock-run/packages/entry/src/index.ts)暴露。它的契约是启动进程并探测文件系统隔离，因此不属于下文的 Rust 内核候选。

知识内核仍由进程内 TypeScript 实现：BM25、分词和余弦相似度位于[`packages/host/knowledge-wiki/src/search.ts`](../../packages/host/knowledge-wiki/src/search.ts)；图遍历和 Louvain 社区发现位于[`packages/host/knowledge-wiki/src/graph.ts`](../../packages/host/knowledge-wiki/src/graph.ts)。当前工作树包含确定性的优化 TypeScript 对照实现[`scripts/rust-migration/benchmark-knowledge-search.ts`](../../scripts/rust-migration/benchmark-knowledge-search.ts)、隔离的 Rust shadow 回放[`scripts/rust-migration/differential-replay.ts`](../../scripts/rust-migration/differential-replay.ts)，以及默认关闭的生产候选 seam [`packages/host/knowledge-wiki/src/rust-search-candidate.ts`](../../packages/host/knowledge-wiki/src/rust-search-candidate.ts)。这些内核仍没有生产 N-API provider 或 enforced Rust owner。

取消和子进程恢复仍由现有 TypeScript runtime 管理。[`packages/subprocess/subprocess-local`](../../packages/subprocess/subprocess-local) 通过 `AbortSignal` 终止受管理的进程组；[`packages/jobs/jobs-local`](../../packages/jobs/jobs-local) 拥有任务取消和清理流程。迁移边界必须保留这些既有 owner。

## 候选决策

| 候选模块 | 当前 owner | Rust 边界 | 证据状态 | 决策 |
| --- | --- | --- | --- | --- |
| 分词和 BM25 评分 | `knowledge-wiki/search.ts` | 不可变 UTF-8 请求字节和页面记录；确定性结果字节 | 优化后的 TypeScript 和隔离 Rust shadow 在确定性语料上结果一致；尚无真实边界或端到端回放 | **RETAIN_TS** |
| 余弦相似度 | `knowledge-wiki/search.ts` | 不可变数值向量；确定性分数 | 尚无优化 TypeScript 或 Rust 实现；启用时，embedding 调用是混合搜索的主要开销 | **RETAIN_TS** |
| Wiki 图派生和 Louvain | `knowledge-wiki/graph.ts` | 不可变页面／边记录；确定性图结果 | 尚无优化 TypeScript 或 Rust 实现；文件遍历和图语义还需要回放语料 | **RETAIN_TS** |
| 增量搜索或图索引 | 没有独立索引 owner；搜索和图派生都从 Wiki 树重建 | 带 generation 和 checksum 的版本化规范索引字节 | 尚无索引格式或重建／恢复契约 | **DEFER** |
| JSONL 或压缩帧扫描 | Session persistence 和 query packages | 有界序列范围内的只读字节区间 | 现有 persistence 和 SQLite/zstd 路径已成熟；尚无 Rust 对照 | **RETAIN_TS** |
| 批量 hash 或摘要 | `packages/util/crypto` 和 knowledge ingestion | 规范字节和有界批量大小 | 尚无工作负载或端到端基准 | **RETAIN_TS** |
| 长时间运行的子进程 | 现有 subprocess 和 jobs packages | 仅限 request ID、generation、deadline、budget 和 cancellation token | 已有进程组取消与清理测试；引入 Rust 子进程会增加第二个 supervisor | **RETAIN_TS** |

`RETAIN_TS` 表示当前不得选择 Rust 实现进入生产。`DEFER` 表示开始实现前必须先定义索引契约和回放语料。现有 C11 Landlock launcher 仍是 native 文件隔离 provider；本矩阵不把它列为 Rust 候选。

## 启用的 profile 模块审查 — 2026-10-10

组合 profile 依次应用 `dsh-base`、`native-api-app` 和 Jiuzhang overlay。Ark 3.1.22 候选 runtime 清单有 106 项：一个 `cordis:include` 根和 105 个 plugin ID，其中 78 个启用、27 个禁用。打包后的 base、native API 和 Jiuzhang patch hash 与源码一致（`24b9156d…`、`87baf5a5…` 和 `805694d8…`）。已安装的 Ark 3.1.0 使用不同的 Jiuzhang overlay hash（`b24765d0…`），所以候选回执不能证明正式 app 的 runtime plugin 清单。[3.1.22 候选安装回执](/Users/hui/ark-test/evidence/install-e2e-candidate322-20261010.json)证明清单成员关系，不证明每个启用的 plugin 都实际运行过。

| Runtime 职责及启用的 plugin ID | 语言决策及原因 |
| --- | --- |
| Agent 和策略：`agent`、`agent-default-model`、`agent-loop`、`agent-presets`、`approval`、`command-feedback`、`command-goal`、`commands`、`goal`、`goal-round-driver`、`permission`、`repeat-tool-reminder`、`system-prompt`、`timeout-policy`、`timer`、`token-meter`、`user-questions` | **RETAIN_TS**；这些模块拥有可变生命周期、类型化事件、面向模型的策略和审批决策。 |
| 模型和知识：`deepseek-llm-api-extensions`、`llm`、`llm-deepseek`、`llm-pi-ai`、`llm-retry`、`knowledge-wiki`、`tool-knowledge-wiki`、`session-title-llm` | **RETAIN_TS**；provider 路由、凭据、authority 检查和工具输出属于边界工作。纯搜索内核已在上文单独评估。 |
| Session、持久化、存储和投影：`attachment-local`、`file-reference-local`、`message-feedback`、`session`、`session-checkpoint-policy`、`session-log-deepseek`、`session-persistence-jsonl`、`session-projection`、`session-projection-cache`、`session-query-sqlite`、`session-reference`、`session-remote-operations`、`session-stats`、`session-title`、`settings`、`storage`、`storage-domain`、`storage-json`、`workspace` | **RETAIN_TS**；Session event 仍是权威来源，JSONL/Zstandard、SQLite 和 JSON storage 已拥有各自的持久化边界。 |
| 执行、能力和隔离：`bash-sandbox`、`code-runtime`、`credentials`、`fs-observation-policy`、`fs-sandbox`、`jobs`、`sandbox`、`sandbox-policy`、`shell-env`、`skill`、`spill-local`、`spill-policy`、`subagent`、`subagent-fork-in-process`、`subagent-model-selection-settings`、`subagent-spawn-in-process`、`subprocess`、`tool-subagent-report`、`tools` | **RETAIN_TS**；这些模块实施权限并监督外部副作用、取消和进程清理。再增加一个 runtime owner 会扩大安全边界，目前没有测量证据证明这样做有益。 |
| Host、传输和平台适配器：`api-gateway`、`directory-picker`、`host-connection`、`native-api-runtime`、`native-api-startup`、`native-events`、`plugin-inventory`、`plugin-package-inventory-deepseek`、`typert`、`typert-loader`、`web`、`web-fetch-http`、`web-search-deepseek`、`webserver`、`workbench-remote` | **RETAIN_TS**；这些模块绑定 native 产品能力、HTTP 和现有 wire contract。Ark 的 SwiftUI/AppKit 产品不在本次 Rust 评估范围内。 |

27 个禁用 ID 为 `agent-instructions`、`command-compact`、`compaction-basic`、`hmr`、`plan-mode`、`pwsh-sandbox`、`session-telemetry-otel`、`skill-badge`、`skill-filesystem`、`tool-bash`、`tool-fs`、`tool-fs-search`、`tool-goal`、`tool-jobs`、`tool-pwsh`、`tool-ralph`、`tool-result-pruner`、`tool-skill`、`tool-str-replace-editor`、`tool-subagent`、`tool-subagent-control`、`tool-subagent-fork`、`tool-subagent-list-agents`、`tool-todo`、`tool-web`、`tool-workflow` 和 `workflow-worker-thread`。它们仍由 TypeScript 实现，且未进入活动 runtime；没有启用状态下的工作负载、差分回放和端到端证据，就没有理由为它们选择 Rust。若 profile 启用了这些模块，应重新评估。

这次审查覆盖候选清单中的全部 105 个 plugin ID：按职责划分的 78 个启用模块都保留 TypeScript 决策，27 个禁用模块在有启用工作负载证据前也保留 TypeScript。BM25 的实测决策仍是优化 TypeScript；图派生和未经测量的批量 hash 暂缓实现，等待更多证据；现有 C11 Landlock provider 与 Rust 分开处理。

## 任一候选晋级前所需的证据

每个候选都必须注册固定输入语料，并比较以下三种实现：

1. 当前 TypeScript 实现。
2. 保持相同可观察契约的优化 TypeScript 实现。
3. 经生产计划使用的真实 N-API 或 IPC 路径调用的 Rust 实现。

基准记录必须包含仓库 Git SHA、profile 名称、语料 hash、实现版本和工具链版本；还必须报告冷／热 p50、p95、p99 延迟、CPU 时间、Node 加 native RSS、event-loop delay、序列化和复制成本、FFI 或 IPC 成本、取消延迟、崩溃恢复结果、构建时间、CI 时间、包大小和平台失败率。Rust 内部微基准不足以作为证据。

差分回放必须对相同请求序列比较规范结果字节和错误类别。结果不匹配、超时、版本不一致、进程崩溃或取消失败，都必须让候选留在 shadow 模式并记录 TypeScript 回退结果。Shadow 模式不得重复写入生产事件，也不得重复执行外部副作用。只有通过回放和可靠性门槛后才能启用 enforce；之后若再次不匹配，必须失败关闭。

学习效果声明使用[`scripts/rust-migration/evaluate-learning.ts`](../../scripts/rust-migration/evaluate-learning.ts)中的确定性归约器，以及[`scripts/rust-migration/README.md`](../../scripts/rust-migration/README.zh.md)记载的输入契约。归约器要求 baseline/candidate 记录由独立验证，并且 model、task、goal 和 policy hash 匹配；配对不完整时返回 `UNKNOWN`，而不是通过。

Rust 输入限于规范字节或不可变 DTO，以及 `requestId`、`sessionId`、`generation`、capability、deadline、budget 和 cancellation token。Cordis context、Agent、Session、ToolDefinition、凭据、JavaScript callback、可变 JavaScript object 和全局 service 都必须留在 Rust 边界之外。

## 当前结论

基于文件的合成知识搜索 fixture 比较了当前 TypeScript、重建索引的 TypeScript、生产 root-local 缓存 TypeScript、每次新建子进程的 Rust IPC 和仅供 benchmark 使用的常驻 Rust worker；维护中的运行记录显示规范结果数组一致。热缓存 TypeScript 路径现在由 `WikiSnapshotStore` 持有，并有明确的写入和 watcher 失效机制。但这项源码基准并非完整生产证据：真实用户 Wiki 行为、候选 profile 执行、子进程总资源核算、生产 Rust worker 所有权、取消、恢复和跨平台测量仍未完成。目前没有证据支持生产 Rust 迁移。保留现有 TypeScript 内核和 native C11 隔离 provider，保留 TypeScript fallback；在生产证据齐备前维持 `RETAIN_TS`。

<a id="current-benchmark-snapshot--2026-10-10"></a>

## 当前基准快照 — 2026-10-10

维护的基准 runner 在同一份 240 页合成 Wiki 语料上进行了三轮全新的 30 样本运行，TypeScript/Rust 结果 digest 均一致。内存中的五 query 批量任务，current TypeScript 的 p50 为 12.113–12.197 ms；每批重建索引的优化 TypeScript 为 2.983–3.016 ms；预建热索引场景为 0.508–0.513 ms；Rust IPC 为 7.253–7.285 ms。基于文件的单 query 路径上，current TypeScript 的 p50 为 10.653–10.865 ms，重建索引 TypeScript 为 9.097–9.259 ms，Rust IPC 为 16.953–17.466 ms；每次创建子进程的 Rust IPC 比重建索引 TypeScript 慢 1.86–1.90 倍。Ark 当前的 `modelSearch` 每次调用处理一个 query，因此批量测试不能证明生产收益；生产继续使用 TypeScript。热索引 TypeScript 数字仍只是 benchmark 场景，尚无生产 owner 或失效契约。独立[差分回放回执](../../scripts/rust-migration/knowledge-search-differential-replay-20261010.json)报告 digest 完全相同。旧聚合记录中互相矛盾的 `allCanonicalResultsMatch: false` 条目仍予保留，尚未解决；详见[三轮维护 runner 回执](../../scripts/rust-migration/knowledge-search-benchmark-repeatability-20261010.json)。这项合成基准仍缺少生产常驻 worker 接入、子进程 CPU/RSS、跨平台、取消／恢复、生产语料和 ACL／路径隔离证据，因此整体 Rust 验收仍为 `UNKNOWN`。

每个基于文件的 30 样本 fixture 都使用同一份临时 240 页 Wiki，关闭 embedding，分别运行当前 `hybridSearch`、每个样本重建索引的优化 TypeScript，以及候选 Rust IPC helper。两轮隔离运行产生完全相同的排序结果数组。helper 每轮都会重新遍历文件、计算规范 TypeScript oracle、序列化请求、启动一个 Rust 子进程并检查结果；这只是本次调用内的 `enforce` 对照，没有改变仍保持禁用的活动 profile。第二轮的测量值如下：

| 基于文件的路径 | p50 | p95 | p99 | Node 父进程 CPU／30 个样本 |
| --- | ---: | ---: | ---: | ---: |
| 当前 TypeScript `hybridSearch` | 10.862 ms | 13.487 ms | 13.730 ms | 488,113 µs |
| 优化 TypeScript，每个样本重建索引 | 9.129 ms | 11.091 ms | 11.183 ms | 420,699 µs |
| 与 TypeScript 对照的 Rust IPC 候选 helper | 17.319 ms | 18.572 ms | 18.592 ms | 625,204 µs |

在两次基于文件的运行中，Rust p50 比当前 TypeScript 慢 57–59%，比重建索引的 TypeScript 慢约 88–90%。这支持 Ark 当前一次 query 搜索路径继续使用 TypeScript，不支持声称生产提速。Rust 子进程 CPU/RSS 未计入父进程总量。首次启动 Rust 子进程在两轮中分别耗时 415.544 ms 和 22.765 ms；这些首次调用发生在 TypeScript 探测之后，进程／文件系统缓存状态未受控制，只能作为启动风险观察，需与后续 30 样本分布分开看待。第二轮的 1 ms event-loop histogram 测得当前 TypeScript 的平均超额延迟为 9.890 ms，重建索引 TypeScript 为 8.773 ms，异步 Rust IPC wrapper 为 1.269 ms（Rust 的 p95 超额延迟为 9.667 ms）。热索引 TypeScript 仍只是缓存场景。真实用户 Wiki、ACL／路径隔离、生产 profile 执行、子进程资源核算、生产常驻 worker、取消、崩溃恢复和跨平台结果都还没有测量。Benchmark 状态仍为 `unknown`，生产决策仍为 `RETAIN_TS`。

### TypeScript 评分器后续试验 — 2026-10-10

临时 `scorePages` 重构预先计算每页的词频 map 和标题 token 成员关系。两次隔离的 30 样本运行使用同一份 240 页合成语料，规范结果保持一致。相较于 `rust-benchmark.json` 中试验前的 current-TypeScript 基线，内存单 query p50 提高 7.16–11.67%，但 p99 退化 3.70–4.57%。基于文件的单 query 路径则出现：p50 慢 1.85–11.90%，p95 慢 5.95–39.00%，p99 慢 7.59–54.14%，Node 父进程 CPU 增加 1.08–9.52%。端到端和尾延迟结果不足以证明额外评分器复杂度值得保留，因此已撤销该重构，生产评分器未改变。撤销后的定向搜索和 Rust 差分套件通过 5 个文件／18 项测试。此结果不改变 `RETAIN_TS` 决策，也不构成生产提速证据。详见[完整试验记录](/Users/hui/ark-test/evidence/typescript-bm25-inline-optimization-trial-20261010.json)、[运行 1](/Users/hui/ark-test/evidence/typescript-bm25-inline-optimization-trial-20261010-run1.json)和[运行 2](/Users/hui/ark-test/evidence/typescript-bm25-inline-optimization-trial-20261010-run2.json)。

### Rust 常驻 worker 基准 — 2026-10-11

同一份 240 页合成 Wiki 上进行了三轮全新的 30 样本运行，并逐一将 Rust 响应与 TypeScript oracle 对照。仅供 benchmark 使用的 Rust JSONL worker 每个进程接收 33 个请求（一个冷请求、两个预热请求和 30 个计时请求）；三个 worker 都正常退出，三轮差分回放全部匹配。按三轮分布的中位数计算，常驻 Rust p50 为 14.800 ms，每次新建子进程的 Rust IPC 为 17.129 ms，current TypeScript 为 10.689 ms，每个样本重建索引的优化 TypeScript 为 9.541 ms。复用 Rust worker 使 p50 相比每个 query 新建子进程降低 13.60%，但仍比 current TypeScript 慢 38.46%，比重建索引的 TypeScript 慢 55.11%。其 p95／p99 中位数为 15.638／15.940 ms，而 current TypeScript 为 12.968／12.972 ms。因此，生产形态的一次 query 路径上，常驻 worker 仍无速度优势；决策维持 `RETAIN_TS`。

三次正常退出和结果匹配，只证明这一有界合成协议测试能重复完成；它没有测量 Ark 稳定性、生产 worker 所有权、取消、崩溃恢复、长时间压力运行、子进程 CPU/RSS、跨平台行为、真实 Wiki 内容或 ACL／路径隔离。JSONL 模式只供 benchmark 使用，所有 profile 都未启用。详见[聚合回执](../../scripts/rust-migration/knowledge-search-persistent-benchmark-20261011.json)及[三份运行回执](../../scripts/rust-migration/knowledge-search-persistent-benchmark-20261011-run1.json)、[运行 2](../../scripts/rust-migration/knowledge-search-persistent-benchmark-20261011-run2.json)和[运行 3](../../scripts/rust-migration/knowledge-search-persistent-benchmark-20261011-run3.json)。

### 单次 query 路径上的生产缓存与 Rust — 2026-10-11

可复现的[`--series`基准](../../scripts/rust-migration/knowledge-search-cache-vs-rust-reproduction-20261011.json)在基于文件的 240 页合成 Wiki 上运行三轮独立 30 样本对比，每个请求只含一个 BM25 query。三轮的输出字节完全一致，三个 Rust worker 均正常退出。p50／p95／p99 中位数分别为：每次重读文件并重建索引的 TypeScript 10.109／11.072／11.577 ms；从已解析页面重建索引的优化 TypeScript 2.172／3.024／4.048 ms；生产 `WikiSnapshotStore.get` 热命中加评分 0.095／0.127／0.195 ms；新建子进程 Rust IPC 6.631／6.881／7.032 ms；仅供基准使用的常驻 Rust worker 4.079／4.595／5.554 ms。生产索引未命中耗时为 11.126–12.902 ms。热缓存 p50 约比常驻 Rust 快 43 倍；Rust 只比每次重读文件的 TypeScript 快，没有超过优化 TypeScript 或实际热路径，而且每次 query 仍要传输页面记录。此源码绑定复测取代早期 harness 未计相同缓存查找边界的一次性数字。1 ms 直方图分辨率下，当前 TypeScript、重建索引 TypeScript、热缓存、新建 Rust 子进程、常驻 Rust 的 event-loop delay p95 依次为 12.403／2.517／1.020／6.885／1.596 ms；样本数不均（29／29／3／29／93），只能作为诊断值。Rust 子进程 CPU／RSS 未计入。该对比也不包括 provider／模型延迟、embeddings、verifier／ACL、压力、生产取消和崩溃恢复或真实 Wiki 内容，不能证明 Ark 端到端提速或稳定性提升。Rust 仍禁用，生产决策继续为 `RETAIN_TS`。
