# Agent Note: 写穿队列的接纳上限与失败退避

Status: implemented

[English](2026-08-16-write-behind-capacity-and-backoff.md) | 中文

## Problem

会话持久化审计发现 P2-4 指出 `SessionWriteBehind`（packages/session/session-persistence/src/write-behind.ts）存在两处无界行为。其一，`pending` 事件数组没有容量上限：当事件产出速度超过后端写入吞吐（慢盘、大批量突发）时，待写缓冲区无界增长，且不向生产者提供背压。其二，写失败后没有退避重试：失败批次保留在队头并置 `automaticPaused`，下一次 `enqueue` 会重新武装固定的 200 ms 窗口并整体重试——永久性故障（磁盘满）因此永远付出"事件速率 × 全队列重试"的代价，反而加重故障后端的负载。

## Decision

`SessionWriteBehind` 现在限制接纳并放大重试间隔。这是对[有界写批处理决策](2026-08-08-bounded-session-persistence-write-batching.zh.md)的扩展：它选定的固定批处理截止时间与 flush 屏障语义保持不变。

- **容量上限。** 新增 `maxPendingEvents` 选项（默认 `DEFAULT_MAX_PENDING_EVENTS = 100_000`）限制待写缓冲区接纳的事件数。`enqueue` 超过上限时抛出 `SessionWriteBehindOverflowError` 拒绝接纳；在 session/event 路径上 SessionStore 会包含并记录该监听器异常，因此被拒绝的事件会带警告被丢弃，而不会超出内存上界被保留。协调器将该上限暴露为经校验的 `PersistenceCoordinatorOptions.maxPendingEvents`；JSONL 与 SQLite 保持默认值。
- **指数退避。** 连续失败计数器在每次写失败时递增，在任何一次成功写入时重置。下一次自动重试窗口按连续失败次数翻倍（200 → 400 → 800 → …），并以 `MAX_WRITE_RETRY_BACKOFF_MS = 5_000` 封顶，且不会低于基础批处理延迟。`automaticPaused` 语义不变：失败后自动重试暂停，直到下一次 `enqueue`（或显式 flush/拆卸）重新武装已退避的窗口。

## Alternatives considered

**用字节预算代替事件计数上限。** 已拒绝：为每次入队的事件估算序列化大小需要在热路径上做一次 JSON 遍历；事件计数上限是确定性的接纳门槛，也符合审计建议的 `MAX_PENDING_BATCHES` 形态。

**将溢出落盘（spill）。** 已拒绝：对 P2-4 而言属于过度设计——spill 文件加恢复时合并会使后端表面翻倍，而 fail-loud 接纳已经覆盖了该场景。

**只在协调器层设上限而不在单元层设。** 已拒绝：该边界属于持有缓冲区的类本身，这样每次直接构造（测试、未来的内嵌方）都会继承该上限。

## Consequences

产出速度超过后端的生产者现在会在接纳点收到背压：队列停止超过 `maxPendingEvents` 增长，被拒绝的事件带警告日志被丢弃（仅在持续溢出时才出现持久化缺口，且是响亮地暴露而非静默）。永久性故障现在最多按翻倍窗口重试一次，而不是每次 enqueue 都重试整个队列，并以 5 s 间隔封顶。正常路径行为不变：健康批处理仍写入一个固定窗口；除 write-behind spec 的构造需要显式传入该选项外，所有既有契约、崩溃恢复与写竞争测试均原样通过。
