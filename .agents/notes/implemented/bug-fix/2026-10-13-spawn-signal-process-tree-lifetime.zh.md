# Agent Note: Spawn cancellation follows process-tree lifetime

Status: implemented

[English](2026-10-13-spawn-signal-process-tree-lifetime.md) | 中文

## 问题

直接子进程的结果可能已经结算，但同进程组的辅助进程仍在执行。此时释放原始 spawn 信号，会让取消权早于[子进程服务](../../../../packages/subprocess/subprocess/README.zh.md)承诺的进程树生命周期结束。

## 决策

[本机提供方](../../../../packages/subprocess/subprocess-local/README.zh.md)和 [E2B 提供方](../../../../packages/e2b/subprocess-e2b/README.zh.md)保留原始 spawn 信号，直到现有进程树观察器确认完全停稳。启动失败且没有自有进程时立即释放监听器。本机提供方在直接子进程结算时启动或复用已记忆的唯一观察器；E2B 服务通过现有释放路径负责远程观察。两种提供方都不会让 `done` 等待整棵树退出。

Spawn 信号请求终止。传给 `waitForExit` 的信号仅限制这次观察的等待。消费方仍负责自己的期限与失败分类，包括[外部验证器的有界等待](2026-10-13-verifier-post-exit-cancellation.zh.md)。

## 考虑过的替代方案

**在直接结果结算时释放。** 这样能及时释放监听器，但会使仍存活的辅助进程不再响应调用方的取消请求。

**让 `done` 等待进程树退出。** 这会混淆直接命令状态与清理，并允许后代拖住已完成命令的结果。

**逐个修复消费方。** 消费方显式终止仍有用，但分别修补 Bash、验证器和其他调用方，会留下不完整的共享 spawn 约定。

## 后果

一处提供方修复覆盖使用其 spawn 信号的所有调用方。只要自有幸存进程仍存在，本机观察器就保持现有定时器运行，即使直接调用方没有开始自己的等待。一旦确认进程树已不存在，就释放监听器并停止发送信号；自然退出和启动失败都不留下监听所有权。既有宽限期、输出收集、结果值和协议字段保持原值。

回归测试覆盖 leader 退出后的取消、自然退出后的监听释放、启动失败及重复终止。POSIX 进程组身份在首次确认不存在前仍可能复用；离开进程组的后代可逃过组信号。Windows 仍受直接子进程存活探测限制。E2B SDK 替身验证了所有权规则，但不能证明真实沙箱行为。
