# Ark 长会话修复批次 · 独立复核与残留清单（2026-09-13）

复核方式：主代理 + 三个独立 teammate（收据对源码、清理/依赖安全、测试复跑），全部只读。
证据根：`/private/tmp/ark-long-session-work/`；源码根：`/Users/hui/ark/repo`（HEAD `cc2e35e5`，工作树 4381 项未提交）。

## 1. 四份收据的复核判定

| 收据 | 宣称 | 判定 | 关键证据 |
|---|---|---|---|
| acp-snapshot-precise-repair | 15/15 通过，9 文件重基线，2688 公式 | 真实成立 | 独立复跑 ACP 15/15（lib 与 src 两种模式）、单用例 image-compaction 1 passed；公式 366=78+6×48、2688=78+6×(384+51) 由 `route-pricing.ts:56`、`surface-fold.ts:72`、`llm-replay/src/index.ts:675-685`、`cordis.snapshot.yml:52` 独立推算 |
| acp-goal-inventory-repair | inventory 用 loader root baseUrl，4 个 goal 快照 | 部分成立 | `plugin-package-inventory-deepseek/src/index.ts:190`、`launcher.ts:393-395` 成立；但"Only goal-expected"不实：`examples/acp-agent/tests/goal-snapshots/*` 也被改，而该套件不可运行（见残留 C1） |
| sdk-four-inactive-owner | 16/16 通过，fixture 移动 + devDependency + materializer | 真实成立（增量表述不准） | 独立复跑 SDK 16/16；2 个 fixture 移动后字节一致、4 个 example YAML 重定向、`apps/cli/package.json:106` 有 `dsh-subagent-dsh-sdk`；"仅一项 devDependency / +2 direct deps"无法从 diff 证实 |
| 收据 tokenProof | 78 + 6 × (384 + 51) = 2688 | 真实成立 | 数字全部可由源码与已提交 `snapshots/acp/image-compaction/session.jsonl` 推出，无"推不出"的数字；无二次计费（`estimate.ts:53-57` 与 `route-pricing.ts:45-65` 互斥） |

**重要更正**：image-compaction「修重复 header 与计量值」**不是 9/13 的代码修复**。`surface-fold.ts`、`route-pricing.ts`、`estimate.ts` 相对 HEAD 未变更（mtime 9/10），2688 的实现早已存在；9/13 的真实动作是把过期快照从 366 重基线到 2688。即：**这一条已经包含在正式版 `202609121430` 里，不属于"正式版跑旧代码"**。

## 2. 唯一正式版与三处状态

| 位置 | 身份 | 事实 |
|---|---|---|
| `~/ark/Ark.app` | 3.1.0 / `202609121430` / stamp `40cf4481` / source `8fcec77a` | 唯一正式版；runtime 与仓库 `lib/` 有 75 个模块不同，其中 25 个"候选/仓库已新、正式版仍旧" |
| `~/ark/repo` | HEAD `cc2e35e5`，分支 `ces/ark-v6` | 唯一主源码树；工作树 4381 项脏改动，修复批次只在工作树成立 |
| `~/ark-test/candidate/Ark.app` | 3.1.99 / `2026091301` / source `cc2e35e5` | 候选；不含 03:50–04:08 这批测试/期望侧修复 |
| `~/ark-test/dsh-015` | HEAD `8fcec77a`，分支 `test/dsh-015-arkfix`，2.6G | 正式版 native 的来源树，删除前必须确认历史已入 `refs/archive/ark-test-dsh-015` |
| `~/Ark-Recovery-20260908` | 非 git，192M | 9/8–9/10 恢复检查点与 tarball，独有恢复源，非垃圾 |

最硬例证（交付陈旧）：正式版 `Contents/Resources/runtime/.../dsh-token-meter/lib/index.js:690` 仍是 `while (state.consumedEvents < session.events.length)`；候选与仓库已是 `const endSeqExclusive = session.seq; … session.eventAt(…)` 的增量折叠，并配 `packages/llm/token-meter/tests/token-meter.spec.ts` 的 2 万事件回归。长会话 28 万事件下，旧写法每次计量都读整个事件数组。

## 3. 可信度边界

- 可信：ACP 15/15、SDK 16/16、goal 2/2、单测 12/12 均被独立复跑（exit 0），业务断言未被削弱；"15/15"=8 个 scenario + 7 个 fixture meta 测试。
- 已在 Phase 1/2 修复：全量 `test:snapshot` 当时红（14 failed / 93 passed / 2 skipped）。根因两条——(a) `web-fetch-fixture-server.mjs` 作为独立子进程裸 import `@deepseek-ai/dsh-web-fetch-http`，从自身 file URL 向上解析，而 `linkProfilePackage` 只链 patch 里的裸包名；修法是在根 `package.json` 声明该 workspace devDependency（与 `dsh-tool-session-query` 同型）；(b) 13 条 prompt/schema 侧车过期。修复后 `NODE_OPTIONS=--max-old-space-size=4096 npm run build:lib:host` exit 0，再用免 key 的 `DSH_SNAPSHOT=refresh` 重放，最终 **107 passed / 2 skipped（109），exit 0**。
- lib 构建（03:45）落后于 8 个已改源码（04:02–04:09）；Phase 2 已用 `build:lib:host`（exit 0）消除该风险，此前的 Host 打包 OOM 未复现。
- 仍然红的：`tsc -p tsconfig.host.json --noEmit` 报 1 个错——`packages/util/values/tests/own-key-pattern.spec.ts` 的 TS2305，成因是 `lib/types/index.d.ts` 落后于源码（该行为测试本身 8/8 通过）；Phase 4 重建后应消失。FULL_GATE 自 9/12 18:12 起未再完整跑过，当时 48 个无关单测失败仍未被处理。

## 4. 残留清单（按处置优先级）

**已在 Phase 1/2 关闭（保留记录）**
- R1 `knip.json`：旧 `examples` 两条已删；改为新增 `packages/test-support/session-snapshot` workspace 段（entry `tests/**/*.spec.ts` + `tests/fixtures/**/*.ts`），并删除死 workspace 段 `packages/test-support/acp-snapshot`。`knip --treat-config-hints-as-errors` exit 0；两个 devDep 未被误删，fixture 用例（SDK/ACP lane 31 passed）复跑为绿。
- R2/R3：`apps/cli/tests/web-agent-presets.e2e.ts` 与 `apps/cli/tests/lazy-search-startup.compat.spec.ts` 按现行权威 note `2026-08-29-retire-generic-web-ui` 连同测试一起退休删除；`run-gates.ts` 的 cli-lazy-search 门与 `cliSmoke` 选项、`rescope-vendor.ts` 两条条目、`tsconfig.base.json` 死别名、`vitest.web-stress.config.ts`、`vendor/README.md` 过期覆盖引用同批清理。
- web-fetch fixture 解析：根 `package.json` 声明 `@deepseek-ai/dsh-web-fetch-http: workspace:^`，`pnpm install` 建根链接后 lib 模式可解析。

**仍待处置**
- R4 `examples/**/tests` 旧测试树（不在任何 vitest/tsconfig/gate 内）：54 个文件中有 **11 个** 引用不存在的 `@deepseek-ai/dsh-acp-snapshot`（`examples/acp-agent/tests/{acp.e2e,acp.snapshot,cleanup,escalation.e2e,hooks.e2e}.ts`、`examples/headless-agent/tests/{headless,semantic-checkpoint,subagent-diagnostic,subagent-inheritance,workspace-context-resume}.snapshot.ts`、`examples/jsonrpc-agent/tests/sdk.snapshot.ts`）。与已在 Phase 1 删除的 `goal.snapshot.ts` 同一成因，处置需二选一：整片退休删除（`snapshots/` 下三条 lane 是真正在跑的覆盖），或统一改名为 `@deepseek-ai/dsh-session-snapshot` 并接入某个 include。**待用户拍板。**

**清理收尾（死物，确认无引用后删）**
- C1 `examples/acp-agent/tests/goal.snapshot.ts`：import `@deepseek-ai/dsh-acp-snapshot`，全仓无此包、不在任何 vitest include；本轮却改了它消费的 `goal-snapshots/{goal-round-driver,goal-wrapup}/session.expected.jsonl` 两份。与在跑的 `apps/cli/tests/profiles/acp/tests/goal.expected.e2e.ts`（2/2）构成"同一逻辑两套快照"。要么删（连两份 expected），要么改成消费真实存在的 session-snapshot 套件并加进 include，不留中间态。
- C2 `packages/**/*.orig` 5 个（token-meter src/lib、core/session、session-projection src/lib），`pnpm run clean` 不清理；live 为新实现，.orig 为旧实现。
- C3 顶层 `orig/`（git 跟踪，3 个 Swift 旧副本：ArkRootView 11967 vs live 12698 行等），不参与构建。
- C4 `vitest.web-stress.config.ts:10` 指向已删 `apps/web/stress-tests`，无引用。
- C5 `tsconfig.base.json:160` 死别名 `@deepseek-ai/dsh-experimental-inspector/client`；`gen-tsconfig-paths --check` 不校验手写别名（门禁盲区）。
- C6 `snapshots/web/**` 孤儿场景（snapshots 下已无 web `*.snapshot.ts`）。

**发布前必须确认（不允许静默回退）**
- `packages/test-support/session-snapshot/package.json` 相对 HEAD：版本从 `0.1.2-alpha.1` 回退到 `0.1.1-rc.2`，并删了 5 个 devDependency。需确认是预期冻结而非误回退。

**未发现**：无任何被删包/文件仍被 cordis.yml、bundle、workspace 依赖、lockfile、tsconfig 项目引用或正式/候选 runtime 动态加载；148 个插件引用 0 缺失、258 配置门禁 exit 0、jscpd 0 clones。

## 4b. 反复扫描新增发现（2026-09-13 04:5x–05:1x）

**已修并复验**
- `verify-runtime-closure`：`python/sdk-runtime` 缺 `@deepseek-ai/dsh-util-values`（`session-persistence` 的 peer），已声明 → exit 0（4 preset / 129 包闭环）。
- `verify-type-equiv`：manifest 4 条指向已搬走的 `packages/experimental/agent-team/src/types.ts`，已改为 `packages/subagent/agent-team/src/types.ts` → exit 0（401 块）。
- `verify-md-links`：provider journal recovery 双语 Note 里链到已不存在的 `snapshots/native-provider-recovery.snapshot.ts`，已删该引用 → exit 0（2726 文件）。
- 生成物门禁：`docs/{tool-catalog,config-catalog,module-graph,event-producer-consumer}` 陈旧，已用 4 个 generator 重生成 → 全绿。
- `scripts/code-scan-config.spec.ts`：`packages/util/values` 的 knip project 缺 `tests/**/*.ts`，已补 → 该 spec 4/4 通过（knip 仍 exit 0）。
- `scripts/session-fixture-layout.spec.ts`：刷新后的 83 个 session.jsonl 是未打包形态，已跑 `pnpm run migrate:packed-session-fixtures`（83 rewritten / 301 inspected）→ 该 spec 8/8 通过，snapshot lane 仍 107 passed。
- 全量单测从 **4 failed / 14070 passed** 收敛到 **1 failed / 14073 passed**；剩下 1 条是 `packages/boot/app-boot/tests/user-patches.spec.ts`，单独复跑 3/3 通过，与 `hmr-config.spec.ts`、`profile.spec.ts` 同属 HMR/文件监听时序 flake（同套件多次复跑 F/P 交替），不是本批改动引起。

**新增未修（需要决策）**
- **CI 释放路径断裂（与本批无关，但会挡发布）**：`.github/workflows/{release,release-publish,e2b-e2e,sandbox,e2e}.yml` 共 15 处调用 `pnpm run build:official` 与 `release:verify`，这两个脚本在 `package.json`（含 HEAD 与 `dsh-015`）**都不存在**，属上游 deepseek-harness 的 CI 契约；本 fork 若要发布必须二选一：在 `package.json` 定义这两个脚本，或把 workflow 改成本 fork 的真实入口（`build:lib:host` 等）。删除/改写哪个契约属维护者决定。
- `package.json` 两条悬挂脚本：`test:build:lib:host:smoke` → `scripts/build-host-bundles.smoke.ts`（不存在）、`gen-package-invariant` → `scripts/gen-package-invariant.ts`（不存在），HEAD 即如此。
- `tsconfig.base.json:122` 死别名 `@deepseek-ai/dsh-agent/brand`（目标不存在，无引用；生成区校验不覆盖手写区）。
- `packages/sandbox/sandbox-local/src/index.ts:229` JSDoc 仍指 `examples/acp-agent/tests/fixtures/partial-landlock-sandbox.ts`（已搬到本包 tests/fixtures），生成物同样陈旧。
- 文献陈旧（不影响门禁）：`AGENTS.md:87`、`docs/development.{md,zh.md}` 的 `demo:cordis`；`examples/acp-agent/README*` 与 `packages/core/tools/README*` 的 `demo:code-mode`；`packages/extensions/tool-cordis/README*` 的 `gen-client-catalog`/`verify-client-catalog`；`packages/AGENTS.md:22` 与 `snapshots/AGENTS.md:3` 的 `tsconfig.base.client.json`/`test:web`。

## 5. P5/P6 待决项（晋升前清单）

1. 按 R1–R3 清红，并解冻一次安装同步（补 `node_modules` 链接，修 headless lane 依赖解析）。
2. 冻结源码并记指纹（含 `session-snapshot` 版本回退确认）；确认无并发写入者。
3. 用当前工作树**重建一次**唯一候选；构建后重跑全量 `test:snapshot`（不是只跑 ACP/SDK 两条 lane）与 FULL_GATE，不允许降范围。
4. 候选 Native 验收 + 交付包一致性扫描（正式版/候选 runtime 与仓库 `lib/` 逐文件哈希对比）作为晋升前置门禁。
5. 原子替换 `~/ark/Ark.app` → 启动复验 → 删候选 → 按本清单逐项清理（确认独有历史已归档后再删 `dsh-015`、`Ark-Recovery-20260908`、rollback 件）。
