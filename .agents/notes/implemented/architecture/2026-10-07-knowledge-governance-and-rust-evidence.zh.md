# Agent Note: Governed knowledge events and evidence-gated Rust selection

Status: implemented

[English](2026-10-07-knowledge-governance-and-rust-evidence.md) | 中文

## Problem

active Ark 源码已经保存 Wiki candidate、评审、verifier receipt 与 utility 计数，但模型可见的检索和注入仍需要持久 provenance、scope 校验、过期、冲突处理与回放。仓库还需要一个可证据审查的 Rust 决策，不能在没有端到端证据时替换可用的 TypeScript 内核。

## Decision

知识记录显式保存 provenance、trust、authority、evidence、verification、scope、ACL、过期时间、冲突和 utility 字段。hash 链项目日志记录 observation、candidate、verification、rejection、retrieval、injection、conflict、expiry、promotion 和 rollback。candidate 生命周期事件携带完整记录；晋级需要独立验证、评审和独立实测的 trial 证据。模型可见 Wiki 工具追加 `knowledge/retrieved` 和 `knowledge/injected` session 事件，事件包含调用身份、scope、结果 hash 和可回放 JSON 值。未验证、过期、冲突、越界、ACL 拒绝或低置信度记录会 fail closed。

未签名的接纳不能替换已有 identity，也不能赋予 verified trust。验证使用经过认证的完整记录，拒绝被改写的先前接纳。历史 canonical 接纳绑定最终 content hash；模型投影在搜索、embedding、图谱派生、列表或页面读取前检查实际文件字节。检索和 utility 回放把路径解析为同一个受治理 identity，修改展示投影不能重置治理计数。这些绑定防止未签名 hash 链或新算出的文件 hash 冒充验证。

语义验证检查不代表成功 trial。当前 receipt 合约无法认证实测 trial 收益，因此 Promote、Merge、Replace 和 Deduplicate 在修改前拒绝；prepared canonical WAL 恢复同样拒绝，包括标记为 Archive 的 canonical 操作。正向 UI 反馈与声称来自 evaluator 的标签保留为观察，不能增加受治理的 successful-use 计数或维持保留。纠正保留负向 utility 效果。Archive、Skip、advisory resolution 和 rollback 保留现有 authority 与事务要求。

Candidate identity 包含路径和内容 hash。字节变化会创建独立的评审 revision；再次观察相同字节不能重开已解决的评审，也不能覆盖已经认证的 identity。

checkout 包含隔离的 [knowledge-search shadow crate](../../../../rust/knowledge-search-shadow/README.zh.md) 与默认关闭的 TypeScript child boundary。搜索 authority、图谱派生、session 持久化和 subprocess 管理继续由 TypeScript 或已有 native owner 负责；没有 receipt 授权 Rust enforce。Rust candidate matrix 要求三组对照、差分回放、取消、恢复、打包和平台证据通过后才允许 enforce。[源码清点](../process/2026-10-08-function-language-census.zh.md) 区分声明覆盖与功能、性能验证。

学习结论使用相同 model、配置、task、goal 和 policy hash 的 baseline/candidate 配对结果。缺少机会或独立验证时返回 `UNKNOWN`；知识条数、模型调用次数或 Rust 行数不能证明改进。

## Alternatives considered

- **不记录 Wiki recall：** 拒绝，因为模型可见输入必须能由 session event log 重建。
- **根据 utility 或模型输出自动晋级：** 拒绝，因为低 trust 和未验证内容不能改变运行时策略或 canonical knowledge。
- **把验证检查当作成功使用：** 拒绝，因为检查 candidate 不等于测量它对后续任务的效果。
- **优先迁移 Rust：** 拒绝，因为 shadow crate 和相同结果 digest 不证明端到端收益，且现有 TypeScript/native owner 已提供取消和恢复。
- **合并成一个总分：** 拒绝，因为每项 rate 与零泄漏要求必须独立检查。

## Consequences

Wiki 事件日志可审计、可回放。prepared canonical journal 会阻止初始化或项目切换并保留证据，不会在缺少实测 trial authority 时继续提交。Archive 恢复认证操作身份并只记录一次终态 rejection；单独的 committed 标记不能认证文件状态已提交。历史接纳 fixture 用于检查读取边界，不会启用当前晋级。新增 session event 不改变 session format version。没有 calling session 的工具调用仍可服务非 Agent caller，但模型可见的 Agent 调用不能绕过 session event 记录。Rust enforce 保持 deferred，直到具体候选登记 corpus、边界和三组证据。

测试 authority 只验证确定性的认证与拒绝行为。独立评估者密钥分离、原生配置、实际 trial 收益与真实 provider 的配对学习证据仍未验证；验证结果通过和 UI 反馈不能证明修复规则被正确复用。
