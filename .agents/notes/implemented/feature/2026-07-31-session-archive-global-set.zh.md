# Agent Note: 会话归档（注册表级全局集合）

Status: implemented

[English](2026-07-31-session-archive-global-set.md) | 中文

## 问题

Sidebar workspace 浏览区的会话行菜单里，「Delete session」一直是纯视觉占位（无 handler）。产品口径定为**归档**而非删除：会话日志与 workspace 记账都不动，只把该会话从所有分组视图（workspace 分组、Ungrouped、搜索、平铺列表）里隐藏。归档记录需要一个落点：Ungrouped 的会话不属于任何 workspace 实体，per-workspace 字段放不下它。

## 决策

**归档集合是 workspace domain 全局单例（`workspaceDomainState.archivedSessionIds`）上的一个新字段，覆盖在 workspace 记账之上；显示过滤全部收敛在 client 的 `tree.ts` 派生层；wire 面走全快照姿态。**

- 存储：`archivedSessionIds: z.array(sessionId).default([])`，domain version 保持 2——纯新增字段，旧介质经 schema default 解析为空集合，无迁移代码。被归档的会话保留其 `sessionIds` slot（未来取消归档恢复原位置），因此与「一个会话只被一个 workspace 记账」不变式零纠缠。
- 注册表：`ctx.workspaceRegistry.archiveSession(id)` 走 `enqueueOperation` 与 create/delete 串行；未知会话（实时与持久化都查不到）抛 `WorkspaceUnknownSessionError`；已归档 id 不写盘不发事件。`archivedSessionIds` getter 暴露只读集合。
- RPC：`workspace.archiveSession({sessionId}) → {archivedSessionIds}`（应答更新后的完整集合）；`workspace.list` 响应携带集合作为重连基线；新 host 帧 `host/archived-sessions-changed` 在每次持久变更后推完整快照（与 `host/workspace-changed` 同姿态，从 `domain/changed` 的 global put 分支比对推帧）。未知会话复用错误码 `session-not-found`。
- client 运行时：`WorkspaceListState.archivedSessionIds`（按 Host 顺序的 `readonly SessionId[]`，成员不变不换引用——公有快照状态保持 store 引擎的纯数据词汇：immer draft 不开 MapSet 插件就不接受 Set；membership 查询在派生函数内自建临时 Set，与 expandedProjects 同款）；list 基线、unary 回声、changed 帧三路都会用完整集合整体替换现有值。投影层在当前 selection 落入归档集合时统一清空回 New Session 视图（用户拍板：归档当前打开的会话会使主视图回到 hero）——一条规则同时覆盖本地 unary 回声、其他标签页的 changed 帧、以及重连基线发现当前 selection 已在此 client 离线期间被归档的情形；帧/回声落在 in-flight `workspace.list` 期间时还会屏蔽旧基线对新集合的回滚。
- UI：菜单项 `delete`（visual-only）改为 `archive`（label「Archive session」，非 danger 样式，无确认对话框——非破坏性操作，误触后果只是列表隐藏）；过滤实现为 `tree.ts` 的 `sessionVisible` 判据加一档，`deriveGroups`/`deriveFlat` 增加 `archived` 集合入参，四个视图（分组循环、stray 兜底、搜索、平铺）同源生效。
- 归档生命周期：带数量的「归档」头部入口打开显式列表，归档会话不会在这里被直接打开。`workspace.unarchiveSession` 把保留日志恢复到原有记账位置。永久删除使用单独、明确点名对象的确认框，操作对象是已归档 Session 及其完整保留后代树。注册表会重复发现并围住整棵树，拒绝冲突或循环谱系，退役所有由 Host 持有且空闲的驻留身份，再按后代优先顺序删除；运行中、外部持有、存在队列、轮次未闭合、持有任务、等待交互或被 resume 预约的身份仍会被阻止。多个 Session 共用的公共附件会刻意保留。
- 持久删除：`SessionPersistence.delete()` 与同一 id 的所有 load/append/preparation 串行。SQLite 在事务内删除。JSONL 先把整个 Session 目录重命名到项目内确定性的 `~delete/<encoded-id>` 墓碑，fsync 参与的目录，再递归清除墓碑。清理失败或重命名后的 fsync 失败会向上报告，同时保留归档标记，使同一个操作可在重试或重启后幂等完成。
- 已提交投影：persistence 层删除事件只清理派生缓存。只有所有 workspace 记账和最终归档快照都提交后，才会为每个被删身份发送一帧 `host/session-deleted`；client 会先清除 selection、summary、pending interaction、job、catalog、scope 与 projection，再安装该最终归档集合。因此 unary 先到或 Host frame 先到都保持幂等，已删除行不会短暂复活。

## 已考虑的替代方案

**per-workspace archivedSessionIds（最初表述）。** 否决：Ungrouped 会话无落点；用户改口全局。

**SessionSummary 打 archived 标（session.list 层）。** 否决：要把 workspace domain 事实 join 进 sessions domain 投影，summary 无增量帧还得另发通知，跨域耦合大于收益。

**host 侧在 `workspaceView`/`sessionIds` getter 过滤。** 否决：归档 ≠ 改记账，投影过滤会把两个概念搅浑；未来恢复入口也需要 client 拿到全量记账。

**增量帧（archived/removed 单条）。** 否决：集合极小、变更频率低，全快照免去 client 侧合并逻辑与去重状态，与 workspace-changed 现有姿态一致。

## 后果

归档会话现在始终可从一个明确的「归档」入口找回，不打开会话即可恢复；永久删除只能经过上述 fail-closed 路径。陈旧的归档 id 会显示为待清理记录：恢复保持禁用，永久删除仍可重试。`workspace.list` 响应形状变化仍是 pre-release 直改（无兼容层）。workspace-management e2e 钉住「归档 → 隐藏 → reload → 恢复 → 再归档 → 确认永久删除 → reload 后消失」；domain、网关与 client 测试钉住幂等、未知 id 拒绝、后代优先的子树删除、冷却/预约前置条件、循环谱系拒绝、崩溃重试、缓存清理、事件顺序与旧介质默认升级。
