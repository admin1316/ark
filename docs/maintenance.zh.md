# 仓库维护与清理边界

[English](maintenance.md) | 中文

本页统一回答：什么算源码、生成物、历史证据；什么可以移出版本控制、必须满足什么前提；以及当前有效的构建、检查与回退入口。

## 权威边界

- `main` 是当前开发源码入口；本页刷新时的 HEAD 记录在根 README 第 9 节。
- `release/20260913-clean-baseline` 是历史基线参考（快照 `9e83b626…`、卫生提交 `795c5306…`）；其提交不在 `main` 祖先中。
- 已安装正式件 `~/ark/Ark.app` 携带自身发布身份与 provenance；不因 main 前进而继承"当前"身份。

## 目录分类

- 源码：`packages/`、`native/`、`integrations/`、`apps/`、`python/`、`scripts/` 与 `.agents/` 工作流。
- 生成物且当前被跟踪：`packages/`、`vendor/`、`apps/` 下的 `lib/` 构建输出与 208 个被跟踪的 `*.tsbuildinfo`。移出版本控制是专项变更，必须先证明完整链路：干净检出 → `pnpm install --frozen-lockfile` → 构建 → 测试 → 打包 → 安装验证。
- 历史证据，保留并索引：`orig/`（三份改写前 Swift 副本）、根目录阶段报告（`evidence-r18.md`、`handoff-r18.md`、`integration-l1517-report.md`、`package-audit-r18.json`）、`.agents/notes/archived/` 下的冻结 Agent Notes。
- 可重建缓存：`.tmp-swift-module-cache-*/` —— Swift 编译器输出（`.pcm`/`.swiftmodule`/`.timestamp`）。自 2026-09-16 起移出跟踪并被忽略；产品与契约测试按名称前缀排除该目录，没有任何跟踪文件把它当作输入。
- 用途不明，保持不动：根目录 `.lock` 文件（内容 `1872`，无跟踪引用）。

## 清理前提

- 缓存移出版本控制的前提：内容确认为工具输出、没有跟踪文件把它当作输入、重建可再生成。
- 历史证据不在卫生轮删除，只在本页索引。
- "已忽略"不等于"已移出跟踪"：修改 `.gitignore` 后要分别验收（`git check-ignore` 与 `git ls-files`）。

## 构建、检查与回退入口

- 安装：`pnpm install --frozen-lockfile`。文档门：`pnpm run doc-sync`；免构建子集为 `tsx scripts/run-gates.ts doc-quick`。
- CI 等价套件：`pnpm run check:ci` 系列（`scripts/run-gates.ts` 模式）；覆盖门为 `pnpm run test:coverage`。
- 原生契约：`swift run --package-path integrations/jiuzhang/native --skip-update JiuzhangShellContractTests`。
- 构建输出清理：`pnpm run clean`。正式件回退：根 README 第 8 节。

## 工程债索引

- 被跟踪的 `lib/**` 与 `*.tsbuildinfo`（根 README 第 10 节）；移出前提见上。
- Windows 原生债务：Issue #28（open）——类目与数量以该 issue 为准；运行时形态通过不代表原生全面一致。
- 合并后 main 的 CI 失败以 run ID 记录在根 README 第 10 节；`serial / macos` 保持禁用（`if: false`）作为治理项。

## 2026-09-16 清理记录

- 基线：`main` @ `4d0da264d373d6a2f8e948ac9683efcdbc947880`；工作分支 `chore/repo-hygiene-20260916-134459`。
- 移出 `.tmp-swift-module-cache-20260822/`（108 个文件，93,877,300 逻辑字节）；新增精确缓存忽略规则与根 `.env` 防回流规则。
- 该轮未覆盖：未重扫生产、未重写历史、`lib/` 移出延期、Windows 与远端平台验证本地未运行。
