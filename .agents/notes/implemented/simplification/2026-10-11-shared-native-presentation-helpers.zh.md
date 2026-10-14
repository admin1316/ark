# Agent Note: 原生呈现共用纯函数

Status: implemented

[English](2026-10-11-shared-native-presentation-helpers.md) | 中文

## Problem

工具视图和长任务摘要重复提取卡片标题、翻译执行阶段。Markdown 转换器重复实现外围解析器的反斜杠奇偶判定。工作台根目录选择重复转换受保护的路径，已完成和活动中的过程卡片重复生成统计和过滤条目。这些副本没有提供不同的行为，却要求修改时同步维护。

## Decision

[`ArkToolPresentation.title` 和 `ArkExecutionPhase.localizedLabel(language:)`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkToolModels.swift) 在 UI 模块内负责已有的纯操作。调用者保留自己的选择规则：聊天先尝试结果标题再尝试调用标题；长任务摘要先选择结果卡片，缺少标题时回退到工具名。语言仍作为显式参数传入。另一个状态阶段枚举保留自己的 neutral 和 stopped 状态。

嵌套的 Markdown 转换器调用 [`NativeGFMParser.isEscaped`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/NativeMarkdownGFMModel.swift)。扫描方向、字符串索引处理和奇数反斜杠规则保持不变。

[`ArkRootView`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkRootView.swift)已有的私有类型负责自己的构造。`WorkbenchRootSelection` 在转换 URL 前校验原始路径；一般根目录优先选择工作区，工具文件导航优先选择会话目录。`NativeChatProcess` 从所选条目生成隐藏标识、可观察的详情条目和统计。已完成和活动投影保留各自的条件、条目选择、代次及锚点规则。

## Alternatives considered

**保留副本。** 它们重复同一纯操作，后续增加卡片类型或修改翻译时仍要找到每个视图。

**合并调用者的回退规则。** 聊天和长任务摘要有意使用不同的缺失标题处理方式。共用取值函数可以保留两种规则。

**新增呈现服务。** 现有枚举和解析器已经负责这些数据。再增加服务或工厂会增加归属层，却没有新的调用契约。

## Consequences

共用纯函数不新增状态、依赖、wire 字段、事件或渲染路径。现有原生合约检查覆盖卡片解码、长任务摘要、本地化、无障碍、Markdown 代码与公式边界和投影的共用构造。构建及这些合约检查仍须与打包候选的交互和截图验收分别核验。
