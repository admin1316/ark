# api/：Host API 策略

[English](README.md) | 中文

供 API 传输共用的 Host 侧策略。本组不包含浏览器装配或客户端运行时。

| 包 | 职责 | ctx key |
|---|---|---|
| [`gateway/`](gateway/README.zh.md) | 面向原生 API 客户端的 Host-only 严格 Typert Remote 分派 | `ctx.typertGateway` |
| [`remotes/`](remotes/README.zh.md) | Agent/Session lookup 策略，以及允许穿过原生 API 的 Host 事件名单 | 无服务；提供 Host 策略 |

严格运行时路径为 `Typert registry + 领域 Remote 服务 → gateway → host/connection → host/webserver`。[`host/connection`](../host/connection/README.zh.md)持有鉴权与物理 route，[`host/native-events`](../host/native-events/README.zh.md)持有事件/响应投影，[`host/webserver`](../host/webserver/README.zh.md)持有 loopback 监听器。

## 已知限制与延期工作

- 历史名称 `remotes` 仍然保留，尽管浏览器 Remote 运行时已经不存在；改名属于另一项包身份变更。
- 原生调用使用严格斜杠 Remote descriptor；事件下行、回答关联与流式下载继续作为独立 Host 载体能力。
