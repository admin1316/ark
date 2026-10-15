# Knowledge Wiki

[English](knowledge-wiki.md) | 中文

`@deepseek-ai/dsh-knowledge-wiki` 是 Ark 使用的进程内 Wiki 服务，负责项目 Markdown 页面、混合检索、图谱派生、源文件摄取、候选评审、独立验证、晋级事务日志和 utility 反馈。[Phase 0 source-truth report](rust-migration/source-truth-report.zh.md)、[profile matrix](rust-migration/profile-matrix.zh.md) 与 [knowledge runtime report](rust-migration/knowledge-runtime-report.zh.md) 记录源码、profile 和运行证据的对照。

## 配置

服务校验 `wikiRoot`、`mainRoot`、`credential`、`llmProvider`、`llmModel`、`llmBaseUrl`、`llmCredential`、`ownedStageExecutor`，以及可选的 `knowledgeSearchCandidateMode`、`knowledgeSearchCandidateBinary` 和 `knowledgeSearchCandidateTimeoutMs`。`credential` 用于可选的语义向量和图片说明；`llmCredential` 用于 owned 摄取 worker。候选模式默认为 `disabled`；`shadow` 只观测，`enforce` 在完整混合契约证明前 fail-closed。包契约与 profile 示例见 [`packages/host/knowledge-wiki/README.md`](../packages/host/knowledge-wiki/README.zh.md)。

## 持久状态

项目状态位于 `.llm-wiki/`：`ingest-queue.json` 保存可恢复任务，`ingest-cache.json` 保存成功源文件 hash，`review.json` 保存 advisory 与 candidate 评审，`knowledge-utility.json` 保存检索结果，`knowledge-events.jsonl` 保存 hash 链生命周期证据。写入使用包内受限的原子辅助函数和事件日志追加校验。

## 学习流程

知识流程为 `observed → candidate → provenance check → independent verification → review → limited use → promoted、downgraded、expired 或 rolled back`。`KnowledgeRecord` 包含内容、来源及 source hash、scope、trust、authority、evidence 引用、验证状态、置信度、验证与过期时间、冲突、检索/成功使用/用户修正计数和 utility 分数。

外部网页、MCP 结果、文件和其他 Agent 消息以低 trust observation 进入。模型可见注入前执行 scope 与 ACL 校验；未验证、过期、冲突或低置信度记录会被拒绝。低 trust 记录不能改变权限、策略、凭据或模型路由。晋级需要既有 authority 绑定的 verifier receipt 与明确评审动作。

事件日志接受 `knowledge/observed`、`knowledge/candidate`、`knowledge/verified`、`knowledge/rejected`、`knowledge/retrieved`、`knowledge/injected`、`knowledge/conflict`、`knowledge/expired`、`knowledge/promoted` 和 `knowledge/rolled_back`。回放 hash 链可重建受治理的记录状态；格式错误、乱序或篡改事件会 fail closed。

每个独立记录的 `knowledge/retrieved` 事件最多允许该页面产生一次非中性 utility 结果。服务在接受反馈前会将 hash 链日志中的结果计数与 utility JSON 投影核对；即使中断后投影陈旧，也不能重复计入成功或修正。`wiki_propose_repair` 只有在同一会话完整读取已验证来源、消费一次性来源 hash 能力，并且 host 确认同一轮直接用户消息中的规则与日志里的工具参数一致后才记录修正结果。模型访问前，至少检索三次且 utility 不高于零的已验证记录会收到可回放的 `knowledge/expired` 事件。调用方报告的成功仍是反馈信号，不是任务正确性的独立验证。

### 修正提案

如果用户纠正了一个 Wiki 支持的结论，`wiki_propose_repair` 可以为 `concepts/`、`entities/`、`findings/`、`research/` 或 `methodology/` 下已验证的 Markdown 页面创建低 trust Candidate。工具要求同一会话先完整执行 `wiki_read`，服务端还会独立校验绑定会话、项目、来源路径和准确内容 hash 的一次性进程内能力。服务还会核对可回放的 session 日志，要求同一轮包含直接用户消息，且工具参数与用户原文中的修正规则一致。该能力 15 分钟后过期；超过共用 8000 字符工具读取上限的页面不会获得此能力。Candidate 发布前，旧记录先被拒绝；在独立 verifier 通过且明确执行 Replace 评审前，模型可见的 Wiki 读取仍隐藏修正规则。这是受控的修正提案流程，不能证明下一次对话会检索并复用修正。

## 模型可见行为

`tool-knowledge-wiki` 注册 `wiki_search`、`wiki_files`、`wiki_read`、`wiki_graph`、`wiki_reviews`、`wiki_ingest`、`wiki_verify_candidate` 和 `wiki_propose_repair`。Wiki 内容通过这些工具进入模型，调用方 session 记录包含 tool call、scope、结果 hash 和可回放 JSON 值的检索与注入事件。每个模型步骤没有自动的无 scope recall 段落。

检索将 BM25 与可选在线 embedding 结合；embedding 不可用时退回关键词结果。图谱从 Wiki Markdown 派生并在内存缓存。源摄取串行、受限、可取消并可恢复；生成页面在验证和评审完成前保持 candidate 状态。

## Session 与运行时边界

Ark active profile 通过 JSONL 持久化 session，并在 native API bundle 中启用 projection cache。`session-query-sqlite` 以 `openAt: never` 和内存路径挂载，因此保留精确读取与 trace，同时关闭全文检索。Knowledge 事件是 session-log 扩展，遵循标准 session 持久化与回放规则。

当前仓库包含隔离的 Rust shadow crate 和默认关闭的 Rust 检索候选边界，但没有生产 Rust N-API provider 或 enforced Rust owner。检索与图谱内核继续使用 TypeScript，直到同一 current TypeScript、优化后的 TypeScript 和真实生产边界 Rust 实现通过 [Rust candidate matrix](rust-migration/rust-candidate-matrix.zh.md) 的对照证据。
