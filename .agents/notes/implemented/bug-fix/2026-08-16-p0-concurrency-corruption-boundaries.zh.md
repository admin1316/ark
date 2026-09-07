# Agent Note: P0 并发与损坏边界修复

Status: implemented

[English](2026-08-16-p0-concurrency-corruption-boundaries.md) | 中文

## 问题

静态审计（两模型交叉复审：gpt-5.6-sol-ultra 与 gpt-5.5-xhigh 各两轮）在四个 P0 缺陷上达成一致；返工反馈又增加了三个失败模式，批次通过前全部修复：

1. `run_code` 子调度 lane 在 `scheduler.dispatch`/`prepare` 拒绝或 commit 阶段抛错时绑定永不 settle：`drainDispatches` 永不收敛，run 即使 abort 也挂死。复审另发现 lane 失败后 `exclusiveActive` 残留（程序捕获绑定失败后再调用即卡死）、跳过 in-flight 与 settle 日志排干（违反 in-turn settlement 保证）。
2. `wakeDriver` 在 initiator scope 关闭窗口内同步抛错：driver promise 永久 pending、phase 卡 running、`whenIdle()` 与 disposal 死锁。
3. JSONL plaintext 把已提交区损坏行当 torn tail 静默截断——有效已提交事件被物理删除且零告警。复审另发现 zstd 路径的裸 corruption 错误绕过类型化包装，丢失 `SessionPersistenceCorruptionError`、raw 路径与 cause。
4. `retireCore` 在 drain flush 失败时保留 `states` owner 认领，id 被永久楔死（delete 与同 id 重建被永远拒绝）。复审另发现 ownerless state 放行所有控制器：两个同 id 生命周期都失败退休后，旧控制器的 teardown 重试可赢得串行竞争并持久化陈旧事件；`delete()` 之后旧控制器还能经 `adopt()` 复活该 id。

## 决策

**A — lane 终态。** `laneFailure` 以 `Error` 捕获；driver catch 重置 `exclusiveActive`、单独跟踪 commit 中的 head（成功提交后才清除，抛错时经 `fail(error)` 处理）、settle 全部挂起 head（queued-unstarted 走 abandon、started 走 fail）并清空队列。`drainDispatches` 先排干 live 池与 settle 事件工作，再上抛失败——失败路径上 in-turn settlement 同样成立。`binding` 入口检查终态标记：死 lane 的新调用立即拒绝而非排队。dispatch 拒绝折叠为按提交顺序落定的错误结果；prepare 拒绝在 driver 内捕获并 fail head（绑定拒绝 + 失败事件以 `tool/code-dispatch` 落日志）。

**B — wakeDriver 收敛。** `withInitiator` 调用包 try/catch：同步抛错时把 phase 收敛回 idle 并 resolve driver promise。teardown 窗口内丢弃该次 wake 与既有 `disposed` cause 语义一致；`whenIdle()` 永不悬挂。回归测试直接 `await agent.whenIdle()`（证明 `activityDone` 已 settle），断言关闭窗口内零 adapter 请求，恢复后新 wake 精确触发一个真实回合（请求数 +1）。

**C — corruption 契约对齐。** 扫描器输出 `corruption` 上下文（消息 + droppedRows/droppedEvents，含被回滚的 seq-gap 行本身）。`readPrefix` 在 raw 与 zstd 两条路径对 committed 损坏统一抛 `SessionPersistenceCorruptionError`（带 raw log 路径与 cause）；仅无换行的 torn EOF fragment 生成 tornMarker（截断 + 合成 closers）。扫描器的裸 throw（corruption 后跟 committed `turn/end`、完整 zstd 帧内 torn 记录）在 read 边界统一包装为类型化错误。两个既有崩溃模拟测试的 `'\n{"partial…'` 前缀（产生人工空行——真实 torn write 不可能产生）改为规范 fragment 形状。拒绝回归测试断言被拒 load 后工件字节逐字节不变。

**D — 精确所有权。** `retireCore` 失败时仅清除 `state.owner`（state 条目与 live write-behind 保留，钉死的 teardown 重试契约不变）。`appendLiveBatch` 按精确 owner 门控：state 缺失或归属他人即丢弃批次。`delete()` 移除该 id 的全部 stale 控制器（其守卫已排除 live owner）。`onCreated` 在继任者认领 ownerless state 时丢弃前任控制器。回归测试：继任者数据在前任 teardown 重试后胜出且无重复；delete 不复活 id；delete+create 不能经新 ownerless state 泄漏旧 pending 事件；无关 live 控制器在 delete 后完好。

## 备选方案

**lane 失败只上抛、不 settle 挂起 head。** 否决：程序可能正 await 其中任一绑定，永不 settle 的绑定会令 run 自身挂死——与原始缺陷同类。

**plaintext 损坏行继续容忍、只加 warn。** 否决（复审阻止）：README 契约要求 committed corruption 拒绝；warn+截断会固化错误行为。

**失败 retire 保留 `states` owner，使 delete 的 live 守卫仍可见。** 否决：该守卫正是楔死 id 的元凶；清除 owner 并在 `appendLiveBatch` 以精确所有权门控陈旧写入，在消除楔死的同时堵住同一漏洞。

## 后果

本批次把三个静默挂起/数据丢失路径转为响亮、类型化的失败，并在 I/O 失败后解除 session id 楔死。代价：两个钉死的扫描器层容忍仅保留在扫描器层（read 边界拒绝）；`delete()` 现在同时清除保留控制器（本就隐含的语义）；`run_code` lane 增加终态簿记，未来的调度器改动必须遵守。覆盖率门禁对两个不可达防御分支保留了窄范围 `v8 ignore` 注释（继任者已认领后的失败 drain 无物可清；delete 路径已移除其 state 的保留控制器）。
