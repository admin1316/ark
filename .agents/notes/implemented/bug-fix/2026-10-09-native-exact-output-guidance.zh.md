# Agent Note: Native 预设的精确输出与算术指导

Status: implemented

[English](2026-10-09-native-exact-output-guidance.md) | 中文

## Problem

Native 任务的最终 JSON 即使正确，前面的普通助手消息也可能违反用户的整轮输出约束。有限精度计算也可能与一个样例一致，却无法证明其他输入的精确性。只检查最后一条消息或一次计算样例，不能证明这两项性质。

## Decision

`packages/boot/profile-runner/config/agent-presets/` 中共享的 `standard` 与 `code` persona 文字指导模型在整轮中遵守指定输出格式，在只需结果的请求中调用工具而不增加说明，并在指定舍入阶段之前保留十进制与有理数的精确值。[Profile runner](../../../../packages/boot/profile-runner/README.zh.md) 负责这些 Native-safe 资产。它们的作用域 persona 通过现有注册覆盖部署默认值；`minimal` preset 的完整 persona 保留其精确语义。

这是提示词指导。助手文字仍是会话日志中可见的权威记录；该修改不增加输出过滤、重试、结构化输出传输、事件类型、权限例外或学习收益。它保留[逐会话 preset 归属](../architecture/2026-08-03-per-session-agent-presets.zh.md)的决策，不取代该决策。

## Alternatives considered

**修改部署 persona 或另一份 preset 副本。** 作用域 preset persona 覆盖部署默认值，无关资产不能决定 Native 请求。必须在共享 owner 处检查实际渲染的文字。

**过滤进度文字或只校验最终 JSON。** 过滤会隐藏真实违约，并改变模型输出、持久历史与用户可见输出的关系。只校验最后一条消息会漏掉工具调用前的普通文字。

**启用 provider JSON mode 或复用子智能体结构化输出。** 两条现有路径都不能提供跨工具步骤的 root 整轮约束。Provider 传输扩展需要单独审查公开契约；子智能体捕获不会抑制前面的普通文字。

## Consequences

所选 persona 增加稳定的提示词文字，可能改变请求 token 计数与前缀缓存复用。指导仍具有概率性：可运行的无密钥组合验证实际共享 preset 是否进入已记录请求，全新 Native 对话则独立检验整轮输出与精确计算。样例通过不能证明一般算术正确、持久纠错复用或速度提升。

[Native 组合回归](../../../../packages/bundle/native-api-app/tests/native-persona-request.spec.ts) 装载真实 profile 与共享 preset，只对外部模型提供脚本响应，并将实际 provider 请求与持久请求头、公共持久化检查结果比较。完整请求头金样覆盖 POSIX 工具；Windows 需要独立的真实 PowerShell 金样。不经过过滤的前言/工具/最终消息用例保留跨平台断言，且不会把人工编写的模型输出记为遵从能力。
