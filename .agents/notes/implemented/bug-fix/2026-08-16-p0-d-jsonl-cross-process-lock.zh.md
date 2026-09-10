# Agent Note: P0 D——JSONL 跨进程写锁

Status: implemented

[English](2026-08-16-p0-d-jsonl-cross-process-lock.md) | 中文

## Problem

共享同一 JSONL 会话根的两个进程可能交错写入同一会话日志：materialize（首写）、append、崩溃修复（截断）与 delete 各自对工件做读-改-写而互不排斥，交错的 torn 写入会破坏已提交日志——正是加载路径现在会大声拒绝的那类损坏。coordinator 的 per-id serialize 链只保护单进程内的写入者。

## Decision

每个可变 JSONL 操作都在根级 per-id 跨进程锁（`<root>/.dsh-locks/<encoded-id>`）下执行。锁文件以 `wx` 创建并写入持有者 pid；遇到已有锁的竞争者会检查该 pid 是否仍存活，并回收崩溃进程遗留的 stale 锁（`ESRCH`），因此崩溃不会楔死该 id。竞争按指数退避，10s 后失败。`appendBatch`、`deleteStored` 与 `commitRepair` 全部持锁；读路径（list、load、inspect）保持无锁，因为日志只追加、delete 经 rename 到 tombstone 分阶段完成。锁目录被排除在项目发现之外，绝不会被误认为会话项目。回归测试植入死 pid 锁（被回收）并运行并发写入对（两次 append 都落盘且不交错）。

## Alternatives considered

**复用 dsh-atomic-write 的 `withFileLock`。** 否决：它从不回收 stale 锁（孤儿恢复是运维动作），一个崩溃进程会让该 id 的每次写入永久 10s 超时；JSONL 需要自动回收 stale，因为其写入在热路径上。

**按日志文件加锁。** 否决：delete 会把会话目录 rename 走、文件随之移动；根级 per-id 锁与工件当前路径无关，统一覆盖 materialize→append→repair→delete。

## Consequences

同一根上的跨进程写入者按 id 串行；崩溃写入者的锁由下一个竞争者回收。根下出现 `.dsh-locks` 目录（排除在发现之外，绝不当作项目）。单进程行为不变，只是每个写批次多一次 mkdir+锁文件往返。
