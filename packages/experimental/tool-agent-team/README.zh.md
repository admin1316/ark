---
description: "正式 Agent Teams 作用域模型工具的兼容入口。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

[English](README.md) | 中文

## 概述

本私有兼容入口重导出[正式 Team 工具](../../subagent/tool-agent-team/README.zh.md)。策略文字、schema、成员作用域安装、预设处理与释放直接使用该实现，依赖正式 `ctx.agentTeams` 领域。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

既有私有组合可加载本包代替 `@deepseek-ai/dsh-tool-agent-team`。在 `@deepseek-ai/dsh-agent-team` 旁只挂载这两个工具入口之一。`freshProvider`、`forkProvider` 配置和十个作用域工具保持一致。[正式包](../../subagent/tool-agent-team/README.zh.md) 负责精确策略、授权、错误与共享工作区限制。

[实验性配置层](../agent-team-profile/README.zh.md) 直接挂载正式工具并添加独立 Remote 适配器，禁用重叠的全局可继续子代理工具，保留一次性委派。

<a id="understand-the-implementation"></a>
## 理解实现

[`src/index.ts`](src/index.ts) 重导出正式函数插件的 `name`、`inject`、`Config`、`apply`，不拥有第二套工具安装器或提示策略。包专属的 [`src/invariant.ts`](src/invariant.ts) 伴生插件不拥有可变关系，持久化验证由 Team 领域负责。

<a id="further-exploration"></a>
## 进一步探索

- [正式 Team 工具](../../subagent/tool-agent-team/README.zh.md) — 行为、配置与作用域生命周期。
- [正式 Agent Teams](../../subagent/agent-team/README.zh.md) — 成员、消息与任务板。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team) — 此兼容入口的 schema。

<a id="model-experience"></a>
## 模型体验

### Team 策略与工具

#### 模型看到什么

正式 `dsh-tool-agent-team` 实现提供 Team 角色策略与作用域 schema，包括 `spawn_teammate` 和 `team_task_update`。创建团队要求用户明确请求；本入口不添加自己的策略。

#### Token 影响

正式策略与 schema 产生正常请求开销，工具结果与已投递成员消息保持正式领域的行为。

#### KV Cache 影响

成员、配置与插件代次相同时，策略前缀保持稳定。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 本私有兼容入口不进入正式发布。
- 同时挂载两个工具入口会重复注册，每个组合只使用其中一个。
- 共享工作区协调不提供文件系统隔离或约束。

<a id="dev-note"></a>
### 开发备注

工具行为变更归正式包所有，本入口只保留实验性导入路径。
