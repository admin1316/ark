# Agent Note: Durable native command receipts

Status: implemented

English | [中文](2026-10-20-durable-native-command-receipts.zh.md)

## Problem

A native command can mutate a domain before its response reaches the application. Repeating the handler after a disconnected response can repeat that mutation; forgetting an interrupted command cannot establish whether its effect happened. A request lifetime alone cannot own this uncertainty across application or Host restarts.

## Decision

The Host exposes `session/command`, accepts a caller-persisted invocation identity with the exact line and ordered images, and reads live or cold receipts before resolving an Agent. `CommandRuntime` owns execution and the receipt projection over `command/run` and `command/done`; it creates no second JSON ledger. Optional invocation metadata keeps `SESSION_FORMAT_VERSION` at `0` and permits reading records without a retry identity.

A new invocation flushes its run record before entering the handler and flushes its terminal record before reporting `completed`. The input digest binds the identity to the exact line and ordered image contents. The same identity observes `running` or replays its original completed success or error; different content conflicts. An admitted run without a confirmed result reports `unknown`, preserving the identity without re-entering the handler. One session owns at most one active command and does not queue another invocation behind it.

Durability checkpoints resolve the optional session store and persistence owners explicitly through `ctx.get`. An injected Remote consumer does not grant `CommandRuntime` implicit access through `ctx.sessions`; relying on that property can fail before the handler despite both owners being mounted. Missing ownership still fails the durable call, while local execution remains independent of persistence.

The Host activity signal owns cancellation independently of HTTP response observation. Entered handlers retain execution ownership until they actually settle, including handlers that ignore cancellation. Shutdown waits for that settlement. After Host readiness or observed backend exit, native teardown can cancel and await response observers without acknowledging their journals.

### Native acknowledgement

Native decoding rejects missing or non-string error text, non-string optional success text, and source-event references on error results before any journal acknowledgement. A malformed response preserves the original submission identity for receipt recovery.

One native submission owner uses the existing private inflight journal and preserves the complete confirmed terminal result. A successful composer receipt clears only its captured payload. After displaying a confirmed error, the composer durably replaces the matching draft's submission metadata while keeping its text, references and attachment journal, then retires the old inflight identity. A subsequent explicit submission receives a new identity; no submission starts automatically. Compare-and-save preserves later edits, and a failed draft acknowledgement keeps the original identity available for a receipt query. Independent button and menu actions also retire a completed error only after displaying it. Neither path converts `running`, `unknown`, unconfirmed result durability or a transport failure into a new invocation.

A new-session permission prerequisite derives a distinct identity from the captured parent submission and exact permission command, so retrying after a lost local acknowledgement still observes the same prerequisite. A successful explicit permission choice clears the matching draft's frozen prerequisite through a durable compare-and-save while preserving the main submission identity.

The [registration decision](../feature/2026-07-19-plugin-command-registration.md) retains plugin scoping and human/model separation; its dispatch and recovery limits are partially superseded here. The [image envelope decision](../feature/2026-08-17-command-image-attachment-envelope.md) retains producer declarations and whole-envelope admission. Same-process `executeLocal` has no Remote route or durable retry promise.

## Alternatives considered

**A new identity for every retry** loses the relationship to an already executed effect and cannot distinguish lost responses from new intent.

**A separate command JSON ledger** duplicates the authoritative session log and introduces another crash-consistency boundary. The projection stores coordinates into the existing records instead.

**Cancelling the response means execution stopped** creates a false terminal result for an uncooperative handler. Actual handler settlement remains the completion boundary.

## Consequences

Retries preserve one admitted invocation and recover its recorded result without model configuration or a second handler call. An unknown outcome can require inspecting the affected domain; automatic replay cannot repair an unrecorded external effect. This contract does not guarantee exactly-once behavior across external systems, and an explicitly new user invocation may perform the operation again.

## Verification

The real Loader/Agent/JSONL command composition pins admission before a synthetic filesystem effect, concurrent and cold retries, interrupted runs, error replay and explicit new intent. A Loader consumer injected only with the Host Remote service pins first-call durable completion and live/cold retries of one invocation identity with one effect; root-context calls alone do not exercise that scope. Native contracts exercise the real AppModel and wire codec across completed composer errors, fresh explicit intent, restored text and image journals, later edits and failed native acknowledgement, alongside original identities, permission supersession and response teardown. Both SDKs replay the same synthetic command metadata through their real stdio clients.
