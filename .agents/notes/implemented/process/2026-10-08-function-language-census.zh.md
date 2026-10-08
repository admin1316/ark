# Agent Note: Separate source coverage from language-selection evidence

Status: implemented

[English](2026-10-08-function-language-census.md) | 中文

## Problem

子系统表可能遗漏函数、混淆源码可用与实际启用，也可能让未测量的保留决策看起来像语言性能结论。依赖运行环境的工具和组合无法通过目录检查得到完整验证。

## Decision

[语言清单](../../../../scripts/rust-migration/inventory-language-fit.ts) 复用包发现、Cordis 扫描、不执行表达式的 YAML parser、patch 组合与工具 harvest。Git 在 workspace 派生范围及 integration、Python、Rust 范围内枚举 tracked 与非 ignored 代码。排除的代码仍保留记录。必需范围为空或包发现不完整时拒绝生成。hash 绑定代码、manifest 与配置；AST 声明保留源码位置，动态名称继续标为未解析。

覆盖、语义审查、运行验证和语言收益具有独立状态。直接 `Remote` 与带 scope 的 `RemoteScope` 声明保留导出名称及 scope；检查导入 alias 和限定名访问时不执行 decorator。[人工操作记录](../../../../scripts/rust-migration/feature-language-review.json) 绑定引用文件及清单快照，将局部函数体审查与未审查的 provider/helper 分开，明确保留待核对项。记录完整性前核对包集合及检测到的入口集合。函数核对拒绝失效的源码选择条件；内核资格不授权迁移。[治理决策](../architecture/2026-10-07-knowledge-governance-and-rust-evidence.zh.md) 和[工具 catalog 决策](2026-07-02-tool-schema-catalog.zh.md) 继续独立负责晋级与实际 schema harvest；清单没有取代两者。

## Alternatives considered

**只保留子系统表。** 拒绝，因为新增源码和注册点可能在不改变表格的情况下被遗漏。

**把静态分类视为完成验证。** 拒绝，因为声明不能证明启用、代表性性能、取消、恢复或行为成功。

**新增运行注册表。** 拒绝，因为已有 catalog 和组合负责这些机制；审计不新增产品 authority。

## Consequences

[核对参考](../../../../docs/rust-migration/full-runtime-language-matrix.zh.md) 链接可重新生成的证据，并明确审查尚未全部完成。parser/角色测试覆盖 alias、计算式访问、动态名称、注释、函数声明、Native contract test 与排除项。Swift/C/Python/Rust 的逐项函数、用户插件和外部 MCP schema 仍是明确缺口。工具写入审计证据，不加载 active 用户 profile，也不启用 Rust。
