---
description: "面向交互式 UI 的人类斜杠命令注册表：插件拥有的命令直接针对 agent 执行，不产生模型消息；供组合或扩展命令面的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-commands

[English](README.md) | 中文

## 概述

`dsh-commands` 让用户能在交互式 Harness UI 中输入 `/command [input]`，并直接针对接收命令的 agent（智能体）执行，不产生模型消息。插件注册命令时提供名称、描述、可选的输入提示与图片接受标志，以及可中止的处理器；交互式适配器按 agent 发现并分派这些命令。挂载在 agent 上下文之下的命令生产插件可以注册精确限定到该 agent 的命令，它会遮蔽同名的全局定义。每次命令执行都会记录在接收 agent 的会话日志中，结果由适配器渲染，绝不进入模型历史。斜杠命令随 `dsh` CLI 与 Web 客户端一起提供。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当交互式 UI 希望用户用斜杠命令而非模型提示词驱动 agent 侧行为时，组合此服务。无 UI 的演示主干和 ACP（Agent Client Protocol）自动化不提供命令适配器，也不需要它。

### 注册命令

插件用 `ctx.commands.register()` 注册命令：小写名称、在发现界面中展示的描述、可选的 `input` 提示，以及针对接收 agent 运行的处理器。

```text
ctx.commands.register({
  name: 'plan',
  description: 'Enter plan mode',
  input: { hint: '<message>' },
  handler: ({ agent, rawInput }) => {
    // Runs directly against the agent; no model message is created.
    return { kind: 'success', text: 'plan mode selected' }
  },
})
```

处理器返回 `success` 或 `error`，并可附带由适配器渲染的 UI 文本。`recordInput` 默认为 true；若载荷由命令自己的权威领域事件持有，命令会将 `recordInput` 设为 false，避免会话日志重复记录该输入。同一作用域内重复注册同名命令会抛出异常。

### 命令语法

命令行的第 0 字节必须是斜杠，随后是小写名称（可含字母、数字、`_` 或 `-`），再之后是输入末尾或空白。名称之后的每个字节——包括分隔空白——都是该命令的 `rawInput`，命令自己拥有其专属语法。不符合命令语法、或名称未知的行会被适配器拒绝，而不是变成模型提示词。

### 限定到 agent 的命令

普通注册全局生效。挂载在 agent 自身上下文之下的命令生产插件会声明 `commands` 注入，并注册精确限定到该 agent 的命令；该定义只对这个 agent 遮蔽同名的全局定义。

### 图片附件

命令可以声明 `input.images` 以接受 composer 图片附件。执行器负责声明的强制执行：把图片发给未声明的命令、附件存储缺失或批量超出限制，都会在处理器运行前以错误结果结算。通过准入的图片以冻结的有序 `ImageBlock` 数组挂在 `invocation.attachments` 上交给处理器，其模型可见用途由处理器负责——注册表本身绝不定时调度它们。

### 从适配器分派

原生适配器向 `session/command` 提交 `sessionId`、调用方已保存的 `invocationId`、确切的 `line` 和有序 `images`。Host 在解析 Agent 前先检查活跃或冷会话回执。`completed` 回放持久结果，`running` 观察同一次所属执行，`unknown` 保留身份且不重复处理器。相同身份对应不同内容时失败；同一会话的新调用不能排队等待活跃命令。`list(agent)` 与 `find(agent, name)` 在应用 agent 作用域遮蔽后服务发现。同进程适配器可以显式使用 `executeLocal(agent, line, images, signal)`；该方法没有 Remote 路由，也不提供持久重试约定。

### 取消

Host 独立于响应传输拥有持久命令的取消。调用方断线后可以查询同一身份，同时处理器继续保持活跃。退出会等待已经进入的处理器；不配合取消的工作仍在运行时，系统不能发布终态记录。重启后，已有持久开始记录却没有确认终态的命令返回 `unknown`。仅限本地的分派会在调用方中止时停止等待，因此处理器必须配合才能停止外部副作用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

可观察行为已在[使用本包](#use-this-package)中说明；本节解释注册表的构建方式与其约定的归属。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `CommandRuntime` 服务：注册、作用域、分派、生命周期事件 |
| [`src/types.ts`](src/types.ts) | 命令定义、描述符、执行与结果类型 |
| [`src/brand.ts`](src/brand.ts) | 生命周期配对 id 的 `CommandId` brand |
| [`src/receipts.ts`](src/receipts.ts) | 基于现有日志事件的输入摘要和仅 Host 回执投影 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：按会话日志配对 `command/run` 与 `command/done` |

### 生命周期事件

持久 `execute()` 在进入处理器前刷盘携带调用身份和输入摘要的 `command/run`，并在返回 `completed` 前刷盘 `command/done`。成功结果可以通过 `sourceEventSeq` 指向更早的权威领域事件；处理器异常成为终态错误结果。两个事件都是独立的仅写日志追加，没有轮次包裹。回执投影引用这些原始记录，不另建账本。持久化屏障失败时返回 `unknown`，绝不会因此允许再次运行处理器。未通过准入的输入（语法无效或名称未知）不记录任何事件。仅限本地的分派在常规检查点和销毁时持久化。

### 作用域

注册表通过 `ScopedLayers` 维护全局层与按 agent 的作用域层，并按 agent 合并视图。子级注入形态——挂载在 `agent.ctx` 之下的命令生产插件声明自身的 `commands` 注入——保留了 agent 作用域，同时不会让核心 agent loop 依赖 UI 服务。同一层内的名称重复会在注册时失败；注册或移除命令时，系统会通知每个 `commands/change` 观察者，使运行中的适配器能够刷新发现结果。观察者失败会写入日志，既不能否决注册表变更，也不能阻止后续观察者运行。

### 图片准入

图片强制执行发生在执行器而非 composer 中：通过准入的批量经 `admitEncodedImages` 提交给 `attachments` 存储，被拒绝的批量不发布任何持久化对象；取消会在处理器运行前被处理，因此重试的调用方绝不会重复状态。无法使用图片的处理器会返回错误，使分发方 composer 保留原件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享命令词汇逐步进入设计证据与相邻表面。

- [命令子系统参考](../../../docs/subsystems/commands.zh.md)——注册表语义、输入元数据与 `ctx.commands` 的 cordis 接口面。
- [命令注册 Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-plugin-command-registration.zh.md)——此服务背后的边界与分发约定。
- [交互组映射](../README.zh.md)——相邻的审批、权限与问答包。
- [Plan mode 包](../../plan/plan-mode/README.zh.md)——一个驱动模型可见工作的随附命令生产方。

-----

<a id="model-experience"></a>
## 模型体验

### 直接面向用户的命令

#### 模型看到的内容

注册表自身不会提交任何内容。已知斜杠命令在 UI 命令平面执行，其 `CommandResult` 文本不会作为用户消息提交。已交付的适配器会拒绝未知斜杠命令输入，而不是将其变成模型提示词。命令生产方可以显式使用接收命令的 `Agent`；例如，[`dsh-plan-mode`](../../plan/plan-mode/README.zh.md#model-and-human-interactions)在选择 plan mode 后，会提交 `/plan [message]` 中的可选消息。图片附件遵循同一规则：执行器只负责把它们准入为持久化附件对象，是否以及如何成为模型可见的消息内容由声明接受的生产方决定。

#### Token 影响

命令发现、执行和 UI 输出不会增加模型 token。命令生产方显式安排的 agent 工作与相应 agent 输入具有相同的 token 影响。

#### KV Cache 影响

注册表元数据、命令输入和直接输出绝不会进入模型请求，也不会影响其缓存。发生变更的领域负责之后产生的所有缓存影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明注册表不提供什么。它们是当前包约束，不是 UI 积压事项。

- **仅支持非结构化文本输入**：表单、补全 schema 和类型化参数仍由各命令自行解析。
- **外部副作用由处理器负责**：持久回执会阻止自动重复处理器，但不能保证外部系统中的副作用恰好一次；结果中断时需要检查，而不是自动重试。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
