# Phase 0 active profile matrix

[English](profile-matrix.md) | 中文

**Sources compared:** checked-out `integrations/jiuzhang/profile`, `packages/bundle/base/cordis.patch.yml`, `packages/bundle/native-api-app/cordis.patch.yml`, installed product `/Users/hui/Library/Application Support/Ark/Harness/profiles/jiuzhang`, and packaged runtime `/Users/hui/ark/Ark.app/Contents/Resources/runtime/jiuzhang/profile`. Profile rows are loader patches; later rows replace a matched row's whole config.

**已审计快照：** 源码 patch、正在运行的干净75候选 profile 和隐藏的干净930候选产物于2026-10-08接受审计。[隐藏315](../../scripts/rust-migration/evidence/candidate-native-build-93040bb5.json) 的隔离 home 为空，尚未安装 runtime 或配置模型。正式与活动候选 home 保持分离；两份活动 profile 均未启用 Rust 搜索或独立 verifier authority。正在运行的75 app 不包含隐藏315中的召回修复。

## 源码 profile 配置与声明行为

| Capability | dsh-base | native-api-app | jiuzhang profile overlay (active product) | Effective result |
| --- | --- | --- | --- | --- |
| Session persistence | `session-persistence-jsonl`, root `dshHomePath('sessions')` ([`base/cordis.patch.yml:105-108`](../../packages/bundle/base/cordis.patch.yml)) | inherited | no override | **Enabled**; append-only per-session JSONL/Zstandard frames. |
| Session query | SQLite `path: ':memory:'`, `openAt: never` ([`base/cordis.patch.yml:116-128`](../../packages/bundle/base/cordis.patch.yml)) | inherited | same override `path: ':memory:'`, `openAt: never` ([`integrations/jiuzhang/profile/cordis.patch.yml:40-43`](../../integrations/jiuzhang/profile/cordis.patch.yml)) | **Mounted exact reads/filters/traces; full-text search disabled and SQLite never opened.** |
| Projection cache | absent | `session-projection-cache`, `writeEveryEvents: 200`, `writeIntervalMs: 5000` ([`native-api-app/cordis.patch.yml:96-100`](../../packages/bundle/native-api-app/cordis.patch.yml)) | no override | **Enabled**; durable `session_projcache` JSON storage with mandatory create/turn-end/dispose writes. |
| Knowledge Wiki owner | absent | inserts `knowledge-wiki` with empty `wikiRoot/mainRoot`, `credential: ''`, v4-flash ([`native-api-app/cordis.patch.yml:117-124`](../../packages/bundle/native-api-app/cordis.patch.yml)) | replaces with env roots, `credential: DEEPSEEK_API_KEY`, `ownedStageExecutor: true` ([`jiuzhang/profile/cordis.patch.yml:27-34`](../../integrations/jiuzhang/profile/cordis.patch.yml)) | **Active product uses env-bound roots and owned worker; both rows use the current Config vocabulary.** |
| Rust search candidate | no override | default-disabled candidate fields | no override | **Disabled in the active product; production search remains TypeScript.** |
| Independent verifier | absent | absent | no `knowledgeWikiVerifierAuthority` provider row | **Unavailable at baseline**; launcher-owned adapter exists but is not composed, so candidate verification returns an explicit blocker. |
| Knowledge tools | absent | absent | inserts `tool-knowledge-wiki` ([`jiuzhang/profile/cordis.patch.yml:36-38`](../../integrations/jiuzhang/profile/cordis.patch.yml)) | **Enabled** in Jiuzhang; unavailable in native bundle without this overlay. |
| Telemetry | base mounts OTel disabled by default/config ([`base/cordis.patch.yml:136-169`](../../packages/bundle/base/cordis.patch.yml)) | inherited | explicitly `disabled: true` ([`jiuzhang/profile/cordis.patch.yml:45-46`](../../integrations/jiuzhang/profile/cordis.patch.yml)) | **Disabled.** |
| Product roots | launcher sets `ARK_MAIN_ROOT` and `ARK_WIKI_ROOT` from product data locations ([`integrations/jiuzhang/native/Sources/JiuzhangShellCore/ShellContract.swift:232-260`](../../integrations/jiuzhang/native/Sources/JiuzhangShellCore/ShellContract.swift)) | no own root | overlay consumes those env vars | **Knowledge data is product-owned, outside source checkout.** |

## Source/profile/install consistency

- [当前只读 hash](../../scripts/rust-migration/profile-byte-drift.json) 显示三份 package manifest 相同，但源码 patch 与正式包及已安装产品 patch 不同：源码多了 verifier-config 绑定。不能把源码组合当成已安装产品行为。
- 正式产品 profile 包含 `@deepseek-ai/dsh-native-api-app`，但其 patch 与源码不同。过期的通用 `/Users/hui/.dsh/profiles/jiuzhang/` 只含 `@deepseek-ai/dsh-base` 和空 patch，不是原生 launcher 选定的产品 Harness home。
- [干净75候选证据](../../scripts/rust-migration/evidence/candidate-native-build-75f8050d.json) 将 `/Users/hui/ark-test/candidate-home-75f8050d/profiles/jiuzhang/` 绑定到打包源码 patch `525559a9…`，与正式 `b24765d0…` patch 分离。复用用户在旧候选输入的选定凭据保留 `deepseek-official / deepseek-flash / max` 及完整配对配置，不能由此获得 verifier authority 或真实任务成功结论。
- `packages/host/knowledge-wiki/src/index.ts:144-155` validates `credential`; the native API bundle now supplies `credential: ''`, so its standalone composition uses the current Config vocabulary and disables optional embeddings until a credential is configured.
- Product `settings.yaml` currently selects `deepseek-official/deepseek-flash` with `reasoningEffort: max`; this is user settings, not a Knowledge Wiki config. The profile overlay's Wiki LLM defaults remain `deepseek-reasoner` unless settings/provider resolution changes them.

## Session backend decision

The active profile has **JSONL persistence enabled**, **projection cache enabled**, and **SQLite query indexing mounted but disabled**. This is intentional in the base patch: `openAt: never` preserves `ctx.sessionQuery` exact reads and traces while `searchSessions`/`searchEvents` fail closed as `SESSION_QUERY_SEARCH_DISABLED` and SQLite is not imported/opened ([`packages/session-query/session-query-sqlite/src/index.ts:85-103`](../../packages/session-query/session-query-sqlite/src/index.ts), [`:251-255`](../../packages/session-query/session-query-sqlite/src/index.ts)). Enabling content search requires a later profile override to `first-search`/`startup` and a durable path, per base comments ([`base/cordis.patch.yml:116-128`](../../packages/bundle/base/cordis.patch.yml)).

## Drift actions

1. Update `docs/knowledge-wiki.md` to the current service/schema and label the old JSONL/vector contract historical.
2. Keep the native API bundle's `credential` key covered by profile composition and native preset runtime checks.
3. Keep `session-query-sqlite` disabled until a benchmark and durable index ownership decision exists; do not infer search availability from the row being mounted.
4. Keep the stale `/Users/hui/.dsh` profile out of runtime claims; product launch identity is `JIUZHANG_DSH_HOME`/`DSH_HOME` and the native data-root checks in `runtime.mjs:946-965`.
