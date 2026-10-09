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

## 模型可见行为

`tool-knowledge-wiki` 注册 `wiki_search`、`wiki_files`、`wiki_read`、`wiki_graph`、`wiki_reviews`、`wiki_ingest` 和 `wiki_verify_candidate`。Wiki 内容通过这些工具进入模型，调用方 session 记录包含 tool call、scope、结果 hash 和可回放 JSON 值的检索与注入事件。每个模型步骤没有自动的无 scope recall 段落。

检索将 BM25 与可选在线 embedding 结合；embedding 不可用时退回关键词结果。图谱从 Wiki Markdown 派生并在内存缓存。源摄取串行、受限、可取消并可恢复；生成页面在验证和评审完成前保持 candidate 状态。

## Session 与运行时边界

Ark active profile 通过 JSONL 持久化 session，并在 native API bundle 中启用 projection cache。`session-query-sqlite` 以 `openAt: never` 和内存路径挂载，因此保留精确读取与 trace，同时关闭全文检索。Knowledge 事件是 session-log 扩展，遵循标准 session 持久化与回放规则。

当前仓库包含隔离的 Rust shadow crate 和默认关闭的 Rust 检索候选边界，但没有生产 Rust N-API provider 或 enforced Rust owner。检索与图谱内核继续使用 TypeScript，直到同一 current TypeScript、优化后的 TypeScript 和真实生产边界 Rust 实现通过 [Rust candidate matrix](rust-migration/rust-candidate-matrix.zh.md) 的对照证据。
