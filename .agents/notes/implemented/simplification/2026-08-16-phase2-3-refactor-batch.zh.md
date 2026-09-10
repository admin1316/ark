# Agent Note: Phase 2/3 并行重构批次

Status: implemented

[English](2026-08-16-phase2-3-refactor-batch.md) | 中文

## Problem

v2 审计的 Phase 2（巨型模块拆分）与 Phase 3（治理）清单仍有四项大型重构待做——api-proxy 的 RPC 分组、TrajectoryTable 的组件关注点、continuation 的生命周期域、ToolRuntime 的管线/注册表拆分——以及 coverage exclude 治理债（见专篇 note 2026-08-16-coverage-exclude-consistency-gate）。

## Decision

四项行为保持重构，由独立代理在互不相交的包上并行执行：

1. **api-proxy RPC 分组**（`packages/host/apiproxy`，`cd896b4bab`）：前四组——sessions/subagents/workspace/goals——移入 `src/handlers/`（显式 `ApiProxyContext` 的 `context.ts`、`shared.ts`，及每组一个 `register<Group>Handlers(api)` 模块，689/192/189/68 行）。工厂保留状态创建与装配；未动分组经逐字节比对验证一致。api-proxy.ts 3515 → 2332 行。
2. **TrajectoryTable 关注点**（`packages/client/ui-trajectory`，`f8ec462ed5` + `4a232edd49`）：详情面板缩放、older 历史分页、检查器选择/聚焦提取为 `useDetailsResize`/`useOlderLoading`/`useTrajectorySelection`，配共享 `detail-tabs` 模块；组件减少约 138 行。虚拟滚动与滚动同步留在组件（与渲染闭包共享 `pendingScrollRecordId`/`followsTableTail`/virtualizer）。
3. **continuation 生命周期域**（`packages/subagent/subagent`，`66369907aa`）：`OwnershipGraph`/`ActivationMaterializer`/`SettlementWatcher`/`Disposer` 提取（136/188/171/198 行），置于共享 `continuation-state.ts` 契约之上；manager 经构造器钩子委托。settlement 顺序逐字节保留——`notifySettlement` 仍在 `finishDisposal` 中 `activations.delete` 之后、所有权释放之前调用。continuation.ts 1483 → 836 行。
4. **ToolRuntime 管线/注册表**（`packages/core/tools`，`97c65f20dc`）：执行管线移入 `ToolExecutor`；注册/限制/展示留在 `ToolRuntime`（`ToolRegistry` 面）。取消融合语义（TOOL_ABORTED / TOOL_ABORTED_BEFORE_DISPATCH / cancelled）不变；新模块保持每文件 100% 覆盖。

## Alternatives considered

**一次拆完全部十二个 api-proxy 分组。** 拒绝：出于审查体量与风险——events/downloads/respond 组共享帧队列子系统（P3 标记部分）；首批四域确立 context 模式并可独立验证。

## Consequences

每项重构由未改动的包内套件覆盖（apiproxy 398、ui-trajectory 107、subagent 249、tools 全绿且 executor 100% 覆盖）；typecheck/lint/duplication/hygiene 全部通过。一次协调事故：并发工作树 reset 将四个 TrajectoryTable hook 模块从首个提交中丢失；后续提交恢复组件并落地这些模块。剩余 Phase 3 项（wire 层循环 SCC、extensions 门禁）留待后续批次。
