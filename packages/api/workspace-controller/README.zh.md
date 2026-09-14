---
description: "Host Workspace follow 流，以及基于权威 Workspace Registry 的目录选择操作。"
kind: "package-reference"
---
# Workspace Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-workspace-controller` 拥有 Host 的 `ctx.workspaceController` 和 `workspace/follow` 流。`@deepseek-ai/dsh-workspace` 是工作区列表、创建、重命名、删除、排序、归档、恢复及永久删除已归档会话的唯一 Remote 所有者。本包同时拥有 `ctx.directoryPickerController` 与生成的 `ctx.remote.directoryPicker` namespace，因为它承载的选目录 seam 是抽象的，自身从不作为 Loader entry。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Workspace Registry 串行执行变更，在 Remote 传输结果内返回核心领域结果。消费方必须解开两层结果，才能将变更视为成功。空白名称返回 `arguments-invalid`；非法会话排序的诊断详情保留工作区、会话及可选锚点标识。它的 `follow()` 流会同步订阅持久 Workspace 变更，先发出一份完整 baseline，再按顺序发出 `upsert`、`remove`、`order` 和 `archived` 增量。重连会以替换 baseline 开始新一代，因此消费方不依赖收到断线期间的每个增量。


-----

<a id="model-experience"></a>
## 模型体验

无，因为 Workspace 组织属于Host 控制状态，并且不注册提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；Workspace 变更不会改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `follow()` 在重连后替换完整投影，不提供持久 cursor 或增量追赶协议。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
