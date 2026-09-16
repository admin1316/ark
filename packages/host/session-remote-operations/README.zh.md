---
description: "生成式 session/ Remote 端口与 workspaceSessionRetirer 能力的 Host 实现。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-session-remote-operations

[English](README.md) | 中文

## 概述

生成式 `session/*` Remote 端口与 `workspaceSessionRetirer` 能力的 Host 实现。本包组合现有的 Agent、会话持久化/查询/投影、Workspace、LLM、附件、标题、工具呈现、预设、队列与任务 owner；这些服务仍是各领域的权威来源。历史读取保留有界的数值索引和有明确释放时机的正文物化结果，不建立第二份持久会话日志，也不替换既有投影、工作区、附件或模型目录 owner。

`SessionRemoteOperationsService` 实现 `list`、`search`、`create`、`history`、`models`、`selectModel`、`rename`、`fork`、`prompt`、`attachment`、`updateQueue` 与 `cancel`。创建和恢复按会话身份 single-flight。`AgentRegistry` 返回的句柄由本服务作为精确能力保留，所以永久删除只能退休由该 Host 创建或恢复、且当前空闲、已归档的根 Agent。后代删除顺序、持久化 reservation、日志持久删除、工作区记账和归档状态提交仍由 `WorkspaceRegistry` 负责。

同一服务还持有通过 `ctx.connection.downloads` 注册的精确 `/api/session/export` GET/HEAD 下载。它会在读取原始持久工件前 flush 实时会话，可选包含后代和引用媒体，以有界 ZIP 流式输出并支持取消；缺少持久化、查询或附件 owner 时，会在产生响应 body 前明确失败。

编码器或生产者失败会使响应 body 报错；迟到的编码器回调不能将其变成成功的归档。消费方取消会等待生产者清理，并报告清理失败。[导出决策](../../../.agents/notes/implemented/feature/2026-08-10-web-session-log-export.zh.md#terminal-failure-and-cancellation)定义了首个原因的优先级与验证限制。

每次修改前及异步读取前后都会检查取消状态。历史与列表直接读取权威服务；投影或工具呈现失败只降级可选 view。读取图片前必须证明该附件引用存在于目标会话日志中，队列编辑仅接受文本块。

普通消息重试复用 `source.invocationId`：已有匹配回执只确认原消息，不重复入队，也不恢复冷 Agent。相同身份携带不同内容、模式或时区会被拒绝。成功确认要求完成持久化。`prompt-durability-unconfirmed` 且 `accepted: true` 表示消息已经接收，调用方重试时必须保留原身份。命令副作用以及回执落盘前的进程崩溃不在此保证内。

## 目录

- [历史视图](#history-views)
- [提示调用身份](#prompt-identity)
- [Session 单一入口与低成本列表](#canonical-session-ownership-and-cheap-listing)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="history-views"></a>
## 历史视图

原始请求使用 `maxEvents`（1–2048，默认 2048）限制事件条数。`maxMessages` 保留消息组上限语义；同时提供时，分页在先达到的边界停止。原始事件分页可以截断一条消息，完整内容仍由语义视图提供。

根会话 `history` 请求省略 `view` 和 `sourceRevision` 时，保留旧 `beforeSeq`/`maxMessages` 事件分页契约和可选投影基线。显式 `view: 'raw'`、提供 revision 或携带子会话 mode 准入时，使用与语义读取相同的、有租约的不可变 observation。原始响应必含 `view: 'raw'`、`sourceRevision` 和 `asOfThroughSeq`，不附带投影基线。revision 可以来自语义分页或绑定来源的原始分页；后续每页都提交该 revision，exclusive `beforeSeq` 不会超过固定 cut。有界原始分页不等于完整消息。已挂载会话复用 Session 缓存的冻结事件前缀，不再额外复制一次；不含工具事件的原始分页不构建语义索引，也不解析预设 scope。

`view: 'semantic'` 通过 `sessionQuery.observeSession` 读取不可变 cut。响应包含有界的消息/工具描述、`sourceRevision`、`asOfThroughSeq`、`turns` 和 `dependencyRecords`。读取更早分页时，发送同一 revision，并把 `nextBeforeRecordId` 作为 `beforeRecordId`。记录身份区分重试 attempt，在对应流式回答形成最终消息后保持稳定。最终和中断消息使用权威 `assistant/message`；活动、失败和孤立前缀复用 Agent 循环已有的 `BlockAssembler` 恢复可读文本与推理。预览只是有界摘录，完整正文另行读取。

实时 revision 绑定实际 Session 实例代次和固定 cut：追加保留旧 cut，替换或消失会使其失效。冷会话 revision 绑定持久化 owner 提供的来源及版本；包括追加在内的任何持久变化都会使该 cut 的后续读取失效。正在进行的冷读取会保留原不可变来源租约直到呈现结束，不在每个 await 前后重新 stat 文件。来源无效时返回 `history-stale-source`。数值索引被淘汰不会使游标失效：只要来源仍有效，就可以重建同一 cut。

### 完整正文与读取器生命周期

`view: 'content'` 接收 revision 和消息或依赖记录 ID。首次从 offset 零开始读取并获得 `contentReadId`；续片发送该句柄和返回的 `nextOffset`。必须拼接 `encoding: 'json'` 的片段后再解码。offset 按 UTF-16 代码单元计数，边界不会拆开代理项对。每次初始读取只物化一次准确正文，即使正文超过普通内容预算也是如此；续片不会重建正文、数值索引或完整 observation。实时续片直接检查 Session 身份及元数据，冷会话续片使用轻量持久化快照。

`done` 会释放物化结果。客户端放弃未完成读取时，应携带绑定的读取器身份发送 `close: true`；正文 owner 在来源替换后仍可关闭。子会话路由仍要求目录与 mode 准入，因此子会话被删除或重新分类后，关闭可能被拒绝，正文改由空闲超时释放。空闲超时和 Host 销毁也会释放读取器。Abort 会停止进行中的工作，但不能替代客户端对已物化读取器的显式关闭。遇到 `history-content-busy` 时，需要先完成或关闭已有读取；遇到 `history-content-expired` 时，需要重新发起初始读取，不会悄悄换一份正文继续。

### 呈现依赖

`dependencyRecords` 中的工具、状态和轮次 ID 通过同一正文读取器返回独立 bundle，其 revision 和 cut 与分页完全一致。bundle 包含真实领域事件、`completeness` 和明确的 `missing` 关联缺口。工具 bundle 保留配对调用参数、工具 owner 的呈现结果、PTC 调度和独立 workflow 运行/成员记录；状态 bundle 保留命令、压缩、请求、重试及轮次历史。每份物化正文仅解析一次历史工具预设 scope，使用 cut 及之前的最近选择；非工具条目不解析预设 scope。

轮次 bundle 使用 `chunkCoverage: 'timing-boundaries'`：保留计时证据，不包含全部原始 chunk。完成轮次的精确用量由现有严格 `deriveTurnTokenUsage` owner 对全部原始轮次事件计算一次；无法证明的用量为 `null`，不会补造可选缓存、推理或路由数值。不得将这些 bundle 当作完整原始证据喂给实时用量累加器。

消费方在每个 revision 下只安装一次全局依赖 bundle，并限制可见呈现行的数量。普通翻页不得重新读取、重放全部全局 bundle。这些独立 seed 不推进连续原始事件或实时游标。

### 内存边界

`Config.semanticHistory` 控制复用和读取器准入。默认最多保留八份数值索引，采用保守的 16 MiB 计费上限；最多允许八个正文读取器，普通预算为 8 MiB，空闲 60 秒后过期。同一时间只允许一份初始正文物化。单条超大消息可占用超大正文槽，直到完成、关闭或过期；竞争读取返回 `history-content-busy`，不会在续片之间淘汰该正文。这不是任意大小消息都适用的绝对内存上限。

语义读取 owner 不保留原始事件数组，也不跨请求持有 prepared lease。Session 在追加后仍可能创建一次冻结快照，既有持久化 preparation 缓存仍按条数限制，而非按字节或 TTL 限制。因此，上述配置不能证明整个进程具有总内存上界。

<a id="prompt-identity"></a>
## 提示调用身份

子会话历史调用方可以提供 `expectedParentSessionId`。历史所有者在渲染事件前将其与实际来源 header 比较，因此先前的目录查找不能授权读取父身份不同的替换 Session 分页。正文读取也执行该检查；不匹配时返回 `subagent-unauthorized`，不返回内容。子会话来源必须同时提供父身份和 `expectedSubagentMode`，缺失即拒绝。实际 observation 中已注册的子会话投影，必须证明固定 cut 内存在属于本会话后缀且 mode 匹配的 descriptor；此前的目录查询不能授权另一份来源。实时 descriptor 变化也会撤销未完成的正文读取器。这里复用已有 descriptor 投影，不引入另一套解析器。

`subagent/history` 保留父会话、子会话、mode 参数及外层 Remote result。第 4 个参数仍名为 `beforeSeq`，可传旧数值游标或 raw/semantic/content 类型化选项；传选项对象时省略独立的 `maxMessages` 参数。路由对每次分页、续片和关闭都执行既有子会话目录与 mode 准入，再自行填入父身份和 mode。读取不会恢复任一 Agent。

每个 `SessionRemotePromptRequest` 都携带必填的、不透明的 `invocationId`。本服务校验该身份，并把它与可选的规范化客户端时区一起持久化到准确的用户消息来源中。这样可以保留乐观消息对账能力，同时不会把传输层 RPC 身份泄漏进 Session 领域。

以斜杠开头的行首先由命令注册表解析。没有命令认领时，本服务查询当前 Agent 的 skill 注册表，仅允许名称精确匹配且用户可调用的 skill，并保持用户文本不变，交由 `dsh-tool-skill` 在 `agent/pre-step` 注入；其他未匹配的斜杠行均返回 `unknown-command`。

<a id="canonical-session-ownership-and-cheap-listing"></a>
## Session 单一入口与低成本列表

共享 Session 方法由 core SessionStore 唯一声明 Remote；旧 controller 仅保留不同的桌面与 stream 操作。列表与搜索可见性复用 SessionQuery 的 corpus header。列表读取现有 live/cold 投影提示，未知冷文件仅在物理大小不超过 `Config.coldBlankProbeMaxBytes` 时才观察（默认 1,024 字节，0 禁用），每批最多 16 个。大文件或无法访问的 cache miss 保持未知且可见；提示可能陈旧，缺失的 preset 列不能由创建 header 冒充。搜索不触发列表摘要的观察，并在每次 provider await 后检查取消。

队列编辑在变更 inbox 之前拒绝非文本与空白内容。模型选择复用中立 agent-default-model 的投影与组装 owner，无 controller 时也恢复 pending 意图；先追加既有 model/selection 事件，再保存未来默认值，默认保存失败不撤销已接受路由。

<a id="model-experience"></a>
## 模型体验

### 会话级模型路由

#### 模型看到的内容

本服务不增加面向模型的工具或提示文本。它把 `SessionRemotePromptRequest` 中选定的提供方、模型和推理路由接入 Agent 现有的请求路径，实际模型内容仍由组合后的 Agent 负责。

#### Token 影响

本服务不直接影响 token；请求大小由所选 Agent 组合、prompt、工具描述和提供方决定。

#### KV Cache 影响

本服务按会话保留所选路由，不增加模型内容；更换提供方、模型、推理路由或组合后的 prompt 可能使提供方侧复用失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **Native 接入**：上述 Host 视图和独立 seed 已实现，但接口存在不代表 Native 已完成接入，也不代表 GUI 或性能已验收。
- **冷会话活动回答续接**：可读 `assistant-prefix` 不是可恢复的 indexed assembler checkpoint。Host 已提供绑定 revision 的原始分页和子会话语义转发，但 Native 仍需收集、校验完整连续的活动轮次范围，再安装可继续流式接收的恢复 checkpoint。
- **原始工件要求**：所选持久化后端无法提供逐会话原始工件时，会话导出返回 501；本包绝不会从解析后的事件重建近似日志。

历史 `fork` 可传 `sourceRevision`（来自语义或绑定来源的原始分页，已包含固定 cut）和 `atSeq`。子会话还须传相同的 `expectedParentSessionId`、`expectedSubagentMode`。Host 从最初的不可变 observation lease 选取 seed，锚点及完成回合不能越过 cut，预设也从该 seed 解析。异步 scope 设置完成后复用同一观察 owner 验证 revision，并在 Agent 同步 publication commit 前后验证来源；已观察到换源、截短或子会话身份变化会返回 `history-stale-source`。后续追加不能混入 seed。冷源 lease 保持至整个调用结束；提交前会重读并比较 durable revision，但不声称与外部进程改写文件全局互斥。不传 revision 的旧 fork 调用保持原边界语义。

<a id="dev-note"></a>
### 开发备注

无。
