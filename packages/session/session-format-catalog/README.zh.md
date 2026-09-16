---
description: "供离线转换使用的静态第一方 Session 编解码器与相邻迁移装配。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-catalog

[English](README.md) | 中文

## 概述

`dsh-session-format-catalog` 装配已发布的 v0–v3 编解码器与相邻迁移边，无需查询已挂载插件。目录目标格式是 v3；Ark 安装的 `dsh-session` 写入器与持久化读取器使用 v0，尚未接入本目录。转换后的 v3 artifact 是离线迁移结果，不代表 Ark 可以安装或恢复该会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

本库用于隔离的已发布格式转换与校验。功能组合不能注册或重排条目。Ark 的 JSONL 持久化未调用这些迁移，并会拒绝其他会话版本。可变行 decoder 状态只属于调用方持有的一次还原。

### 入口

```text
const restore = sessionFormatCatalog.createRestore(physicalHeader, { recovery: 'recoverable', validation: 'transformed' })
for (const row of physicalRows) restore.decodeRow(row)
const current = restore.finish()
const headerRecord = sessionFormatCatalog.encodeCurrentHeader(current.header, current.inheritedEventCount)
const eventRecords = current.events.map(sessionFormatCatalog.encodeCurrentEvent)
```

从包根导入 `sessionFormatCatalog`。离线读取方创建一次 restore，把已解析物理行传给 `decodeRow()`，再调用一次 `finish()`。编码方法生成目录目标 v3 记录，不能用于写入 Ark 活动中的 v0 历史。`readHeader()` 按离线可读性分类：有效 v0–v2 标头需要迁移，有效 v3 标头属于本目录的当前格式，未来版本不受支持，畸形标头被拒绝。

`validation: 'transformed'` 在迁移后执行完整的已发布 v3 校验。已经是 v3 的输入只接受编解码器检查；完整的离线关系校验需要把结果传给 `restoreReleasedV3Artifact`。`validation: 'current'` 还要求已安装 Session 接受结果，因此 v3 结果会被 Ark 的 v0 core 拒绝。恢复模式独立控制未完成尾部处理，不能授权其他格式。

目录直接持有已发布读取器，通过 `dsh-session` peer 获取已安装事件名称与还原规则；历史迁移边校验器保持冻结。已安装准入保留 core 的三个参数还原契约，对目录种子、非零继承切点、非法切点和版本不匹配明确拒绝，不丢弃元数据。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`src/catalog.ts`](src/catalog.ts) 直接持有编解码器与迁移边顺序。[`src/current.ts`](src/current.ts) 先检查已安装版本、种子和继承切点准入，再把事件与请求校验委托给已安装 Session。底层构造函数会在开始读取之前拒绝重复编解码器、重复迁移边、缺口，以及超过目录目标版本的条目。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [迁移机制](../session-format/README.zh.md)——目录构造与分派行为。
- [已发布 v0 到 v1 迁移边](../session-format-v0-to-v1/README.zh.md)——编解码器与校验器所有权。
- [已发布 v1 到 v2 迁移边](../session-format-v1-to-v2/README.zh.md)——Assistant stream 嵌入与基数变化引用重映射。
- [已发布 V2 到 V3 规范](../session-format-v2-to-v3/README.zh.md#v2-to-v3-specification)——转换、保留与拒绝。
- [JSONL 持久化](../session-persistence-jsonl/README.zh.md)——不可变 generation 命名与排他发布。

-----

<a id="model-experience"></a>
## 模型体验

### 目录分派

#### 模型看到什么

没有直接可见内容。Ark 请求重建未使用离线目录 `sessionFormatCatalog`。

#### Token 影响

不直接产生 token。

#### KV Cache 影响

没有直接影响；还原后的历史在其消费者中决定缓存身份。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **运行时准入独立**——Ark 的 v0 写入器不支持目录 v3；接入活动历史之前，必须实现 core 与持久化迁移。
- **仅包含第一方构建清单**——尚不支持外部迁移所有权与分发。
- **静态顺序封闭**——运行时插件注册无法补充缺失的历史迁移边。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
