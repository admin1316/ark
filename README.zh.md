# 九章天幕 · Ark

[English](README.md) | 中文

**所思即行，所创即见。**

## 1. Ark 定位

九章天幕 Ark 是一个本地优先的桌面智能体工作台：原生 SwiftUI/AppKit 外壳 + 内嵌完整 Node 运行时，安装即用，不需要用户另装环境。

- 正式件：`~/ark/Ark.app`（bundle id `cn.jiuzhangtianmu.industrybrain`），当前发布线 3.1.0 / 构建号 `202609131514`。
- 本地优先：会话、凭据、设置、知识库都在本机；云端只承担模型推理。
- 单一权威：所有能力以插件接入同一个运行时，外壳不复制业务状态。
- 可验证：每个正式件都携带可独立核对的 provenance，验收结论必须给出可复现命令与实测数字。

## 2. 核心能力

- **会话工作台** — 多会话并行、长任务与规划模式、子智能体协作与血缘视图。
- **万相织鉴** — 项目知识库：摄取、语义检索、校验与裁决。
- **原生体验** — SwiftUI 原生界面、内嵌运行时、原生编辑/终端/文件/Git 审阅能力。
- **能力扩展** — 一切皆插件（Cordis 插件框架），命令 / 技能 / 引用三类输入源。
- **权限与安全** — 沙盒模式 + 审批策略预设，读写边界与保护目录契约。

## 3. Runtime / Harness / Provider / Plugin 架构

四层职责互不重叠：

- **Runtime（`runtime-template`）** — 由 `integrations/jiuzhang/src/pack-runtime.mjs` 从工作区打包：逐个 `pnpm pack` 工作区包，再以 `pnpm install --frozen-lockfile --offline` 组装出可离线复现的运行时模板，产物为 `runtime-template/` + `pack-receipt.json`。当前打包 164 个包，对照源码工作区 212 个含 `lib/` 的包。
- **Harness** — 用户态数据与配置根：`~/Library/Application Support/Ark/Harness`（`settings.yaml`、`.credentials.yaml`、`sessions/`）。外壳与运行时都只通过这一层读写用户数据，候选构建使用独立私有 home 做隔离。
- **Provider** — 模型与外部服务接入层，凭据只经 Harness 的凭据记录解析，不进源码树、不进日志。
- **Plugin** — 能力实现层：业务能力一律以 Cordis 插件注册到运行时，壳层只做渲染与生命周期管理。

分层收益：运行时可以整包替换（升级/回退不依赖用户环境），插件可以独立演进，而外壳与 UI 只依赖稳定的运行时契约。

## 4. Trajectory / Chat 锚定语义

滚动行为由统一的滚动协调器负责：`ArkChatScrollController`（SwiftUI 侧）→ `ArkChatScrollCoordinator` → `ArkChatScrollStateMachine`，两种表面共用同一状态机，只有锚点不同：

- **Chat = 底部锚定（`ArkScrollAnchor.bottom`）** — 默认贴底跟随新内容；用户上滚阅读时暂停跟随；执行会话切换/插入历史时只做一次性的重排抑制（`suppressResizeOnce`），不打断阅读位置。
- **Trajectory = 顶部锚定（`ArkScrollAnchor.top`）** — 首次打开即显示内容顶端，不需要用户真实滚动来触发物化；记录刷新、会话切换、加载更早内容与窗口/面板尺寸变化都不改变当前阅读位置（`viewportDidMove/Resize`、`contentDidResize`、`requestBottom`、`completePrepend` 在顶部锚点下全部短路）。

契约覆盖：首次打开、A→B→A 会话往返、记录刷新、加载更早（前插）、窗口 resize、面板 resize、聊天贴底回归，见 `integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkTrajectoryScrollContractChecks.swift`。

## 5. provenance

正式件在 `Contents/Resources/ArkProvenance/` 携带完整构建身份：

- `source-and-pack.json` — 源码身份：`ArkSourceCommit`、`ArkSourceDirtyStatusSHA256`、`ArkSourceDirtyDiffSHA256`、`ArkSourceSnapshotSHA256`、`ArkPackReceiptSHA256`。
- `pack-receipt.json` — 打包回执：闭包计划、锁文件、包计数、安装命令、运行时身份哈希。
- `closure-plan.json` / `native-source-inputs.json` — 依赖闭包与原生输入清单。

两个脏状态哈希的定义是稳定的：`ArkSourceDirtyStatusSHA256` = `git status --porcelain=v1 -z --untracked-files=all` 的 SHA256；`ArkSourceDirtyDiffSHA256` = `git diff --binary --no-ext-diff HEAD --` 字节流的 SHA256。干净基线构建时二者都是空流哈希 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，即“此件完全由某个提交生成”。

## 6. 验证体系

分层的可执行验证，全部给出现场实测数字：

```bash
# 原生契约与全局检查（48 组契约组全部到达）
swift run --package-path integrations/jiuzhang/native --skip-update JiuzhangShellContractTests

# 运行时核心测试
pnpm test:jiuzhang

# 依赖与锁文件门（干净环境可复现）
pnpm install --frozen-lockfile

# 交付字节对照：正式件 runtime 中的 JS 模块 vs 源码工作区 lib 产物
python3 tools/delivered-bytes-scan.py <Ark.app> [源码根]
```

发布状态三联校验（源码身份 / 交付字节 / 运行目标）以单一入口执行，只输出 PASS、MISMATCH 或 UNKNOWN，任何一步失败都 fail-closed。当前发布线实测：`SOURCE_STATE: MATCH`、`PAYLOAD_BYTES: PASS（651 模块，0 差异 / 0 缺失）`、`RUNNING_TARGET: PASS`。

## 7. 构建与发布

```bash
pnpm install
node integrations/jiuzhang/src/pack-runtime.mjs --out /private/tmp/runtime-pack
JIUZHANG_SELF_CONTAINED=1 JIUZHANG_PACK_RECEIPT=/private/tmp/runtime-pack/pack-receipt.json \
  JIUZHANG_RUNTIME_ROOT=/private/tmp/runtime-pack/runtime-template \
  integrations/jiuzhang/native/build-app.sh <全新输出目录>
```

候选构建必须与正式件隔离：`JIUZHANG_CANDIDATE_BUILD=1` + `JIUZHANG_CANDIDATE_DATA_HOME=<0700 私有目录>` + 显式 `JIUZHANG_CANDIDATE_VERSION` / `JIUZHANG_CANDIDATE_BUILD_NUMBER`，候选得到独立 bundle id 后缀与独立数据根，可与正式件同时运行互不干扰。

晋升门槛（缺一不可）：候选验收通过、存在**唯一**直接前驱回退副本、显式授权。晋升顺序为：暂存正式形态（改 plist + 重签 + 复验）→ 备份 → 原子替换 → 复验；任一步失败不触碰正式件。

## 8. rollback

回退依赖**唯一直接前驱副本**，而不是重新构建：

- 副本位置：`~/ark-test/rollback-<stamp>/`，记录在对应发布记录 `~/ark/releases/<build>.md`。
- 回退步骤：停正式实例 → 替换 `~/ark/Ark.app` → `codesign --verify --deep --strict` → 冷启动 → 复验（健康检查、单实例、会话/设置/凭据数量与哈希不变）。
- 保留策略：只保留当前正式件 + 一份直接前驱回退副本；被淘汰的旧副本在发布记录中标记为 `RETIRED DURING RETENTION CLEANUP`，不静默丢弃。

## 9. clean baseline

当前源码标准是干净基线分支 `release/20260913-clean-baseline`：

- 快照提交（生产源码快照）：`9e83b626add9e31511185bc61a2d29f14042f490`
- 干净基线提交（仓库卫生）：`795c5306ad81ce79d95d45686214503665fee382`
- 干净门：`git status --porcelain=v1 -z --untracked-files=all` 与 `git diff --binary --no-ext-diff HEAD --` 的 SHA256 均为空流哈希；HEAD 必须等于基线提交。
- 快照等价性：快照提交的每个变更路径与生产源码工作树逐文件 SHA256 一致，仅因“GitHub 以前有”而存在的旧源码不再保留，由 Git deletion 正常删除。

main 的更新方式：以 `main` 为唯一父提交、以干净基线 tree 为 tree 的前向提交，经正常 PR 合入；不使用 force push、不重写历史、不做无关历史合并。

## 10. 已知工程债

- **CI 缺口**：`build:official` 在 CI 中缺失，本地构建路径完整但未纳入持续集成。
- **生成物入库**：`lib/**` 构建产物被纳入版本控制（含 208 个被跟踪的 `*.tsconfig.tsbuildinfo`）；由此产生 3 处 white-space 命中（2 处在生成文件、1 处在测试源码 `packages/util/http-proxy/tests/proxy-env.ts`）。根因修法是一次性把生成目录移出版本控制，而不是逐文件打补丁。
- **钩子与冻结快照的冲突**：`pre-push` 钩子执行 `pnpm run typecheck`（即 `build:lib:host`），会重写已提交的 `lib/` 产物；因此在冻结 provenance 的仓库内提交/推送必须显式跳过钩子，或先装依赖再执行。
- **本地 remote 失效**：Ark 仓库原有的 `origin` 指向一个已删除的本地路径，GitHub 远端以 `github` remote 单独配置。
- **血缘分离**：干净基线与 GitHub `main` 没有共同祖先，因此 main 采用“采纳 tree”的前向提交方式，而非直接合并两条历史。
- **未验证项**：Mach-O 主程序与 Swift 源码的字节对应关系未做可复现构建比对；`ArkSourceSnapshotSHA256` 未独立重算；轨迹/聊天的真实鼠标验收需要人工复点，没有自动化点击能力时不报程序化 PASS。

## 安全边界

启用工具或打开不受信任的工作区前，先阅读 [SAFETY.zh.md](SAFETY.zh.md)。凭据只存放在 Harness 凭据记录中，绝不出现在源码树、日志或发布产物里。

## 许可

见 [LICENSE](LICENSE)。
