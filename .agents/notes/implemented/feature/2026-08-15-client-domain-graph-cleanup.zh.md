# Agent Note: 客户端域图清理

Status: implemented

[English](2026-08-15-client-domain-graph-cleanup.md) | 中文

## 问题

固定基线上的 `verify-client-domain-graph` 报出 27 处违规。其中 4 处是门禁脚本自身误读越出 client 根目录的导入（空栈上 pop `..`），其余是 runtime、ui-conversation、ui-workspace 客户端包中的跨域导入——共享 API 没有走 contract 层或顶层共享文件。此外，早期框架工作遗留的过期侧边栏字标快照与目录生成器未登记的 event scope 也使仓库级检查失败。

## 决策

**门禁脚本现在追踪越出 client 根的 `..`**，按注释声明的意图把这些导入视为包级并跳过；4 处误报随之消除。

**跨域导入统一走 contract 层或顶层共享文件。** `runtime` 中自包含的 scope、notifier、pending、context-provenance、conversation 模块提升到客户端顶层；列表/行/会话类型（SessionSummary、SessionListState、SessionBinding、SessionProvideDescriptor、SessionProvideContribution、SessionSearchResultItem、SessionListPhase、SubagentCatalogSnapshot、WorkspaceListState、WorkspaceListPhase）移入 contract 层，并在原文件保留 re-export，所有消费点导入位置不变。`ui-conversation` 中 turn-metrics、message-chrome、StatsLine、tool-node-reader、blocks、decorations 与队列 store 提升到顶层，`input/contract.ts` 移入 contract 层。`ui-workspace` 的 rows 组件提升到顶层。行为不变，纯路径/类型搬迁 + re-export。

**过时产物重新生成。** 侧边栏字标快照按 ARK 字标刷新；`gen-cordis-catalog` 补上 `session-persistence → persistence.md` 与 `workspace → workspace.md` 两个 event-scope 映射，重新生成早期框架工作遗留过期的目录产物。run-gates 测试按 ci-consumers 图的新门数（10 → 11）更新。

## 曾考虑的替代方案

**逐个类型搬移修复。** 部分采用：自包含模块整体提升，纠缠的类型簇作为单元移入 contract 并保留 re-export。完全不动的方案被否决——门禁存在的意义就是强制分层。

## 后果

`verify-client-domain-graph` 报告 "client domain layering clean"；`tsc -b tsconfig.client.json` 零错误；四个受影响包 1017 项测试通过；目录规格逐字节再生一致；knip 与包不变量全部符合。全量套件中剩余的失败均为环境性（沙箱禁止真实 shell spawn、宿主机核数、30 秒超时），且位于未被触碰的包中。
