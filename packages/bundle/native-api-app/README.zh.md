# `@deepseek-ai/dsh-native-api-app`

[English](README.md) | 中文

这是位于 [`dsh-base`](../base/README.zh.md) 之上的原生桌面 API-only 组合包。它的 patch 只挂载原生客户端需要的 Host 配置行：存储、反馈、Workspace、投影缓存与投影单元、引用、目录选择、插件清单、知识 Wiki、严格 Host Remote Gateway、直接 Workbench 与 Session Remote owner、原生事件投影、`WebServer`、Host Connection 和 Agent preset。它还把面向模型的配置行移入逐会话 preset，通过 [`dsh-cmdline`](../../boot/cmdline/README.zh.md) 解析可选 `--port` 参数，默认请求系统分配端口，并且只在完整 Loader 树结算后输出已解析的 `dsh native-api: http://127.0.0.1:<port>`。

监听器固定绑定 loopback，要求启动级 `DSH_API_TOKEN`，并设置 `apiOnly: true`。该组合包不挂载前端 fallback、模块扫描器、Client runner、浏览器 runtime、浏览器包、UI 插件、Web prompt、shell Web URL 或浏览器打开器。`@deepseek-ai/dsh-host-connection` 持有 `/api`、`/api/events/mux`、`/api/events/host` 以及精确下载/响应 route，且不发布浏览器入口；`@deepseek-ai/dsh-api-gateway` 仅在 Host 运行，并持有所有动态注册的严格斜杠 Remote 拦截。

## Model Experience

间接经由所选 Agent preset；本组合包不增加 prompt 文本或工具 schema。

#### KV Cache effect

无直接影响。

## Known Limitations and Deferred Work

- **单一 loopback 监听器** — 本组合包有意不接受 host 或可信 authority 覆盖；原生客户端必须与服务运行在同一台机器上，并携带启动令牌。
- **就绪状态经 stdout 发布** — 嵌入式 supervisor 必须解析确切的、结算后输出的 `dsh native-api:` 行，并拒绝非 loopback 或越界的已解析端口。
