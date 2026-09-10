# Agent Note: 限制原生启动解析与 Markdown 发布工作量

Status: implemented

[English](2026-09-08-native-startup-and-markdown-batching.md) | 中文

## 问题

独立启动器在启动后端之前，为每个可达的 JavaScript 文件单独调用一次 Node。在打包运行时上，进程启动占据了大部分验证时间。恢复会话时，每份 Markdown 解析结果还会单独发布一份完整的 SwiftUI 对话快照，使同一对话在结果集中返回期间被反复更新。

## 决策

[运行时验证器](../../../../integrations/jiuzhang/src/runtime-closure.mjs) 在独立 Node 进程中，每批编译最多 256 个可达入口。Node VM 根据文件扩展名和最近的 package manifest 选择模块或 CommonJS 语法；不会链接或执行包代码。仅移除位于字节零的 shebang；不能因为移除了前置 BOM，就接受 Node 原本拒绝的语法。包哈希、依赖可达性、禁用包、符号链接规则和收据验证仍是前置条件。

[原生对话数据源](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkRootView.swift) 在已有投影状态中暂存完成的 Markdown 解析结果，并在 16 毫秒的合并间隔后发布一次快照。发布时重新验证会话、源文本和请求身份。取消、源文本替换和会话切换会丢弃过期的暂存结果。

## 考虑过的替代方案

**跳过启动验证或仅缓存文件时间戳。** 包内容变化后，这会丢失内容与语法验证。批量处理保留验证工作，并消除反复启动进程的开销。

**通过执行 import 验证模块。** 导入会执行包代码，可能触发文件系统、网络或注册副作用。只编译的 VM 构造函数可以验证语法而不产生这些副作用。

**每份解析结果完成后立即发布。** 每次完成都会复制投影映射并触发 SwiftUI 更新。合并以最多一个短暂显示间隔换取更少的复制与布局更新。

## 后果

语法解析器对象的数量受批次大小限制，并位于启动器堆之外。所选 Node 必须支持 VM 模块和包清单发现。[运行时闭包测试](../../../../integrations/jiuzhang/tests/runtime-closure.test.mjs) 覆盖混合语法、跨批次边界的无效入口与不执行代码。[原生滚动测试](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkChatScrollContractChecks.swift) 覆盖 128 个来源的批次、重复提取、源文本替换、取消和过期会话结果。这些检查不证明生产晋级或无限长度会话的性能。
