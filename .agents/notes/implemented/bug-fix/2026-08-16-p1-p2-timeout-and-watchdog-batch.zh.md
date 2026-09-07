# Agent Note: P1/P2 批次——SDK 空闲超时、SSE 看门狗、修订重试上限

Status: implemented

[English](2026-08-16-p1-p2-timeout-and-watchdog-batch.md) | 中文

## Problem

企业审计异步/并发清单中的三个无界等待缺陷。其一，`HarnessSession.run()` 等待运行时空闲状态没有截止时间：楔死的运行时（挂起的审批、模型停滞、死亡传输）会让 SDK 自动化永久阻塞，而 `requestTimeoutSeconds` 只约束 unary 调用。其二，fetch carrier 的 SSE 读取器既无空闲看门狗也无帧缓冲上限：半开连接（对端消失但未 EOF）让流静默保持「已连接」，行为异常的对端持续发送无帧边界的数据会让内存无界增长。其三，`PersistenceCoordinator` 的 prepare/load/inspect 收敛循环（`for (;;)`）没有迭代上限：持续的外部写入者可无限期推迟收敛。

## Decision

**`Session.run()` 增加空闲截止时间。** 等待由新增的 `run_timeout_seconds` 参数约束，未给出时使用 `DeepSeekHarnessConfig.request_timeout_seconds`；两者皆无时等待保持无界（显式退出）。`NotificationSubscription.next()` 接受 timeout 并在队列空时抛 `TimeoutError`，run 循环把剩余预算传入，静默运行时无法把循环拖过截止时间。空闲超时错误点名会话、prompt 消息 id 与可能的楔死原因。回归：永不发出 idle 的 fake runtime 抛 `TimeoutError` 而非阻塞。README（中英）已文档化该参数。

**SSE 读取器受看门狗与边界约束。** 每次 `reader.read()` 与 60s 静默计时器赛跑；超过即抛半开传输错误而非冻结。解码后的帧缓冲上限 16 MiB；永不发出 `\n\n` 边界的对端会触发上限。两个赛跑输家都被消费，避免未处理拒绝。回归：无边界无尽流以缓冲上限错误拒绝；首帧后静默的流在 fake timers 下以半开错误拒绝。

**收敛循环加上限。** prepare/load/inspect 最多重试 64 次（`MAX_REVISION_RETRIES`），随后抛响亮的收敛错误而非在持续外部写入者下空转。不可达分支以 `v8 ignore` 注释（测试无法驱动 64 次串行 entry 竞争）；coordinator 覆盖率保持 100/100/100/100。

**`waitWithSignal` 传播拒绝。** e2b 等待辅助此前丢弃拒绝的 promise：拒绝变成未处理、abort 监听泄漏、外层等待永不 settle。现在转发拒绝（先移除监听器）；所有当前调用方都传入不拒绝的 promise（`commandState` 总是 resolve，其余皆 `.catch` 包装），因此新分支是防御性的并以 `v8 ignore` 注释。失败命令的 `waitForExit` 仍 resolve `true`（静止），崩溃测试已断言。

**到期 schedule 提醒在 framing/followup 失败后重排。** 此前 framing catch 返回 `false` 且不重排，瞬时失败会静默丢弃一次性提醒。catch 现在布防 30s 重试（`DISPATCH_RETRY_DELAY_MS`）；下次 drive 重新决策并送达。回归：throwFollowup 后恢复恰好送达一次 followup。

**SQLite 搜索索引重试失败的打开。** `_ensureReady` 此前缓存首次 `_open()` 的结果，瞬时文件系统或锁失败会让索引在进程生命周期内楔死。失败的打开现在在重抛前重置 `_ready`，下次调用重试；回归覆盖 `openAt: 'first-search'` 下只读目录恢复为成功搜索。

**LSP 拒绝空 Content-Length 值。** `Number('') === 0` 让空白的 `Content-Length:` 溜过校验进入 `JSON.parse('')`，杀掉连接。空值被显式拒绝；单元与连接回归覆盖它，无冒号的头行仍可跳过。

**首行读取加字节预算。** `readFirstLine` 与 `readFirstZstdLine` 现在在 `MAX_HEADER_READ_BYTES`（1 MiB）内未出现完整换行或 zstd 头帧时放弃（返回 `undefined`，工件从发现中缺席）；损坏或恶意的日志不再无界累积内存。回归覆盖两种编码。readPrefix 兜底重抛（所有扫描层拒绝要么已类型化、要么匹配损坏正则）在完整追踪可达拒绝类别后以 `v8 ignore` 注释。

**修订稳定读加上限。** `readStableFile` 的 stat/read/stat 重试循环现在在 10s 墙钟预算（`READ_STABLE_DEADLINE_MS`）后响亮失败，而不是在持续追加的活跃日志下空转；回归测试让每次 stat 报告不同修订并把 `Date.now` 推进过预算。

**三条审计 P2 评估为设计而非缺陷。** （1）telemetry `handoffCursor` 刻意模块级——cordis 无 HMR 状态交接 API，按 store 持有的 Session 对象为键让重新采纳的 fiber 恢复而非重放历史，且 otel bundle 以互斥方式实例化 live 与 on-demand 两个 coordinator，实践中不会有两个实例共享游标。（2）projection-cache `deletionEpoch` 条目从不删除，因为 epoch 单调性是关键语义：删除条目可能让快照了旧 epoch 的过期冷读通过后续 delete 的新 epoch 检查并写回陈旧行；代价是每个已删除 id 8 字节。（3）session-title 每次 user 消息的 `collectSessionTitleMessages(session.events, event.seq)` 全量扫描是标题固有的 O(n) 折叠，且调度路径在标题已存在时短路（`this.get(session) !== undefined`），因此 O(n²) 仅在 fallback 标题创建持续失败时出现。

**`syncTools` 先注册新一代、再释放上一代。** 交换此前先 dispose 旧工具集，注册冲突会中途让该服务器的工具整体消失。现在新一代在上代仍存活时注册；冲突时回滚部分新一代并保留上一代（`kept the previous tool set`），`registrationFailure: 'throw'` 在严格初始同步时仍重抛。回归：冲突名称使交换失败且旧工具仍保持注册。

**ACP `agent/error` 只拒绝相关 turn。** 守卫此前在错误 turn 与在飞 turn 匹配时提前返回，相关失败永不拒绝——客户端等待挂起——而无关 turn 的错误反而拒绝错误等待。守卫现在在 turn 未知（prompt 从未被认领，如 turn/start 失败）或与在飞 turn 匹配时拒绝，只忽略已知不同 turn 的错误。回归：不同 turn 的错误被忽略且等待保持 pending；turn/start 失败拒绝。

**workflow parentPort 监听器评估为设计而非缺陷。** 每次 workflow run 都生成全新 worker 进程，`parentPort` 消息监听器不会跨 run 累积，受进程生命周期约束；未作修改。

**`phase()`/`log()` 叙述按 run 预算。** 失控脚本可在紧循环中调用钩子并洪泛 host 事件总线与会话日志。worker 现在把每次 `phase()`/`log()` 调用计入 `maxNarrationEvents`（引擎 Config，默认 5000）；超出后 run 以 `NARRATION_CAP` 响亮失败而非洪泛。回归：phase-only、log-only 与共享预算越过上限；runtime 覆盖率保持 100/100/100/100。

**llm 适配器 disposer 包容处置失败。** `registerAdapter` 的 disposer 此前用 `void dispose()` 丢弃 ctx.effect disposer 的结果：同步 INVARIANT 编码的 `llm/adapters-updated` 监听器失败在处置内部重抛并逃出 disposer 调用点。handle 现在记录日志而非让其逃逸。回归：注册后安装的监听器仅在处置时失败并被记录。

**llm 适配器流包容提前关闭的清理失败。** 下游消费者提前 break 时，reject 的 `iterator.return()` 清理此前传播进 break 点，掩盖消费者自身的完成。finally 现在记录清理失败；内置适配器永不触发，第三方路径被包容。回归：reject 的 `return()` 让消费者循环正常完成并记录失败。

## Alternatives considered

**让 `next()` 保持阻塞、只在通知之间检查截止时间。** 否决：静默运行时永不投递通知，循环会卡在 `next()` 内部越过截止时间；队列等待本身必须携带剩余预算。

**依赖传输自身的 EOF 检测半开。** 否决：半开 TCP 连接不会 EOF；只有墙钟看门狗能区分静默与死亡。

**收敛循环保持无界。** 否决：JSDoc 已承认「持续的外部写入者可推迟完成」；上限把无限空转变成响亮、可诊断的失败。

## Consequences

带请求超时的 SDK 调用方现在获得有界的 `Session.run()`；依赖无界等待的调用方必须在无请求超时的配置上显式传 `run_timeout_seconds=None`。SSE 消费者在 60s 静默后看到流错误而非静默冻结，病态对端无法把缓冲帧内存推过 16 MiB。持续外部写压下的 coordinator 调用方在 64 次重试后响亮失败而非空转。MCP 客户端在交换中途的注册冲突中保留上一代工具集，ACP 客户端不会被相关 turn 失败挂起。耗竭叙述预算的 workflow 脚本响亮失败而非洪泛观察者；llm 适配器处置与提前关闭清理失败被记录而非逃逸。
