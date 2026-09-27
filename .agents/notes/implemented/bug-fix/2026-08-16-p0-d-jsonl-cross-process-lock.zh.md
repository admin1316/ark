# Agent Note: P0 D——JSONL 跨进程写锁

Status: implemented

[English](2026-08-16-p0-d-jsonl-cross-process-lock.md) | 中文

## Problem

共享同一 JSONL 会话根的两个进程可能交错写入同一会话日志：materialize（首写）、append、崩溃修复（截断）与 delete 各自对工件做读-改-写而互不排斥，交错的 torn 写入会破坏已提交日志——正是加载路径现在会大声拒绝的那类损坏。coordinator 的 per-id serialize 链只保护单进程内的写入者。

## Decision

每个可变 JSONL 操作通过共享的 `withFileLock` 实现在根级按 id 的跨进程锁（`<root>/~locks/<encoded-id>.lock`）下执行。`appendBatch`、仅含头部的落盘、`deleteStored` 与修复提交都会持锁；读路径保持无锁，其可见性由追加及 rename 定义。共享辅助函数采用独占创建、PID 记录、有界等待及受保护的已退出持锁者恢复。[恢复决策](2026-09-27-selective-upstream-runtime-reliability.zh.md) 定义保守失败情形及释放归属检查。锁目录被排除在项目发现之外，不会被当作会话项目。

## Alternatives considered

**复用不带遗留持锁者恢复的 dsh-atomic-write `withFileLock`。** 最初的决策否决了这一行为，因为崩溃写入者可能无限期阻止后续修改。JSONL 使用共享实现，其已退出持锁者恢复满足该要求，无需重复锁协议；无法确认的持锁者及遗留接管声明仍采取保守失败。

**按日志文件加锁。** 否决：delete 会把会话目录 rename 走、文件随之移动；根级 per-id 锁与工件当前路径无关，统一覆盖 materialize→append→repair→delete。

## Consequences

同一根上的跨进程写入者按 id 串行。共享协议可回收合法的已退出持锁者记录，但并非每种孤儿文件都能自动恢复。`~locks` 目录保持在会话发现范围之外。单进程写入也使用文件锁，在第二个进程加入时仍维持同一修改边界。
