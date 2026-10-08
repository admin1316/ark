# Phase 0 knowledge/runtime report

[English](knowledge-runtime-report.md) | 中文

**已审计快照：** 源码发现已按 checkout 提交 `32bb727505bce1c403b362cb82fcefd40dffa6d7`，审计日期为 2026-10-08。运行时观察区分隔离候选 Ark 与未修改的正式包；此前的 `02bf7ebc7f973b35e298bcd4121199f0ab81683c` 和 `b8adf5a7ec` 仅是历史证据，不能作为当前源码身份。

[当前 profile 字节比较](../../scripts/rust-migration/profile-byte-drift.json) 记录了 source/artifact drift。运行观察只能归属其记录的 app/source 版本，不能作为当前源码 Native 行为的验收证据。

## What the model can actually see

The active source has no automatic Knowledge Wiki recall section. `tool-knowledge-wiki` adds a short system-prompt instruction to use `wiki_search`, `wiki_read`, `wiki_files`, `wiki_graph`, `wiki_reviews`, `wiki_verify_candidate`, and `wiki_ingest` ([`packages/host/knowledge-wiki-tools/src/index.ts:64-69`](../../packages/host/knowledge-wiki-tools/src/index.ts)). A model sees Wiki content only when it calls the registered tools; `wiki_search` returns ranked paths and `wiki_read` reads a requested path ([`index.ts:71-165`](../../packages/host/knowledge-wiki-tools/src/index.ts)). There is no `knowledge-wiki-recall` section, no profile/reflection selector, and no code that injects latest knowledge into each provider request in the audited package.

服务的受治理 model 方法现在要求真实 session `cwd`/project scope 和 verifier authority；只有通过 record gate 后，`modelSearch()` 与 `modelPageContent()` 才会增加 retrieval utility（见 [`packages/host/knowledge-wiki/src/index.ts`](../../packages/host/knowledge-wiki/src/index.ts)）。`recordKnowledgeOutcome()` 更新 utility 及其事件日志（见 [`index.ts:707-835`](../../packages/host/knowledge-wiki/src/index.ts)）。Wiki 工具会先把 source hash、authority、trust、evidence、freshness、conflict provenance 写入 session 的 `knowledge/retrieved`，再把 `tools/result` 的最终渲染内容原样写入 `knowledge/injected`（见 [`packages/host/knowledge-wiki-tools/src/index.ts`](../../packages/host/knowledge-wiki-tools/src/index.ts)、[`session-events.ts`](../../packages/host/knowledge-wiki-tools/src/session-events.ts)）。因此回放既能重建模型看到的工具值，也能绑定其受治理来源；未受 scope 约束的逐步自动 recall 仍然关闭。

## Write/verification path

| Stage | Current evidence | Status |
| --- | --- | --- |
| Observe | `summarizeSession()` reads `sessionQuery.readSession(sessionId)` when `agent/disposed` fires ([`packages/host/knowledge-wiki/src/index.ts:296-323`](../../packages/host/knowledge-wiki/src/index.ts)). | Session-level only; no per-turn observer. |
| Candidate | LLM summary writes `_candidates/{topics,reflections,incidents}` and appends `.llm-wiki/review.json` ([`index.ts:326-397`](../../packages/host/knowledge-wiki/src/index.ts)). | Enabled if stage executor and project target pass. |
| Provenance / hash | Candidate reviews contain candidate hash; verifier types include source identity/build digest and review hash ([`packages/host/knowledge-wiki/src/types.ts:78-129`](../../packages/host/knowledge-wiki/src/types.ts)). | Present for candidate review lane. |
| Independent verification | `verifyCandidate()` requires injected `knowledgeWikiVerifierAuthority`, persists a receipt, then binds it to the review ([`index.ts:1225-1257`](../../packages/host/knowledge-wiki/src/index.ts)). | No production authority provider found at baseline; explicit authority-unavailable blocker. |
| Review / promotion | `resolveReview(s)` calls advisory resolution or `applyCandidateReview()` ([`index.ts:1264-1318`](../../packages/host/knowledge-wiki/src/index.ts)). | Explicit action; canonical changes are governed. |
| Utility | 受治理的 retrieval/outcome 计数解析为已接纳的知识 ID，并由日志回放；`.llm-wiki/knowledge-utility.json` 是展示投影（见 [service](../../packages/host/knowledge-wiki/src/index.ts)）。 | 源码行为已测试；UI 反馈和 verifier 检查通过不证明独立 trial 收益或 utility lift。 |
| Expiry/conflict/rollback | `KnowledgeRecord` fields and `knowledge-governance.ts` transitions enforce expiry, scope, ACL, conflicts, downgrade, promotion, and rollback. | **Implemented with focused replay/gate tests.** |

The old auto-sediment module contains reusable turn extraction/page builders, but the service does not register its advertised `agent/turn-stopping` listener. Its own comments say turn-level Markdown is disabled ([`packages/host/knowledge-wiki/src/auto-sediment.ts:1-14`](../../packages/host/knowledge-wiki/src/auto-sediment.ts), [`index.ts:291-300`](../../packages/host/knowledge-wiki/src/index.ts)). Unit tests exercise these pure helpers, which is not evidence of production registration.

## Session persistence/query/cache runtime

- JSONL is the active durable event authority. The base profile mounts it under `dshHomePath('sessions')` ([`packages/bundle/base/cordis.patch.yml:105-108`](../../packages/bundle/base/cordis.patch.yml)). The provider stores one append-only file per session with checksummed Zstandard frames by default and lossless packed delta rows ([`packages/session/session-persistence-jsonl/src/index.ts:1-6`](../../packages/session/session-persistence-jsonl/src/index.ts), [`:64-88`](../../packages/session/session-persistence-jsonl/src/index.ts)).
- The SQLite query provider is mounted with `path: ':memory:'`, `openAt: never` in both base and Jiuzhang overlays ([`base/cordis.patch.yml:124-128`](../../packages/bundle/base/cordis.patch.yml), [`integrations/jiuzhang/profile/cordis.patch.yml:40-43`](../../integrations/jiuzhang/profile/cordis.patch.yml)). Its code explicitly leaves exact reads/filters/traces available while disabling full-text search and avoiding SQLite open/import ([`packages/session-query/session-query-sqlite/src/index.ts:85-103`](../../packages/session-query/session-query-sqlite/src/index.ts), [`:251-255`](../../packages/session-query/session-query-sqlite/src/index.ts)).
- Native API mounts the projection cache with count/interval triggers 200 events/5000 ms ([`packages/bundle/native-api-app/cordis.patch.yml:96-100`](../../packages/bundle/native-api-app/cordis.patch.yml)). The cache is derived, fail-soft, identity-bound, and mandatory at session creation, `turn/end`, and disposal ([`packages/session/session-projection-cache/src/index.ts:1-16`](../../packages/session/session-projection-cache/src/index.ts), [`:41-75`](../../packages/session/session-projection-cache/src/index.ts), [`:220-270`](../../packages/session/session-projection-cache/src/index.ts)).

## Runtime evidence inspected

1. **Production Harness** `/Users/hui/Library/Application Support/Ark/Harness`: profile overlay and bundle list match the source; `settings.yaml` selects DeepSeek official/flash with max reasoning; 16 projection-cache rows exist under `storages/session_projcache/sessions/`. Rows include session stats, model selection, title, token usage, context pressure, goals, and seq watermarks; one example had seq `155930`, 3 turns, 153 steps, 158,460 output tokens and 26,989,696 cache-read tokens. These are metadata counters only; no message content is reproduced here. The sibling production `Knowledge` root contains only purpose/schema/index/log and a workspace registry, with no candidate pages or utility file.
2. **Production session files:** the corresponding `Harness/sessions` tree currently has only `~locks`/`~delete` directories and no `session.jsonl.zstd` files. Thus current disk evidence proves projection-cache records existed but does not provide a replayable event log for those rows. This is a material recovery/replay gap to investigate, not proof that deletion is incorrect.
3. **Isolated candidate runtime** `/Users/hui/ark-test/candidate-home-2026092701`: two synthetic JSONL/Zstandard logs exist (about 1.6 MiB and 48 KiB) and two projection rows exist; `Knowledge/wiki` contains only `index.md` and `log.md`, with no generated candidate pages. Provider logs in `/Users/hui/ark/releases/2026092701/evidence/provider-live-v3.jsonl` show a listening synthetic provider and streamed `ARK_SYNTH_BURST` requests; `/Users/hui/ark/releases/2026092701/REPORT.md` records 19,993-event/169-event synthetic session replay and the final UI/provider markers. These are synthetic reliability evidence, not proof of Knowledge Wiki writes or automatic recall.
4. **候选 Ark 实时 smoke（2026-10-08）** `/Users/hui/ark-test/candidate-20261008/Ark.app` 使用隔离 home `/Users/hui/ark-test/candidate-home-20261008` 运行。带认证的 loopback `knowledgeWiki/search` 返回了预置候选页面，carrier/domain 结果正常。这证明候选 Ark 的原生 TypeScript 路径在隔离数据下可用。记录明确标注 `mode: typescript-authoritative`、`rustShadowInvoked: false`：原生路由不会调用模型/工具 Rust seam，而且该候选 home 没有配置模型。因此它不是 Rust 性能或正式验收结果。凭据为 `/Users/hui/ark-test/candidate-ark-20261008-live-baseline.json`。
5. **候选 Ark 模型/工具 shadow smoke（2026-10-08）** 同一个候选 app 使用本地 DeepSeek 兼容 mock SSE provider 和独立隔离 home 运行，治理 event log 使用了匹配的项目路径。真实 `wiki_search` 工具调用触发了 Rust wrapper；wrapper 以 `0` 退出，返回两条预置命中，请求摘要一致，Rust 结果摘要也与独立 TypeScript BM25 摘要完全一致。修正版凭据为 `/Users/hui/ark-test/candidate-ark-20261008-rust-model-shadow-smoke-scoped.json`，源码提交为 `9563cbe8801c847ac51a376929bc8cdc149d37ac`，Rust 二进制 SHA-256 为 `6c35da217bb5f5b207e10a38f1d8cdbe805ab43746b06500c25791bd94bd81fa`。该 smoke 证明候选功能调用和字节一致，不证明提速或正式验收。

## Drift and required follow-up

接纳专项审计发现未签名内容可以直接成为 verified、后续 seal 会替先前未签名记录背书、canonical 字节没有绑定，以及 page-ID/candidate-ID 计数分离。源码修复强制保守接纳、认证完整记录 identity、检查模型投影实际字节，并从日志派生受治理 utility。确定性回归 fixture 覆盖这些缺陷，但不能替代当前源码 Native UI 或独立学习验收；机制由 [governance 决策](../../.agents/notes/implemented/architecture/2026-10-07-knowledge-governance-and-rust-evidence.zh.md) 负责。

评估者独立性仍未证明：adapter 让 launcher 接收匹配的私钥、普通检查通过会转换为 trial success、UI 结果缺少独立实测的 use receipt。尽管 JS launcher 会转发，Native parent 没有配置 `ARK_KNOWLEDGE_VERIFIER_CONFIG`；acceptance CLI 也没有外部配置的 trusted key。这些都是未解决的验收条件，本地测试密钥或 synthetic provider 运行不能把它们变成已验证的学习证据。

- The old docs' claim that every turn creates conversation/profile/reflection entries and every model step receives recalled profiles/reflections is contradicted by source and runtime artifacts. Mark it **DRIFT: confirmed**.
- Review is implemented and mounted, but the independent verifier authority is not provided by the baseline production composition (only tests provide it). The release profile has no verified promotion path until that owner is composed. Candidate lifecycle, project audit, and session retrieval/injection events are implemented; generic per-step recall is not enabled. Mark **PARTIAL / VERIFIER BLOCKED**.
- Session durability is JSONL plus projection cache; SQLite query search is intentionally disabled. Mark **CONFIRMED** and do not benchmark SQLite search as active until `openAt` changes.
- Model request evidence exists in synthetic provider logs and production projection counters, but no captured request payload currently demonstrates Wiki content injection. Mark **NOT VERIFIED** for “knowledge injected in every model step.”
- Maintain the replay tests and run the learning evaluator on independently verified paired outcomes before claiming a utility or smartness lift. Keep candidates below canonical trust until independent verification and review complete.

## Current Rust candidate seam

The working tree now exposes an optional, default-disabled Rust search candidate in `KnowledgeWikiService`. Shadow mode is observational: it sends a bounded immutable page/query DTO to an isolated child process, checks the input and result digests plus canonical BM25 equality, and keeps the TypeScript result. Candidate failures, cancellation, timeout, or divergence fall back to TypeScript. Enforce mode is deliberately rejected until Rust covers the complete hybrid BM25-plus-embedding contract. This seam is testable in a candidate profile, but the active Ark profile remains TypeScript-only and the acceptance audit remains `UNKNOWN` without production-boundary receipts.

当前工作树还包含带有子进程签名结果和晋级 seal 的 launcher-owned external verifier adapter。profile 只暴露 launcher-owned 的 `knowledgeVerifierConfig` 接缝，活动值为空，因此当前产品的 candidate verification 仍明确不可用；隔离 service fixture 已证明子进程绑定路径，但不宣称 production acceptance。
