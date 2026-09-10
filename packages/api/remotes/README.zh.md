# @deepseek-ai/dsh-api-remotes

[English](README.md) | 中文

仅 Host 使用的 Remote 策略包。`createApiRemoteAgentResolver()` 会复用 live Agent、恢复普通冷会话、对并发恢复去重、保留 subagent ownership，并为 Typert 的 `agent` 与 `session` lookup 配置同一个 resolver。

`API_REMOTE_FORWARDED_EVENTS` 是允许不经投影、脱敏或改名而穿过原生 API 的 Host Cordis 事件唯一名单。Host 编译器会把每个条目对照已声明事件词汇，并拒绝带 scope、waterfall 或 bail 语义的事件。`./types` 子路径向 Host 事件载体导出选择类型。

本包只有一个 Host TypeScript project，没有 `dsh.client` metadata、没有客户端 export，也没有浏览器 bundle。[`@deepseek-ai/dsh-host-native-events`](../../host/native-events/README.zh.md)消费其 resolver 与转发事件策略。

## 模型体验

无。该包持有身份与转发策略，但不注册任何面向模型的上下文。

#### KV Cache 影响

无直接影响；被调用的 Host 能力持有任何模型可见行为。

## 已知限制与暂缓事项

- 历史包名仍含有“remotes”，但浏览器 Remote 运行时不再交付；给该包改名属于另一项包身份变更。
