# Agent Note: SessionManager 列表模型簇提取

Status: implemented

[English](2026-08-16-manager-list-model.md) | 中文

## Problem

pending 与目录簇移出后（2026-08-16-manager-pending-tracker、2026-08-16-manager-catalog-store），`SessionManager` 仍承载会话列表簇——summaries、拉取状态/阶段/错误、在飞变更重放、条目身份缓存、完成提醒、notifier 与快照构建器——与实例簇及帧入口并存。

## Decision

将列表簇提取到 `list-model.ts` 的 `ListModel`（527 行）：summaries 与 `applyMutation` 重放（blank 只降、running 兼作跨端 blank 翻转、preset 最新者胜、无变化 upsert 保持引用）、拉取状态/阶段/错误轴、notifier 支撑的快照缓存与条目身份保持、完成提醒、作业镜像与列表 API（`refresh`、`search`、`create`、`fork`、`mergeSummary`、`noteAgentPreset`、`recordMutation`、`subscribe`、`getListSnapshot`）。manager 组合单个实例，注入 `markDirty`/`notifyNow`/`ensureProjectionStore`/`projectionStoreOf`/`pushSummaries` 宿主回调；选择、帧入口、`get()`/`createSession` 与 `handleConnected` 均改为委托。manager 减少 327 行（858 → 531），现仅含实例簇与帧入口编排。

## Alternatives considered

**将 notifier 留在 manager。** 拒绝：notifier 拥有快照缓存生命周期（无监听者时脏后惰性重建），属列表簇状态；拆分会让重发布通道为每次变更跨两个对象。

## Consequences

行为逐字节不变——同样的变更语义（含 status 的 blank 翻转与无变化 upsert 的引用保持）、同样的首次拉取 `pending → ready` 边、同样的条目身份稳定性。由既有 manager spec 覆盖（61 测试，list-model 语句/分支/函数/行 100%；无需修改测试）。`SessionManager` 现为实例簇 + 帧入口 + 三个组合模型；文件架构 P2-2 批次完成。
