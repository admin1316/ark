---
description: "正式 Agent Teams 领域的实验性 Remote 适配器，保留成员视图与任务变更接口。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

[English](README.md) | 中文

## 概述

本私有包通过 Typert 暴露成员视图与任务变更。[正式 Agent Teams 包](../../subagent/agent-team/README.zh.md) 负责成员身份、持久化消息、任务 CAS、恢复与释放。适配器依赖该服务，不注册第二套 Team 领域或持久化事件定义。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

只挂载一次领域服务，在 Remote 调用方需要成员视图或任务变更时添加适配器。领域限制配置在 `dsh-agent-team`，模型工具使用 `dsh-tool-agent-team`。[实验性配置层](../agent-team-profile/README.zh.md) 组合这三个插件。

<a id="smallest-working-setup"></a>
### 最小可用配置

已提供 Agent、Subagent 与持久化服务的运行时可添加：

```yaml
- name: '@deepseek-ai/dsh-agent-team'
- name: '@deepseek-ai/dsh-tool-agent-team'
- name: '@deepseek-ai/dsh-experimental-agent-team'
```

### 浏览器 Remote

`TeamRemoteAdapter` 注册 `ctx.agentTeamRemote`，保留 `agentTeams/view`、`agentTeams/createTask`、`agentTeams/updateTask` 传输命名空间。各方法要求精确的存活调用 Agent。`view` 返回当前成员和未删除任务。创建与更新返回显式领域结果：旧版本冲突映射为 `team-task-conflict`，其他 Team 拒绝映射为 `team-rejected`；意外异常仍作为传输失败。

`./remote` 导出生成的 Client 贡献；`./client` 保留仅类型的请求、视图和变更结果 DTO。根导出为既有导入重导出正式领域 API，默认导出是 Remote 适配器。释放适配器会移除它的注册；领域服务、存活成员和持久化状态仍由单独挂载的领域服务负责。

<a id="understand-the-implementation"></a>
## 理解实现

[`src/index.ts`](src/index.ts) 将 Remote 操作交给 `ctx.agentTeams`。[`src/types.ts`](src/types.ts) 只拥有 Remote 结果与聚合视图类型，共享领域类型来自正式包。[`src/invariant.ts`](src/invariant.ts) 注册空不变量伴生插件，因为适配器不拥有可变 Team 关系；正式领域的不变量伴生插件验证持久化转换。

<a id="further-exploration"></a>
## 进一步探索

- [正式 Agent Teams](../../subagent/agent-team/README.zh.md) — 领域限制、授权、持久化消息、任务 CAS 与生命周期。
- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md) — 共享类型与服务 API。
- [Team 工具](../../subagent/tool-agent-team/README.zh.md) — 作用域模型策略与工具 schema。

<a id="model-experience"></a>
## 模型体验

### Remote Team 操作

#### 模型看到什么

适配器不添加提示词或工具 schema。`agentTeams/createTask` 与 `agentTeams/updateTask` 修改正式领域的任务板；正式 Team 工具随后通过 `team_task_list` 结果呈现该状态。

#### Token 影响

Remote 成员读取与任务变更不增加对话 token。成员消息行为由正式领域负责。

#### KV Cache 影响

适配器不增加请求前缀内容。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 私有 Remote 契约属于实验能力，不进入正式发布载荷。
- 适配器要求挂载唯一正式 Team 领域，不能独立运行或提供跨进程协调。
- Remote 读取暴露当前任务板，不引入独立的持久化或生命周期所有者。

<a id="dev-note"></a>
### 开发备注

生成的 Remote 描述符保留实验包身份与 `agentTeams` 命名空间；Cordis 服务键为 `agentTeamRemote`。
