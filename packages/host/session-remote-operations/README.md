---
description: "Host implementation of the generated session/ Remote port and the workspaceSessionRetirer capability."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-session-remote-operations

English | [中文](README.zh.md)

## Summary

Host implementation of the generated `session/*` Remote port and the `workspaceSessionRetirer` capability. The package composes the existing Agent, Session persistence/query/projection, Workspace, LLM, attachment, title, tool-presentation, preset, queue, and job owners; these services remain the domain authorities. History reads retain bounded numeric indices and explicitly released content materializations; they do not create a second durable transcript or replace the existing projection, workspace, attachment, or model-catalog owners.

`SessionRemoteOperationsService` implements `list`, `search`, `create`, `history`, `models`, `selectModel`, `rename`, `fork`, `prompt`, `attachment`, `updateQueue`, and `cancel`. Creation and resume are single-flight per identity. Handles returned by `AgentRegistry` remain exact capabilities owned by this service, so permanent deletion can retire only an idle, archived, root Agent created or resumed by this Host. `WorkspaceRegistry` remains responsible for descendant ordering, persistence reservations, durable log deletion, workspace accounting, and archive-state commits.

The same service owns the exact `/api/session/export` GET/HEAD download registered through `ctx.connection.downloads`. It flushes live Sessions before reading raw durable artifacts, optionally includes descendants and referenced media, streams a bounded ZIP with cancellation, and fails before body production when the required persistence/query/attachment owners are unavailable.

An encoder or producer failure errors the response body; later encoder callbacks cannot turn it into a successful archive. Consumer cancellation waits for producer cleanup and reports cleanup failures. The [export decision](../../../.agents/notes/implemented/feature/2026-08-10-web-session-log-export.md#terminal-failure-and-cancellation) defines first-cause precedence and verification limits.

Cancellation is checked before every mutation and around asynchronous reads. History and listing read their authoritative services directly; projection and tool-presentation failures degrade only the optional view. Image retrieval requires an attachment reference in the addressed Session log, and queue editing accepts text blocks only.

Ordinary prompt retries reuse `source.invocationId`: an existing matching receipt confirms the original message without enqueueing it again or resuming a cold Agent. Reusing an identity with different content, mode, or timezone is rejected. Successful acknowledgement requires durable materialization. `prompt-durability-unconfirmed` with `accepted: true` means admission occurred and the caller must preserve the same identity when retrying. Command side effects and a process crash before the receipt reaches storage are outside this guarantee.

## Table of Contents

- [History views](#history-views)
- [Prompt identity](#prompt-identity)
- [Canonical Session ownership and cheap listing](#canonical-session-ownership-and-cheap-listing)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## History views

Raw requests use `maxEvents` (1–2048, default 2048) for a hard event-count limit. `maxMessages` retains its message-group limit; when both are supplied, pagination stops at the first limit reached. A raw event boundary may split a message, whose complete content remains available through the semantic view.

A root `history` request without `view` or `sourceRevision` keeps the legacy `beforeSeq`/`maxMessages` event-page contract and optional projection baseline. Explicit `view: 'raw'`, a supplied revision, or a child-mode admission uses the same retained immutable observation as semantic reads. Its raw response always includes `view: 'raw'`, `sourceRevision`, and `asOfThroughSeq`; it omits the projection baseline. The revision can come from either a semantic or bound raw page. Every subsequent page supplies it, and its exclusive `beforeSeq` is capped at the fixed cut. A bounded raw page is not a complete message. Attached reads reuse Session's cached frozen event prefix rather than copying it again; raw pages without tool events do not build a semantic index or resolve a preset scope.

`view: 'semantic'` reads an immutable cut through `sessionQuery.observeSession`. The response contains bounded message/tool descriptors, `sourceRevision`, `asOfThroughSeq`, `turns`, and `dependencyRecords`. Older pages send the same revision with `beforeRecordId` from `nextBeforeRecordId`. Record identity distinguishes retry attempts and remains stable when the corresponding streamed attempt becomes a finalized message. Final and interrupted messages use the canonical `assistant/message`; unfinished, failed, and orphaned prefixes use the agent loop's existing `BlockAssembler` for readable text and reasoning. Previews are bounded excerpts; complete content is available separately.

A live revision binds the actual Session generation and fixed cut: append preserves an old cut, while replacement or disappearance invalidates it. A cold revision binds the persistence owner's source-qualified revision; any durable change, including append, invalidates subsequent reads of that cut. An in-flight cold read retains its original immutable source lease through presentation; it does not repeatedly stat the file across awaits. An invalid source returns `history-stale-source`. Numeric-index eviction does not invalidate a cursor: the same cut can be rebuilt while its source remains valid.

### Complete content and reader lifetime

`view: 'content'` takes the revision and a message or dependency record ID. The initial offset-zero read returns a `contentReadId`; subsequent requests send that handle and the returned `nextOffset`. Concatenate the `encoding: 'json'` fragments before decoding. Offsets count UTF-16 code units and never split a surrogate pair. Each initial read materializes the exact body once, including when it exceeds the ordinary content budget; continuations do not rebuild the body, numeric index, or full observation. Live continuations check Session identity and metadata directly; cold continuations use lightweight persistence snapshots.

`done` releases the materialization. Clients should send `close: true` with the bound reader identity when abandoning an unfinished read; the content owner can close after source replacement. The child route still requires catalog/mode admission, so a deleted or reclassified child may reject close and leave idle expiry to release the body. Idle expiry and Host disposal also release readers. Abort stops in-flight work; it does not replace a client's explicit close for an already materialized reader. `history-content-busy` requires finishing or closing an existing read, and `history-content-expired` requires a fresh initial read rather than silently continuing from new content.

### Presentation dependencies

The tool, status, and turn IDs in `dependencyRecords` resolve through the same content reader to independent bundles at the page's exact revision and cut. They contain real domain events, `completeness`, and explicit `missing` relationship reasons. Tool bundles preserve paired call arguments, tool-owned presentation, PTC dispatches, and independent workflow run/member records. Status bundles preserve command, compaction, request, retry, and turn history. Tool presentation resolves the historical preset scope once per materialized body, from the latest selection at or before its cut; non-tool entries do not resolve a preset scope.

Turn bundles use `chunkCoverage: 'timing-boundaries'`: they retain timing evidence, not every raw chunk. Exact completed usage comes from the existing strict `deriveTurnTokenUsage` owner over all original turn events once; unproven usage is `null`, and optional cache/reasoning/route values are not invented. The bundles must not be fed to a live usage accumulator as complete raw evidence.

A consumer installs each global dependency bundle once per revision and keeps its visible presentation rows bounded. Ordinary pagination must not reload and refold all global bundles. These independent seeds never advance the contiguous raw/live cursor.

### Memory bounds

`Config.semanticHistory` controls reuse and reader admission. Defaults retain at most eight numeric indices with a conservative 16 MiB charge, and eight content readers with an ordinary 8 MiB budget and 60-second idle expiry. One initial body may materialize at a time. A single oversized message may occupy the oversize slot until completion, close, or expiry; competing reads receive `history-content-busy` instead of evicting that body between fragments. This is not an absolute RAM cap for arbitrarily large messages.

The semantic owner retains no raw event arrays or cross-request prepared leases. Session may still create a frozen snapshot after mutation, and the existing persistence preparation cache remains count-bounded rather than byte- or TTL-bounded. These limits therefore do not establish a total process-memory bound.

## Prompt identity

Child-history callers may supply `expectedParentSessionId`. The history owner checks it against the actual source header before rendering events, so a prior catalog lookup cannot authorize a page from a replacement Session with another parent. The check also applies to content reads; a mismatch returns `subagent-unauthorized` without content. Child-origin reads fail closed unless both parent and `expectedSubagentMode` are supplied. The exact observation's registered subagent projection must prove an own-suffix descriptor with the expected mode at the cut; an earlier catalog lookup cannot authorize a different source. A live descriptor change also revokes outstanding content readers. This reuses the existing descriptor projection rather than introducing another parser.

`subagent/history` retains its parent/child/mode arguments and outer Remote result. Its fourth argument, named `beforeSeq`, accepts either the legacy numeric cursor or typed raw/semantic/content options; with typed options, omit the separate `maxMessages` argument. The route performs the existing child catalog/mode admission on every page, fragment, and close, then supplies the parent and mode itself. Neither Agent is resumed.

Every `SessionRemotePromptRequest` carries a required opaque `invocationId`. The service validates it and persists it with the exact user message beside the optional canonical client time zone. This preserves optimistic-message reconciliation without leaking a transport RPC identity into the Session domain.

A leading slash line resolves against the command registry first. When no command claims it, the service consults the live Agent's skill registry and admits only an exact user-invocable skill name, preserving the user's text unchanged for `dsh-tool-skill` to inject at `agent/pre-step`; every other unmatched slash line returns `unknown-command`.

## Canonical Session ownership and cheap listing

Core SessionStore is the sole Remote declaration owner for the shared Session methods; the legacy controller contributes only its distinct desktop/stream operations. List and search visibility reuse SessionQuery corpus headers. Listing reads existing live/cold projection hints and observes an unknown cold artifact only when its physical file is at most `Config.coldBlankProbeMaxBytes` (default 1,024; 0 disables probes), in batches of at most 16. Large or inaccessible cache misses stay visible as unknown; hints may be stale, and an absent cached preset is not inferred from the creation header. Search performs no list-summary observations and rechecks cancellation after each provider await.

Queue edits reject non-text and empty/whitespace-only content before inbox mutation. Model selection uses the neutral agent-default-model projection and assembly owner, including pending intent restored without a controller. The existing model/selection event is appended before future-default saving; failed default storage does not roll back the accepted route.

## Model Experience

### Per-session model route

#### What the model sees

The service adds no model-visible tools or prompt text. It installs the selected provider, model, and reasoning route from `SessionRemotePromptRequest` into the existing Agent request path, while the composed Agent owns the actual model content.

#### Token effect

No direct token effect from this service; the selected Agent composition, prompt, tool descriptions, and provider determine request size.

#### KV Cache effect

The service retains the selected route per session without adding model content; changing the provider, model, reasoning route, or composed prompt can invalidate provider-side reuse.

## Known Limitations and Deferred Work

- **Native adoption** — These Host views and independent seeds are implemented; their presence does not establish Native integration or GUI/performance acceptance.
- **Cold active continuation** — A readable `assistant-prefix` is not a resumable indexed assembler checkpoint. Host now provides revision-bound raw pages and child semantic forwarding, but Native must still assemble and validate the full contiguous active-turn range before installing a live recovery checkpoint.
- **Raw artifact requirement** — Session export returns 501 when the selected persistence backend cannot expose per-session raw artifacts; it never reconstructs an approximate log from parsed events.

Historical `fork` accepts an optional `sourceRevision` from a semantic or bound raw page (including its fixed cut), together with `atSeq`. Child sources also require the same `expectedParentSessionId` and `expectedSubagentMode`. The Host selects the seed only from the initial immutable observation lease; neither the anchor nor its completed turn may exceed the cut, and preset selection comes from that seed. After asynchronous scope setup, the same observation owner revalidates the revision; the Agent's synchronous publication commit checks source identity before and after its existing admission commit. Observed replacement, truncation, or child identity changes return `history-stale-source`. Later appends cannot enter the seed. Cold leases remain held through the call; durable revision is checked again before publication, without claiming global exclusion against external filesystem writers. Calls without a revision retain the legacy fork boundary semantics.

### Dev Note

None.
