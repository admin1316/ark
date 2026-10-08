# Phase 0 active profile matrix

English | [中文](profile-matrix.zh.md)

**Sources compared:** checked-out `integrations/jiuzhang/profile`, `packages/bundle/base/cordis.patch.yml`, `packages/bundle/native-api-app/cordis.patch.yml`, installed product `/Users/hui/Library/Application Support/Ark/Harness/profiles/jiuzhang`, and packaged runtime `/Users/hui/ark/Ark.app/Contents/Resources/runtime/jiuzhang/profile`. Profile rows are loader patches; later rows replace a matched row's whole config.

**Current snapshot:** source/profile comparisons were refreshed against checkout commit `2d8923344bf5f0101f3eb76a056434b5a78aef3e` on 2026-10-08. The earlier `b8adf5a7ec` references are historical only. The active production profile remains separate from the candidate profile and does not enable the Rust search candidate or verifier authority.

## Profile rows and effective behavior

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

- `integrations/jiuzhang/profile/package.json` and `cordis.patch.yml` match the packaged app runtime copies byte-for-byte (SHA-256 above). This is a positive source-to-artifact check.
- The active product profile at `/Users/hui/Library/Application Support/Ark/Harness/profiles/jiuzhang/` matches the source overlay and includes `@deepseek-ai/dsh-native-api-app`. The stale generic `/Users/hui/.dsh/profiles/jiuzhang/` currently contains only `@deepseek-ai/dsh-base` and an empty patch; it is not the product Harness home selected by the native launcher. Treat it as an unrelated/stale dev profile, not active Ark state.
- `packages/host/knowledge-wiki/src/index.ts:144-155` validates `credential`; the native API bundle now supplies `credential: ''`, so its standalone composition uses the current Config vocabulary and disables optional embeddings until a credential is configured.
- Product `settings.yaml` currently selects `deepseek-official/deepseek-flash` with `reasoningEffort: max`; this is user settings, not a Knowledge Wiki config. The profile overlay's Wiki LLM defaults remain `deepseek-reasoner` unless settings/provider resolution changes them.

## Session backend decision

The active profile has **JSONL persistence enabled**, **projection cache enabled**, and **SQLite query indexing mounted but disabled**. This is intentional in the base patch: `openAt: never` preserves `ctx.sessionQuery` exact reads and traces while `searchSessions`/`searchEvents` fail closed as `SESSION_QUERY_SEARCH_DISABLED` and SQLite is not imported/opened ([`packages/session-query/session-query-sqlite/src/index.ts:85-103`](../../packages/session-query/session-query-sqlite/src/index.ts), [`:251-255`](../../packages/session-query/session-query-sqlite/src/index.ts)). Enabling content search requires a later profile override to `first-search`/`startup` and a durable path, per base comments ([`base/cordis.patch.yml:116-128`](../../packages/bundle/base/cordis.patch.yml)).

## Drift actions

1. Update `docs/knowledge-wiki.md` to the current service/schema and label the old JSONL/vector contract historical.
2. Keep the native API bundle's `credential` key covered by profile composition and native preset runtime checks.
3. Keep `session-query-sqlite` disabled until a benchmark and durable index ownership decision exists; do not infer search availability from the row being mounted.
4. Keep the stale `/Users/hui/.dsh` profile out of runtime claims; product launch identity is `JIUZHANG_DSH_HOME`/`DSH_HOME` and the native data-root checks in `runtime.mjs:946-965`.
