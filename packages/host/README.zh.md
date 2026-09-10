# host/ — 原生/API Host 层

[English](README.md) | 中文

供原生桌面与 API 集成使用的 Host 服务：类型化业务网关、鉴权 HTTP/WebSocket 载体、loopback 监听器，以及 Host 自有的桌面能力。Ark sidecar 通过 [`dsh-native-api-app`](../bundle/native-api-app/README.zh.md)组合它们；通用 headless CLI 不挂载本层。它们全是**产品**包。

| 包 | 职责 | ctx key |
|---|---|---|
| [`connection/`](connection/README.zh.md) | 鉴权 `/api` HTTP bridge 与事件 WebSocket | `ctx.connection.rpc` |
| [`webserver/`](webserver/README.zh.md) | API-only HTTP 与 upgrade route 载体 | `ctx.webServer` |
| [`native-events/`](native-events/README.zh.md) | 原生事件投影与回答关联 | `ctx.nativeEvents` |
| [`session-remote-operations/`](session-remote-operations/README.zh.md) | Session Remote 实现与流式导出 | 生成式 `session/*` descriptor |
| [`directory-picker/`](directory-picker/README.zh.md) | 工作区目录选择 seam | `ctx.directoryPicker` |
| [`directory-picker-native/`](directory-picker-native/README.zh.md) | 原生目录选择器后端 | 注册 `ctx.directoryPicker` |
| [`plugin-inventory/`](plugin-inventory/README.zh.md) | 当前 Loader 条目的只读投影 | Host API `pluginInventory.list` |

领域服务发布严格 Remote descriptor，`connection` 则在 `webserver` 上暴露鉴权 route；`native-events` 与 `session-remote-operations` 持有非一元的事件、响应和下载表面。原生选择器是共享 seam 后随桌面产品交付的提供方。

子系统参考见 [API 网关](../../docs/api-gateway.zh.md)、[web server](../../docs/subsystems/web-server.zh.md)与 [workspace](../../docs/subsystems/workspace.zh.md)（选择器 seam）。
