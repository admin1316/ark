# Phase 0 active profile matrix

[English](profile-matrix.md) | 中文

**Sources compared:** checked-out `integrations/jiuzhang/profile`, `packages/bundle/base/cordis.patch.yml`, `packages/bundle/native-api-app/cordis.patch.yml`, installed product `/Users/hui/Library/Application Support/Ark/Harness/profiles/jiuzhang`, and packaged runtime `/Users/hui/ark/Ark.app/Contents/Resources/runtime/jiuzhang/profile`. Profile rows are loader patches; later rows replace a matched row's whole config.

**当前候选文件观察 — 2026-10-13。** 已安装的 3.1.41 候选中，base patch、native API patch、Jiuzhang patch 和 Jiuzhang package 四组源码／包内对照逐字节一致；候选 home 中的 Jiuzhang patch 和 package 也与源码一致。[profile 回执](../../scripts/rust-migration/candidate341-profile-consistency-and-source-api-boundaries-20261013.json)绑定这些文件及独立的 home assembly 摘要。已批准的不持有私钥验证器 factory／配置迁移属于源码变更，不在冻结的 3.1.41 runtime 内。文件身份不能证明活动 authority 配置非空、签名密钥已受保护托管或正式 profile 的成员关系。

**2026-10-13 候选文件观察（历史，3.1.39）。** 隔离候选 3.1.39 中，`dsh-base`、`native-api-app` 和 Jiuzhang 的源码与包内 patch 字节一致，Jiuzhang package 文件也一致。[profile 回执](../../scripts/rust-migration/candidate339-profile-consistency-and-runtime-boundaries-20261013.json) 绑定这四组对照和包内 Wiki 模块。文件一致不能证明 launcher 信任配置非空、受保护验证器已部署或正式 Ark 的 profile 成员关系。

**2026-10-12 候选文件观察（历史）。** 隔离的 3.1.35 候选 runtime 中，源码 `dsh-base` 和 `native-api-app` profile 的 `cordis.patch.yml` 与打包副本逐字节相同；Jiuzhang profile overlay 的 `package.json` 和 `cordis.patch.yml` 也逐字节相同。Jiuzhang patch 的 SHA-256 为 `1474a3ded0fb19a19829d39bb37d052eaa0bddc594825bca2c87f81be0c36454`，package 的 SHA-256 为 `7dde652cc7638fe205e1e1c2e22974646c7d9d99586ada6a4b17c362cc502d3e`。这些候选文件匹配并不证明它们属于正式 Ark 3.1.0 的 active profile；正式安装仍独立且未变更。详见[候选回执](../../scripts/rust-migration/candidate335-summary-admission-native-result-20261012.json)。

**2026-10-08 profile 观察（历史）。** 当时源码/profile 对比按 checkout 提交 `02bf7ebc7f973b35e298bcd4121199f0ab81683c` 刷新。更早的 `b8adf5a7ec` 属于 Phase 0 基线。

后续的[验证器取消源码修正](../../.agents/notes/implemented/bug-fix/2026-10-13-verifier-post-exit-cancellation.zh.md)尚未进入冻结的 3.1.39 候选。其源码测试不会更新已安装 runtime，也不能证明原生验收通过。

## Profile rows and effective behavior

下表描述这些 patch 加载后的源码组合。3.1.41 对照绑定候选文件，不能证明当前正式产品的成员关系或环境变量值。

| Capability | dsh-base | native-api-app | Jiuzhang source profile overlay | Effective result |
| --- | --- | --- | --- | --- |
| Session persistence | `session-persistence-jsonl`, root `dshHomePath('sessions')` ([`base/cordis.patch.yml:105-108`](../../packages/bundle/base/cordis.patch.yml)) | inherited | no override | **Enabled**; append-only per-session JSONL/Zstandard frames. |
| Session query | SQLite `path: ':memory:'`, `openAt: never` ([`base/cordis.patch.yml:116-128`](../../packages/bundle/base/cordis.patch.yml)) | inherited | same override `path: ':memory:'`, `openAt: never` ([`integrations/jiuzhang/profile/cordis.patch.yml:40-43`](../../integrations/jiuzhang/profile/cordis.patch.yml)) | **Mounted exact reads/filters/traces; full-text search disabled and SQLite never opened.** |
| Projection cache | absent | `session-projection-cache`, `writeEveryEvents: 200`, `writeIntervalMs: 5000` ([`native-api-app/cordis.patch.yml:96-100`](../../packages/bundle/native-api-app/cordis.patch.yml)) | no override | **Enabled**; durable `session_projcache` JSON storage with mandatory create/turn-end/dispose writes. |
| Knowledge Wiki owner | absent | inserts `knowledge-wiki` with empty `wikiRoot/mainRoot`, `credential: ''`, v4-flash ([`native-api-app/cordis.patch.yml:117-124`](../../packages/bundle/native-api-app/cordis.patch.yml)) | replaces with env roots, `credential: DEEPSEEK_API_KEY`, `ownedStageExecutor: true` ([`jiuzhang/profile/cordis.patch.yml:27-34`](../../integrations/jiuzhang/profile/cordis.patch.yml)) | **The Jiuzhang overlay specifies env-bound roots and owned workers; both rows use the current Config vocabulary.** |
| Rust search candidate | no override | default-disabled candidate fields | no override | **No source profile row enables the Rust candidate; the default search path remains TypeScript.** |
| Independent verifier | absent | absent | `knowledgeVerifierConfig` 使用 `ARK_KNOWLEDGE_VERIFIER_CONFIG` | **按配置组合**；[Wiki owner](../../packages/host/knowledge-wiki/src/index.ts) 使用非空 launcher JSON 创建验证器。空配置使此路径不提供验证器；owner 也检查 `knowledgeWikiVerifierAuthority`。源码组合路径不能证明实际配置非空或密钥受保护。 |
| Knowledge tools | absent | absent | inserts `tool-knowledge-wiki` ([`jiuzhang/profile/cordis.patch.yml:36-38`](../../integrations/jiuzhang/profile/cordis.patch.yml)) | **Enabled** in Jiuzhang; unavailable in native bundle without this overlay. |
| Telemetry | base mounts OTel disabled by default/config ([`base/cordis.patch.yml:136-169`](../../packages/bundle/base/cordis.patch.yml)) | inherited | explicitly `disabled: true` ([`jiuzhang/profile/cordis.patch.yml:45-46`](../../integrations/jiuzhang/profile/cordis.patch.yml)) | **Disabled.** |
| Product roots | launcher sets `ARK_MAIN_ROOT` and `ARK_WIKI_ROOT` from product data locations ([`integrations/jiuzhang/native/Sources/JiuzhangShellCore/ShellContract.swift:232-260`](../../integrations/jiuzhang/native/Sources/JiuzhangShellCore/ShellContract.swift)) | no own root | overlay consumes those env vars | **Knowledge data is product-owned, outside source checkout.** |

## Source/profile/install consistency

- `integrations/jiuzhang/profile/package.json` and `cordis.patch.yml` match the packaged app runtime copies byte-for-byte (SHA-256 above). This is a positive source-to-artifact check.
- 历史产品 home 观察记录 `/Users/hui/Library/Application Support/Ark/Harness/profiles/jiuzhang/` 与当时观察的源码 overlay 相同，并包含 `@deepseek-ai/dsh-native-api-app`；通用 `/Users/hui/.dsh/profiles/jiuzhang/` 当时只有 `@deepseek-ai/dsh-base` 和空 patch。这些记录不能证明当前正式产品的 profile 成员关系；3.1.39 回执只对照候选包文件。
- [Wiki Config 所有者](../../packages/host/knowledge-wiki/src/index.ts)校验 `credential`；原生 API bundle 提供 `credential: ''`，因此其独立组合使用当前 Config 字段，并在配置凭据前停用可选嵌入调用。
- 历史产品设置记录选择了 `deepseek-official/deepseek-flash` 和 `reasoningEffort: max`；这不代表当前候选设置。源码原生 API patch 为 Wiki 指定 `llmProvider: deepseek-official` 和 `llmModel: deepseek-v4-flash`。Jiuzhang 整体替换 Wiki config 时没有这两个字段，因此该 overlay 使用 Config 默认值，并不继承这个模型选择。会话的模型选择与 Wiki 配置各自独立。

## Session backend decision

The source-defined composition has **JSONL persistence enabled**, **projection cache enabled**, and **SQLite query indexing mounted but disabled**. This is intentional in the base patch: `openAt: never` preserves `ctx.sessionQuery` exact reads and traces while `searchSessions`/`searchEvents` fail closed as `SESSION_QUERY_SEARCH_DISABLED` and SQLite is not imported/opened ([`packages/session-query/session-query-sqlite/src/index.ts:85-103`](../../packages/session-query/session-query-sqlite/src/index.ts), [`:251-255`](../../packages/session-query/session-query-sqlite/src/index.ts)). Enabling content search requires a later profile override to `first-search`/`startup` and a durable path, per base comments ([`base/cordis.patch.yml:116-128`](../../packages/bundle/base/cordis.patch.yml)).

## Drift actions

1. Update `docs/knowledge-wiki.md` to the current service/schema and label the old JSONL/vector contract historical.
2. Keep the native API bundle's `credential` key covered by profile composition and native preset runtime checks.
3. Keep `session-query-sqlite` disabled until a benchmark and durable index ownership decision exists; do not infer search availability from the row being mounted.
4. Keep the stale `/Users/hui/.dsh` profile out of runtime claims; product launch identity is `JIUZHANG_DSH_HOME`/`DSH_HOME` and the native data-root checks in `runtime.mjs:946-965`.

<a id="installed-state-observation--2026-10-10"></a>

<a id="current-installation-status"></a>

## 2026-10-10 安装态观察

正式 Ark 仍为 3.1.0/build `2026092701`。隔离候选槽中保存 Ark 3.1.24/build `2026101124`；`2026-10-10T23:38:18Z` 的本机进程扫描未发现候选 app、runtime 或 API runner 进程，也未发现端口 `50074` 的监听器。源码、打包后的 base、native API 和 Jiuzhang profile patch 的 hash 分别为 `24b9156d…`、`87baf5a5…` 和 `805694d8…`；候选副本与检出源码逐字节一致。runtime 清单包含 106 项：一个 `cordis:include` 根和 105 个 plugin ID，其中 78 个启用、27 个禁用；安装态 E2E 在两次进程运行中通过 121 项检查，失败为 0。记录中的 3.1.24 进程环境检查发现，候选 app、runtime 和 API runner 中都没有 `ARK_KNOWLEDGE_VERIFIER_CONFIG`，因此该次启动虽打包了 verifier 实现，却没有活动 authority。正式安装使用不同的 Jiuzhang overlay，所以候选清单不能证明正式版的 runtime 成员关系。参见[候选模块和语言清单](rust-candidate-matrix.zh.md)、[3.1.24 安装态回执](../../scripts/rust-migration/candidate324-installed-e2e-20261011.json)、[3.1.24 verifier 进程观察](../../scripts/rust-migration/candidate324-verifier-runtime-20261011.json)及[最新本机进程观察](../../scripts/rust-migration/candidate324-process-observation-20261011.json)。

### Ark 3.1.19 工作区绑定失败基线

Ark 3.1.19 候选打包了该 Jiuzhang overlay。一项全新的只读发票任务使用 `deepseek-official/deepseek-v4-flash/max`，返回了与两份 CSV fixture 独立核对一致的五键 JSON。持久化 Session 的 CWD 却是候选的 `Default Workspace`，而 UI 显示的是发票 Workspace，且该 Workspace 的注册表中没有此 Session。因此，即使算术正确，这次运行的 Workspace 绑定仍失败。native 源码会在首次发送 prompt 前核对返回的 Session 是否属于所选 Workspace，并检查规范化后的 CWD；回归检查也覆盖了不一致时阻止发送以及绑定正确时成功的路径。这项源码修复与记录中的 3.1.19 构建分开；只读模式也不会将文件读取限制在单一文件夹。参见[source-truth 报告](source-truth-report.zh.md#current-source-candidate--2026-10-10)和[3.1.19 实时审计回执](/Users/hui/ark-test/evidence/candidate-3.1.19-deepseek-v4-flash-output-audit-20261010.json)。

### Ark 3.1.20 工作区绑定实时复测

3.1.20 候选在选中发票 Workspace 后运行了一项全新的只读任务。持久化 Session 的 CWD 与该 Workspace 完全一致，Workspace 注册表也包含这个 Session ID。运行只读取两份任务 CSV，没有调用写入或编辑工具，返回值与独立精确有理数计算一致。这只证明本次运行正确绑定 Workspace，并观察到任务文件范围；不能证明只读模式限制了文件系统读取。完整的输出、verifier、学习和发布结论见[3.1.20 source-truth 条目](source-truth-report.zh.md#current-source-candidate--2026-10-10)和[实时审计回执](/Users/hui/ark-test/evidence/candidate320-deepseek-v4-flash-output-audit-20261010.json)。

<a id="当前-verifier-接线与候选运行时--2026-10-11"></a>

### Verifier 接线与候选运行时观察 — 2026-10-11

Jiuzhang 和 native API profile patch 将 `ARK_KNOWLEDGE_VERIFIER_CONFIG` 映射到 `knowledge-wiki.knowledgeVerifierConfig`。Knowledge Wiki owner 会通过受管理的 `ctx.subprocess`，根据 launcher 所拥有的 JSON 构造外部 authority；Native launcher 只转发这个专用变量，并会从普通模型可调用子进程中清除它。源码定向检查通过 88 项 subprocess 测试、97 项 Jiuzhang Node 测试和 53 组 native contract 检查；Ark 3.1.24 包含了这项转发修复。

对 Ark 3.1.24/build `2026101124` 的启动检查确认，其 Jiuzhang 和 native API profile 副本与源码一致。进程环境检查发现，app、runtime 和 API runner 中都没有这个专用 verifier 变量。因此该次启动没有活动 verifier authority。发票任务没有使用 Wiki 检索，也就不能证明实时 verifier 知识学习或复用。之后的本机进程扫描发现候选已停止；app bundle 仍留在候选槽。参见[3.1.24 verifier 进程观察](../../scripts/rust-migration/candidate324-verifier-runtime-20261011.json)、[同题发票审计](../../scripts/rust-migration/candidate324-live-invoice-20261011.json)、[仅源码的转发回执](../../scripts/rust-migration/native-verifier-config-forwarding-20261011.json)和[最新本机进程观察](../../scripts/rust-migration/candidate324-process-observation-20261011.json)。

### 面向模型内容的规范生命周期门控 — 2026-10-11

当前检出源码会在 `knowledge/promoted` 建立 `lifecycle: canonical` 之前，阻止 verifier 签名记录进入常规模型搜索、读取、列表、图谱和修复来源读取路径。由于没有配置独立的实测试用回执读取器，Canonical Promote、Merge、Replace 和 Deduplicate 同样会失败关闭；Archive 则保留已认证的 WAL 和恢复路径。3.1.24 候选包不含这些源码变更。app bundle 仍在候选槽，但最新本机进程扫描未发现候选 app、runtime 或 API runner 进程。重新运行全部 76 个 Wiki/tools 测试文件，通过 693 项；Knowledge Wiki 和 Wiki tools typecheck 均通过。记录中的 3.1.24 启动没有 `ARK_KNOWLEDGE_VERIFIER_CONFIG`，因此实时 verifier 行为仍不可用。参见[规范内容回执](../../scripts/rust-migration/knowledge-canonical-content-gate-20261011.json)、[实测试用拒绝回执](../../scripts/rust-migration/knowledge-measured-trial-gate-20261011.json)和[最新本机进程观察](../../scripts/rust-migration/candidate324-process-observation-20261011.json)。

<a id="当前-实测试用接线状态--2026-10-11"></a>

### 实测试用接线源码观察 — 2026-10-11

源码现在提供可选的 launcher-owned measured-trial reader 和新增登记 RPC。晋级必须通过与候选、语义 verifier 回执、操作和精确目标字节绑定的签名试验；提交与恢复时都会重新验收回执。Jiuzhang profile 已把仅由 launcher 提供的公钥与 artifact-root 变量映射到服务，但活动环境没有受信配置值，因此所有规范 review 操作仍会失败关闭。新增配置与文件 resolver 回归通过 34/34 项；Jiuzhang Node runtime 测试通过 24/24 项；Wiki/tools 整包复测通过 78 个文件／719 项。这些源码改动不在暂存的 3.1.26 包中；当前运行候选是 3.1.25。正式 Ark 3.1.0 未变，Phase 6 仍为 0/16 项行为检查通过，尚未上传 GitHub 或晋级正式版。
