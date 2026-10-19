---
description: "这是位于 dsh-base 之上的原生桌面 API-only 组合包。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-native-api-app`

[English](README.md) | 中文

## 概述

这是位于 [`dsh-base`](../base/README.zh.md) 之上的原生桌面 API-only 组合包。它的 patch 只挂载原生客户端需要的 Host 配置行：存储、反馈、Workspace、投影缓存与投影单元、引用、目录选择、插件清单、知识 Wiki、严格 Host Remote Gateway、直接 Workbench 与 Session Remote owner、原生事件投影、`WebServer`、Host Connection 和 Agent preset。它还把面向模型的配置行移入逐会话 preset，通过 [`dsh-cmdline`](../../boot/cmdline/README.zh.md) 解析可选 `--port` 参数，默认请求系统分配端口，并且只在完整 Loader 树结算后输出已解析的 `dsh native-api: http://127.0.0.1:<port>`。

监听器固定绑定 loopback，要求启动级 `DSH_API_TOKEN`，并设置 `apiOnly: true`。该组合包不挂载前端 fallback、模块扫描器、Client runner、浏览器 runtime、浏览器包、UI 插件、Web prompt、shell Web URL 或浏览器打开器。`@deepseek-ai/dsh-host-connection` 持有 `/api`、`/api/events/mux`、`/api/events/host` 以及精确下载/响应 route，且不发布浏览器入口；`@deepseek-ai/dsh-api-gateway` 仅在 Host 运行，并持有所有动态注册的严格斜杠 Remote 拦截。

原生启动还持有由 `ARK_NATIVE_OWNER_SOCKET_PATH` 与 `ARK_NATIVE_OWNER_LAUNCH_TOKEN` 提供的可选知识私有通道。有界且具有关联 ID 的 Unix socket 消息独立于 loopback 和就绪日志。就绪握手提供已登记的源码/构建身份、各角色公钥及只读工件目录；同一通道提供 Wiki verifier、journal signer、固定任务 evaluator、measured-trial reader 与逐次使用费用解析器。Adapter 只向此 owner 发送最终请求摘要和固定元数据。启动令牌只绑定子进程，不授予试用权限。端点缺失或 owner 禁用时，不发布可信能力。

通道串行处理操作，取消后等待 owner 响应或 socket 关闭。启动阶段卸载会中止未完成握手并等待 socket 关闭；握手具有十秒协议时限。回执解析验证既有 canonical 签名字节，不改变事件或 WAL 格式。Owner 准入、密钥托管、guard 来源认证与启用均不由此 Node provider 决定；测试密钥与源码检查不能证明这些条件。

单独启动的 guard 可从既有 `startup` 入口导入 `connectNativeGuardCostOwner`。它复用相同的分帧、关联与清理机制，但握手保持 `ownerStatus: disabled`，不提供签名密钥，并且只公开已登记派发的准入核验及结算记录。它的 `closed` promise 在 socket 实际终止后结算，让 launcher 在 owner 消失时关闭 HTTP listener。App 认证其独立启动的 peer；普通 backend Context 没有结算方法。费用 owner 禁用时，guard helper 不得启动。

## 目录

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="model-experience"></a>
## Model Experience

间接经由所选 Agent preset；本组合包不增加 prompt 文本或工具 schema。

#### KV Cache effect

无直接影响。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **单一 loopback 监听器** — 本组合包有意不接受 host 或可信 authority 覆盖；原生客户端必须与服务运行在同一台机器上，并携带启动令牌。
- **就绪状态经 stdout 发布** — 嵌入式 supervisor 必须解析确切的、结算后输出的 `dsh native-api:` 行，并拒绝非 loopback 或越界的已解析端口。

<a id="dev-note"></a>
### 开发备注

无。
