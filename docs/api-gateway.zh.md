# 原生 Host API

[English](api-gateway.md) | 中文

本文记录供原生桌面客户端使用的鉴权 API-only Host。它不包含浏览器应用、静态前端、Client 插件运行时、HTML index 或公开 Web route。Headless、ACP（Agent Client Protocol）与 SDK 应用使用各自的直连或 stdio 传输，不挂载这个监听器。

## 运行时组装

Ark 启动专用的 [`dsh-native-api-runner`](../packages/boot/native-api-runner/README.zh.md)；该 runner 只能引导受管理 profile，且不依赖通用 `dsh` CLI（命令行界面）。该 profile 把 [`dsh-base`](../packages/bundle/base/README.zh.md)与 [`dsh-native-api-app`](../packages/bundle/native-api-app/README.zh.md)组合起来。

| 包 | 职责 |
|---|---|
| [`dsh-api-gateway`](../packages/api/gateway/README.zh.md) | 严格斜杠 Remote 分派，以及生成式参数/结果校验 |
| [`dsh-api-remotes`](../packages/api/remotes/README.zh.md) | 共享 Agent/Session 解析，以及可转发 Host 事件的允许名单 |
| [`dsh-host-connection`](../packages/host/connection/README.zh.md) | 鉴权 `/api` 载体、关联、精确下载、响应与事件 WebSocket |
| [`dsh-host-native-events`](../packages/host/native-events/README.zh.md) | 原生事件投影与回答关联 |
| [`dsh-host-session-remote-operations`](../packages/host/session-remote-operations/README.zh.md) | Session Remote 实现与流式 Session 导出 |
| [`dsh-host-webserver`](../packages/host/webserver/README.zh.md) | 鉴权 loopback 监听器，以及 HTTP/upgrade route 生命周期 |

原生组合包把监听器固定在 `127.0.0.1`，默认请求由操作系统分配端口，设置 API-only 模式，并且只在完整 Loader 树结算后打印 `dsh native-api: http://127.0.0.1:<port>`。监督它的 app 持有本次启动专属的 `DSH_API_TOKEN`，并且只接受带有效端口的 loopback 就绪 URL。

## 鉴权与路由

每个 `/api` HTTP 请求与 API WebSocket upgrade 都必须携带本次启动专属的 token。HTTP 客户端发送 `Authorization: Bearer <token>`；原生进程从自己的 sidecar 启动状态取得该值，而不是从用户可见文档读取。token 缺失或不匹配时，会在业务 handler 运行前返回 401。

监听器还会在 loopback 上拒绝外部 `Host`，防止 DNS rebinding 把远程 origin 变成本地 authority。即使某项组装声明了额外的受信 authority，特权配置与原生桌面方法仍然只允许 loopback。

API-only 模式在 `/` 返回一份小型 JSON 状态文档，只分派已注册的 `/api` route，并对其他每条 HTTP 路径返回 JSON 404。非 API upgrade 会在 route 分派前被拒绝。不存在可提供文件或应用 shell 的 fallback handler。

## 业务 API

每个领域服务持有自己的生成式 `@Remote` 约定。[`dsh-api-gateway`](../packages/api/gateway/README.zh.md)解析实时 descriptor，并通过 `POST /api/<namespace>/<method>` 提供精确参数与结果校验。响应回显请求的 `rpcId`，并携带方法结果或封闭的业务错误码。HTTP 状态表达载体失败，不表达领域成功。

网关在调用时解析 live Agent 与 Session 状态，应用 Host 自有的鉴权与持久化规则，并且只在各领域提交点之后发布变更。大型 Session 日志导出使用独立的鉴权下载 route，因此可以按背压流式传输字节，而不是缓冲进 RPC envelope。

## 事件下行

`/api/events/mux` 承载按 Session 划分的状态与生命周期 frame；`/api/events/host` 承载 Host 级失效通知与 inventory 变更。两者都是经过鉴权、只允许下行的 WebSocket。客户端建立显式订阅，并把 Host 提供的重连基线视为权威；消费方操作失败时，不得推进 cursor，也不得确认尚未应用的状态。Session 归档通过独立的 `/api/session/export` 流式传输。

可转发的 Host 事件集合显式定义在 [`dsh-api-remotes`](../packages/api/remotes/README.zh.md)中。带 scope、waterfall（瀑布式事件）或 bail 语义的事件不能进入该集合，因为转发它们会丢失执行语义。

## 边界

- 原生 AppKit/SwiftUI 持有 Ark 的可见 UI，并把用户操作映射到本 API；Host 包不渲染任何内容。
- 通用 CLI 持有任意 profile、插件管理与一次性 headless 执行。它不导出受管理的原生 runner。
- [`packages/web`](../packages/web/README.zh.md)是面向模型的搜索/抓取能力。它与浏览器 UI 无关，仍可供 agent preset 使用。
- 新的浏览器产品需要新的产品决策、依赖闭包、信任设计、无障碍约定与独立测试 owner。它不得作为 Ark fallback 重新出现。

## 验证

原生组合包约定会检查精确的 Host 配置行集合，并拒绝浏览器包。已安装运行时测试在端口 0 引导打包后的 sidecar，要求 bearer token，覆盖代表性业务调用与事件 upgrade，并要求非 API route 保持不可用。原生 UI 验收仍然是一项独立的 AppKit/SwiftUI 行为检查。
