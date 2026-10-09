---
description: "供 dsh 可执行应用复用的 profile 生命周期。"
kind: "package-library"
---

# `@deepseek-ai/dsh-profile-runner`

[English](README.md) | 中文

## 概述

供 dsh 可执行应用复用的 profile 生命周期。`runProfile()` 根据调用方显式提供的 `installAnchor` 组合 bundle 层、profile 与 home patch、命令行 overlay、遥测策略、失败即停启动和有界退出。通用应用默认保留 patch 热监视；受管应用设置 `watchLiveConfig: false`。

本包也是 Native-safe 的 `standard`、`code`、`minimal` 三套系统 preset 的唯一发布真源。应用可通过 `additionalSystemPresetRoots` 增加独立系统根；通用 CLI 用该入口装入 CLI-only 的 `cordis` preset，不复制共享资产。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="model-experience"></a>
## 模型体验

### 所选系统 preset

#### 模型看到的内容

runner 不增加面向模型的内容。应用所选的 preset 负责作用域 prompt section 与工具。共享的 `standard` 与 `code` persona 指导整轮输出合规与精确算术，不会校验或过滤生成的输出；`minimal` 保留其完整 persona。

##### 共享 standard/code 指导语

```markdown
Follow the user's requested output format throughout the entire turn, including before and between tool calls. For output-only requests, make necessary tool calls without optional user-facing narration, then emit only the requested result. If the user requires a single JSON value, emit that value in the requested shape without greetings, plans, progress updates, Markdown fences, or surrounding explanation. Do not invent a result to satisfy an output format. When exact arithmetic is required, parse decimal inputs exactly, keep ratios as integer fractions, and apply rounding only at the requested stage using the specified rule. Do not treat an approximation as exact merely because it uses high decimal precision.
```

#### Token 影响

这是间接且取决于 preset 的影响：请求大小由所选 preset 的 prompt 和工具描述决定。

#### KV Cache 影响

runner 保留所选 preset 的请求前缀；更换 profile、preset 或挂载的插件配置可能使该前缀的复用失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 实时 patch 监视属于进程级能力，仅面向通用 CLI 应用；受管产品必须显式关闭。
- 额外系统根必须使用唯一 preset id，因为两个系统 owner 不能定义同一个随附 preset。
- Persona 指导不能保证输出合规或算术正确；必须独立核验完整的普通助手输出与计算结果。

<a id="dev-note"></a>
### 开发备注

无。
