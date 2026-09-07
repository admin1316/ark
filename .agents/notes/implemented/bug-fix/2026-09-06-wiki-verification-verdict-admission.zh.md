# Agent Note: Wiki 验证结论准入

Status: implemented

[English](2026-09-06-wiki-verification-verdict-admission.md) | 中文

## 问题

通过真实性验证的验证收据也可能记录失败。真实性本身不能授权 Candidate 晋升：项目可写的复核镜像或 prepared 晋升日志都可能引用真实的失败收据。

## 决定

[收据验证](../../../../packages/host/knowledge-wiki/src/verifier.ts)保留真实失败收据的审计读取能力，但只有经过认证的 `pass` 结论才能生成通过晋升验证的投影。[晋升恢复](../../../../packages/host/knowledge-wiki/src/reviews.ts)在执行非 Archive 日志的任何操作前，独立要求同一通过结论。日志签名、精确字节绑定、路径限制和冲突检查仍然必需，任何一项都不能替代验证结论。

## 考虑过的替代方案

**仅在服务入口拒绝。** prepared 日志在恢复时可以绕过该入口，因此恢复逻辑的负责模块也必须检查验证结论。

**丢弃失败收据。** 这会删除审计证据，并把真实拒绝与证据缺失或被篡改混为一谈。失败收据仍然存储并允许读取。

## 影响

失败收据不能授权 Canonical 写入、Candidate 移除或复核条目解决，即使引用它的 prepared 日志具有正确签名。这类日志会被拒绝，而不是静默完成或删除。Archive 保留独立策略。[行为回归](../../../../packages/host/knowledge-wiki/tests/verification.spec.ts)覆盖直接准入、伪造项目镜像、审计可读性，以及操作前状态保持不变的恢复路径；这些约定不构成安装态应用验收。
