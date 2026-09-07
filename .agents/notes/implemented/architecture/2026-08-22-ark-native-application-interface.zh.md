# Agent Note: Ark 原生应用界面

Status: implemented

[English](2026-08-22-ark-native-application-interface.md) | 中文

## Problem

Ark.app 通过 WKWebView 渲染可见产品界面。客户端 bundle 或 profile 的变化会替换整套应用布局、移除九章天幕品牌，甚至把 API-only JSON 响应直接显示在窗口里。产品即使被打包成 macOS bundle，可见界面仍然是浏览器应用。

## Decision

Ark.app 使用 AppKit 管理应用、窗口、菜单和后台进程生命周期，使用 SwiftUI 绘制全部可见控件。`ArkRootView` 拥有九章天幕字标、工作区与会话导航、对话输入、轨迹浏览，以及万相织鉴三栏工作台。可执行文件不导入或链接 WebKit。

错误显示在能够处理它的原生界面中：设置、Composer、导航与知识操作分别持有内联错误状态，工作台文件导航失败使用一次性原生提醒。应用顶栏不把操作失败投影成全局横幅。外观修改立即应用应用自身持有的本地偏好；可写的 `ui-theme` namespace 只增加持久化能力，缺失时保持静默的仅本地模式。设置导航使用可聚焦的按钮行，提供稳定的辅助功能标识、选中 trait、`AXPress`、当前页初始焦点和顺序明确的方向键移动。会话显示的连续 Slider 在 popover 内持有草稿值，只在编辑结束时向应用自身的偏好写入一次；离散 Switch 每次用户操作只写入一次。

本机进程继续承担传输与模型运行职责，不再负责界面渲染。原生壳每次启动生成一个令牌，以 `DSH_API_TOKEN` 传给子进程，`ArkAPIClient` 用 bearer 头调用 loopback RPC。启动器始终在用户 profile 之后追加 `native-only.cordis.patch.yml`；该 overlay 把主监听器设为 `apiOnly: true`，旧 profile 也不能重新打开 HTML fallback。原生知识视图通过 knowledge Remote 获取项目、页面、图谱、正文和 Review；Remote 不可用时保留只读的本地文件投影作为降级路径。

自包含构建分别签名应用本体与内嵌 Node。Node 只获得 V8 JIT 权限，并且签名后必须实际执行成功；原生应用只保留 Sparkle 所需的 library-validation 例外，不获得 JIT 权限。

## Alternatives considered

**保留 WKWebView，只用应用令牌保护页面。** 否决，因为它只能限制浏览器访问，不能改变界面仍由 HTML/CSS/JavaScript 构成、仍会随 Web bundle 回归的事实。

**连同 Web 界面一起删除 loopback 进程。** 否决，因为会话、模型、工具、持久化与知识治理属于本机运行时。删除的是渲染器；服务继续由原生 API 客户端访问。

**全部使用命令式 AppKit 绘制。** 否决，因为进程与窗口仍由 AppKit 管理，而 SwiftUI 能以更少的自定义生命周期代码表达状态驱动的多栏界面，同时仍是原生 macOS UI。

## Consequences

唯一面向用户的交付物是 Ark.app，其辅助功能树包含原生列表、按钮、文本框和滚动区，不再出现 Web 区域。`/` 返回服务 JSON，浏览器/PWA 路由不会渲染产品界面。客户端 bundle 的变化不能再替换应用外壳或九章天幕字标。

缺失可选设置 namespace 不会产生反复出现的顶层错误。传输、校验、安全与数据失败继续显示在各自所属界面中，不会被丢弃；辅助技术客户端可以通过明确的原生按钮动作打开设置页面。

首版原生实现会在选中会话时轮询历史尾部，并在异步结果写入前重新核对会话身份。流式 chunk、审批、提问与更丰富的工具卡需要接入两条带鉴权 WebSocket 下行通道才能达到完整功能对等；没有原生契约的控件保持禁用，不伪装为可用功能。
