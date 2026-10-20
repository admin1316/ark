# Agent Note: Commit inbox consumption and step input as one atomic group

Status: implemented

English | [中文](2026-10-20-atomic-inbox-input-commit.zh.md)

## Problem

An accepted inbox message can disappear from durable pending work before asynchronous prompt preparation finishes. A process interruption in that interval leaves neither pending input nor a `user/message` record. Requeueing in a `finally` block handles cooperative failure but cannot repair a killed process. A synchronous sequence of ordinary appends also leaves partial durable prefixes when the writer fails or storage recovery salvages complete records from a torn compressed frame.

## Decision

The loop previews selected inbox messages without removing them. Prompt assembly can restart when that selection changes before `agent/pre-step`; the awaited pre-step decision runs once. Before consumption, the inbox verifies that the exact selected message identities and positions remain current. Unrelated appended tails remain independent; a selected edit during the decision ends the attempt without rerunning an effectful hook. Cancellation with `keepInbox` and preparation failure preserve pending input. Explicit rejection consumes the preview and closes a blocked turn.

Pre-step listeners can append log-only facts while input remains pending. The one-shot child's `subagent/descriptor` therefore precedes inbox consumption; it identifies an established child without adding a model-visible message. A storage-failure fixture that targets the request checkpoint arms after step entry, independently of the earlier preparation checkpoint.

Step entry commits normalized inbox deletion splices, `step/start`, and every final `user/message` through `Session.appendAtomic`. The session snapshots and validates the entire group, including provisional surface transitions, before publishing any member. It installs the complete group and emits one `session/committed(session, events, true)` notification, followed by individual `session/event` notifications. Ordinary append emits the same committed notification with one event and `false`. Persistence consumes only committed notifications; UI and projection consumers retain individual events. This separates storage grouping from the logical event taxonomy without duplicating event payloads.

The persistence queue retains group coordinates by canonical sequence number across batching and retry. JSONL writes each group as one version `1` `atomic-events` record with a required physical `seq` equal to its first member; compression gives each atomic record its own frame. The decoder validates the whole record before exposing members, so plaintext byte cuts and Zstandard prefix salvage cannot admit only its inbox deletion. The guard and frame separation let the Ark 3.1.2 reader retain a complete unknown record and refuse interpretation before repair. Without the guard, an unsupported tail row resembles an incomplete append; without frame separation, a later scalar sequence gap can discard the frame containing the guard. SQLite appends a batch in one database transaction. Neither a JavaScript stack nor a compression frame substitutes for the complete validated record.

The [single-pre-step decision](2026-07-31-claimed-pre-step-inbox-lifecycle.md) remains authoritative for one waterfall, `MessageId` addressability, and minimal live notifications; this decision supersedes its claim-before-preparation timing. The [chunk-packing decision](2026-07-26-packed-chunk-rows-by-default.md) continues to own ordinary chunk rows. Atomic groups use existing `SessionEvent` values and keep the logical format version; their physical record has its own version. Older applications cannot consume that wrapper. Strict offline export flattens complete copied artifacts into scalar-event JSONL for an isolated rollback profile and refuses damaged or incomplete input.

## Alternatives considered

**Restore claimed messages in `finally`.** This cannot run after process termination and leaves the durable deletion-before-input interval intact.

**Flush before claiming, then append ordinary events.** This preserves older writes but does not make the later deletion and input indivisible. Flushing after deletion can durably expose the very gap that needs protection.

**Replay preparation when the queue changes.** A pre-step listener can perform effects. The loop accepts independent appended tails but fails a changed selected cut without automatically repeating that listener.

**Treat every compressed append frame as atomic.** Recovery deliberately salvages complete records from torn frames. Only a whole validated physical record can preserve the logical group under that policy.

**Add a second durable copy of input.** Existing inbox and user-message events already describe pending and entered input. A physical grouping wrapper preserves their relationship without another source of truth or new model-visible content.

## Verification

Session and inbox tests prove whole-group validation, one committed notification, no partial observer view, cancellation before commit, selected edits, and deferred observer cancellation. Agent-instructions tests cover selected workspace context without removing the preview during preparation. JSONL tests split an atomic record at every plaintext byte and salvage incomplete Zstandard frames; malformed members never publish a group prefix, and the guard must match the first member even for a one-member group. SQLite tests inject a later insert failure and require transaction rollback. Export tests compare exact logical events for both encodings and reject incomplete input. The installed Ark 3.1.2 persistence library refuses guarded synthetic artifacts across raw/compressed, one/multiple-member, and tail/followed-by-scalar cases without changing file bytes. The assembled headless `input-atomic` keyless snapshot checks both the model-visible transcript and the actual persisted input group and guard.

TypeScript SDK snapshots select the source CLI explicitly for parent and SDK-spawned child runtimes and decode physical groups before logical assertions. Their strict logs fix descriptor-before-consumption ordering. The packaged Python advanced and restart snapshots retain actual atomic storage records; replay expands them without weakening payload or notification comparisons.

## Consequences

The accepted-input transition has one in-memory validation boundary and one durable storage boundary. Hooks observe still-pending input and must return current-step rewrites rather than remove the selected batch themselves. Individual event listeners observe a session whose whole group is already installed. The design does not make external tool effects transactional, guarantee persistence before a flush succeeds, or establish a strict memory bound. Rollback requires an independent exported profile because the older reader does not understand the new physical wrapper.
