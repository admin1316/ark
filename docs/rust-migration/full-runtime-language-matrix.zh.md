# ARK 全运行时 TS/Rust 适配矩阵

**快照：** `codex/ark-rust-knowledge-20261008`，提交 `8de9f3b9549f24563c04f4867301f74d0d6c53eb`，2026-10-08。本文把整个运行时按职责分类；它不启用 Rust，也不改变现有 wire contract。

## 判断原则

语言选择按端到端结果决定，而不是按“计算看起来复杂”决定：

1. 先冻结当前 TypeScript 的可观察契约，再做优化后的 TypeScript 对照。
2. 只有纯计算、输入可封闭、输出可做 canonical digest 的模块，才进入 Rust 候选。
3. Rust 必须通过真实 N-API/IPC 边界测量；只看 Rust 内部 microbenchmark 不算收益。
4. 任何候选都要同时检查 p50/p95/p99、CPU、总 RSS、event-loop delay、序列化/IPC、冷启动、热运行、取消、崩溃恢复、CI、包体和跨平台失败率。
5. 结果漂移、超时、取消失败或进程崩溃都保持 TypeScript fallback；没有端到端收益就保留 TypeScript。

## 全局矩阵

| 子系统 | 当前权威实现 | 更适合的语言 | 决策 | 原因与必须验证的条件 |
| --- | --- | --- | --- | --- |
| Agent loop、Cordis、Goal、Session、ToolRuntime | `packages/core/**`、`packages/extensions/**`、`packages/goal/**` | TypeScript | **RETAIN_TS** | 包含可变上下文、事件顺序、权限和模型回调；跨语言会复制 authority，增加恢复和副作用风险。 |
| LLM provider、SSE、重试、token meter | `packages/llm/**` | TypeScript | **RETAIN_TS** | 直接绑定 provider wire contract、credential 和取消；Rust 不能持有 credential、JS callback 或 provider 状态。 |
| MCP、工具注册、权限、审批、凭据 | `packages/mcp/**`、`packages/core/tools/**`、`packages/credentials/**`、`packages/interaction/**` | TypeScript | **RETAIN_TS** | 这是安全边界和动态插件组合，不是封闭纯计算；正确性与可审计性优先于微优化。 |
| Knowledge governance、verifier、review、utility、事件 authority | `packages/host/knowledge-wiki/src/{knowledge-governance,external-verifier-adapter,reviews,verifier}.ts` | TypeScript | **RETAIN_TS** | 需要签名、hash chain、scope/ACL、过期、冲突和回滚；Rust 不得成为知识晋级的第二 authority。 |
| Wiki 分词、BM25 | `packages/host/knowledge-wiki/src/search.ts` | TypeScript 当前；Rust shadow | **SHADOW_ONLY** | 纯计算适合 Rust，但实测优化 TS 热 p50 约 `0.665 ms`，Rust 独立 IPC warm p50 约 `18.5 ms`；结果一致不等于更快。只有持久索引或 in-process 边界带来端到端收益才可迁移。 |
| cosine、embedding、hybrid search | `packages/host/knowledge-wiki/src/search.ts` | TypeScript | **RETAIN_TS** | embedding 网络调用占主导；当前 hybrid 只在 lexical top-15 中补语义排序，Rust 不能解决候选集合和远端延迟问题。先修完整 semantic candidate DTO，再评估 ANN。 |
| Wiki graph、Louvain | `packages/host/knowledge-wiki/src/graph.ts` | TypeScript | **DEFER** | 计算可封闭，但当前没有稳定的图索引格式、权重语义和回放语料；先修 edge weight/linkCount/cohesion 的语义，再比较 Rust。 |
| 持久化 search/graph index、mmap/增量派生 | 当前无独立 owner | 未来可能 Rust | **DEFER_CANDIDATE** | 这是最有可能获得 Rust 收益的全局候选，但必须先定义版本、generation、checksum、重建、回滚和跨平台格式；在大语料端到端 benchmark 前不写实现。 |
| JSONL/Zstd/SQLite 只读扫描 | `packages/session/**`、`packages/storage/**`、`packages/session-query/**` | 现有 native/TypeScript | **RETAIN_TS** | SQLite、zstd 和 ripgrep 已经是成熟 native kernel；当前 session-query-sqlite 在 active profile 还是 `:memory:`/disabled，不能为假想负载引入 Rust。 |
| JSON canonicalization、hash、签名摘要 | `packages/util/crypto/**`、ingest/verifier | TypeScript/native crypto | **RETAIN_TS** | 调用系统 crypto 的边界成本低，且与 verifier receipt 已绑定；只有批量 hash 成为实测瓶颈才注册 Rust 候选。 |
| compaction、上下文裁剪、token 预算 | `packages/compaction/**`、`packages/session/session-stats/**` | TypeScript | **RETAIN_TS** | 规则与 provider token 语义、目标和安全门槛耦合；错误会改变模型行为，不能只按字符串吞吐迁移。 |
| subprocess/jobs、超时、取消、进程组恢复 | `packages/subprocess/**`、`packages/jobs/**` | TypeScript supervisor | **RETAIN_TS** | 现有 owner 已管理 `AbortSignal`、进程组和 teardown；再加 Rust supervisor 会产生双重生命周期和 orphan 风险。 |
| filesystem、sandbox、Landlock、路径策略 | `packages/fs/**`、`packages/sandbox/**`、`native/landlock-run/**` | TypeScript + 现有 C11 native | **RETAIN_EXISTING** | 安全边界已有 native provider 和策略组合；Rust 重写必须证明同等平台覆盖和审计能力，当前没有理由替换。 |
| API gateway、controllers、settings、profile loader | `packages/api/**`、`packages/settings/**`、`packages/boot/**` | TypeScript | **RETAIN_TS** | 动态配置、插件装配和错误诊断需要现有生态；跨语言收益无法抵消 wire/schema 维护成本。 |
| 其他 I/O、协议和生命周期 surfaces | `attachment/**`、`workspace/**`、`shell/**`、`terminal/**`、`lsp/**`、`sdk/**`、`schedule/**`、`workflow/**`、`goal/**`、`plan/**`、`context/**`、`feedback/**`、`hooks/**`、`webhook/**`、`acp/**`、`subagent/**`、`experimental/**`、`e2b/**` | TypeScript + 现有 native | **RETAIN_EXISTING** | 这些模块由文件/终端/HTTP、动态协议、事件生命周期、sandbox 和模型语义主导；`attachment` 已使用 sharp/libvips native，Rust 重写不会自动带来收益。 |
| Web、HTTP、搜索 provider | `packages/web/**`、`packages/llm/**` | TypeScript | **RETAIN_TS** | 网络等待远大于本地计算，且 provider contract/credential/取消仍由 TS authority 管理。 |
| code runtime、Python、worker thread | `packages/code-runtime/**` | TypeScript + Python 子运行时 | **RETAIN_EXISTING** | 语言运行时本身不能用 Rust 替换；Rust 只可能作为隔离的纯 CPU 子任务，需单独证明。 |
| session projection、title、telemetry | `packages/session/**` | TypeScript/native backend | **RETAIN_TS** | 投影和指标与事件 schema、持久化顺序绑定；迁移会扩大回放和兼容面。 |
| UI、SwiftUI/AppKit/native API app | `packages/bundle/**`、native app | SwiftUI/AppKit + TypeScript bridge | **RETAIN_EXISTING** | 任务明确要求保持现有产品；Rust 不能改善 UI authority，反而增加桥接层。 |
| benchmark、differential replay、learning evaluator | `scripts/rust-migration/**` | TypeScript | **RETAIN_TS** | 这些脚本的价值是复现整个契约和证据链；不能把 evaluator 本身迁移后削弱可审计性。 |

## 目前真正值得继续研究的 Rust 候选

按优先级只保留三类：

1. **持久化不可变搜索索引**：先定义索引格式和 generation，再比较 TypeScript cached index、Rust persistent child 和可能的 N-API/in-process 实现。
2. **大语料图派生索引**：先修权重语义并建立回放语料，再比较 Louvain/派生过程的总耗时和内存。
3. **批量纯 CPU kernel**：只有当 profiling 证明 hash、摘要或其他 bounded batch 占据可观端到端时间，才做 Rust 候选。

当前 BM25 Rust shadow 只证明了 **差分一致性和隔离可行性**；它没有证明速度提升，也没有授权 production enforce。当前候选 Ark 的 UI smoke 还发现了一个配置问题：新会话的默认模型必须由 profile 明确提供；旧候选缺失默认模型时会显示“当前模型不可用”。这类 profile/运行时问题应先修复，再谈语言迁移。

## 迁移闸门

任何一行从 `RETAIN_TS`、`SHADOW_ONLY` 或 `DEFER` 变成 Rust owner，都必须附带：

- 当前 TS、优化 TS、Rust 三路同一 corpus hash 和同一 request sequence；
- canonical result/error digest 逐请求一致；
- 候选 Ark profile 中的真实边界回放；
- 取消、超时、SIGKILL 后恢复和无 orphan process 证据；
- CPU/RSS/event-loop/IPC/包体/CI/跨平台报告；
- Rust failure 时 TypeScript fallback 的回执；
- verifier、knowledge event 和 session replay 不发生重复副作用；
- 独立 review 后才允许逐步打开 candidate，再考虑 enforce。

所以全局结论不是“把 TS 全部改成 Rust”，而是：**保留动态 authority 在 TypeScript，把有证据的封闭计算逐个候选化；目前只有持久索引方向值得继续投入，现有 BM25 shadow 仍停在 shadow。**
