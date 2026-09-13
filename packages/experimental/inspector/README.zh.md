---
description: "面向 Host Cordis 运行时的实验性 Chrome DevTools 检查，由 Worker 管理 Console、Sources、Network 采集、Elements 树与查询 API。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-inspector

[English](README.md) | 中文

## 概述

使用这个实验性 Inspector，可以在 Chrome DevTools 中检查一个运行中的 dsh Host。它提供 Host Console 求值、Sources 与调试、Host fetch 采集及 Cordis 树，并让 Worker 管理 CDP 状态。本包不提供浏览器 Client 插件；保留的 Worker ingest 协议需要另行实现的 adapter。

本包为私有包，不进入正式发布。Worker 不访问实时 Cordis 对象；共享 Cordis collector 会在传输前把它们投影成已验证 snapshot。Cordis 还负责插件组合、注册 `ctx.inspector`、注入 bootstrap 和资源释放。

## 目录

- [运行时布局](#runtime-layout)
- [配置](#configuration)
- [观测 API](#observation-api)
- [Cordis 树检查](#cordis-tree-inspection)
- [Host fetch 采集](#host-fetch-capture)
- [安全](#security)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="runtime-layout"></a>
## 运行时布局

Host 插件启动 Worker 并连接专用 `MessagePort`。Chrome DevTools 连接 Worker 的 CDP WebSocket。每条 DevTools 连接在 Worker 中独占一个连接 Host 主线程的 `node:inspector.Session`，因此 Host JavaScript 暂停时，Host Console 求值、Sources、断点和 resume 仍然可用。

源码树包含 `host/` adapter 与库入口、`worker/` 编排与 Chrome protocol 状态，以及 `shared/` 中与环境无关的模型和桥接协议。`worker/realms/` 保留 Host 与外部 source 协议 adapter；两者都在 Worker 中运行。包中没有 `src/client` 插件入口，也不交付 `lib/client.js` bundle。

Host 与任何已接纳外部 producer 发送内部观测记录，不发送 CDP 消息。记录包含 source generation、sequence、source 时钟时间、topic 和 JSON payload。Worker 验证每个进程或网络帧，独占 source 状态与保留历史，并把已识别 topic 转换成标准 CDP domain。

保留的外部 source 协议可以声明 Runtime、Console 与只读 Sources 能力。Worker 将请求路由至已注册 source 并校验回复；本包不提供浏览器实现。target-wide pause 与 resume 只控制 Host debugger。

Host 使用共享 Cordis collector，把可达 Context 与 Fiber 对象转换成有版本的 `CordisTreeSnapshot`。Worker 保留这份与 CDP 无关的表示，并把已接纳 source 的 snapshot 投影到 Elements。

<a id="configuration"></a>
## 配置

Host 插件注入 `webServer`，接受以下字段：

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `host` | `127.0.0.1` | Worker endpoint 监听地址；只接受 loopback |
| `port` | `9230` | Worker endpoint 起始端口；端口占用时向上递增，`0` 表示由操作系统分配 |
| `clientOrigins` | `[]` | `/ingest` 额外接受的精确浏览器 origin；loopback origin 始终允许 |
| `captureFetch` | `true` | 包装 `globalThis.fetch` 并发布之后的每次调用 |
| `maxRequestBodyBytes` | 8 MiB | 每次请求保留的 request body 前缀 |
| `maxResponseBodyBytes` | 32 MiB | 每次请求保留的 response body 前缀 |
| `maxBodyChunkBytes` | 48 KiB | base64 编码前一条 body 记录携带的原始字节数 |
| `maxJournalBytes` | 256 MiB | Worker 保留的请求与响应 body 总字节数 |
| `maxRetainedRequests` | `2000` | Worker 保留的进行中与已完成请求总数 |
| `maxSourceFrameBytes` | 128 KiB | 编码后的 source frame 上限 |
| `maxSourceRecordsPerFrame` | `128` | 每个 source batch 的记录数 |
| `maxQueuedRecords` | `2048` | 每个 producer 等待发送的记录数 |
| `maxQueuedBytes` | 16 MiB | 每个 producer 等待发送的编码字节数 |
| `startupTimeoutMs` | 10 秒 | Worker ready 截止时间 |
| `stopTimeoutMs` | 5 秒 | 强制终止前的 Worker 优雅关闭期限 |
| `clientReconnectBaseMs` | 250 ms | Client 首次重连退避上限 |
| `clientReconnectMaxMs` | 5 秒 | Client 最大重连退避上限 |
| `clientRuntimeTimeoutMs` | 30 秒 | 一次 Worker 到 Client Runtime 或 Sources 命令的截止时间 |
| `queryTimeoutMs` | 10 秒 | 一次非 CDP 语义查询的截止时间 |
| `maxClientRuntimeObjects` | `10000` | 每条 DevTools 连接保留的 Client 实时对象 handle 数 |
| `maxClientRuntimeProperties` | `2000` | 单次 Client 对象检查返回的属性描述符数 |
| `maxClientSourceBytes` | 8 MiB | 单个 Client script 或 source map 允许读取的最大编码字节数 |
| `maxCordisNodes` | `2048` | 一个 realm snapshot 截断前允许的 Context 与 Fiber 节点数 |
| `maxDisconnectedCordisTrees` | `8` | 作为非实时 snapshot 保留的最近断联 realm 树数量 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-inspector)是全部已接受字段及其声明的详尽来源。

Worker 监听后，Host 会记录一个 `devtools://` URL。同一个 Worker 提供 `/json`、`/json/list`、`/json/version`、`/devtools/page/<id>` target WebSocket 和 `/ingest` Client source。

<a id="observation-api"></a>
## 观测 API

Host 插件提供以下服务：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { InspectorJsonValue } from '@deepseek-ai/dsh-experimental-inspector'

declare const ctx: Context
declare const topic: string
declare const jsonPayload: InspectorJsonValue

ctx.inspector.publish(topic, jsonPayload)
await ctx.inspector.cordis.getTree()
```

发布操作先验证无损 JSON，再调度发送，不等待 Worker。每个 source 的队列都有上限；溢出表现为 sequence gap，绝不延迟被观察的应用操作。`cordis.getTree()` 读取 Worker 最新的 detached semantic snapshot，不创建 CDP session，也不启用 Runtime、Debugger 或 Sources。

<a id="cordis-tree-inspection"></a>
## Cordis tree inspection

Elements document 包含固定的 `<host>` 与 `<clients>` 容器。`<host>` 包含 Host root Context；`<clients>` 为每个 Client source 包含一个 `<client>`，每个 `<client>` 再包含该 realm 的 root Context。Cordis root Fiber 不显示。其他 Fiber 都是 `fiber.parent` 的子节点，并包含唯一一个表示 `fiber.ctx` 的 Context 子节点；Fiber 只携带 `uid="<Cordis Fiber.uid>"`，Context element 不携带 attribute。只有 Context 的 `extend()`、`isolate()` 与 `intercept()` 层仍然是直接 Context 后代。

Host 与已接纳外部 source 发布同一种嵌套 `CordisTreeSnapshot` 类型。Context 与 Fiber 节点携带用于 realm-local 对象查询的不透明 object handle；Fiber 还携带 Cordis `uid`。Worker 把这些 realm snapshot 组合成一棵 `{ host, clients }` inspection tree。Worker 按 source generation 分配 `BackendNodeId`；每条 DevTools 连接分配自己的 `NodeId`；`DOM.resolveNode` 请求所属 Host 或 Client Runtime 生成连接本地 `RemoteObjectId`。`DOM.requestNode` 把该 object id 映射回同一个 Elements 节点。`ctx.inspector.cordis.getTree()` 与 `DSHInspector.getCordisTree` 读取不含 routing handle 或 CDP id 的 detached consumer-neutral tree。

节点按 DevTools 连接做深度受限下发：调用方省略 `depth` 时 `DOM.getDocument` 提供三层 document，被扣留的层级通过 `childNodeCount` 声明数量，展开时经 `DOM.requestChildNodes` 获取（`depth: -1` 取整棵子树）。经 `DOM.performSearch`、`DOM.requestNode` 或 `DOM.pushNodesByBackendIdsToFrontend` 流出的 NodeId 会先把尚未下发的祖先层级以 `DOM.setChildNodes` event 推送出去。

source 仍发布完整 snapshot，Worker 在通知 DevTools 前按稳定的 backend node identity 比较差异。无变化的 snapshot 不发送 DOM event；新增、移除和 attribute 变化使用节点级 CDP event，插入节点的载荷扣留其子树，兄弟节点重排只替换对应 parent 的 children。现有 `NodeId` 与未受影响的 Elements 展开状态保持稳定。

Client 断联时，其 Console execution context 与 live object id 会立即销毁。启用断联树保留后，Elements 会原样保留最后一棵树；连接状态留在 inspection model 中，不会未经设计就成为 DOM attribute。重连会沿用逻辑 source id，为新的 transport generation 创建新的 synthetic CDP context id，并在完整 snapshot 到达后替换旧树。source 身份与重连必须由外部 adapter 提供。Worker 最多保留 `maxDisconnectedCordisTrees` 棵此类 snapshot；设为零会立即移除。

<a id="host-fetch-capture"></a>
## Host fetch 采集

fetch 采集默认开启，记录完整 URL、全部请求与响应 headers、请求体、响应体、状态、时间、错误和取消。它不脱敏 credential、Cookie、query value 或 payload。body 采集读取 clone；原始 fetch resolve 后，调用方立即拿到原始 Response。

配置的 body 上限限制保留量，而不选择字段：采集保留前缀并标记 truncated。`Network.getRequestPostData` 与 `Network.getResponseBody` 读取 Worker 保留的字节。`Network.streamResourceContent` 返回已缓冲的前缀，并仅为发起调用的 DevTools 连接把后续 response 字节附加到 `Network.dataReceived`，以驱动实时 Response 与 EventStream 视图。直接调用 Undici Client/Dispatcher，以及插件激活前保存的 fetch 引用，不在观察范围内。

response headers 到达后，调用方 abort 可能会终止 observer clone；已采集的字节仍可通过 `Network.getResponseBody` 读取，采集 metadata 记录错误与截断，并且 CDP 因 fetch 已返回 Response 而发送 `Network.loadingFinished`。response headers 到达前发生的 fetch rejection 会发送 `Network.loadingFailed`，其中 abort 对应 `canceled: true`。

<a id="security"></a>
## 安全

CDP target 通过 `Runtime.evaluate` 提供 Host 和已连接 Client realm 中的任意代码执行能力，Host Debugger 操作还会提供额外控制，完整 fetch 采集也包含秘密。因此 Worker 只接受 `127.0.0.1` 监听地址。Client ingest 还要求 Host 注入的随机 WebSocket subprotocol token；除非配置明确允许，否则拒绝非 loopback origin。CDP socket 本身不携带 token，loopback 监听是它唯一的访问控制。

<a id="model-experience"></a>
## 模型体验

无：这个仅供开发者使用的 Inspector 只观察运行时活动，不改变模型请求。

#### KV Cache 影响

无：本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **不包含浏览器 Client adapter**——保留的 Worker source 协议不是浏览器产品，也不是 Ark 回退界面。
- **fetch 拦截范围是 `globalThis.fetch`**——直接调用 Undici API，以及激活前保存的 fetch 引用不会被观察。
- **body clone 有运行成本**——完整采集会 tee 请求与响应 stream，直至达到配置上限，可能增加内存与 I/O 压力。保留 body 的上限不包含 stream tee 内部的缓冲，包括来源提供的超大 chunk，或为读取较慢的应用分支排队的数据。
- **不自动重启 Worker**——Worker 意外退出会使当前 Inspector 实例失败；生命周期恢复留待后续改动。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
