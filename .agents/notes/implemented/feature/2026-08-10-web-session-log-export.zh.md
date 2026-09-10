# Agent Note: Web 会话日志导出——宿主流式 ZIP 下载

Status: implemented

[English](2026-08-10-web-session-log-export.md) | 中文

## 问题

Trajectory 视图没有任何方式把调试工件交到人手里：原始会话日志存放在磁盘与宿主侧，客户端历史面只提供折叠后的投影（而非原始事件），而带子代理的会话横跨多个相互独立的会话日志。bug 报告需要整棵会话树的完整原始日志，并且形态要能在被转发后仍然可用。

## 决策

- **导出是宿主侧的下载面，不是 RPC**：`GET /api/session.export?sessionId=…&includeDescendants=true` 流式返回一个 ZIP 附件。每个文件都是会话**存储工件的逐字原文**：持久化服务新增的 `readRaw` 读取后端自己的持久化字节（jsonl 后端解码其物理 zstd 帧，或直接返回明文）——绝非从解析后事件重建，因此 chunk 打包、键序、换行全部逐字节保留——放在其原始基础文件名下（根为 `session.jsonl`，子代理为 `subagents/<id>/session.jsonl`）。压缩在宿主侧使用 fflate 流式 `Zip`/`ZipDeflate` API 和已验证的 `sessionExportCompressionLevel` 0–9（默认 6），使部署可以在 CPU／延迟与归档大小之间取舍；每个条目按有界分块边产出边压缩，响应随生成分块写出，宿主从不把整个归档放进单个缓冲区（除预载的根外，最多同时持有一条后代的工件文本）。到达 64 KiB 响应字节高水位后，生产会等待 Consumer pull 恢复容量；fflate 的同步回调最多只会在该队列界限外再增加一次有界输入 push。不写清单——每个文件都与持久化工件逐字节一致，并通过自身 header 行自描述。
- **错误词汇是 HTTP 原生的**：服务缺失 → 500，后端不提供每会话原始工件 → 501，根会话缺失 → 404（三者都在任何字节流出前判定），后代缺少存储工件 → 流失败（fail-loud，绝不静默少导出）。请求中止会保持取消语义而不会改写成 500；请求取消与响应 Consumer 取消汇合到生产者 signal，该 signal 会传到血缘、持久化与附件读取，并终止活跃压缩器。载体（`toFetchHandler`）已对 `/api` 应用信任围栏；GET 分支与既有 SSE GET 路由并列，由 `ApiProxy.downloads.sessionLog`（host-only、无 wire 信封、不在 `IApiClient` 上）实现。
- **UI 只负责下载**：浏览器 Consumer 可以先发出不读取 body 的 `HEAD` 预检以取得准备阶段错误，再把 GET 端点交给浏览器原生下载管理器，因此 JavaScript 不会缓冲 ZIP。早先迭代发布的 `session.log` RPC 已删除——下载端点是它唯一的消费者，仓库规则是不留无当前所有者的公共接口。客户端 bundle 不包含任何归档实现。
- 当前 Header 与 `/export` Consumer 由 [Web 导出命令与弹窗决策](2026-08-11-web-export-command-and-dialog.zh.md)定义。

<a id="terminal-failure-and-cancellation"></a>

## 终态失败与取消

保留的宿主实现是 [`streamSessionLogZip`](../../../../packages/host/session-remote-operations/src/session-export.ts)，通过 `ctx.connection.downloads` 注册在 `/api/session/export`。[通用 Web UI 退役决策](../simplification/2026-08-29-retire-generic-web-ui.zh.md)取代了本文关于浏览器、ApiProxy、旧路由和 fixture UI 的描述；这些段落记录原始交付设计，不代表当前产品可用性。[包约定](../../../../packages/host/session-remote-operations/README.zh.md)定义当前消费方。

ZIP 生产者只拥有一个终态结果。编码器失败会立即使响应报错，并中止后续条目生产；迟到的数据或完成回调被忽略。压缩器终止发生在同步编码器回调退出之后：fflate 报错后仍可能继续当前 `add()` 调用栈。已经中止的请求会保留自身原因，优先于随后发生的编码器错误或生产者清理错误。编码器错误一旦选定终态，迟到的请求中止不能替换它。

消费方取消先选定取消终态，再终止编码器，并等待生产者退出。生产者以取消原因本身拒绝属于预期清理；不同的生产者清理拒绝或编码器终止失败会使取消操作拒绝。次生清理错误不能替换已交付给读取方的响应失败。归档完成后才到达的取消不会改变成功结果。

会话导出的行为测试固定了逐字节保真的成功结果、容量背压、真实编码器失败、迟到回调、取消顺序、清理拒绝与空编码分片。超长文件名 fixture（测试前置数据）触发真实 fflate 错误，但不代表第一方 JSONL 提供方会产生这种文件名，也不代表 macOS 可以存储它。平台回调故障探针验证错误隔离，而非已知的安装态应用触发条件。这些测试不能证明 GUI 响应性或 Connection 传输层的生命周期验收。

## 考虑过的替代方案

- **`session.log` 数据 RPC + 客户端打包**——先发布，后与用户共同否决：浏览器要拉取完整原始 JSON（约为最终 zip 的 10 倍）并在主线程压缩；对实际使用中 23 MB 级别的会话，宿主流式严格更优。迁移时把该 RPC 一并删除，而不是留作无消费者的公共接口。
- **用信封行把多会话编码进单一 JSONL**——与用户共同否决：把多个会话混进一个 JSONL 会失去干净的按文件边界；ZIP 让每个会话保持一个规范文件。
- **jszip**——更重（约 100 kB），依赖图还会拉入 readable-stream 的浏览器映射；fflate 专为此而生且体积小。
- **将 fflate 浏览器入口 vendoring 进仓库**——仓库的 vendoring 流程面向 cordis 级别的固定源码；resolveId 别名在保持维护中的依赖的同时无需复制代码（宿主侧 fflate 根本不需要别名）。

## 后果

- 导出保真度：读取每个实时根会话或后代前，导出器会通过权威的 `SessionStore.flush` 持久性屏障；每个导出文件都与由此得到的持久化工件逐字节一致。实时会话可能在自身读取后再次追加，因此归档是按会话读取边界形成的快照，而不是整棵树的原子快照。压缩包名为 `dsh-session-<sanitized-id>.zip`，归档路径在塑造条目前会先净化会话 id。
- `supportsRawArtifacts` 明确区分后端能力与会话缺失：SQLite 等不支持的后端报告 `false`，具体 `readRaw` 默认会拒绝；JSONL 覆写则报告 `true`、自持物理解码，并只用 `undefined` 表示工件缺失。`ApiProxy.downloads.sessionLog` 为契约新增一个 host-only 成员，外加宿主侧 query schema，并在 fetch handler 加一个 GET 分支——没有 RPC map 行、信封 schema 或客户端 `IApiClient` 面。
- fixture 模式（无宿主）对导出应答 404，浏览器会将其报告为下载失败；navigation-panes golden 快照包含「导出」按钮。
- 暂缓：transcript.md 以及 report/feedback 打包留待后续；逐字节忠实、无清单的形态让 v2 的打包扩展保持廉价。
