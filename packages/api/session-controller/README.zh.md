---
description: "Host 会话操作、历史流及基于权威 Session 服务的实时控制基线。"
kind: "package-reference"
---
# Session Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-session-controller` 保留桌面操作、历史日志流、生命周期通知与不激活 Agent 的 `skills/list`。其 `session` contribution 仅声明 `modelCatalog`、`canOpenWorkspacePath`、`openWorkspacePath`、`page`、`follow` 和 `control`。list/search/create/selectModel/rename/fork/prompt/attachment/updateQueue/cancel 由 core SessionStore 唯一声明并交给 Host SessionRemoteOperations 实现，本包不再保留第二条写入路径。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

历史页与 follow opening snapshot 携带带判别字段的 `SessionHistoryRecord`。两个分支都使用 `{ type, event }`：`type: 'event'` 携带一个原始 `SessionWireEvent`，`type: 'chunks'` 则携带一个由连续且属于同一 block 的 `assistant/chunk` delta 组成的无损 `ChunkRowEvent`。两种内部值都公开 `type`、`seq`、`time` 与 `data`，因此协议消费方无需展开打包成员即可校验每条记录。packed event 的 `seq` 与 `time` 表示首成员，`data` 保留 fragment 与 timestamp-gap 数组。实时 follow frame 继续携带单个 `event` record。工具参数、结果内容、失败信息和 `tool/result.data.meta` 原样通过；controller 不解析 Tool definition、不运行 presenter，也不附加 UI 数据。

每个 endpoint 都声明自己的激活策略。列表、搜索、附件、历史页、日志跟随、skill 发现和工作区路径打开可以在不激活 Agent 的情况下检查 persistence；`canOpenWorkspacePath()` 无需指定 Session 即可报告原生打开能力。queue 变更与取消要求 live 状态；模型、重命名、prompt 和文件引用操作可以解析或恢复普通 Session。只有 create 与 fork 会直接创建新 Agent。skill 目录则优先使用已有 live Agent，否则使用所记录 preset 的常驻 scope，因此列表查询绝不会启动 Agent。

消费方必须校验连续的逻辑覆盖范围：普通记录覆盖 `[event.seq, event.seq]`，打包行覆盖 `[event.seq, event.seq + memberCount - 1]`。每次 follow 开头都先提供基线，再发送后续事件；每个 control generation 为队列、job 和投影提供完整的进程内基线。[Native 历史所有者](../../host/session-remote-operations/README.zh.md)定义 Ark 使用的来源绑定语义分页、原始事件恢复和内容流。

提示词接受与重试身份由 Host SessionRemoteOperations 负责。Control 读取方接受历史 `rpcId` 与当前 `invocationId` 来源；队列项保留 `SessionQueuedItem.rpcId` wire 字段。待发送 UI 草稿和乐观渲染由 Native 消费方负责，不属于本 controller。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `nativeOpen` | 平台探测 | 是否能把 Session 工作区路径交给原生桌面打开器 |

冷列表 `coldBlankProbeMaxBytes` 已归属 Host SessionRemoteOperations Config，默认 1,024 个物理字节，0 禁用探测。旧 controller 的显式配置需迁移到该 owner。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-session-controller)是所有受支持字段及其 JSDoc 的完整来源。

-----

中立的 `agent-default-model` 唯一注册既有 modelSelection 投影，并让入口共用同一个 Agent 请求组装适配器。选择通过验证后先记录当前意图，再保存未来默认值；默认保存失败不撤销已接受选择。canonical unary 的 Session 业务结果位于生成载体结果内层，API 消费方分别解包两层。

<a id="model-experience"></a>
## 模型体验

无直接内容，因为本包负责 Session API 与传输，模型可见的影响由其调用的 Agent 命令决定。

#### KV Cache 影响

无直接影响；模型请求仍由 Agent 和 LLM 包拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Control baseline 表示进程本地状态，因此 Host 重启后无法重建 jobs。
- 文件引用补全使用共享 Agent lookup，因此可能恢复冷 Session；`skills/list` 目录是不激活 Agent 的 skill 元数据读取路径。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

文件引用的 `fileReferences/list` 唯一 owner 是 `@deepseek-ai/dsh-file-reference`；本包不再声明或挂载重复 adapter。它仍使用共享 Agent lookup，原 provider 的发现与取消行为不变。`skills/list` 则保留：它按 Session 读取冷来源而不激活 Agent，与 core `skill/list` 的 Agent 寻址接口不同，不属于重复 endpoint。
