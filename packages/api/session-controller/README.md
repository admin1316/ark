---
description: "Host session actions, history streams, and live control baselines over canonical Session services."
kind: "package-reference"
---
# Session Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-session-controller` owns desktop actions, journal streams, lifecycle notifications, and the non-activating `skills/list` catalog. Its `session` contribution contains only `modelCatalog`, `canOpenWorkspacePath`, `openWorkspacePath`, `page`, `follow`, and `control`. Core `SessionStore` declares the canonical list/search/create/selectModel/rename/fork/prompt/attachment/updateQueue/cancel methods, implemented by Host SessionRemoteOperations; this package has no duplicate write path.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

History pages and follow opening snapshots carry a discriminated `SessionHistoryRecord`. Both variants use `{ type, event }`: `type: 'event'` carries one raw `SessionWireEvent`, while `type: 'chunks'` carries one lossless `ChunkRowEvent` for consecutive same-block `assistant/chunk` deltas. Both inner values expose `type`, `seq`, `time`, and `data`, so a protocol consumer can validate each record without expanding packed members. A packed event's `seq` and `time` identify its first member, and `data` retains the fragment and timestamp-gap arrays. Live follow frames remain individual `event` records. Tool arguments, result content, failures, and `tool/result.data.meta` pass through unchanged; the controller does not resolve a Tool definition, run a presenter, or attach UI data.

Each endpoint states its activation policy. List, search, attachment, history pages, log following, skill discovery, and workspace-path opening can inspect persistence without activating an Agent; `canOpenWorkspacePath()` reports native-opening availability without addressing a Session. Queue mutation and cancellation require live state; model, rename, prompt, and file-reference operations may resolve or resume an ordinary Session. Create and fork are the only operations that create a new Agent directly. The skill catalog instead uses a live Agent when present or the recorded preset's standing scope when cold, so listing never starts an Agent.

Consumers must validate contiguous logical coverage: ordinary records cover `[event.seq, event.seq]`, and packed rows cover `[event.seq, event.seq + memberCount - 1]`. Each follow opening supplies its baseline before later events; every control generation supplies a complete process-local baseline for queue, jobs, and projections. The [Native history owner](../../host/session-remote-operations/README.md) defines source-bound semantic pages, raw recovery, and streamed content for Ark.

Prompt acceptance and retry identity belong to Host SessionRemoteOperations. Control readers accept both historic `rpcId` and current `invocationId` sources; queue occurrences retain the `SessionQueuedItem.rpcId` wire field. Pending UI drafts and optimistic rendering belong to the Native consumer, not this controller.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `nativeOpen` | platform-detected | Whether Session workspace paths can be handed to a native desktop opener |

Cold-list `coldBlankProbeMaxBytes` belongs to Host SessionRemoteOperations Config (default 1,024 physical bytes; 0 disables probes). Move any old controller override to that owner.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-session-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

The neutral `agent-default-model` owner registers the existing modelSelection projection and shares one Agent-scoped assembly adapter. A validated selection is recorded before saving the future default; a default-save failure leaves the accepted current selection in effect. Canonical unary calls carry a Session domain result inside the generated carrier result; API consumers unwrap both layers.

<a id="model-experience"></a>
## Model Experience

None, as this package owns Session API and transport while invoked Agent commands own model-visible effects.

#### KV Cache effect

No direct effect; model requests remain owned by the Agent and LLM packages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Control baselines represent process-local state and therefore cannot reconstruct jobs after a Host restart.
- File-reference completion uses the shared Agent lookup and can resume a cold Session; the `skills/list` catalog is the non-activating alternative for skill metadata.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

The sole owner of `fileReferences/list` is `@deepseek-ai/dsh-file-reference`; this package no longer declares or mounts a duplicate adapter. It still uses shared Agent lookup with the original provider discovery and cancellation behavior. `skills/list` remains: its non-activating cold Session read differs from the core Agent-addressed `skill/list`, so these are distinct endpoints.
