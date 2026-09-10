# Agent Note: SessionManager 目录簇提取

Status: implemented

[English](2026-08-16-manager-catalog-store.md) | 中文

## Problem

pending 簇移出后（2026-08-16-manager-pending-tracker），`SessionManager` 仍承载子代理目录簇——持久直接父地址、每父快照、单飞拉取、打开菜单成员更新、移除时失效——以私有 map + 内联逻辑散布在选择、实例构建、帧入口与列表快照中。

## Decision

将目录簇提取到 `catalog-store.ts` 的 `CatalogStore`（344 行）：地址 + 快照 + 在飞生命周期，含只读面（`snapshot`、`catalogOf`、`addressOf`、`hasAddress`、`navigationAddress`、`retainAddress`、`parentAvailable`、`isOpen`、`openIds`）、帧入口 sink（`markExpandable`、`scheduleRefresh`、`updateActivity`、`handleOwnerRemoved`——即原先横跨 removed 分支的移除时父可用性失效）、`clearSession`（永久删除：debounce/inflight/stale/open/catalogs/addresses 及子地址清扫与跨目录条目移除）、刷新生命周期（`refresh`、`setOpen`）。manager 组合单个实例，注入 `markDirty` + `onParentAvailable` 宿主回调；选择、`get()`/`createSession`、宿主帧入口、`handleConnected` 与列表快照均改为委托。manager 减少 213 行（1071 → 858）。

## Alternatives considered

**先提取列表模型簇。** 拒绝：列表模型读取目录与地址（快照 `subagentsByParent`/`current`、选择可用性），且目录簇的帧入口 sink 是 `handleHostEnvelope` 中最大的内联块；先提取 store 可在列表状态机迁移前移除最深的耦合。

## Consequences

行为逐字节不变——同样的单飞复用、同样的请求局部可展开/活动折叠、同样的移除时 override 语义。由既有 manager spec 覆盖（61 测试，catalog-store 语句/分支/函数/行 100%；无需修改测试）。列表模型簇（变更重放、条目身份缓存、lineage 展平、完成提醒）仍在 manager.ts，留待最后一批。
