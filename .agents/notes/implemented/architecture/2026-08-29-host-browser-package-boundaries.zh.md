# Agent Note: Host 与浏览器包边界

Status: implemented

[English](2026-08-29-host-browser-package-boundaries.md) | 中文

## Problem

Connection 与 Remote 装配包都同时发布 Host 入口和浏览器入口。仅 Host 的原生 runtime 因而会保留永远不会执行的浏览器包身份与文件，依赖闭包也无法证明原生产品不含浏览器包。

## Decision

物理 HTTP、信任、Host RPC 与 WebSocket 行为只属于 `@deepseek-ai/dsh-host-connection`；`@deepseek-ai/dsh-client-connection` 只包含浏览器插件。无依赖的 `host-connection/protocol` 子路径是路由常量、loopback 判定与共享 RPC 类型的唯一 owner。

Host Agent/Session lookup 与转发事件名单只属于 `@deepseek-ai/dsh-api-remotes`；生成的浏览器 Remote 贡献挂载只属于 `@deepseek-ai/dsh-client-api-remotes`。每个包只参加一个 TypeScript aggregate，并且只发布自己的 runtime face。

Native 的严格斜杠 Remote 分派只属于 Host-only 的 `@deepseek-ai/dsh-api-gateway`。它动态认领已注册 Typert descriptor，不提供 Client 入口或 SRC fallback，并经私有结构化能力接入 `ctx.connection.rpc.intercept`，不会形成包依赖或 project-reference 反向边。`@deepseek-ai/dsh-host-apiproxy` 仍作为明确命名的兼容配置行，承载 59 条点号 RPC 及其现有事件和下载载体；原第 60 项一元入口 `pluginInventory/list` 属于新 Gateway，ApiProxy 绝不认领斜杠 endpoint。

Web bundle 挂载彼此独立的 Host 与 Client 配置行，并持有服务浏览器 Remote 调用的 Typert Gateway 配置行。原生 API bundle 只依赖 Host 包，其闭包策略会拒绝直接链接或 pnpm storage 中的任何 `@deepseek-ai/dsh-client-*` 身份。

## Alternatives considered

**保留组合包，但从原生 profile 中省略浏览器配置行。** 这能阻止激活，却仍会发布浏览器包身份与浏览器产物，因此产物闭包无法证明其不存在。

**把共享常量复制到两个 face。** 这样可消除包依赖，却会为协议路径与 loopback 语义制造两个权威；发生漂移时不会出现类型错误，却会破坏传输。

**把组合式 alpha Gateway 包导入 Native。** 这会重新带入 Ark 不消费的 Client、浏览器 stream 与 SRC 行为，也让原生闭包无法证明仅 Host 的包图。

## Consequences

原生 runtime 装配可以要求 Client、Web、headless 与 UI 包身份全部为零，同时保持严格斜杠 Remote 动态注册。通用 Web 通过分离的配置行保留同样的 Host 与浏览器行为。增加跨平面的协议事实时，只需更新小型共享协议子路径，而不会让浏览器 bundle 导入 Host 实现。只有 ApiProxy 兼容配置行及其调用方退出原生闭包后，ApiProxy 移除才算完成。
