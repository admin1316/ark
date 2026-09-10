# Agent Note: 覆盖率排除项一致性校验

Status: implemented

[English](2026-08-16-coverage-exclude-consistency-gate.md) | 中文

## 问题

`vitest.config.ts` 里有一长串静态 `coverage.exclude` 列表——client/web 文件的逐文件债务条目和整包豁免。没有任何机制校验列出的模式是否仍匹配真实文件。`self-modification` 包从仓库移除后，它的 `packages/self-modification/*/src/**/*.{ts,tsx}` 排除项留了下来：对覆盖率运行无害、审查时不可见，而审计的 P0/P1 项要求删除死条目并防止再次累积。

## 决策

覆盖率排除列表现在收敛到一个导出的数组 `coverageExcludeEntries`（位于 `scripts/coverage-exclude.ts`），按当前平台与环境计算：静态逐文件债务加上条件性的 Windows/pwsh 通道。同一模块还持有 `windowsUnsupportedPackages` 常量，测试排除也消费它。`vitest.config.ts` 导入该数组并用作 `coverage.exclude`；新的 gate `scripts/verify-coverage-exclude.ts` 导入同一数组，任一模式在仓库根下匹配不到常规文件即报错。该 gate 注册在 package.json 的 `hygiene` 链里，也在 `scripts/run-gates.ts` 中作为 `coverage-exclude` 进入 `ci-primary`/`ci-static` 共享的静态 gate 组、以及 `check-all` 的 hygiene 叶子，因此 CI primary 与 static 通道都会强制执行。

有一条模式被允许刻意匹配不到东西：`packages/*/*/src/oxlint-contract-*.ts` 守卫。它的存在是因为 `oxlint-contract.spec.ts` 会在包的 src 树里写临时探针文件、并在 `finally` 块中删除——测试被杀掉时会留下探针，这条排除项让残留文件进不了逐文件 100% 阈值。gate 以带理由的方式把该精确模式列入白名单；其余任何零匹配模式都会失败，漂移后的模式也会掉出白名单而失败。

本次改动同时删除了僵尸条目本身：`packages/self-modification/*/src/**/*.{ts,tsx}` 匹配不到任何文件，已移除。

## 考虑过的替代方案

**让 gate 从 `vitest.config.ts` 导入导出的列表。** 单一文件最省事，但配置文件不在任何 tsc 工程里：从 scripts 里的 gate 导入它，会把 `vitest.config.ts` 与 `vitest.shared.ts` 拉进 host 程序，违反工程文件清单规则（TS6307），并暴露 `vitest.shared.ts` 里一处潜在的 `exactOptionalPropertyTypes` 错误。共享模块让 gate 的导入图留在 `scripts/` 内，类型检查干净。

**只把静态列表抽进共享模块，平台条件性条目留在配置内联。** diff 更小，但 gate 看不到 Windows/pwsh 通道，`sandbox-windows-acl` 或 `pwsh-*` 文件改名后可能无人察觉地过期。模块计算完整列表，因此主机上应用的每一条模式都会被校验。

**用文本解析的方式校验配置。** 字符串匹配无法可靠枚举列表；导入导出的数组不需要解析器，也不会漂移。

**连零匹配的 oxlint-contract 守卫一起报错。** 删除它会拿掉一道有文档的防线——被杀测试留下的探针会击穿逐文件阈值；白名单机制在保留守卫的同时仍然拒绝每一个真正的僵尸。

## 后果

现在，包被移除而覆盖率排除项残留，会在 hygiene 与 CI static 通道以点名死模式的报错失败，而不是带着一条不可见的陈旧条目合并。代价是一个小脚本、一个共享模块和两处 gate 注册，以及每新增或修改一条零匹配守卫时的一次显式审查。平台条件性通道（仅 Windows 的 sandbox 源码、无 pwsh 的主机）只在它们生效的主机上被校验，这与 vitest 自身的姿态一致。
