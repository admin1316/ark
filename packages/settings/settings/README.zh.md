---
description: "面向插件作者与维护者的用户设置服务：注册可配置 namespace、读取解析值或接入配置界面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-settings

[English](README.md) | 中文

## 概述

`dsh-settings` 让插件把配置开放给用户运行时修改：插件用一个 schema 注册 namespace，解析值依次尊重 schema 默认值、部署自身的组合 `base` 与用户编辑的文档分节——用户覆盖优先。消费方读取解析值快照并在每次已提交变更后收到通知；配置界面每个 namespace 得到一条 descriptor——schema、当前值、每个字段来自哪一层、生效时机——而无需直接触碰存储。写入只改动用户覆盖、按 namespace 逐个执行，并可携带期望 revision，让持有陈旧快照的写入方被拒绝，而不是悄悄覆盖较新的写入。文档必须由挂载的提供方存储；没有提供方时一切照旧，配置保持组合原样。

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

插件与配置界面通过 `ctx.settings` 在运行时读取并修改配置。常用路径：挂载提供方、用 schema 注册 namespace、读取并观察解析值，并通过 owner scope 写入。

### 何时选择

当插件的配置需要在运行时可变——用户编辑文档或配置界面修改——且无需重启或重读 `cordis.yml` 时，选择设置服务。它适合多个插件各拥有一个配置 namespace、以及配置界面需要渲染 schema、标记用户覆盖字段并持久化编辑的场景。当配置在加载时固定则没有必要：没有挂载提供方时一切照旧，配置保持组合原样。

### 挂载提供方

服务本身不存储任何内容；请挂载一个提供方，例如随附的文件型提供方：

```yaml
- name: '@deepseek-ai/dsh-settings-file'
  config:
    path: /absolute/path/to/settings.yaml
```

提供方上线后 `ctx.settings` 即出现。完整配置面由提供方 README 负责；生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-settings-file)列出每个受支持字段。

### 注册 namespace

插件用 schemastery schema 注册自己的 namespace，并可选地把组合配置作为 `base` 层传入，让解析值从部署已配置的内容起步：

```text
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema, {
  base: config,   // composition entry config; the user layer resolves above it
})
const theme = scope.get()              // deep-frozen resolved snapshot
scope.update({ density: 'compact' })   // merges into the user section and persists
```

`installSettingsSection` 为消费方插件封装了这套接线：只要设置服务存在，它就用插件的组合配置作为 `base` 注册 namespace；服务消失时插件回退到组合配置，行为与原先完全一致。

### 读取与观察值

`get(ns)` 以深冻结快照返回解析值，namespace 未注册时为 `undefined`。`watch(callback)` 在每次已提交变更后以 `(next, prev)` 调用回调：同一回调的调用按提交顺序逐个执行，异常被隔离并记入日志，因此慢或抛错的观察者绝不会阻塞或破坏其他观察者。

### 写入值

`settle(ns, revision)` 等待某个精确持久化修订对应的所有者回调，并报告它们是否成功。持久化本身不等于生效。期间发生新写入或所有者释放会拒绝该等待。卸载 namespace 会保留其名称，直到已接收的写入和已启动的回调完成；超时的所有者仍保留该名称。已卸载的 scope 不能通过替换后的注册写入。

`update(ns, patch)` 把普通对象 patch 深合并进用户分节——绝不进 `base`——校验解析候选值、经提供方持久化后提交。`replace(ns, section)` 整体替换用户分节，是删除/重置路径：`replace({})` 重新继承 `base` 与 schema 默认值。`mutate(ns, ops)` 在写入排到队首那一刻的分节上按序施加 `{ op: 'set' | 'unset', path }` 编辑——这是持有不完整（例如脱敏后）视图的调用方的删除路径，因为按协议接口返回的内容重建分节再整体替换，会删掉协议从未回传的每个字段。

每次写入都会拒绝与 JSON 不兼容的数据（`Date`、`Map`、`BigInt`、非有限数或循环引用会在任何内容持久化前以 `$` 为根的路径报错）、拒绝只读提供方上的写入，并可接受可选的 `expectedRevision`：把 descriptor 中的 `revision` 传回，namespace 已越过该值时写入会被 `SettingsConflictError` 拒绝，而不是覆盖先完成写入的一方。

### 配置界面

`describe()` 为每个已注册 namespace 返回一条 descriptor：序列化 schema、解析值、分离的 `base` 与 `user` 层（字段出现在 `user` 中即标记为用户覆盖）、生效时机与 namespace 的 revision。每个协议接口都必须传入 `redactSecrets: true`：它从每一层剥离 `role('secret')` 字段，并把它们枚举为 `{ path, set }` slot，让页面可以渲染只写输入而不接触任何机密。`documentPath` 与 `prepareDocument()` 在提供方拥有用户可编辑文件时把它暴露给原生编辑器。

### 事件与失败

原生 `settings/*` Remote 方法归此提供方所有。读取和写入回复均为脱敏后的独立副本，schema 元数据中的机密默认值也会移除。`openDocument` 接受取消信号，不接受调用方指定的路径，只打开提供方未发生变化的绝对文档路径。领域事务所有者可以保护 namespace，拒绝通用 Remote 写入，同时保留同进程写入能力。写入失败会保留修订冲突信息，但不会暴露可能含有机密的提供方诊断。

`settings/updated (ns, next, prev, source)` 在每次已提交变更后触发——进程内写入（`source: 'update'`）或外部观察到的编辑（`source: 'provider'`）——解析值深相等时绝不触发。`settings/document-updated (ns, revision)` 在原始用户分节发生变化时触发，即使解析值没有变——已打开的编辑器正需要它来得知字段从继承变为覆盖。schema 拒绝的存量分节在重载时保留该 namespace 的最后可用值并告警；注册时同样的失败会直接拒绝注册。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **分层解析，单一用户层。** namespace 的值依次为 schema 默认值、注册方的组合 `base`、用户文档分节；写入只触碰用户层，因此 `replace({})` 是真正的重置。
- **提交以深相等为门槛。** 只有解析值变化时 `settings/updated` 才触发；原始分节事件独立存在，因为配置界面还必须得知「继承变成了覆盖」。
- **写入排队并做 revision 检查。** 每个 namespace 的写队列按调用顺序串行，`expectedRevision` 在队首判断——那里服务才能分辨持有新鲜快照的写入方与持有陈旧快照的写入方。
- **观察者与监听器异常被隔离。** watcher 调用与事件扇出隔离同步抛出与异步拒绝，一个坏掉的观察者不会卡死提交或提供方的重载循环；`INVARIANT` 编码的失败在所有监听器执行完后重新抛出。
- **注册是 fiber 上的 effect。** 注册 namespace 是调用方插件 fiber 上的 effect：dispose（资源释放）该 fiber 即移除 namespace 及其观察者。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition：namespace brand、注册、解析、写队列、describe/脱敏、事件、`installSettingsSection` |
| [`src/redact.ts`](src/redact.ts) | `redactSecrets` 遍历器：剥离 `role('secret')` 字段并枚举其 slot |
| [`src/types.ts`](src/types.ts) | 客户端安全类型面：事件声明、`SettingsNamespace`、`SettingsUpdateSource` |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：`settings/updated` 只对已注册 namespace、只在解析值变化时、且携带权威值触发 |

### 解析与写入路径

每次写入都在调用时对输入做快照（分离并校验 JSON 形状的数据），然后排上该 namespace 的串行链。在队首，服务按当前状态重读分节、检查 `expectedRevision`、合并/替换/编辑、经 schema 与 owner 的可选 `validate` 解析并校验候选值、经提供方持久化，然后才提交并发出事件。registrant fiber 在写入途中被 dispose 的写入仍到达存储，但不会提交、也不会通知任何人；卸载先拒绝新写入，并排干排队写入与已启动的 watcher 调用后才完成。

### 变更检测与事件

`bumpRevision` 比较原始分节并绑定精确修订的完成结果。`commit` 先安装解析值、排入所有者回调，再通知 `settings/document-updated`；仅在解析值变化时发出 `settings/updated`。两种通知都隔离监听器失败，并在重入发布后停止投递已被替代的状态。

### 客户端安全类型

`./types` 子路径出口持有事件声明及其签名点名的 `SettingsNamespace`、`SettingsUpdateSource` 类型，包根继续 re-export 这些类型。于是 Host 编译面之外的消费方读到的正是 Host 发射的那一份签名，而不必再写一遍。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当服务级约定不够用时阅读以下页面。它们从共享子系统词汇逐步进入随附提供方与能力架构。

- [设置子系统参考](../../../docs/subsystems/settings.zh.md)——namespace、注册、owner scope、descriptor、变更提交与生成的 cordis 接口面。
- [文件型设置提供方](../settings-file/README.zh.md)——随附的 YAML/JSON 提供方：配置、热重载、保留注释的写入。
- [设置包映射](../README.zh.md)——用户设置能力的两个包及其角色。
- [能力 seam](../../../docs/capability-seams.zh.md)——本服务遵循的 Service Definition / Service Provider / Consumer 拆分。

-----

<a id="model-experience"></a>
## 模型体验

间接生效：消费方插件拥有任何由设置值喂给的模型面内容；本服务只存储并解析用户设置，自身不注册任何模型面内容。

#### KV Cache 影响

无直接失效；把设置值纳入请求前缀的消费方负责该变更。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本服务何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **单一用户层**——解析只认识 schema 默认值、一个组合 `base` 与一个用户文档；它不记录每个解析值由哪一层提供。
- **机密 schema 需要可证明的结构**——支持 object、dict、array、tuple、union 和 intersection 关系。字典键 schema 参与引用发现；含机密的键会被拒绝，避免暴露键名。解析值、被覆盖的层及 schema 默认值中的错误形状机密容器都会被拒绝，即使更高层已让生效配置合法。所有分支都会贡献机密位置，因此存在歧义的分支可能隐藏原本公开的字段。机密数组位置变为 `null`。含机密的不支持的 transform、无法解析的 schema 引用及机密字面量 schema 会被拒绝，不会穿过 Remote。所有者必须声明机密；任意未标记字符串无法被自动识别为凭据。
- **跨进程并发由提供方定义**——服务仅在进程内按 namespace 串行写入；跨进程并发按提供方行为收敛（文件提供方在写锁下读-改-写，因此并发写入者不会丢掉彼此的 namespace，同 namespace 冲突按后写胜出解决）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

此非权威章节记录把 `ns` 更名为 `namespace` 的提议，范围包括 API、提供方、测试和消费方。公开行为和限制仍以上文为准。

</details>
