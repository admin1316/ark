# @deepseek-ai/dsh-host-connection

[English](README.md) | 中文

原生 API 客户端的 Host 传输 owner。该插件注册唯一的 `/api` 前缀、`/api/events/mux` 与 `/api/events/host` WebSocket upgrade，以及严格 RPC 拦截、`/api/respond`、精确下载和事件 producer 的作用域注册表。`@deepseek-ai/dsh-api-gateway` 动态拦截严格斜杠 Remote 调用；各领域 owner 注册自己的下载或事件 handler。Connection 包只持有物理传输、请求 authority、关联 envelope 与 socket 生命周期，不再存在点号 RPC fallback。

每个请求都必须携带 loopback `Host` 或来自 `trustedHosts` 的规范 authority；监听器还会独立要求本次启动专属的 bearer token。特权严格斜杠方法与敏感下载仅限 loopback，格式错误的受信 authority 会让插件加载失败。两条 WebSocket 路径只负责下行；Host teardown 会终止已接受的 socket、中止其来源，并等待来源完成清理。

`./protocol` 子路径是路由常量、loopback hostname 分类与共享 RPC 接口的唯一 owner。原生客户端镜像这份协议格式，无需导入任何 Host 实现代码。

## 模型体验

### Native API 传输

#### 模型看到的内容

无。本包只承载 `/api` 等已经组合好的 API 值，不注册面向模型的上下文。

#### Token 影响

不直接影响 token；本包既不组装也不发送提供方请求。

#### KV Cache 影响

本包不修改模型请求，因此不独立影响模型内容缓存。

## 已知限制与暂缓事项

- **请求体会整体缓冲在内存中**：`maxRequestBodyBytes` 默认 300 MiB，使默认 200 MiB 图片总量在 base64 膨胀后仍可容纳；要降低驻留成本，需要流式请求体载体。
- **受信 Host 是可达性策略，不是认证**：非 loopback 部署在暴露特权能力前仍需要认证层。
