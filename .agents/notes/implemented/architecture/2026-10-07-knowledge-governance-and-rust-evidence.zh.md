# Agent Note: Governed knowledge events and evidence-gated Rust selection

Status: implemented

[English](2026-10-07-knowledge-governance-and-rust-evidence.md) | 中文

## Problem

active Ark 源码已经保存 Wiki candidate、评审、verifier receipt 与 utility 计数，但模型可见的检索和注入仍需要持久 provenance、scope 校验、过期、冲突处理与回放。仓库还需要一个可证据审查的 Rust 决策，不能在没有端到端证据时替换可用的 TypeScript 内核。

## Decision

知识记录显式保存 provenance、trust、authority、evidence、verification、scope、ACL、过期时间、冲突和 utility 字段。hash 链项目日志记录 observation、candidate、verification、rejection、retrieval、injection、conflict、expiry、promotion 和 rollback。candidate 生命周期事件携带完整记录；晋级需要现有独立 verifier 与评审事务。模型可见 Wiki 工具追加 `knowledge/retrieved` 和 `knowledge/injected` session 事件，事件包含调用身份、scope、结果 hash 和可回放 JSON 值。未验证、过期、冲突、越界、ACL 拒绝或低置信度记录会 fail closed。

checkout 包含隔离的 [knowledge-search shadow crate](../../../../rust/knowledge-search-shadow/README.zh.md) 与默认关闭的 TypeScript child boundary。搜索 authority、图谱派生、session 持久化和 subprocess 管理继续由 TypeScript 或已有 native owner 负责；没有 receipt 授权 Rust enforce。Rust candidate matrix 要求三组对照、差分回放、取消、恢复、打包和平台证据通过后才允许 enforce。[源码清点](../process/2026-10-08-function-language-census.zh.md) 区分声明覆盖与功能、性能验证。

学习结论使用相同 model、配置、task、goal 和 policy hash 的 baseline/candidate 配对结果。缺少机会或独立验证时返回 `UNKNOWN`；知识条数、模型调用次数或 Rust 行数不能证明改进。

## Alternatives considered

- **不记录 Wiki recall：** 拒绝，因为模型可见输入必须能由 session event log 重建。
- **根据 utility 或模型输出自动晋级：** 拒绝，因为低 trust 和未验证内容不能改变运行时策略或 canonical knowledge。
- **优先迁移 Rust：** 拒绝，因为 shadow crate 和相同结果 digest 不证明端到端收益，且现有 TypeScript/native owner 已提供取消和恢复。
- **合并成一个总分：** 拒绝，因为每项 rate 与零泄漏要求必须独立检查。

## Consequences

Wiki 事件日志可审计、可回放，canonical 文件继续由现有评审与 verifier WAL 保护。新增 session event 不改变 session format version。没有 calling session 的工具调用仍可服务非 Agent caller，但模型可见的 Agent 调用不能绕过 session event 记录。Rust enforce 保持 deferred，直到具体候选登记 corpus、边界和三组证据。
