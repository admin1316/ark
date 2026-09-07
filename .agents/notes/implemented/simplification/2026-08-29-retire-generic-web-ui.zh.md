# Agent Note: 退役通用 Web UI

Status: implemented

[English](2026-08-29-retire-generic-web-ui.md) | 中文

## 问题

通用浏览器应用重复了已经由 Ark 原生 AppKit/SwiftUI 界面持有的用户可见产品工作。保留两个产品还会保留第二套 shell、Client 插件运行时、静态文件服务器、浏览器传输、UI 包家族、构建平面、测试车道、文档集合与运行时依赖闭包。两套界面可能持续漂移，而浏览器测试通过并不能证明原生行为正确。

本仓库还用“web”命名另一项模型能力。删除名称中所有 web 内容会把 agent 的搜索与抓取一并删除，并不能解决 UI 重复问题。

## 决策

DeepSeek Harness 不交付通用浏览器 UI。`dsh web` alias 与 Web profile、`apps/web`、`packages/client`、`dsh-web-app` 组合包、Client Cordis runner 与 UI、静态前端 fallback、仅供浏览器使用的目录选择器与 Session 导出适配器、Client 编译/构建/测试车道，以及相应的现行用户与贡献者文档都不存在。

通用 `dsh` CLI（命令行界面）持有任意 profile、插件管理与一次性 headless 模板。它不导出、也不依赖 Ark 的受管理 Native 入口。Ark 启动 [`dsh-native-api-runner`](../../../../packages/boot/native-api-runner/README.zh.md)，后者只会在 [`dsh-native-api-app`](../../../../packages/bundle/native-api-app/README.zh.md)之上引导受管理 profile。

原生 sidecar 是 API-only 的：[`dsh-host-webserver`](../../../../packages/host/webserver/README.zh.md)监听 loopback，要求本次启动专属的 bearer token，并且只公开已注册的 `/api` HTTP 与 WebSocket route。它不提供 HTML、CSS、JavaScript、静态文件、Client bundle 或 fallback 应用 shell。Ark 的可见界面保持为原生 AppKit/SwiftUI。

## 保留内容

- [`packages/web`](../../../../packages/web/README.zh.md)继续作为提供方无关的搜索/抓取能力与面向模型的工具家族。它不包含浏览器 UI。
- Host API 包继续服务原生 sidecar，包括业务方法、鉴权、事件下行、持久化与原生桌面操作。
- Headless、ACP（Agent Client Protocol）、TypeScript/Python SDK、JSON-RPC，以及外部 UI/编辑器协议集成仍是受支持的入口模式。
- `website/` 继续作为静态文档站。它不会进入 Ark 运行时，也不会重建已经删除的应用。
- 历史事故复盘（postmortem）与先前 Agent Note 继续作为早期设计证据。它们描述已交付通用浏览器产品时，以本 Note 为当前权威。

## 取代关系

本决策完全取代 [Web Client 架构](../architecture/2026-07-19-gui-web-client-architecture.zh.md)、[Web 组装](../architecture/2026-07-24-web-config-tree-boot-and-transport-layering.zh.md)、[浏览器 e2e 车道](../testing/2026-07-24-web-gui-browser-e2e-lane.zh.md)、[Web 样式系统](../process/2026-07-19-web-styling-system.zh.md)，以及实现已不存在的纯 Web 功能 Note 中关于当前产品的结论。这些记录保持不变，以便恢复其依据与事故历史；它们不授权重新引入浏览器 fallback。

原生、headless、ACP 或 SDK 消费方仍在使用的 Host 协议、持久 Session 事实、模型工具与其他机制只被部分取代。其现行 owner 文档会在不假定浏览器存在的前提下描述保留行为。

## 考虑过的替代方案

**把 Web UI 保留为独立产品。** 这能保留另一个用户界面，也会保留其完整依赖、构建、测试、无障碍、安全与发布成本。当前没有能够证明该闭包合理的产品 owner 或验收目标。

**保留隐藏或禁用的浏览器 fallback。** 休眠 fallback 仍会保留可执行前端代码，并可能被意外重新激活。它还会让依赖扫描无法证明 Ark 打包运行时是纯原生的。

**删除名称中含有“web”的每个包。** 这会把模型可见的搜索与抓取同浏览器应用一起删除。该模型能力有当前消费方与不同 owner，因此予以保留。

**把浏览器代码移动到仓库内的归档。** Git 历史与已验证的退役归档已经能够恢复精确字节。第二份源码归档仍是可搜索、可打包的残留，并会破坏缺失性检查。

## 验证

- 源码与运行时闭包扫描会拒绝已退役的应用路径、浏览器包名、Web CLI alias/profile、Client 编译输入与静态前端产物。
- 文档链接、生成目录与包 README 检查在不包含已退役页面的前提下通过；全库双语配对报告仍有单独跟踪的历史文档 out-of-sync。
- 受管理 sidecar 通过打包后的 Native runner 在端口 0 引导，要求 app 自有 bearer token，服务代表性 Host API 调用与事件 upgrade，并拒绝非 API route。
- 原生 AppKit/SwiftUI 交互测试仍是用户界面验收权威；Host 或 headless 测试不能替代它。

## 后果

仓库与 Ark 运行时不再包含浏览器 UI、动态 Client 插件生态、浏览器专属配置页面或浏览器快照车道。需要用户界面的集成必须使用原生产品，或持有独立的外部协议客户端。

保留的 Host API 与模型 Web 能力继续保持各自的安全、数据保护、错误、取消和持久化保证。它们的名称不表示存在可见浏览器产品。

重新引入通用浏览器 UI 需要一项新的产品决策，并且必须明确 owner、独立依赖闭包、鉴权与信任设计、无障碍约定、行为验收套件与发布边界。它不能作为 Ark fallback 加回，也不能默认进入打包产物。
