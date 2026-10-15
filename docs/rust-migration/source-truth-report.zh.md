# Phase 0 source-truth report

[English](source-truth-report.md) | 中文

**观察快照 — 2026-10-15。** 已安装的隔离候选为 Ark 3.1.44/build `2026101444`，源码为 `d33bbe5c384d1beace5728fe80597db4d43ab487`；native SHA-256 为 `154919d48800e903893b61e76438dae748e61efb86eb944a421bfbcd16e0a631`，包内 Wiki SHA-256 为 `42b2f07530c100fb5c0e53439bef3bbab1f5700c355930a8661ca8a8ee1efbde`。[源码、产物与 profile 快照](../../scripts/rust-migration/candidate344-source-profile-snapshot-20261015.json)区分这一已安装产物、已上传的 `15970f360bb7b9b6742d195541adebfd419d560a` 和尚未提交的运行时修复。该提交的 Linux 覆盖率和 macOS Native 检查通过，原生 Windows 保留五项失败，独立 Sandbox 工作流通过。最近一次已完成的新[原生代码任务](../../scripts/rust-migration/candidate341-real-native-code-task-result-20261013.json)仍来自 3.1.41；3.1.44 恢复的历史记录不是新任务。正式／候选同题对照的两臂均尚未提交。真实受保护信任、已认证的新对话复用和完整任务验收仍未获证明。正式 Ark 仍为 3.1.0，生产搜索仍为 `RETAIN_TS`。

**2026-10-12 候选观察（历史）。** 隔离候选 Ark 3.1.35/build `2026101235` 位于 `/Users/hui/ark-test/candidate/Ark.app`，二进制 SHA-256 为 `78118580b1b01a01a2c4363ba5c7590f92eac24c3edf828586584cf7079803bb`；打包的 Knowledge Wiki 模块 SHA-256 为 `86a726fa0f0172a9e1e9f415f76e1ceb1e21f9bc31e1468b6fdee58a5de970ab`。Native first-final 任务记录 24,893 个事件；完整会话重放无需修补其私有副本（`repairedPrivateCopy=false`）；详见[first-final 会话重放快照](/Users/hui/ark-test/evidence/candidate335-native-code-first-final-20261012.json)。首次运行结果为 1 项通过／5 项失败，随后记录的复测为 6／0。完整报告判定为 `FAIL`：开头声称 `validate-throws` 在状态污染后抛错，但后文指出 validator 从未调用且请求已被接受。没有触发 child 或 job 调用。Loader test key 仅供测试；没有证据表明生产 authority 已激活或被真实使用。Rust 决策仍为 `RETAIN_TS`。正式 Ark 3.1.0 未变更，未发布到 GitHub，也未晋级；原始 publication、first-command、platform 和 learning 验收仍为 `UNKNOWN`。详见[2026-10-12 候选回执](../../scripts/rust-migration/candidate335-summary-admission-native-result-20261012.json)。

**2026-10-08 源码观察快照（历史）。** 当时本报告按 GitHub 派生 checkout 提交 `02bf7ebc7f973b35e298bcd4121199f0ab81683c`（`fix: harden hybrid embedding boundaries`）刷新。更早的 `b8adf5a7ec` 内容仍可在 Git 历史中作为 Phase 0 基线查阅；两者都不是本页的当前候选身份。

**审计目标。** 仓库 `/Users/hui/ark-test/ark-github-main-20261008`，分支 `codex/ark-rust-knowledge-20261008`，远端 PR 为 `https://github.com/admin1316/ark/pull/39`。审计前已读取任务引用的 mission 文本 `/Users/hui/.codex/attachments/3a68ae30-3b77-4be2-96be-2c65920c5ec6/pasted-text-1.txt`。本次刷新没有修改正式 Ark；候选运行证据单独记录。

## Three-layer conclusion

当前源码树、已打包 Ark profile 和观察到的存储产物共同说明：系统使用受治理的 Markdown Wiki 和常规 Session 持久化。`docs/knowledge-wiki.md` 描述的是旧 runtime 契约，内容已明显过时；其中声称存在动态 `kgraph-1` 插件、`.dsh-knowledge-wiki/knowledge.jsonl`、持久化向量、每个 turn 产生三个产物，以及每个模型 step 都注入的 `knowledge-wiki-recall` 系统提示区块（[`docs/knowledge-wiki.md:5-18`](../knowledge-wiki.zh.md)、[`:45-54`](../knowledge-wiki.zh.md)、[`:71-83`](../knowledge-wiki.zh.md)）。下面所述的活动实现中没有这些名称，也没有逐 turn 自动写入路径。

检出的源码由 package 提供 `KnowledgeWikiService`，并具有持久化 ingest queue、Markdown `_candidates` 与 review 状态、verifier authority，以及可选的在线 embeddings。初始化路径每 60 秒扫描 `raw/sources`，且只监听 `agent/disposed` 来汇总 Session（[`packages/host/knowledge-wiki/src/index.ts:509-544`](../../packages/host/knowledge-wiki/src/index.ts)）。Service 注释明确说明 turn-level Markdown 已关闭（[`index.ts:536-544`](../../packages/host/knowledge-wiki/src/index.ts)）。Session 汇总会通过 `sessionQuery.readSession` 读取整个 Session，要求至少 200 个字符，调用由 owner 管理的 stage executor，然后写入 candidate 和 review item（[`index.ts:556-640`](../../packages/host/knowledge-wiki/src/index.ts)）。

## Knowledge implementation facts

- 部署配置由 `wikiRoot`、`mainRoot`、`credential`、LLM provider/model/base URL/credential 和 `ownedStageExecutor` 组成；TypeScript config 中没有 `apiKey`、entry `kind` 或 vector-store 路径（[`packages/host/knowledge-wiki/src/index.ts:116-155`](../../packages/host/knowledge-wiki/src/index.ts)）。
- 持久化 Wiki 状态位于项目本地的 `.llm-wiki/ingest-queue.json`、`.llm-wiki/ingest-cache.json`、`.llm-wiki/review.json`、`.llm-wiki/knowledge-utility.json` 和 Workspace registry；queue 恢复及原子写入位于 [`index.ts:409-467`](../../packages/host/knowledge-wiki/src/index.ts)，utility 读写位于 [`index.ts:604-635`](../../packages/host/knowledge-wiki/src/index.ts)。
- 搜索会遍历 Wiki Markdown 页面并计算 BM25；还可通过 DashScope HTTP API 为 query 和关键词排名前 15 的页面生成 embeddings。Embedding 失败时会回退到关键词结果（[`packages/host/knowledge-wiki/src/search.ts:27-45`](../../packages/host/knowledge-wiki/src/search.ts)、[`:47-121`](../../packages/host/knowledge-wiki/src/search.ts)、[`:123-146`](../../packages/host/knowledge-wiki/src/search.ts)、[`:176-239`](../../packages/host/knowledge-wiki/src/search.ts)）。Package README 确认 embeddings 在线生成，且没有持久化 vector store（[`packages/host/knowledge-wiki/README.md:102-109`](../../packages/host/knowledge-wiki/README.zh.md)）。
- Retrieval utility 投影到 `.llm-wiki/knowledge-utility.json`；带 hash chain 的 lifecycle journal 是 retrieval 与 correction 计数的权威来源。`recordKnowledgeOutcome({ outcome: 'successful' })` 返回零；事件 replay 忽略独立的 success outcome，在尚无独立、经过认证的 paired-trial reader 时，`knowledgeUtility()` 会把成功使用数维持为零。Wiki 工具还会把模型可见的检索结果及其精确渲染内容绑定到 Session event（[`packages/host/knowledge-wiki-tools/src/index.ts`](../../packages/host/knowledge-wiki-tools/src/index.ts)、[`session-events.ts`](../../packages/host/knowledge-wiki-tools/src/session-events.ts)）。
- Candidate governance 已实现，但此基线没有组合任何生产 `knowledgeWikiVerifierAuthority` provider（测试和库目录之外的 `git grep` 只找到 endpoint metadata 和 `index.ts:83,231` 的 optional getter）。除非注入可信 provider，否则验证会返回明确的 authority-unavailable blocker。这与旧的“memory entry” schema 不同：`CandidateVerification` 绑定内容 hash、review hash、source identity、receipts、methods、confidence 和验证结果（[`packages/host/knowledge-wiki/src/types.ts:78-129`](../../packages/host/knowledge-wiki/src/types.ts)）；`verifyCandidate()` 会在应用 review 之前持久化并记录可信 receipt（[`index.ts:1217-1257`](../../packages/host/knowledge-wiki/src/index.ts)）。`resolveReview()`／`resolveReviews()` 只通过 review 层应用 advisory 或 candidate 操作（[`index.ts:1264-1318`](../../packages/host/knowledge-wiki/src/index.ts)）。
- Utility 没有 expiry、conflict resolution、rollback event、scope/ACL 字段或任务要求的 18 字段知识记录。Session summary candidate 的 frontmatter 带有认知状态／证据计数（`hypothesis` 或 incident 的 `verified`），但晋级仍由 review/verifier 控制（[`packages/host/knowledge-wiki/src/auto-sediment.ts:457-520`](../../packages/host/knowledge-wiki/src/auto-sediment.ts)）。

## Documentation drift register

| Drift | Evidence | Impact |
| --- | --- | --- |
| 旧存储／schema | 文档描述 `.dsh-knowledge-wiki/knowledge.jsonl`、`vectors.json` 和 `kind: conversation/profile/reflection/doc`（[`docs/knowledge-wiki.md:9-43`](../knowledge-wiki.zh.md)）；源码实际写入 `.llm-wiki` queue/cache/review/utility 和 Wiki Markdown candidate（[`index.ts:409-467`](../../packages/host/knowledge-wiki/src/index.ts)、[`:604-635`](../../packages/host/knowledge-wiki/src/index.ts)）。 | 基于旧 JSONL schema 的迁移会指向不存在的活动存储。 |
| 每 turn 摄取 | 文档声称 `agent/turn-stopping`、基于 cursor 的增量提取和每 turn 三个产物（[`docs/knowledge-wiki.md:45-54`](../knowledge-wiki.zh.md)）；Service 初始化说明 turn-level Markdown 已禁用，且只注册 `agent/disposed`（[`index.ts:536-544`](../../packages/host/knowledge-wiki/src/index.ts)）。 | 当前没有逐 turn 学习；只有 agent 结束后的 Session summary 能创建 candidate。 |
| 自动 recall | 文档声称 `knowledge-wiki-recall` 会在每个模型 step 注入 profile/reflection（[`docs/knowledge-wiki.md:71-83`](../knowledge-wiki.zh.md)）；当前工具只添加通用使用说明（`tool:knowledge-wiki`），没有 recall 区块（[`packages/host/knowledge-wiki-tools/src/index.ts:64-69`](../../packages/host/knowledge-wiki-tools/src/index.ts)）。 | 不能根据当前源码声称模型已获得知识注入。 |
| Embedding 持久化／批量 | 文档声称会等待每个条目写入 `vectors.json`，且 API 批次上限为 10（[`docs/knowledge-wiki.md:16-18`](../knowledge-wiki.zh.md)、[`:51-69`](../knowledge-wiki.zh.md)）；源码按 search request 生成 embeddings、每次最多取 16 项，且不持久化向量（[`search.ts:129-145`](../../packages/host/knowledge-wiki/src/search.ts)、[`README.md:104-109`](../../packages/host/knowledge-wiki/README.zh.md)）。 | Vector cache 覆盖范围和旧 embedding 限制不适用于此版本。 |
| RPC／工具名称 | 文档列出 `kw.list`、`kw.graph`、`kw.ingest` 和 `knowledge_search`（[`docs/knowledge-wiki.md:96-108`](../knowledge-wiki.zh.md)）；Remote 方法实际为 `list`、`graph`、`search`、`ingestQueueAdd` 等（[`index.ts:642-705`](../../packages/host/knowledge-wiki/src/index.ts)、[`:956-975`](../../packages/host/knowledge-wiki/src/index.ts)）。 | Client／tool 集成必须使用当前 `knowledgeWiki/*` 和 `wiki_*` 契约。 |

## Runtime evidence

已打包的 Ark app 中，`integrations/jiuzhang/profile/package.json` 和 `cordis.patch.yml` 的副本与源码逐字节一致（SHA-256 分别为 `7dde652cc7638fe205e1e1c2e22974646c7d9d99586ada6a4b17c362cc502d3e` 和 `b24765d09a0441e4fb489122ad2c5543f1fa9c9dbf21c16fa0343797599004ab`）。已安装产品在 `/Users/hui/Library/Application Support/Ark/Harness/profiles/jiuzhang/` 的 Harness profile 具有相同 bundle 列表和 patch 内容。检出源码比已打包 app 新；app 来源记录 `ArkProvenance/source-and-pack.json` 中的源码 commit 为 `4ef63040883f497857cff71ab0e82fd07ac123fa`，而 checkout 为 `b8adf5a7ec`。因此，打包 runtime 行为必须归因于该 app 记录的 commit，不能默认为当前 HEAD。

正式 Harness profile 中的 `knowledge-wiki` 使用 `ARK_WIKI_ROOT`／`ARK_MAIN_ROOT`、`credential: DEEPSEEK_API_KEY` 和 `ownedStageExecutor: true`；它将 `session-query-sqlite` 覆盖为 `path: ':memory:'`、`openAt: never`，并禁用 OTel（[`integrations/jiuzhang/profile/cordis.patch.yml:27-46`](../../integrations/jiuzhang/profile/cordis.patch.yml)）。正式 Knowledge 根目录 `/Users/hui/Library/Application Support/Ark/Knowledge` 有 `purpose.md`、`schema.md`、`wiki/index.md`、`wiki/log.md` 和 `.llm-wiki/workspaces.json`；未观察到 `knowledge.jsonl`、`vectors.json` 或 candidate 页面。在审计源码中没有 `knowledge-wiki-recall` 标识。这是存储观察，不能证明未来一次新运行不可能生成 candidate。

## Phase 0 disposition

将 `docs/knowledge-wiki.md` 及其中文版本视为过时证据，需要通过文档变更请求修订。在新契约经过独立 review 前，以源码实现和活动 profile 为准。不要声称自动逐 turn 学习或模型 step 记忆注入。当前可验证路径为：Session event log → session-disposal summary（满足条件且 stage executor 成功时）→ `_candidates` Markdown 和 review item → 独立 verifier receipt → 显式 review 操作 → canonical Wiki 页面；search 根据当前 service 实现，从 canonical/candidate 树读取。

## Phase 1 reconciliation

The working tree adds governed `KnowledgeRecord` fields, a hash-chained `knowledge-events.jsonl` lifecycle, scope/ACL/freshness/conflict gates, utility retention helpers, and session-log `knowledge/retrieved`/`knowledge/injected` events emitted by Wiki tools. Candidate events carry complete records; verification, promotion, rejection, expiry, and rollback remain explicit transitions. `docs/knowledge-wiki.md` now describes this active contract. The native API bundle row uses `credential: ''`, matching `KnowledgeWikiService.Config`; the Jiuzhang overlay continues to provide `credential: DEEPSEEK_API_KEY` and the owned executor.

The current working tree also adds a default-disabled Rust knowledge-search candidate seam. Shadow mode sends immutable page/query DTOs through an isolated child process, validates request/result digests and byte-exact BM25 output, and always returns the governed TypeScript result. Enforce mode remains fail-closed because the Rust candidate does not yet cover the complete hybrid embedding contract. The active Jiuzhang profile does not enable this mode or provide a verifier authority; production behavior therefore remains TypeScript with explicit verifier-unavailable blockers.

当前工作树还包含 launcher-owned external verifier adapter。它只通过 launcher-owned 的 `knowledgeVerifierConfig` 接缝接受固定 source identity、Ed25519 密钥对和绝对路径 verifier executable；Wiki 内容不能提供该配置。活动 profile 仍没有 verifier config 值，因此该 adapter 虽已通过隔离 fixture 验证，仍不会把当前运行证据自动变成验收结果。

## Automatic-run evidence

当前 checkout 已包含 `project-manifest.json`、`progress.jsonl`、`decision-log.md`、`security-report.md` 和 `rust-benchmark.json`。`scripts/rust-migration/run-context.ts` 会加载 `jiuzhang` profile、当前 Git SHA、immutable hashes 和已有证据，并明确列出缺少的 external verifier/native/candidate 凭据以及 active-profile utility 文件。manifest 只建立 immutable boundary，不会把缺失的行为证据变成 PASS；在可信签名 receipt 绑定当前源码、profile 和运行结果前，验收仍是 `UNKNOWN`。

<a id="observation-snapshot--2026-10-10"></a>

<a id="current-audit--2026-10-10"></a>

<a id="当前审计--2026-10-10"></a>

## 观察快照 — 2026-10-10

源码 checkout `/Users/hui/ark/repo` 报告 HEAD 为 `e9571a5b01b2fc98d64914e3fa9b2e97feae0197`，分支为 `codex/ark-upstream-reliability-20260927`，工作树有未提交改动；commit 本身不能标识实际测试过的源码内容。`scripts/rust-migration/run-context.ts` 报告 `ready`，`scripts/rust-migration/audit-acceptance.ts` 报告 `UNKNOWN`：artifact completeness 为 `PASS`，但 16 项行为检查全为 `UNKNOWN`，因为没有已认证的行为回执绑定到当前源码和活动 profile。

2026-10-10 对 GitHub 的新比较显示，远端 `HEAD` 和 `origin/main` 都指向 `d382723905742f2b87401ad444d02756f5cb229b`；当前 checkout 分支比该基线领先 25 个 commit。当时检查的工作树有 201 个已跟踪修改路径和 65 个未跟踪路径。开放的 PR #46 是独立 draft 分支，head 为 `69bc324a8b125b452993c00c95965afd9a478871`；其检查汇总中 `windows node 24 / native complete` 为 `FAILURE`，真实 DeepSeek `e2e` 为 `CANCELLED`，其他已列检查为 `SUCCESS`。候选 3.1.16 和当前脏源码都不在 PR #46 中。

Knowledge Wiki 和 Rust-migration 套件最近一次本地重跑通过 80 个文件／686 项测试。`pnpm run typecheck` 成功构建 Host bundles；Rust `cargo fmt --check`、3 项 unit test 和 Clippy 通过；`doc-sync` 的 30 个门禁全部通过；`git diff --check` 通过。另有 Jiuzhang native/profile/lifecycle 97/97、53/53 组 shell contract 到达并通过的记录。学习归约器会拒绝未签名或 evaluator 不受信任的 attestations，并在任何已测质量指标退化时阻止 `SUPPORTED`。这些是源码、fixture 和 contract-test 结果，不是 GPT-6 Luna 对话验收或发布证据。与 CI 匹配的分区 coverage 重跑通过两个 coverage 门禁：853 个测试文件、14,393 项通过，statement、branch、function 和 line coverage 均为 100%。

较早的一轮源码快照曾记录 82 个文件／704 项 Knowledge Wiki 和 Rust-migration 测试。托管 verifier 改动后的较晚定向重跑通过 80 个文件／686 项，这是当前应引用的计数。更新后的 Remote boundary 修复通过显式 `unknown` alias 保留运行时 object／array 检查；测试断言会先缩窄返回值再读取内容。全仓 `pnpm run lint`、`pnpm run typecheck:contracts-ready`、Host bundle build、`doc-sync`（30/30）、translation pairing（1,094/1,094）和 `git diff --check` 均已通过。当前源码 digest 已同步到 `rust-benchmark.json`；新的 run-context 为 `ready`，没有缺失证据。16 项行为检查仍全为 `UNKNOWN`；这些本地修复没有提供模型答复或已认证发布回执。

已安装的 `/Users/hui/ark/Ark.app` 仍为 3.1.0/build `2026092701`；其 Jiuzhang profile hash `b24765d09a0441e4fb489122ad2c5543f1fa9c9dbf21c16fa0343797599004ab` 与源码 overlay hash `525559a9ca4e81cc1b2b6b06c83d1903c1e22f657baff099a04bb67294503182` 不同。因此，已安装产品不能证明当前源码改动已启用；参见[2026-10-10 安装态观察](profile-matrix.zh.md#installed-state-observation--2026-10-10)。

3.1.20 实时审计之后，工作源码为低效用的已验证知识增加了有 journal 记录的过期处理，并收紧修正反馈：host 记录修正前现在要求同一 turn 内有直接用户消息、日志中的修复参数完全匹配、project CWD 匹配，并提供已验证的源读取 capability。完整 Knowledge Wiki 和工具包测试通过 76 个文件／687 项，定向 service/tool/composition 运行通过 42/42，ACP snapshot 通过 16/16，Knowledge Wiki typecheck 通过。这些只是源码回归结果；候选 3.1.20 早于这些编辑，未据此重建或实时测试；正式 3.1.0 app 未变。

先前的 Ark 3.1.13 候选基于 GitHub PR #46 head `69bc324a8b125b452993c00c95965afd9a478871`，而不是有未提交改动的 `e9571a5b` checkout；其打包 Jiuzhang patch hash 为 `796d9f9c8cd65581656ae237ad13ac5bbabbebc217da9e594539a8162a1986fd`。只读 `settings.yaml` 快照（SHA-256 `693d665b780827184eacac9b0a146d5b53cd217d85d5043e7052373cb73023cd`）声明 provider `openai`、模型 `gpt-6-luna`，以及 `low`、`medium`、`high`、`xhigh`、`max` 推理强度；其 `baseURL` 指向自定义 OpenAI 兼容主机，而非 OpenAI 官方 API endpoint。较早的 `UNSUPPORTED_REASONING_EFFORT` session 文件早于此设置快照。之后到达 provider 的 `gpt-6-luna/max` session 文件以 HTTP 404 `model_not_found` 结束，没有助手答复。OpenAI 的[GPT-6 Luna API 文档](https://developers.openai.com/api/docs/models/gpt-6-luna)列出该模型 ID 和 `max` 为受支持，因此证据指向自定义 endpoint／账号路由问题；但不能证明已保存的凭据能用于 OpenAI 官方 endpoint。较早一次候选 UI 自动化请求返回 `Invalid app`，而持久化 Session 记录确认任务 prompt 已到达 Ark。PR #46 仍为 OPEN/DRAFT/UNSTABLE；在该过期 PR head 上，`windows node 24 / native complete` 失败、`e2e` 取消（[Windows 运行](https://github.com/admin1316/ark/actions/runs/37960247645)，[E2E 运行](https://github.com/admin1316/ark/actions/runs/37960246725)）。这些都不构成 Ark 模型任务验收。

### 3.1.15 候选的先前路由尝试 — 2026-10-10

Ark 3.1.15/build `2026101005` 由脏源码 HEAD `e9571a5b01b2fc98d64914e3fa9b2e97feae0197` 构建，源码快照 SHA-256 为 `14f116bfdd7d0e36c9164278b3155f435c189c0a9302b17e44daa79a2f5eaa1f`。它安装在隔离的 `/Users/hui/ark-test/candidate/Ark.app` 候选槽；binary SHA-256 为 `02206e33a0d2532012fa3b13ca8c31f635a82c44226f87045edb55d7e86d30d6`。runtime 打包、native Release build、architecture／RPATH 检查、深度签名验证和打包安装态 E2E 均通过；回执记录两次进程运行中的 121 项检查、失败 0 项。临时 ad-hoc 签名仅供测试，app 未 notarize。3.1.14 保留为回滚版本；已安装 Ark 3.1.0 未变。

用户批准范围仅限此隔离候选；其 OpenAI provider `baseURL` 从已保存的自定义路由改为 `https://api.openai.com/v1`。只有候选 `settings.yaml` 中的 endpoint 行发生改变。凭据值既未检查也未修改，凭据文件 hash 保持不变。新的只读 `invoice-reconciliation-current319-20261009` Session 提交了预注册发票任务，使用 `openai / gpt-6-luna / max`。候选 UI 返回 `API 凭据被拒绝 · AUTH`，没有助手答复或工具调用。这说明已保存的凭据未被新配置的路由接受；因此本次运行不能用于评分算术、输出格式、知识检索或学习表现。

构建和打包 smoke 为 `PASS`，模型驱动行为结果为 `UNKNOWN`；16 项行为检查仍全为 `UNKNOWN`，正式晋级保持 `HOLD`。候选没有上传到 GitHub、没有合并，也没有安装为正式 app。机器可读证据位于 `/Users/hui/ark-test/evidence/current-source-candidate-3.1.15-20261010.json`；仅修改 endpoint 的回执为 `/Users/hui/ark-test/evidence/candidate315-endpoint-change-20261010.json`，UI 错误截图为 `/Users/hui/ark-test/evidence/candidate315-auth-failure-20261010.png`。

### Ark 3.1.19 候选基线 — 2026-10-10

Ark 3.1.19/build `2026101019` 占用隔离的 `/Users/hui/ark-test/candidate/Ark.app` 槽。它由源码 HEAD `e9571a5b01b2fc98d64914e3fa9b2e97feae0197` 构建，runtime 源码快照 SHA-256 为 `6976ed675ce3441a2a32156e77a393150d6047e57a20b9e9928323113bb7da05`，构建时脏 diff SHA-256 为 `21a0df4c267ad69ef600e39068310933ce967a31b08262a72f955862bd183b1a`。runtime 打包含 164 个 workspace package；native arm64／签名检查通过，打包安装态 E2E 在两次进程运行中通过 121 项检查、失败 0 项。候选使用 ad-hoc 签名，未 notarize。正式 Ark 仍为 3.1.0/build `2026092701`。

一项使用 `deepseek-official / deepseek-v4-flash / max` 的全新只读发票任务返回精确的五键 JSON；根据两份 CSV 输入独立执行 `Fraction` 重算后，结果一致：6 张有效 approved 发票、1 张 pending 发票、拒绝 ID `I007` 和 `I008`，USD 总额为 26,598 美分。持久化 trajectory 中没有非最终的非空助手文本。但 Session header 中的 CWD 是候选的 `Default Workspace`，而不是 UI 显示的发票 Workspace；发票 Workspace registry 中也没有该 Session ID。运行有 15 次工具调用，包括对 `/Users/hui/ark-test` 的宽范围 `find`，并读取三份不相关的 Knowledge 文件；没有观察到写入或最终答案泄漏。因此 Workspace 绑定和任务范围验收失败。单次运行耗时 213.047 秒，首答耗时 175.906 秒；3.1.18 匹配任务为 28.4 秒和 1.1 秒。`N=1` 不能证明稳定的性能原因。参见[3.1.19 实时审计回执](/Users/hui/ark-test/evidence/candidate-3.1.19-deepseek-v4-flash-output-audit-20261010.json)。

Native composer 会在发送首个 prompt 前，检查 Host 创建的 Session，其规范化 `cwd` 是否匹配所选 Workspace，Session 是否属于该 Workspace。若不匹配，就保留草稿、不发送 prompt，并在重试前更换创建 identity；显式创建空 Session 也使用同一 ownership 检查。Node Jiuzhang 套件通过 97/97，native contract executable 在 Workspace 和 model-route fixture 与 Host contract 对齐后通过全部 53/53 组。这些源码测试不能证明正在运行的 3.1.19 bundle 包含该修复，也不能证明只读模式把读取限制在一个目录。需要重建候选并用 `deepseek-v4-flash/max` 做全新任务；发布验收仍为 `HOLD`。安装 app 未替换，也没有 GitHub 上传或合并。参见[Workspace 绑定决策](../../.agents/notes/implemented/bug-fix/2026-10-10-native-first-prompt-workspace-binding.zh.md)。

<a id="current-source-candidate--2026-10-10"></a>

### Ark 3.1.20 先前候选基线 — 2026-10-10

Ark 3.1.20/build `2026101020` 占用隔离的 `/Users/hui/ark-test/candidate/Ark.app` 槽。bundle 记录的源码 HEAD 为 `e9571a5b01b2fc98d64914e3fa9b2e97feae0197`，runtime 源码快照 SHA-256 为 `6976ed675ce3441a2a32156e77a393150d6047e57a20b9e9928323113bb7da05`，脏 diff SHA-256 为 `3b7cb4f57e3d65e213c17f2db3d436f3cb435dccde04c1f38ff6c35ba6f32d30`，Jiuzhang profile overlay hash 与当前检出源码一致，为 `805694d8e8a4f512a660d71a7d1e6779c24960cd8e21775d62cc3ba4262fa37a`。打包安装态 E2E 在两次进程运行中通过 121 项、失败 0 项。候选使用 ad-hoc 签名，未 notarize；正式 Ark 3.1.0/build `2026092701` 仍已安装，3.1.19 保留在回滚槽。

使用 `deepseek-official / deepseek-v4-flash / max` 的全新只读发票任务耗时 15.266 秒。持久化 Session CWD 与发票 Workspace 一致，该 Workspace registry 也记录了 Session ID。运行仅列出并读取两份任务 CSV，没有调用写入或编辑工具。独立精确有理数计算与最终五键 JSON 一致：6 行有效 approved、1 行 pending、拒绝 ID `I007` 和 `I008`，合计 26,598 USD 美分。一项行内初始计算得到 26,596；第二次计算纠正了 half-away-from-zero 舍入并得到 26,598。`wiki_search` 报告 `knowledge verifier authority is unavailable`；最终助手文本为纯 JSON，但运行期间可见进程文本，所以整轮 JSON-only 验收仍无法确定。一次任务不能证明持久学习、重复错误减少、提速或文件系统读取隔离。16 项行为检查仍全为 `UNKNOWN`；artifact completeness 为 `PASS`。参见[3.1.20 实时审计回执](/Users/hui/ark-test/evidence/candidate320-deepseek-v4-flash-output-audit-20261010.json)。

同一候选的第二个全新对话，在相同 Workspace、模型和只读预设下重复原任务。其 Session CWD 和 Workspace registry 条目再次匹配；去掉任务末尾换行符后，存储的 prompt hash 与任务文件相同。任务耗时 19.044 秒，读取了 `invoices.csv`、`rates.csv`、`purpose.md` 和 `schema.md`，没有写入／编辑工具调用。最终助手消息是恰好包含所需五个键的合法 JSON，且与独立精确有理数重算一致。没有持久化非最终助手纯文本消息。UI 显示单独的进程卡片，记录 10 次工具调用和 5 个中间步骤，因此整轮 JSON-only 门槛仍无法确定。Wiki search 再次因 verifier authority 不可用而失败。两个正确结果重复了该候选的任务结论和 Workspace 绑定，但不能证明持久化修正迁移、效用提升、重复错误降低、文件系统读取隔离或性能收益。耗时样本为 15.266 秒和 19.044 秒（`N=2`），不能作为稳定性能估计。参见[重复实时审计回执](../../scripts/rust-migration/candidate320-repeat-live-audit-20261010.json)和[候选结果截图](/Users/hui/ark-test/evidence/candidate320-repeat-output-20261010.png)。

<a id="ark-3-1-21-current-candidate-2026-10-10"></a>

### Ark 3.1.21 候选观察 — 2026-10-10

Ark 3.1.21/build `2026101021` 当前占用隔离的 `/Users/hui/ark-test/candidate/Ark.app` 槽。自包含 runtime pack 有 164 个 workspace package，源码 digest 为 `ba13504ca8cbacffc2f90950393d2509cc1e7a83a76cc8c7e09be793dd9d5aa3`；app 由当前有未提交改动的 checkout 构建，并通过 runtime-receipt、Mach-O、ad-hoc signature、候选 identity 和安装态 E2E 检查。它复用隔离的候选 data home `/Users/hui/ark-test/candidate-home-current-20261010-v320-workspace-binding`。3.1.20 保存在 `/Users/hui/ark-test/rollback-candidate-v320-before-v321-20261010`。正式 `/Users/hui/ark/Ark.app` 仍为 3.1.0/build `2026092701`。

三次全新的只读对话使用 `deepseek-official / deepseek-v4-flash / max`、同一发票 Workspace 和原始任务。每份最终五键 JSON 都符合独立精确 `Fraction` 计算：6 行 approved、1 行 pending、拒绝 ID `I007` 和 `I008`，总计 26,598 USD 美分。最终对象结构和算术通过 3/3。其中一轮在 JSON 前显示英文助手旁白，另两轮没有；严格整轮 JSON-only 因此 1/3 失败，表现不稳定。耗时为 11.4、14.4 和 19.3 秒，中位数 14.4 秒；缺少匹配基线且只有三次样本，不能声称提速。这项发票任务没有测试 Wiki 修正、过期或跨对话知识复用，相关结论仍只有源码测试，没有 Ark 实时证据。测试后正常退出候选；记录中的 listener `127.0.0.1:54587`、UI、launcher 和 API runner 均已消失。没有 GitHub 上传、合并、正式替换或晋级。证据：`/Users/hui/ark-test/evidence/candidate321-live-invoice-20261010.json` 以及该回执中列出的三张运行截图。

### Ark 3.1.22 候选观察 — 2026-10-10

Ark 3.1.22/build `2026101022` 占用隔离的 `/Users/hui/ark-test/candidate/Ark.app` 槽，3.1.21 保留在 `/Users/hui/ark-test/rollback-candidate-v321-before-v322-20261010`。runtime 源码 digest 为 `ba13504ca8cbacffc2f90950393d2509cc1e7a83a76cc8c7e09be793dd9d5aa3`，最终 tree digest 为 `b91656dc1ebe28097a53e304a3f515063e3ab3cb637440b543cc04dbac9d1e90`。使用 ad-hoc 测试签名的候选通过打包安装态 E2E：两次进程运行共 121 项检查，失败 0 项；候选未 notarize。

三次全新的只读 `deepseek-official / deepseek-v4-flash / max` 对话使用未改动的发票 Workspace 和原始任务。每个已完成的最终面板都显示了符合独立精确算术计算的五键 JSON：6 行 approved、1 行 pending、拒绝 `I007`／`I008`，总计 26,598 USD 美分。最终面板 JSON-only 和算术通过 3/3。两次运行中途可见旁白，所以即使完成面板干净，实时整轮显示契约仍有 2/3 失败。耗时为 15.135、18.422 和 5.546 秒，中位数 15.135 秒；3.1.21 的 11.4、14.4 和 19.3 秒中位数为 14.4 秒。观察到的中位数慢 0.735 秒／5.1%；每个候选仅三个样本，无法证明稳定的速度退化或改善。此 UI projection 改动没有测量 TypeScript 或 Rust 执行速度。发票 fixture 没测试 Knowledge 修正、过期、跨对话复用、压力或长时间可靠性。该未签名实时观察不是已认证的 Phase 6 回执；16 项行为检查仍为 `UNKNOWN`。正式 Ark 仍为 3.1.0/build `2026092701`；没有 GitHub 上传、合并或晋级。参见[3.1.22 实时发票回执](../../scripts/rust-migration/candidate322-live-invoice-20261010.json)及其运行截图。

### 搜索内核延迟和可重复性 — 2026-10-10

同一份 240 页合成 Wiki 上维护的三轮 30 样本运行，得到匹配的 TypeScript/Rust 结果 digest，差分不匹配为零。针对生产形态、基于文件的单 query 路径，新建 Rust 子进程 IPC p50 为 16.953–17.466 ms；当前 TypeScript 为 10.653–10.865 ms，重建索引的优化 TypeScript 为 9.097–9.259 ms。Rust 比当前 TypeScript 慢约 60%，比重建索引 TypeScript 慢 86–90%，因此 profile 继续 `RETAIN_TS`，Rust enforcement 保持禁用。另一个内存五 query 批次中，Rust p50 为 7.253–7.285 ms，当前 TypeScript 为 12.113–12.197 ms；但重建索引的优化 TypeScript 为 2.983–3.016 ms，热索引为 0.508–0.513 ms。该批次不符合 Ark 每次一个 query 的生产调用形态。三轮结果一致证明这份合成语料可确定性回放，不代表生产或长时间稳定性。跨平台测量、Rust 常驻 worker 复用、子进程 CPU/RSS、取消、崩溃恢复和生产 Wiki 语料行为都尚未测量。参见[可重复性回执](../../scripts/rust-migration/knowledge-search-benchmark-repeatability-20261010.json)、[差分回放回执](../../scripts/rust-migration/knowledge-search-differential-replay-20261010.json)和[完整 benchmark 记录](../../rust-benchmark.json)。

另有一项候选 3.1.22 的只读探测选中 Workspace B，通过 `pwd` 确认位于 B，随后仍能通过绝对路径读取 Workspace A 中的 canary 文件；没有观察到写入。源码[`fs-sandbox`契约](../../packages/fs/fs-sandbox/src/index.ts)明确规定，所有模式都放行 read 和 resolve 操作，只读模式用于拒绝修改，因此当前契约允许该结果，并说明所选 Workspace 不是读取权限边界。单次未签名合成探测不能证明跨会话 Knowledge 泄漏或 verifier 管理的知识复用。参见[观察回执](../../scripts/rust-migration/candidate322-cross-workspace-isolation-20261010.json)。

<a id="current-audit--2026-10-11"></a>

<a id="当前审计--2026-10-11"></a>

## 观察快照 — 2026-10-11

本地 checkout 仍位于 `codex/ark-upstream-reliability-20260927`，HEAD 为 `e9571a5b01b2fc98d64914e3fa9b2e97feae0197`，工作树有未提交改动。最新 `git ls-remote` 确认 GitHub `origin/main` 仍为 `d382723905742f2b87401ad444d02756f5cb229b`。PR #46 仍为 OPEN/DRAFT，head 为 `69bc324a8b125b452993c00c95965afd9a478871`，与当前 checkout 分离；其 native-complete Windows 检查失败，真实 DeepSeek E2E 取消。没有将当前 checkout 的源码上传或合并。

隔离候选槽运行 Ark 3.1.23/build `2026101023`；其 base、native API 和 Jiuzhang profile patch 与当前 checkout 逐字节一致。安装回执列出 106 个 runtime 条目，并记载两次进程运行中通过 121 项 E2E 检查、失败 0 项。三次预期 Workspace 中的全新实时发票任务均符合独立精确算术，且合法最终 JSON 为 3/3。事件级审计确认，每个面向用户的最终 text 部分都使用 ASCII 双引号；截图字形不能可靠证明 Unicode 字符。耗时中位数为 16.3 秒，3.1.22 为 15.135 秒；每个候选仅三个样本，本次观察慢 1.165 秒／7.7%，不能据此得出稳定速度结论。输出、provider request、Wiki 和 Session 持久化的细节与限制见[Knowledge runtime 报告](knowledge-runtime-report.zh.md#ark-3123-live-candidate-and-output-result--2026-10-11)和[实时回执](../../scripts/rust-migration/candidate323-live-invoice-20261011.json)。

当前工作树的源码检查包括 Knowledge Wiki/tool 76 个测试文件、687 项通过；未知记录生命周期定向回归 13/13；Knowledge Wiki typecheck 和全仓 lint 通过。实时 Jiuzhang runtime 没有活动 verifier authority，观测到的实时 Wiki search 报告 authority 不可用。三个候选 Session 日志都包含完整 Zstandard frame stream，并记录到 `turn/end`；JSONL persistence service 成功检查并解码每个最终答复。正常退出并重新打开后，3.1.23 UI 恢复了最近的发票对话及答复；重开的 Session 含预期的 `session/end-seed` 边界。这只验证了一次正常重启／UI 恢复路径，不代表崩溃恢复或 verifier 管理的 Knowledge 回放。正式 `/Users/hui/ark/Ark.app` 仍为 3.1.0/build `2026092701`。Phase 6 审计的 16 项行为检查仍全为 `UNKNOWN`；候选未晋级，也未向 GitHub 发布内容。

### Verifier 配置转发源码修复 — 2026-10-11

当前源码现在通过 Native Jiuzhang 子进程环境 allowlist 转发 launcher 所有的 `ARK_KNOWLEDGE_VERIFIER_CONFIG`，并从普通 subprocess 的环境继承中清除该变量。定向 subprocess 测试通过 88/88，Jiuzhang Node 测试通过 97/97，native shell contract 全部 53/53 组到达且成功。这些检查只验证源码行为。Ark 3.1.23 仍是运行中的候选，早于本次修复；其活动 profile 仍无真实 verifier authority 配置。候选尚未根据此修复重建，因此不能声称实时学习、速度或稳定性改善。该[仅源码回执](../../scripts/rust-migration/native-verifier-config-forwarding-20261011.json)绑定实现和测试 hash。

### Rust 常驻 worker 基准 — 2026-10-11

仅供 benchmark 使用的 Rust JSONL worker 在同一份 240 页合成 Wiki 上完成三轮全新的 30 样本运行。每个 worker 处理 33 个请求并正常退出；三轮 TypeScript 差分回放全部匹配。Rust 常驻 worker 的 p50 中位数为 14.800 ms：比新建子进程的 Rust IPC 快 13.60%，但比当前 TypeScript 慢 38.46%，比每个样本重建索引的优化 TypeScript 慢 55.11%。这些数据不能证明 Rust 适合生产单 query 路径，所以继续 `RETAIN_TS`。三次有界运行成功并不证明 Ark 稳定性提升、崩溃恢复或压力可靠性。活动 Ark 3.1.23 候选未因该基准重建或改变。参见[聚合回执](../../scripts/rust-migration/knowledge-search-persistent-benchmark-20261011.json)和[Rust 迁移矩阵](rust-candidate-matrix.zh.md)。

### TypeScript 评分热路径基准 — 2026-10-11

当前 TypeScript BM25 评分路径现在会为每页同时派生 term frequency 和 document frequency，并用 set 保存标题 token 以供评分。在同一份 240 页基于文件的合成 Wiki 上，三轮全新 30 样本运行测得 p50／p95／p99 中位数为 10.289／11.973／12.332 ms。此前记录的 TypeScript 基线为 10.689／12.968／12.972 ms，观察到的降幅分别为 3.74%／7.67%／4.93%。但旧聚合没有绑定先前生产 `search.ts` 的 hash，因此这段历史差值没有与旧模块内容做加密绑定。只能视作有界源码对照，不是 Ark 全局速度声明。三轮当前运行都匹配 benchmark TypeScript reference 和 Rust replay；常驻 Rust worker 每个处理 33 条请求后正常退出。Rust p50 仍为 15.091 ms，比当前 TypeScript 慢 46.67%。另一个仅供 benchmark 的重建索引 TypeScript reference p50 为 8.836 ms，比当前路径快 14.12%；因此 profile 继续 `RETAIN_TS`，TypeScript 仍有优化空间。定向搜索／差分测试通过 16/16，Knowledge Wiki typecheck 通过。活动候选 3.1.23 早于此源码修改，因此不声称候选速度或稳定性改善。它最近观测到的发票任务中位数是 16.3 秒，相比 3.1.22 的 15.135 秒高 7.7%（每版三个样本），不足以证明稳定变化。稳定性百分比尚未建立；压力测试、崩溃恢复和长时间可靠性仍未测量，Phase 6 的 16 项行为检查仍全为 `UNKNOWN`。参见[绑定源码的当前聚合记录](../../scripts/rust-migration/knowledge-search-ts-optimization-20261011.json)及[运行回执](../../scripts/rust-migration/knowledge-search-ts-optimization-20261011-run1.json)、[运行 2](../../scripts/rust-migration/knowledge-search-ts-optimization-20261011-run2.json)和[运行 3](../../scripts/rust-migration/knowledge-search-ts-optimization-20261011-run3.json)。

### 每个根目录的 BM25 索引缓存 — 2026-10-11

当前 TypeScript 源码通过 `WikiSnapshotStore`，为每个 Wiki 根目录共享一份已准备的 BM25 索引；面向模型和公开 search 都会复用 page-token 统计，但每个请求仍会重放受治理记录并执行 verifier／ACL 检查。绑定源码 hash 的 macOS arm64／Node 24.19.0 基准使用 240 页合成 Wiki、每批五个不同 query、三轮独立运行且每轮 30 个批次。热批次 p50／p95／p99 从 48.988／53.216／54.600 ms 降至 0.559／0.696／1.528 ms，降幅为 98.86%／98.69%／97.20%；父进程 CPU 降低 98.95%。冷索引构建中位数为 9.496 ms，首个五 query 批次中位数为 11.758 ms。三轮结果差分和写入失效探测全部通过，每个热批次只构建一次索引。当前 Ark 3.1.24 候选早于缓存改动。这是合成源码测量，不代表 Ark 或生产 Wiki 端到端延迟，也不能建立总体稳定性百分比。参见[当前基准回执](../../scripts/rust-migration/knowledge-search-index-cache-current-20261011.json)和[架构说明](../../.agents/notes/implemented/architecture/2026-10-11-knowledge-search-index-cache.zh.md)。

### 缓存单 query 对照 — 2026-10-11

可复现的[基于文件的单 query 对照](../../scripts/rust-migration/knowledge-search-cache-vs-rust-reproduction-20261011.json)在同一份 240 页合成 fixture 上进行了三轮独立 30 样本测试。p50／p95／p99 中位数为：每次重读文件并重建索引的 TypeScript 10.109／11.072／11.577 ms；从已解析页面重建索引的优化 TypeScript 2.172／3.024／4.048 ms；生产 `WikiSnapshotStore.get` 热命中加评分 0.095／0.127／0.195 ms；新建子进程 Rust IPC 6.631／6.881／7.032 ms；仅供基准使用的常驻 Rust worker 4.079／4.595／5.554 ms。生产索引未命中耗时为 11.126–12.902 ms。三轮字节级差分全部匹配，所有 Rust worker 均正常退出。Rust 只比每次重读文件更快，仍慢于优化 TypeScript 和生产热缓存，而且每次 query 都会传输页面记录。1 ms 直方图分辨率下，当前 TypeScript、重建索引 TypeScript、热缓存、新建 Rust 子进程、常驻 Rust 的 event-loop delay p95 依次为 12.403／2.517／1.020／6.885／1.596 ms；样本数不均（29／29／3／29／93），仅作诊断。Rust 子进程 CPU／RSS 未计入总量。这些本地耗时不包括模型／provider 延迟、embeddings、verifier／ACL、真实 Wiki 数据或 Rust 子进程总资源；不能证明 Ark 端到端提速或 runtime 稳定性。Rust 仍禁用，生产决策为 `RETAIN_TS`。

### Ark 3.1.24 同题实时复测 — 2026-10-11

隔离的 Ark 3.1.24/build `2026101124` 候选在两次进程运行中通过 121 项安装态 E2E 检查，失败为 0。Jiuzhang Node 测试通过 97/97，53 组 native shell contract 检查全部通过。候选使用临时测试签名，未 notarize；正式 Ark 仍为 3.1.0/build `2026092701`。

三次全新的只读对话使用相同发票 Workspace、prompt、标准模式和 `deepseek-official / deepseek-v4-flash / max`。候选端到端耗时为 15.775、13.895 和 10.681 秒，中位数 13.895 秒；3.1.23 同题基线分别为 13.686、16.286 和 19.816 秒，中位数 16.286 秒。小样本显示中位耗时降低 2.391 秒／14.68%，但无法分离源码变化、模型／provider 波动或工具轨迹差异，所以不能证明可重复且由源码导致的 Ark 提速。两个候选的独立精确算术和严格最终 JSON 都是 3/3，没有显示任务成功率提升。最终存储事件为 `turn/end` 的情况，候选是 3/3、基线是 2/3；这是小样本的事件边界信号，不代表整体稳定性百分比。

这项发票任务没有测试 Knowledge 学习或跨对话复用；活动候选 profile 未配置 verifier authority。压力测试、崩溃恢复和长时间可靠性仍未测试。Phase 6 的 16 项行为检查仍为 `UNKNOWN`，正式晋级保持 `HOLD`。参见[同题实时审计回执](../../scripts/rust-migration/candidate324-live-invoice-20261011.json)、[安装态 E2E 回执](../../scripts/rust-migration/candidate324-installed-e2e-20261011.json)和[三张运行截图](/Users/hui/ark-test/evidence/candidate324-live-invoice-20261011/run1-final.png)。

### Knowledge 内容规范门控 — 仅源码检查 — 2026-10-11

当前源码要求普通模型搜索、页面读取、文件列表、图谱和修复来源读取都满足 `lifecycle: canonical`，并保留既有 verifier、scope、ACL、新鲜度、冲突、confidence 和 utility 检查。已签名但未晋级的候选不会进入模型内容面；独立的 review-metadata 面仍可用于治理。由于语义验证本身不能证明观察到的复用或效用，且没有单独的 measured-trial receipt reader，Canonical Promote、Merge、Replace 和 Deduplicate 也会失败关闭；Archive 保留认证 WAL 和恢复路径。回归覆盖了候选正文排除、规范读取、规范操作拒绝和 Archive 回滚。重新运行全部 Knowledge Wiki/tools 测试通过 76 个文件／693 项；两个 package typecheck 通过。只读 run context 对 44 份当前证据计算 hash，没有缺失项；验收审计记录 artifact completeness 为 `PASS`、16 项行为检查均为 `UNKNOWN`。这些是仅源码变更：3.1.24 候选包不含这些改动。`2026-10-10T23:38:18Z` 的本地进程扫描没有发现候选 app、runtime 或 API runner 进程，候选 bundle 仍在隔离槽。正式 Ark 未改，记录中的启动没有 verifier authority，Phase 6 的 16 项检查仍全部为 `UNKNOWN`。参见[规范内容回执](../../scripts/rust-migration/knowledge-canonical-content-gate-20261011.json)、[实测试用拒绝回执](../../scripts/rust-migration/knowledge-measured-trial-gate-20261011.json)和[最新本机进程观察](../../scripts/rust-migration/candidate324-process-observation-20261011.json)。

### 源码已接入认证的实测试用读取器 — 2026-10-11

当前源码接受一个可选的、由 launcher 所有的 `knowledgeWikiMeasuredTrialReader`，并增加 `recordCandidateMeasuredTrial` RPC。它会把签名且内容寻址的试验结果绑定到独立试用 authority、语义 verifier 回执、review／候选／操作，以及当前目标字节。只有该操作的实测 utility 为正时，才会开放对应规范 review 操作。提交会写入回执中冻结的精确目标字节；sealed promotion 与崩溃恢复会重新验证认证回执及字节 hash。authority 缺失、状态过期、目标字节不匹配或回执无效时仍失败关闭，既有 review RPC 请求／响应形状保持不变。

定向回归通过 71/71 项；Wiki/tools 整包此前通过 78 个文件／717 项，两个 package typecheck 均通过。这只是源码证据。Jiuzhang profile 现在会把 launcher 专用公钥与 artifact-root 配置映射到服务，但当前活动启动没有传入受信值，因此实时规范操作仍被阻止。新增配置与文件 resolver 回归通过 34/34 项；Jiuzhang Node runtime 测试通过 24/24 项。接入后重新运行全部 Wiki/tools 套件，通过 78 个文件／719 项。Ark 3.1.25/build `2026101125` 正在运行；暂存的 3.1.26/build `2026101126` 早于本次改动。正式 Ark 仍为 3.1.0/build `2026092701`；尚未上传 GitHub 或晋级。验收审计仍为 0 项 PASS／16 项 UNKNOWN。参见 [Knowledge Wiki 实现](../../packages/host/knowledge-wiki/src/reviews.ts)和[服务回归测试](../../packages/host/knowledge-wiki/tests/verification.spec.ts)。
