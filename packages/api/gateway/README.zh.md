---
description: "供原生 API 客户端使用的仅 Host 严格 Typert Remote 分派器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-gateway

[English](README.md) | 中文

## 概述

供原生 API 客户端使用的仅 Host 严格 Typert Remote 分派器。`TypertGatewayService` 提供 `ctx.typertGateway`，动态认领每一个当前存在或已撤回的严格 `<namespace>/<method>` descriptor，校验精确具名参数，解析 lookup 对象与 scoped Context，注入载体取消信号，校验结果，并返回 Ark 消费的嵌套 `RemoteResult`。

本包不持有 HTTP server 或 envelope parser。它通过一个最小结构化 `ctx.connection.rpc.intercept` 能力注册仅限 loopback 的 interceptor，因此 Gateway 不会形成指回 Host Connection 的包依赖或 TypeScript project edge。Connection 继续持有 bearer 与 authority 校验、请求关联、精确响应/下载注册，以及两条事件 WebSocket。

本包只有一个 Host TypeScript project，没有 `dsh.client` metadata、没有 client export、没有 SRC 反射 fallback，也没有浏览器或前端资产。[`native-remote-routes.ts`](src/native-remote-routes.ts) 记录 Swift 当前消费的严格 descriptor，用于覆盖检查，但不限制 Host 插件的动态注册。

## 目录

- [载体边界](#carrier-boundary)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="carrier-boundary"></a>
## 载体边界

只有一元严格 descriptor 经过本分派器。原生事件下行与回答关联由 `dsh-host-native-events` 持有；流式 Session 导出由 `dsh-host-session-remote-operations` 持有；`dsh-host-connection` 持有它们经过鉴权的物理 route。

活动 Service 缺失时返回 `service-unavailable`，指出 Service 身份并提示检查 Host 组合中的 provider。诊断不包含请求参数或凭证值。

<a id="model-experience"></a>
## 模型体验

无。该分派器只承载已经选定的业务调用，不注册任何面向模型的上下文。

#### KV Cache 影响

无；被调用的业务服务持有所有模型可见影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **仅处理一元严格 descriptor**：事件下行、交互响应与流式下载有意保留在各自专用的原生 Host owner 中；新增其他传输形态时，应建立职责明确的独立载体，而不是扩大本分派器。

<a id="dev-note"></a>
### 开发备注

无。
