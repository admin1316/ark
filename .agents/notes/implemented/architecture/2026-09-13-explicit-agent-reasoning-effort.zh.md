# Agent Note: 保留创建 Agent 时的显式 reasoning effort

Status: implemented

[English](2026-09-13-explicit-agent-reasoning-effort.md) | 中文

## 问题

Agent 的首个请求只从历史重建 reasoning effort，没有读取显式创建选项。因此，新建 SDK Agent 即使配置 `max`，仍可能发送适配器的 `high` 默认值。持久 header 与提供方请求彼此一致，却没有表达调用方声明的意图。

## 决策

每个循环实例的首个请求在提供了 `AgentOptions.reasoningEffort` 时采用该值。否则，仅在 provider/model 路线一致、且 header 未将 effort 标为适配器默认值时恢复上次记录的 effort。缺失值继续保持缺失，直到请求策略与精确模型准备阶段解析它。

`agent/request` waterfall（瀑布式事件）仍可替换提议配置。适配器校验、有效 `request/header` 记录、默认值来源标记与 prepared-call 分派保持既有职责。后续请求使用已记录的提议配置并重新解析带标记的默认值；创建选项不会覆盖后续请求策略。

本决策明确[适配器拥有的 reasoning 能力](2026-07-24-adapter-owned-reasoning-effort-capabilities.zh.md)中的初始值优先级；该说明仍然负责模型取值、校验、默认值与提供方序列化。[适配器拥有的输出默认值](2026-07-30-adapter-owned-max-token-defaults.zh.md)保持不变。

## 考虑过的替代方案

**只修复 SDK 或 Native 调用方。** 调用方已经携带声明的 effort。针对适配器的绕行修复会让直接调用循环的路径继续丢失选项，并重复与提供方无关的请求组装逻辑。

**始终优先恢复历史。** 这会在重新打开 Session 时丢弃调用方显式指定的创建选项。只有未提供显式选项时，历史才作为后备来源。

**在每个请求中重新应用创建选项。** 这会覆盖后续 `agent/request` 决策，并改变既有默认值标记的生命周期。

## 影响

显式创建选项进入首个经过校验且持久记录的提供方请求，支持的 effort id 集合保持不变。不支持的值仍在提供方 I/O 前失败。省略选项时，继续恢复同路线的历史显式值，并由适配器解析默认值。

循环请求重建测试断言首个显式 header，并保留恢复与默认值行为。SDK 的本地 HTTP 提供方测试断言序列化后的 effort，在不使用凭据或外部 API 的情况下覆盖调用方到提供方的完整路径。
