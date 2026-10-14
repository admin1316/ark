---
description: "万相织鉴 host knowledge engine — the in-process engine behind the concept-graph tab."
kind: "package-reference"
---

# @deepseek-ai/dsh-knowledge-wiki

English | [中文](README.zh.md)

## Summary

万相织鉴 host knowledge engine — the in-process engine behind the concept-graph tab. Owns the wiki page tree (graph + Louvain communities), hybrid search (BM25 + optional embeddings), page editing, a two-stage LLM ingest pipeline with a persisted queue, review items, and deep research, all inside the harness. The LLM Wiki desktop app is not involved.

## Table of Contents

- [Configuration](#configuration)
- [Durable state (.llm-wiki/)](#durable-state-llm-wiki)
- [Behavior](#behavior)
- [Candidate measured-trial review](#candidate-measured-trial-review)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration

| key | meaning |
|---|---|
| `wikiRoot` | Absolute path of the project wiki directory (contains concepts/, entities/, sources/, index.md, log.md). |
| `mainRoot` | Main workspace root (fixed, non-removable); defaults to the wiki root's parent. |
| `credential` | Credential reference for semantic embeddings and image descriptions; an empty value disables embedding calls. |
| `llmProvider` | LLM provider id for ingest/research (default `deepseek-official`). |
| `llmModel` | LLM model id for ingest/research. |
| `llmBaseUrl` | Chat-completions endpoint used by the owned stage executor (default `https://api.deepseek.com`). |
| `llmCredential` | Credential reference for ingest/research; empty uses the selected provider's declared environment reference. |
| `ownedStageExecutor` | Enables the bounded owned worker for ingest/research (default `false`). |
| `knowledgeSearchCandidateMode` | Optional Rust search candidate mode: `disabled` (default), `shadow` (observe only), or `enforce` (fail closed until the full hybrid contract is verified). |
| `knowledgeSearchCandidateBinary` | Absolute path to the isolated Rust candidate binary. It is unused while the mode is `disabled`. |
| `knowledgeSearchCandidateTimeoutMs` | Per-query candidate timeout in milliseconds (default `30000`, bounded to `1..120000`). |
| `knowledgeVerifierConfig` | Launcher-only JSON containing the verifier authority id, executable, Ed25519 public key, source identity, and optional arguments and timeout; `privateKey` is rejected. A nonempty value requires managed `ctx.subprocess` plus the Context service `knowledgeWikiVerifierAuthority` with a matching id and typed `sealPromotion` method. The adapter retains the public key for verification and checks delegated seals against it before returning. A mismatched valid public key is rejected on first seal. `timeoutMs` bounds verifier subprocess execution only. Signing receives caller and project cancellation signals, but its owner controls deadlines and process-tree exit. The empty default keeps verification unavailable; Wiki files cannot provide this value. |
| `knowledgeMeasuredTrialConfig` | Launcher-only JSON with distinct evaluator and journal-signer Ed25519 SPKI public keys plus an absolute artifact-store root. The store resolves lowercase SHA-256 filenames as read-only unique ordinary files, capped at 16 MiB each. The empty default disables measured-trial gating; private keys and extra fields are rejected. |

The Jiuzhang launcher maps `ARK_KNOWLEDGE_MEASURED_TRIAL_CONFIG` into this option and the Native shell forwards only that explicit variable. Public trust anchors must come from an independent evaluator and promotion-journal owner; this wiring does not create or provision authorities. A directly injected `knowledgeWikiMeasuredTrialReader` Context service remains supported for hosts that own their own reader. Without trusted configuration, measured-trial registration and canonical review actions fail closed.

```yaml
- id: knowledge-wiki
  name: '@deepseek-ai/dsh-knowledge-wiki'
  config:
    wikiRoot: '/absolute/path/to/project/wiki'
    mainRoot: '/absolute/path/to/project'
    credential: DEEPSEEK_API_KEY
    llmProvider: 'deepseek-official'
    llmModel: 'deepseek-v4-flash'
    ownedStageExecutor: true
    knowledgeSearchCandidateMode: disabled
    knowledgeSearchCandidateBinary: '/absolute/path/to/knowledge-search-shadow'
    knowledgeSearchCandidateTimeoutMs: 30000
```

## Durable state (.llm-wiki/)

- `ingest-cache.json` — flat `{ identity: sha256 }` map, written only after a successful ingest so failed tasks retry.
- `ingest-queue.json` — pending/running tasks persisted; restored on service start.
- `review.json` — bounded JSON array of review items, keyed by deterministic ids and read and written through one UTF-8 byte-limit owner.
- `workspaces.json` — registered secondary workspaces.

## Behavior

- Sources under `raw/sources/` are scanned every 60s; changed files are enqueued for two-stage ingest. A failed ingest (LLM error, zero pages written) enters a 60-minute cooldown and never poisons the cache.
- The summary page for a source is forced onto the deterministic slug contract (`12-ark-sessions--32-…--<fnv32 base36>.md`), matching the existing corpus.
- Generated pages are sanitized, date-stamped, canonicalized (`sources` field), and merged with any existing page: pages owned only by this source are replaced whole; shared pages keep their body and union their `sources`.
- Deterministic fallbacks run regardless of model output shape: index entry, log entry, source summary page, review items.
- With `ownedStageExecutor`, a deadline or owner cancellation aborts the stage and waits for every registered worker join to settle before returning. A join that never settles keeps the operation pending; pre-worker connection resolution and opaque provider termination are not proven quiescent.
- [Durable file removal](src/filesystem.ts) treats a missing target as a no-op only after finding directory ancestry. Non-directory ancestors and inspection failures remain errors; missing-ancestor lookup terminates at the filesystem root. Final-target no-follow, unique-file and inode checks remain in the removal operation.

### Search index reuse

BM25 token and document frequencies are prepared once per Wiki root and reused by distinct search queries through the existing `WikiSnapshotStore`. Canonical writes and the external file watcher invalidate the root's derived search index with the other snapshots. Wiki files remain the source of truth. The service still replays Knowledge governance and applies model-scope access checks on every request; a cached index does not cache authorization.

### Automatic session summaries

On `agent/disposed`, the host may summarize a root session into an untrusted topic, incident, or reflection Candidate in its non-main workspace. The complete session-query snapshot must match the requested session id, contain no origin or parent lineage, have delegation depth zero or absent, and log an explicit `workspace-write` or `danger-full-access` mode. The latest logged file mode decides eligibility; `read-only` or missing policy skips the stage, and approval mode does not substitute for file policy. Child findings remain in the parent's conversation rather than producing an independent automatic page.

After the summary stage, the host rereads the session and requires the same eligibility, cwd, file mode, event count, and extracted conversation before the first write. Cancellation refuses publication. A reader or writer failure remains best-effort and cannot block agent disposal. This check is not an atomic file transaction or a per-file task authorization; the [owning decision](../../../.agents/notes/implemented/architecture/2026-10-12-session-summary-admission.md) records that limit.

### Correcting previously used knowledge

The correction RPC rejects malformed project, workspace, or session fields before resolving paths or reading a session. A non-empty project and session are required; rejected inputs cannot publish a Candidate or revoke the source. It captures the flat proposal and access fields before validation and the asynchronous authorization read. The input owner validates the NFC-normalized, whitespace-collapsed rule once before reading the session; authorization compares that value while the Candidate retains the original trimmed text. Later edits to caller-owned objects cannot change the rule being authorized, consume another session's full-read capability, or move correction provenance to that other session.

When a user corrects a Wiki-backed answer, the model-facing `wiki_propose_repair` flow can stage the corrected rule as an untrusted Candidate. It is accepted only after the same session reads the complete, verified source page with `wiki_read` and the replayable session log confirms the matching tool call quoted the exact rule from that turn's direct user message. The service keeps a one-use, process-local capability bound to that session, source path, and content hash for up to 15 minutes; pages over the shared 8000-character read limit cannot authorize repair. Full reads purge expired capabilities, refresh that session's entry, and evict the oldest entry at the 256-entry limit. A durably appended rejection event revokes the old source before corrected feedback and Candidate publication; if that first append fails, the operation cannot claim the source was revoked. Later feedback or Candidate failures leave a successful rejection in force. External damage or removal of the lifecycle log is outside this persistence guarantee. The correction remains unusable until independent verification and an explicit Replace review succeed. This stages a correction; it does not by itself prove that a model will reuse it in a later conversation.

The authorizing tool call must follow the latest logged `turn/start`. A later turn invalidates earlier correction calls even if its numeric turn id is reused; a malformed latest turn header cannot authorize a repair. An unreadable latest direct human message refuses authorization instead of borrowing an earlier rule. The real session-query provider also rejects malformed message bodies during complete-log replay before Wiki authorization. A source replacement requires a new full read of the currently authenticated bytes. After reading session authorization, the writer rechecks workspace registration, path confinement, current admission, record identity, and source bytes before consuming the capability; a concurrent removal, revocation, or replacement refuses the write.

### Utility feedback

Each distinct journaled `knowledge/retrieved` event allows at most one correction signal for its page. A standalone `successful` report returns zero and cannot increment `successfulUses` or create positive utility; legacy success events and JSON projections do not receive retrospective credit. `knowledgeUtility()` derives retrieval and correction counts from the lifecycle journal and reports no successful-use credit until an authenticated paired trial is available. The complete utility JSON projection is checked by UTF-8 byte length against its existing 5 MiB consumer limit before corresponding lifecycle writes. During repair, computed expiry remains unpersisted until the final projection fits; the owner then persists expiry and revalidates the authenticated source before revocation. After rejection and corrected-feedback events are appended, authenticated replay must confirm the source identity, rejected lifecycle, and utility counters before the projection or Candidate is written. Before ordinary model-facing access, verified records with at least three retrievals and utility at or below zero are marked expired in the journal; pending Candidates are not retired by this rule. See the [governance decision note](../../../.agents/notes/implemented/architecture/2026-10-07-knowledge-governance-and-rust-evidence.md#decision) for the repair failure boundaries.

### Candidate measured-trial review

All `review.json` readers and writers share an 8 MiB limit over the complete formatted JSON array, including escaping and the final newline. Ingest, research, session-summary, correction-repair, and captioned-image producers preflight the whole possible review projection, including partial-success outcomes and same-path fallback variants, before their first Candidate, governance, or review publication. Legacy duplicate ids remain in place; updates retain the existing first-match behavior. Commit compares the exact review bytes, re-resolves the Candidate under the same Wiki root, and rechecks Candidate bytes, source identity, and the current governance decision. A regular in-project source file is bound by its current bytes; an external, virtual, or absent source path binds only its path string, and an unspecified source uses the fixed `unknown-source` marker. Research's `research:${topic}` label binds the request identity, not fetched facts. Raw-source and media prerequisites may already exist, and later file or journal I/O can leave partial results; this is not a multi-file transaction or cross-process lock. Page reads remain capped at 5 MiB, and promotion recovery WALs remain capped at 8 MiB. See the [governance decision note](../../../.agents/notes/implemented/architecture/2026-10-07-knowledge-governance-and-rust-evidence.md#decision) for the owner boundary.

Semantic verification waits for a validated signature on the complete verification event before publishing Review or governance projections. Before writing, the owner rechecks the full Review bytes, confined Candidate path and bytes, source/build identity, authenticated event journal, and receipt bytes and bindings. Cancellation or project changes during the wait refuse publication. A refused seal or an observed change prevents this operation from updating those projections. Later projection I/O failures throw and can leave partial Review or audit state; they do not provide multi-file rollback, and a missing authenticated event cannot authorize model access.

The injected authority signs closed, schema-checked requests for verification events, promotion events, or promotion WAL cores; arbitrary strings, unknown operations, and foreign authority identifiers are refused. These internal requests preserve the existing canonical signed bytes and persisted event/WAL formats. Promotion and authorized recovery prepare the promotion-event signature before applying journal operations, then revalidate current inputs before synchronous commit and event publication.

The service owns one cancellation signal per project generation. Switching workspaces, removing the current workspace, or disposing the service aborts that generation; verification also combines the caller signal. Verification-event, promotion-event, WAL, and recovery signing receive the resulting signal, while the existing post-await state and generation checks remain. A cooperative signing owner must stop and await its process tree before settling. An owner that ignores the signal can keep the call pending; synchronous Wiki disposal requests cancellation and does not itself await signing. The adapter adds no signing deadline. Typed dispatch does not establish protected key ownership or a production signer.

The owner applies signed journal operations and synchronizes their parent directories before appending the matching lifecycle event; it synchronizes the event file and parent directory before writing the `committed` marker. I/O errors can leave operation or event bytes visible while the journal is `prepared`, or return after a rename has made later bytes visible, so an error does not promise rollback. See the [governance decision note](../../../.agents/notes/implemented/architecture/2026-10-07-knowledge-governance-and-rust-evidence.md#decision) for recovery behavior.

The complete serialized promotion WAL is limited to 8 MiB, matching the recovery reader; an oversized transaction is rejected before its first persistent write. This is a recovery-capacity bound, not support for arbitrarily large inputs, and recovery still refuses previously written WALs over that limit.

The complete JSONL event log is capped at 64 MiB of UTF-8 bytes by both reader and append owner; an append that would cross the limit is refused, and an already oversized log remains unreadable. Callers must serialize appends to the same path; there is no cross-process lock, and a caller appending several events does not get an atomic batch.

The shared `validateKnowledgeRecord` owner requires `lastVerifiedAt` and `expiresAt` to be `null` or JavaScript strings accepted by its existing `Date.parse` check; it does not narrow the accepted date-string formats. `claimKey` may be omitted and must be a JavaScript string when present. The seal encoder reuses this validator, and its trust and WAL-role allowlists require JavaScript strings before exact membership checks, without coercion.

After semantic verification, the host RPC `recordCandidateMeasuredTrial` accepts a content-addressed trial hash. The injected reader authenticates the paired-use artifacts and binds the result to the current review, semantic receipt, Candidate hash, action, and canonical target pre-state. The expected binding supplied to the reader is immutable during registration, authorization, and recovery; the reader cannot rewrite the values against which its result is compared. The review exposes that action only when the authenticated trial reports positive utility lift. A later `resolveReview` repeats both semantic and measured-trial validation, then applies the exact frozen target bytes through the sealed promotion journal; crash recovery repeats those checks before completing the write. Missing authority, failed utility, changed Candidate or target bytes, and invalid receipts leave Canonical content unchanged.

Signed use receipts require bounded, non-empty `useId` and `callId` values; a valid signature does not bypass field validation.

Each use receipt names a canonical `knowledge-use-journal-v1` attestation as the first entry of `evidenceArtifactReferences` and the matching oracle evidence list. Its `schemaVersion`, `kind`, `useFactsHash`, `journalArtifactHash`, `journalSignerAuthorityId`, and `journalSignerSignature` fields bind the factual use identifiers and a nonempty journal byte snapshot to the configured journal-signer Ed25519 key. The facts hash covers every use-receipt field except evaluator identity/signature, oracle outcomes, and evidence references; those references are added after journal signing to avoid a hash cycle. Missing attestations, wrong keys, changed facts, and changed journal bytes fail closed even when the evaluator signature is valid. Signer provenance, protected ownership, coherent session events, independent task correctness, and real knowledge reuse remain separate checks.

Paired-use hashes have three domains: the proposal `targetAfterHash`, receipt `contentHash`, and injected event `sourceContentHash` bind the exact raw Wiki page bytes; the injected event `contentHash` and `resultHash` bind the serialized rendered content blocks; and the receipt `renderedToolResultHash` addresses those rendered bytes. The reader checks the selected `knowledge/injected` event against the source hash, rendered artifact, session, call, verification state, and byte count. Every baseline and candidate use must have its own fresh session ID and a unique `useId` within the trial. Call IDs and event sequences are local to a session and may repeat in distinct sessions.

Unsigned Observed and Candidate records cannot claim verified status or canonical lifecycle. Authenticated verification must carry the complete matching record and replaces admission provenance; semantic verification alone retains Candidate lifecycle. Model-facing content must match the current file bytes to the authenticated promotion's `targetAfterHash`. Page reads check their final returned bytes again, and a changed source cannot authorize a repair or appear in canonical search, file, or graph results while its hash differs.

### Rust search candidate

The production search path remains TypeScript by default. In `shadow` mode the service sends the same canonical page corpus and query to the isolated Rust candidate, checks request/result digests and byte-exact BM25 output, logs the observation, and still returns the governed TypeScript result. Candidate processes receive a minimal environment, bounded input/output, and a deadline; failure, timeout, cancellation, or divergence falls back to TypeScript. The `enforce` mode is intentionally fail-closed and currently rejected by `modelSearch` because Rust has not yet implemented the complete hybrid BM25-plus-embedding result contract.

The parent and child enforce the same [UTF-8 string and query-token bounds](../../../rust/knowledge-search-shadow/README.md). Result hashing uses the same ECMAScript number representation as the response bytes; it does not accept a different digest merely because parsed scores are numerically equal.

## Model Experience

### Two-stage source ingest

#### What the model sees

For every changed source file, two sequential requests: a stage-1 analysis prompt carrying the project purpose, a slice of the wiki index, and the source text (capped at 60000 characters); and a stage-2 generation prompt carrying the analysis, the project schema, the exact summary-page path, and today's date. Both prompts are written by this package; the model output is consumed as `--- FILE: … ---` blocks and `---REVIEW: …---` blocks.

#### Token effect

Per ingest, proportional to the source size plus the embedded purpose/index/schema context (each capped at 8000 characters); both requests are one-shot and not retained.

#### KV Cache effect

Independent requests: the stage-2 prompt embeds the stage-1 output, so it cannot reuse the stage-1 request; across ingests the prompt changes with the source. The package owns no stable reusable prefix.

### Deep research

#### What the model sees

An expansion request turning the topic into search queries and a synthesis request fed the fetched web results.

#### Token effect

Per research run, topic-proportional plus the fetched page content.

#### KV Cache effect

Independent requests per research run.

### Vision captions (image ingest)

#### What the model sees

The image bytes of an ingested media file, via the configured vision call, producing the page caption. Captioned image inputs are bounded to 16 MiB. The source bytes are compared after captioning and again after review preflight before the media and Candidate pages are published; a detected source change refuses publication.

#### Token effect

Per image, data-dependent.

#### KV Cache effect

Independent request per image.

## Known Limitations and Deferred Work

- **Long-document truncation** — a source longer than 60000 characters is truncated for the analysis stage; ark-sessions sources are far below this.
- **Conservative shared-page merge** — an existing page with other sources keeps its body; only the `sources` frontmatter is unioned. LLM-body merge for shared pages is not implemented.
- **Stage-2 review blocks only** — review items are parsed from the generation output; there is no standalone review-suggestion LLM stage.
- **Online embeddings only** — vector search calls the embedding API per query; there is no persisted vector store.
- **Polling watch** — `raw/sources` is scanned every 60 seconds; there is no filesystem watcher.
- **Measured-trial authority is not provisioned in the active Jiuzhang runtime** — the profile now has a launcher-only configuration path for independent public keys and a content-addressed store, but the current launch supplies no trusted authority configuration or real paired-use evidence. Until both exist and pass live review, semantic verification cannot unlock a canonical action.
- **Out of scope** — Web Clipper, MCP server, and a desktop UI are not provided; the knowledgeWiki Remote contract and the tool-knowledge-wiki consumer cover the UI surface.

### Dev Note

None.
