# Agent Note: SessionManager pending 簇提取

Status: implemented

[English](2026-08-16-manager-pending-tracker.md) | 中文

## Problem

`SessionManager`（packages/client/runtime）在单个 1183 行文件中承载三个独立簇——会话列表模型、子代理目录存储、实例化前 pending 缓冲。pending 簇最自包含：其状态独立于 Session 实例，wire 契约是三类 mux 帧对，消费方是帧入口、列表快照与连接代际生命周期。

## Decision

将 pending 簇提取到 `pending-tracker.ts` 的 `PendingTracker`（231 行）：每会话的可应答帧缓冲 + 未决交互状态映射，含 `handleUninstantiated`（按稳定 `a:`/`q:`/`queue` 身份缓冲/移除）、`replayInto`（向新实例化会话排空重放）、`trackFrame`/`track`/`resolve`（列表级状态，按 key 幂等）、`dropGeneration`（断连清状态并丢弃可应答缓冲帧——reopen 重放会重新添加）、`clearSession`（移除）、`dropQueueBaseline`（重订阅）、`statusesBySession`（每行一个主导状态，question 优先于 approval）。manager 组合单个实例，注入 `markDirty` 宿主回调；帧入口、`get()` 重放、永久删除、移除、断连与列表快照均改为委托。模块级 `bufferedRequestKey` 与 `questionInteractionStatus` 随迁为私有助手。manager 减少 112 行。

## Alternatives considered

**一次提取全部三个簇。** 拒绝：出于审查体量与风险。目录簇（refresh/inflight/debounce/stale/open/epoch 状态）与列表簇（变更重放、条目身份缓存、lineage 展平）各有不变量与 100% 覆盖面；pending 簇的 wire 契约（三类帧对、稳定 key）可独立测试。

## Consequences

行为逐字节不变——同样的稳定 key（`a:`/`q:`/`queue`）、同样的 `get()` 中先重放后同步 running 位的顺序、同样的代际语义。提取由既有 manager spec 覆盖（61 测试，pending-tracker 语句/分支/函数/行 100%）；无需修改任何测试。剩余簇（list-model、catalog-store）留待后续批次。
