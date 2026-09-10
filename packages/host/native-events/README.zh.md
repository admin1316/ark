# @deepseek-ai/dsh-host-native-events

[English](README.md) | 中文

Ark 原生事件流与交互响应的权威 Host 投影。该插件读取既有 Session、Agent、Workspace、任务、投影、授权与用户提问 owner，并不替代它们。它通过 `ctx.connection.events` 注册唯一的 `mux` 与 `host` producer，并通过 `ctx.connection.responses` 将待处理授权／提问帧与精确且仅限 loopback 的 `/api/respond` 载体配对。

mux 流发布会话订阅与事件、类型化工具视图、队列与任务快照、投影更新，以及具有稳定身份的授权／提问请求。重连会收到当前基线，并以同一 `rpcId` 重放所有仍待处理的交互。host 流发布会话生命周期与运行状态、Agent 错误、Workspace 变化、归档会话变化，以及 allowlist 内的严格 Remote 事件。来源释放会中止活跃代次，并只清理本包的内存关联表；持久领域状态仍由原有服务持有。

`@deepseek-ai/dsh-host-connection` 继续只负责传输：鉴权请求、持有 socket 生命周期并承载 envelope。本包持有 Native 投影与回答关联，因此不存在旧 API fallback 或第二套事件总线。

## 模型体验

### Native 事件投影

#### 模型看到的内容

不直接看到任何内容。本包传输已经提交的 Host 状态和人工回答，例如 `session/projection` 与 `/api/respond`；它不注册提示词、工具、消息、模型提供方或提供方请求。

#### Token 影响

不直接影响 token。人工回答之后可能通过其所属交互服务成为普通 Agent 输入，但本包不组装模型上下文。

#### KV Cache 影响

不独立影响；本包不会改变提供方请求字节。

## 已知限制与暂缓事项

- **待回答关联只存在于当前进程**：同一 Host 进程内重连会重放待处理授权和提问；Host 重启则依赖各领域自己的持久恢复约定，而不是序列化这张传输关联表。
- **大规模实时事件突发仍使用内存**：每条已连接下行流拥有一个生命周期有界的内存队列；额外的磁盘传输缓冲有意暂缓。
