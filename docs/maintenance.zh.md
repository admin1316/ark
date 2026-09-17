# 仓库维护与清理边界

[English](maintenance.md) | 中文

本页统一回答：什么算源码、生成物、历史证据；什么可以移出版本控制、必须满足什么前提；以及当前有效的构建、检查与回退入口。

## 权威边界

- `main` 是当前开发源码入口；本页刷新时的 HEAD 记录在根 README 第 9 节。
- `release/20260913-clean-baseline` 是历史基线参考（快照 `9e83b626…`、卫生提交 `795c5306…`）；其提交不在 `main` 祖先中。
- 已安装正式件 `~/ark/Ark.app` 携带自身发布身份与 provenance；不因 main 前进而继承"当前"身份。

## 目录分类

- 源码：`packages/`、`native/`、`integrations/`、`apps/`、`python/`、`scripts/` 与 `.agents/` 工作流。
- 生成物且已移出版本控制：`packages/*/*/lib/` 与 `apps/*/lib/` 下的宿主构建输出，以及全部 `*.tsbuildinfo`；`.gitignore` 逐类忽略，`git ls-files` 报告为零。`pnpm run verify-generated-tracking` 在这些路径被暂存或提交时失败（含 `git add -f` 绕过），并接入 `ci-static` 门禁车道与 pre-commit 钩子。
- 恰好名为 `lib/` 的跟踪源码：`vendor/cordis/lib/` 与手写的 `.agents/**/lib/` 模块继续留在版本控制中，两者都不是构建输出。
- 历史证据，保留并索引：`orig/`（三份改写前 Swift 副本）、归档在 `archive/` 下的阶段报告（`archive/evidence-r18.md`、`archive/handoff-r18.md`、`archive/integration-l1517-report.md`、`archive/package-audit-r18.json`）、`.agents/notes/archived/` 下的冻结 Agent Notes。
- 可重建缓存：`.tmp-swift-module-cache-*/` —— Swift 编译器输出（`.pcm`/`.swiftmodule`/`.timestamp`）；被忽略且不在索引中，产品与契约测试按名称前缀排除该目录，没有任何跟踪文件把它当作输入。
- 用途不明，保持不动：根目录 `.lock` 文件（内容 `1872`，无跟踪引用）。

## 清理前提

- 缓存移出版本控制的前提：内容确认为工具输出、没有跟踪文件把它当作输入、重建可再生成。仓库级输出移出还要证明完整链路：干净检出 → `pnpm install --frozen-lockfile` → 构建 → 测试 → 打包 → 安装验证。
- 历史证据不在卫生轮删除，只在本页索引。
- "已忽略"不等于"已移出跟踪"：修改 `.gitignore` 后要分别验收（`git check-ignore` 与 `git ls-files`）。

## 构建、检查与回退入口

- 安装：`pnpm install --frozen-lockfile`。文档门：`pnpm run doc-sync`；免构建子集为 `tsx scripts/run-gates.ts doc-quick`。
- CI 等价套件：`pnpm run check:ci` 系列（`scripts/run-gates.ts` 模式）；覆盖门为 `pnpm run test:coverage`。
- 原生契约：`swift run --package-path integrations/jiuzhang/native --skip-update JiuzhangShellContractTests`。
- 构建输出清理：`pnpm run clean`。正式件回退：根 README 第 8 节。
- 生成物入库检查：`pnpm run verify-generated-tracking` 在 Git 索引中命中已移出类别时失败；`publint` 与 `ci-artifacts` 车道回答的是构建出的包是否有效，而不是构建产物能否入库。

## 工程债索引

- Windows 原生债务：Issue #28（open）——类目与数量以该 issue 为准；运行时形态通过不代表原生全面一致。
- 合并后 main 的 CI 失败以 run ID 记录在根 README 第 10 节；`serial / macos` 保持禁用（`if: false`）作为治理项。

## 2026-09-16 清理记录

- 基线：`main` @ `4d0da264d373d6a2f8e948ac9683efcdbc947880`；工作分支 `chore/repo-hygiene-20260916-134459`。
- 移出 `.tmp-swift-module-cache-20260822/`（108 个文件，93,877,300 逻辑字节）；新增精确缓存忽略规则与根 `.env` 防回流规则。
- 该轮未覆盖：未重扫生产、未重写历史、`lib/` 移出延期、Windows 与远端平台验证本地未运行。

## 2026-09-17 维护轮次

- 基线：`main` @ `0cfbf697c24206d4b7e6e66b285413af8516b5d9`；工作分支 `chore/code-hygiene-nonrepeat-20260917-132912`。
- 索引中不存在任何 `packages/*/*/lib/`、`apps/*/lib/` 或 `*.tsbuildinfo` 路径；`pnpm run verify-generated-tracking` 现从 `ci-static` 车道与 pre-commit 钩子维持该状态。
- 仅本地验证；未触碰正式件、日常检出与恢复归档。
