# Agent Note: 文件架构 P1——八个热点的纯函数提取

Status: implemented

[English](2026-08-16-file-architecture-p1-extraction.md) | 中文

## Problem

企业文件架构审计（`enterprise-architecture-report.md`）标记了十八个超过 1,000 行的文件。除一个外均非必须拆分：`host/apiproxy/src/api-proxy.ts`（3,996 行、357 次提交、43 个跨包 import）——最大的手写文件、修改最频繁、承载五处重复的领域规则。其余热点均已部分模块化且剩余部分为清晰的纯函数；审计的 Phase 1 定义为零行为变化的逐字提取。

## Decision

Phase 1 只提取无状态纯函数簇——不移动共享可变状态、不改签名、不触行为：

- **api-proxy.ts → 8 个模块**（`frame-queue.ts` / `wire.ts` / `errors.ts` / `session-summaries.ts` / `pagination.ts` / `image-refs.ts` / `catalog.ts` / `views.ts`）：3,996 → ~3,510 行。提取出的模块离开文件的覆盖率豁免（vitest.config.ts 曾排除 `api-proxy.ts`），因此新增 `api-proxy-modules.spec.ts` 并扩展 models fixture 分支（effort description、缺省 default-effort、非 Error provider 拒绝）把每个模块带到 100/100/100/100。闭包内的域 handler 留给 Phase 2。
- **session/src/index.ts → validation.ts + fork.ts**：十二个 header/事件校验器与 fork 词汇；`_forkSeed`/`_resolveForkSource` 降级为无状态 `forkSeed`/`resolveForkSource`。
- **session-persistence coordinator → errors.ts + migrate.ts**：三个类型化持久化错误与 legacy v0 词汇迁移函数。
- **session-persistence-jsonl → lock.ts**：`withSessionIdLock`/`isStaleSessionLock`/`isEEXISTError`；新测试补齐此前未覆盖的活锁超时、非-EEXIST、不可读/损坏锁 pid 分支（EPERM 分支为不可移植构造的 v8 ignore）。
- **session-query-sqlite → query.ts**：`selectedDocumentsSql` CTE 移到谓词构建器旁。
- **llm → adapter.ts + error.ts**：适配器契约面（LlmAdapter、两个注册 handle、PreparedLlmCall）与 LlmError/assertUsableApiKey 并入既有 error 模块。
- **ui-trajectory layout → content.ts / placement.ts / durations.ts**：内容词汇、放置策略、时长算术（该包保留在覆盖率豁免通道）。
- **cordis-host-runner → steering.ts + queries.ts**：六个模型 steering 模板变为注入 agents/registry 的纯函数（运行时失败去重 claim 留在调用方），六个只读投影成为一行 @Remote 委托。

每个 commit 都是 move-only 重构并自带门禁（typecheck、contracts-ready lint、包套件、`git diff --check`）；只有 api-proxy 提取需要新测试——因为它把代码移出了豁免文件。

## Alternatives considered

**把提取出的模块放回豁免。** 否决：豁免只因 3,996 行文件难以覆盖而存在；模块很小，per-file 门禁正是提取的意义。

**同批拆分 api-proxy 闭包（域 handler）。** 否决：P1 定义为零风险纯移动；闭包共享 pending/mux/lifecycle 状态（pendingApprovals/pendingQuestions/muxQueues/sessionCreations/hostAgentHandles），拆分需要 ProxyState 设计与完整 approval 重放回归矩阵——那是 Phase 2。

**按行号提取。** 两次误提取后否决（多行签名与字符串字面量花括号破坏朴素括号计数）：所有提取改用锚点或手写移动，提交前经 tsc 验证。

## Consequences

八个热点文件各减 300–500 行纯函数剩余；api-proxy.ts 现在围绕提取模块与剩余闭包的编排壳。移动代码在原先隐藏于豁免之处获得 per-file 覆盖强制（api-proxy 模块此前未测的分支——活锁超时、非-EEXIST 锁失败、错误映射兜底、图像载体形状——现为回归覆盖）。公共 API、wire 形状、错误码、磁盘格式均未变；全部套件通过。Phase 2（api-proxy 域 handler + ProxyState、manager.ts 聚簇拆分、jsonl delete/discovery/fs-ops/decode、SQLite 介质 helper）与 Phase 3（CoordinatorState、ActivationForest、analyzer TypeGraphBuilder）按审计路线图保留。
