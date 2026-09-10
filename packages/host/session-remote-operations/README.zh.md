# @deepseek-ai/dsh-host-session-remote-operations

[English](README.md) | 中文

生成式 `session/*` Remote 端口与 `workspaceSessionRetirer` 能力的 Host 实现。本包组合现有的 Agent、会话持久化/查询/投影、Workspace、LLM、附件、标题、工具呈现、预设、队列与任务 owner；它不建立第二份会话正文、投影、工作区、附件或模型目录缓存。

`SessionRemoteOperationsService` 实现 `list`、`search`、`create`、`history`、`models`、`selectModel`、`rename`、`fork`、`prompt`、`attachment`、`updateQueue` 与 `cancel`。创建和恢复按会话身份 single-flight。`AgentRegistry` 返回的句柄由本服务作为精确能力保留，所以永久删除只能退休由该 Host 创建或恢复、且当前空闲、已归档的根 Agent。后代删除顺序、持久化 reservation、日志持久删除、工作区记账和归档状态提交仍由 `WorkspaceRegistry` 负责。

同一服务还持有通过 `ctx.connection.downloads` 注册的精确 `/api/session/export` GET/HEAD 下载。它会在读取原始持久工件前 flush 实时会话，可选包含后代和引用媒体，以有界 ZIP 流式输出并支持取消；缺少持久化、查询或附件 owner 时，会在产生响应 body 前明确失败。

编码器或生产者失败会使响应 body 报错；迟到的编码器回调不能将其变成成功的归档。消费方取消会等待生产者清理，并报告清理失败。[导出决策](../../../.agents/notes/implemented/feature/2026-08-10-web-session-log-export.zh.md#terminal-failure-and-cancellation)定义了首个原因的优先级与验证限制。

每次修改前及异步读取前后都会检查取消状态。历史与列表直接读取权威服务；投影或工具呈现失败只降级可选 view。读取图片前必须证明该附件引用存在于目标会话日志中，队列编辑仅接受文本块。

## 提示调用身份

子会话历史调用方可以提供 `expectedParentSessionId`。历史所有者在渲染事件前将其与实际来源 header 比较，因此先前的目录查找不能授权读取父身份不同的替换 Session 分页。不匹配时返回 `subagent-unauthorized`，不返回分页数据。

每个 `SessionRemotePromptRequest` 都携带必填的、不透明的 `invocationId`。本服务校验该身份，并把它与可选的规范化客户端时区一起持久化到准确的用户消息来源中。这样可以保留乐观消息对账能力，同时不会把传输层 RPC 身份泄漏进 Session 领域。

以斜杠开头的行首先由命令注册表解析。没有命令认领时，本服务查询当前 Agent 的 skill 注册表，仅允许名称精确匹配且用户可调用的 skill，并保持用户文本不变，交由 `dsh-tool-skill` 在 `agent/pre-step` 注入；其他未匹配的斜杠行均返回 `unknown-command`。

## 模型体验

### 会话级模型路由

#### 模型看到的内容

本服务不增加面向模型的工具或提示文本。它把 `SessionRemotePromptRequest` 中选定的提供方、模型和推理路由接入 Agent 现有的请求路径，实际模型内容仍由组合后的 Agent 负责。

#### Token 影响

本服务不直接影响 token；请求大小由所选 Agent 组合、prompt、工具描述和提供方决定。

#### KV Cache 影响

本服务按会话保留所选路由，不增加模型内容；更换提供方、模型、推理路由或组合后的 prompt 可能使提供方侧复用失效。

## 已知限制与暂缓事项

- **原始工件要求**：所选持久化后端无法提供逐会话原始工件时，会话导出返回 501；本包绝不会从解析后的事件重建近似日志。
