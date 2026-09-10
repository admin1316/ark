# Agent Note: DSH alpha 能力的 Ark 原生迁移

Status: implemented

[English](2026-08-30-native-alpha-capability-port.md) | 中文

## Problem

DSH 0.1.2-alpha.1 增加了会话流展示、准确用量、Provider 与子代理控制、图片请求投影、ACP／SDK 控制、可选 DeepSeek 请求扩展、公网 WebFetch 以及多项恢复修复。Ark 的可见界面是原生 AppKit／SwiftUI 产品，不能恢复已经退役的 Web UI。

## Decision

Ark 的所有可见会话、设置、导航、语言、排版、图片和 Provider 登录控件都保留在原生 SwiftUI／AppKit 中。Host 继续作为 API-only sidecar，并承载共享的会话、附件、代币计量、进程、ACP、SDK、WebFetch、插件清单、会话日志和模型路由能力。

已完成的回答默认折叠流程详情和系统提示行，提供经过回放验证的准确用量展开项，支持自适应或拖动会话正文宽度、紧凑轮次导航、会话字号调节和按正文比例缩放 Markdown 表格。原生语言与 Provider 登录注册表采用值所有权并支持卸载；可选 Host locale 能力缺失时，语言选择回退到非敏感的本机偏好设置。

请求图片投影由附件存储、DeepSeek Files、内联回退、pi-ai 和代币压力计量共享，并且是确定性的。它限制像素与字节、保留透明通道、转换不支持的采样深度、按固定量移除旧图片，并且只在模型执行环境内解析本地图片路径。持久 JSONL provenance 使用紧凑序列范围，修复截断尾部时输出警告。

子代理路由选择默认关闭并受 allowlist 授权。除非授权路由改变，子代理会继承 Provider、模型、推理强度和输出上限；Claude Code 与 Codex 适配器通过各自启动协议传递配置的模型。ACP 与 SDK 路径会验证初始化、模型控制、图片、权限、取消、会话状态和退出清理，不暴露浏览器传输。

PTC 是前 Code Mode 呈现方式的面向模型名称，同时保留 `code` 拼写和既有持久记录的可读性。官方 DeepSeek 适配器提供默认关闭的插件包清单与增量会话日志请求扩展。公网 WebFetch 只通过校验地址并固定连接的 Provider 开启，并受固定 URL 与响应大小限制。

## Alternatives considered

**恢复 alpha Web 客户端。** 否决，因为 Ark 的产品不变量要求可见界面原生化；sidecar 只限于经过认证的 API 传输。

**从用量样本推断准确用量，或用启发式估算图片代币。** 否决，因为可展开的准确用量必须在生命周期边界、分桶完整性、路由归属和总量都可证明时才展示。

**让可选模型的子代理读取实时 Provider catalog。** 否决，因为变化中的 catalog 可能在会话运行期间扩大授权范围；每个符合条件的父会话都会捕获经过验证的 allowlist。

**让 WebFetch 使用普通 DNS 查询。** 否决，因为 DNS rebinding 可能把已验证的公网主机名改向私网地址；Provider 会校验完整答案集并固定连接地址。

## Testing

源码与构建后的 Host aggregate 均通过编译；Native Swift 合同二进制通过会话、localization、扩展、图片、进程与后端恢复检查；Ark 静态集成检查通过；SDK stdio initialize／shutdown 往返通过；ACP 测试 68/68 通过；附件测试 78/78 通过；JSONL 持久化测试 244/244 通过；排除依赖操作系统 `ps` 的退出钩子测试后，subprocess 测试 141 项通过并有 2 项平台跳过；SDK client 测试 47/47 通过；headless 测试 10/10 通过；pi-ai 配置与转换测试 83/83 通过。受限 runner 禁止回环监听，因此依赖 loopback 的测试仍受环境限制；pi-ai 0.84.2 已写入 manifest 与 lockfile，但本机依赖缓存尚未包含该包。

## Consequences

原生产品获得 alpha 的会话与恢复能力，同时不重新引入浏览器资源。格式错误或生命周期不完整的历史记录可能不显示准确用量，这比展示伪造数字更安全。图片规范化与请求版本会增加有界的派生存储和 CPU 成本；固定缓存、singleflight 与进程恢复则减少重复工作和会话卡死。要在本机执行 pi-ai 0.84.2 的运行时专属字段，仍需一次新的依赖安装。
