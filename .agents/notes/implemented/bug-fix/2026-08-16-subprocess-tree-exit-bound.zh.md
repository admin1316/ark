# Agent Note: subprocess-local 有界进程树退出观察

Status: implemented

[English](2026-08-16-subprocess-tree-exit-bound.md) | 中文

## Problem

`LocalSubprocessRuntime` 的拆卸通过无期限的 `while (treeAlive()) await sleepTick()` 循环等待整树存活：处于不可中断状态（D 状态，如挂死的 NFS I/O）且扛过 SIGKILL 的后代，使 `waitForExit()`——进而服务 dispose、插件 HMR 重载与任何 `ctx.effect` 清理——永久挂起。

## Decision

`observeTreeExit` 现在在滑动绝对期限（每次 terminate/waitForExit 调用 `2 × spec.graceMs`：一个宽限期给 SIGTERM 层，一个给 SIGKILL 落地并被观察）内轮询。超时且树仍存活时置 `treeExitGivenUp`、停止轮询并如实返回 `false`——不触碰 pid 复用防护、不清升级宽限计时器。`terminate()` 重置放弃状态并重建 observer，使后续升级仍被观察；`waitForExit()` 在先前已放弃后立即上报未确认树。拆卸记录警告并继续而非阻塞；退出未被确认的句柄仍被持有（`release` 将其保留在 live 集），后续 dispose 仍可升级。`terminateForHostExit` 的同步 SIGKILL 路径未动。

## Alternatives considered

**永不放弃。** 拒绝：那正是被修复的挂起；有界上报在保留 pid 复用防护的同时让拆卸继续。

**可配置期限。** 本变更拒绝：`graceMs` 已按 spec 变化，加倍即自然边界；新旋钮需要第二个消费方契约。

## Consequences

含不可杀成员的进程树在拆卸时于两个宽限期边界返回并告警，而非阻塞进程；正常树（在宽限窗口内退出）观察不到变化。三个新测试锁定放弃上报、拆卸告警路径与仍被持有句柄的升级（包内 125 测试，多次重跑稳定）。
