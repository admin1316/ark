# Agent Note: Trajectory 持久化图片附件

Status: implemented

[English](2026-08-24-trajectory-image-attachments.md) | 中文

## Problem

Trajectory 不展示会话图片。持久化的 `{ type: 'image', attachment: ImageAttachmentRef }` 块在详情面板里渲染成格式化 JSON，纯图片的用户消息在记录表中是一个空行。Trajectory 唯一认识的图片路径是对内联 wire 字段（`url`、`image_url`、base64 `data`）的 `imageSrc` 嗅探，而生产事件从不携带这些字段：每个生产方都在事件追加前提交持久化的 `ImageAttachmentRef`。用户无法从执行记录确认模型看到了哪张图（[issue #2986](https://github.com/deepseek-harness/deepseek-harness/issues/2986)），而 Chat 已经能展示同样的附件。

## Decision

- [`ArkMessageImageStore`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkMessageImageStore.swift) 持有当前所选会话中已授权的历史图片字节。`ArkAppModel.messageImages` 为 Chat 和 Trajectory 提供同一个存储。对同一附件的并发请求共用一次加载，缓存字节在淘汰前复用。切换所选会话时取消待完成加载、清空字节并拒绝旧请求完成结果。缓存最多保留 24 张图片，以 64 MiB 为淘汰阈值，同时允许单张超大图片保留以供阅读。
- [`ArkRootView.swift`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkRootView.swift) 中的 `NativeMessageImages` 同时渲染 Chat 附件和 [`NativeTrajectoryParityView.swift`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/NativeTrajectoryParityView.swift) 中的附件。因此加载、取消、重试与原图预览共用一份呈现实现。
- Trajectory 从已记录的图片块提取附件标识并交给共享画廊。读取通过 `ArkInteractionAPI.readImage` 调用按会话授权的 `session/attachment` 端点；画廊不会抓取事件文本中的任意 URL。
- 含图片的记录即使没有文本，也保留附件标识。Trajectory 显示本地化的附件计数和共享画廊，不依赖纯文本摘要。
- 存储与 BFF 均不改动：`session.attachment` 已按会话日志引用授权（缺失、损坏与未被引用的附件显式失败并进入画廊的重试态），sha256 内容寻址已保证每张图片只存一份。

## Alternatives considered

**保留 Trajectory 自己的 `<img>` 渲染并喂给它解析好的 URL。** 这会重复 `ui-attachment` 已拥有的加载占位、重试控件和灯箱，并与[基于 slot 的附件所有权](../architecture/2026-08-17-dynamic-client-render-and-attachment-ownership.zh.md)相抵触，该决定已拒绝跨插件直接 import 组件。

**把 `conversation.message.images` 的声明上提到共享父级，让两个视图渲染同一个键。** `renderSlot` 的类型限定在声明入口自己的 children 表内，同级的 `conversation.view` 入口无法渲染另一个入口的子键；slot registry 也拒绝对同一键的第二次声明。共享 owner 类型的第二个键是受支持的组合方式，且允许主题独立替换任一画廊。

**在持久化路径之外保留内联 `imageSrc` 嗅探。** 所有生产方（宿主 prompt admission、`read_image`、MCP 投影、ACP 入口）都在事件追加前提交持久化引用，嗅探不会命中任何东西；保留它等于保留验收标准明确排除的非持久化渲染路径。

**Trajectory 自有的图片缓存。** 每个视图一份缓存会对同一会话附件发出重复的 `session.attachment` RPC 和重复的 blob URL，违背"Chat 与 Trajectory 引用同一会话附件"的要求，且没有任何收益。

## Consequences

- Chat 与 Trajectory 共用画廊行为和缓存字节。被淘汰的图片可能需要再次授权读取；缓存不承诺长会话整个生命周期内只读取一次。
- 切换会话会释放缓存字节并取消待完成工作。尝试令牌防止旧请求向新选中的会话发布结果。
- [`ArkMessageImageStoreContractChecks.swift`](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkMessageImageStoreContractChecks.swift) 验证并发加载去重、字节缓存、重试、取消与拒绝旧请求完成结果。其中画廊接线断言检查源码；图片显示和预览控件仍需实际 Native 交互验证。
