# Agent Note: Save pressure and explicit quit confirmation

Status: implemented

English | [中文](2026-10-20-session-save-pressure-and-quit-barrier.zh.md)

## Problem

Bounded batching limits intentional scheduling delay, not the volume retained behind a slow or failed write. Removing an active batch from the pending array before acknowledgement also hides its bytes from naive queue counts. A native exit deadline cannot prove saving, and the live Session list omits disposed owners whose retirement failed. Seed initialization can remain unconfirmed even with no newly queued event. A cancelled quit request can arrive again after a newer request and close admission unless its generation is independently verifiable.

## Decision

The persistence owner counts unacknowledged initialization suffixes, active batches and pending events exactly once. Failed writes retain their sequence and atomic boundaries. Initialization retains its operation for explicit retry, including a zero-event failure; successful retirement releases the exact lifecycle only after acknowledgement. `flushAll()` drains retained live and retired owners, initialization and per-id operation chains through quiescence. The live Session registry is not the save ownership inventory.

Backend `writePressure` configuration pauses producers at high water and resumes at low water. Defaults are 4/2 MiB per Session, 32/16 MiB across the coordinator, and a 30-second producer wait. Counts measure serialized event bytes awaiting acknowledgement, not total heap or a universal memory bound. Checkpoints wait before model requests, top-level tool dispatch and step progression; streaming checks capacity after a yielded chunk reaches its consumer. Failure, cancellation or deadline ends the producing Agent's wait while preserving its inbox and the independently owned writer.

The storage wrapper delegates tool execution after its checkpoint. The existing ToolExecutor owns the final cancellation check immediately before the tool body, including cancellation introduced by a later dispatch wrapper.

The Host rejects new prompt/command admission and Agent publication when storage is unavailable or quit preparation is active. Existing matching receipts remain confirmable without another invocation. A quit attempt closes admission, cancels all registered Agents, waits for their idle boundaries and entered command operations, then awaits the persistence barrier. Only this completed sequence authorizes `safeToQuit`; empty counters alone do not.

The Host exposes a nonnegative `quitEpoch`. Prepare and cancel carry the observed epoch and an opaque attempt identity. Cancellation advances the epoch and reopens admission; old-epoch requests only observe current state, and future epochs reject. Repeated current preparation joins its owned attempt, while an explicit retry can restart a failed one. The native monitor rejects observations captured before a newer action and accepts readiness only for its own identity and epoch. Native drafts must also flush before interface teardown. After twenty seconds, a native prompt offers waiting/retry, cancelling quit, or explicit force quit; time alone never kills an unconfirmed writer. The existing bounded process stop runs after verified saving or an explicit force choice. Startup before readiness and before accepted native input retains its owned backend cleanup.

Host settlement and a native HTTP response are separate acknowledgements. After verified Host saving, or an observed backend exit, native teardown cancels remaining response observations and awaits their real transport settlement before waiting for composer callers. Their original journals remain unacknowledged; cancellation cannot invent a command receipt. Ordinary caller cancellation still leaves the command owner running. Starting irreversible native teardown renews the twenty-second prompt with waiting and explicit force available until completion; cancelling quit is disabled because the stopped model cannot be resumed in place.

The final local draft barrier begins by freezing editing and actions, including keyboard, AppKit bridges and mutation owners. It then settles composer work and saves the latest composer and Workbench buffers, covering edits made during the Host wait. Final composer write failures retain one failed snapshot per draft for retry; a newer snapshot supersedes it. A failure keeps the frozen interface mounted with retry and explicit force available rather than closing on an earlier draft acknowledgement.

Failed cold attachment restoration also remains part of that barrier. Explicit final retry awaits the existing restoration owner and clears its failure only after validating the recovered payload. The frozen draft and journal must match the recovered pending record; later edits or added attachments keep the failure visible rather than being overwritten or saved as a reduced payload. Restoration preserves uncertain submission identity and delivery metadata without submitting work. Cancellation or shutdown suppresses late installation, and successful restoration still requires the final durable save.

Lifecycle disposal preserves the durable inbox after Host readiness. Factory co-owners and continuation drains pass `keepInbox` through every child and handle, and mark disposal before awaiting quiescence so maintenance cannot wake retained work. Explicit handle and selected-child disposal retain their default discard semantics. The terminal observer reads the quiescent inbox projection; retained work is stopped, never completed.

Cancellation clears wake requests already latched by the cancelled activity, even when its inbox is retained. A later explicit waking send can set a fresh latch; cancelling quit alone does not restart parked work.

## Alternatives considered

**Drop stream chunks or clear counts when a batch starts.** This changes transcript evidence or conceals outstanding writes. Acknowledgement-aware accounting and producer pressure preserve the log.

**Cancel the disk write when a producer or transport times out.** A caller cannot know whether an append has committed. Cancelling observation preserves one writer and permits a later confirmation instead of introducing a competing retry.

**Flush only registered live Sessions.** Retirement and initialization failures remain owned after registry removal. This loses a retry path and can falsely authorize exit; the persistence owner already holds the complete inventory.

**Remember only the last cancelled attempt ID.** A request delayed across two cancellations becomes admissible again. A monotonic epoch rejects arbitrarily old requests without an ever-growing cancellation set.

**Treat the native deadline as successful saving.** A deadline measures elapsed time. Keeping the interface and an explicit force option preserves user control over unconfirmed data.

**Flush local drafts only when quit starts.** Editing can continue during the Host wait. Freezing before the final snapshot gives the last local version its own save barrier.

## Verification

Synthetic real Loader/JSONL runs fail retirement and seed initialization, observe failed preparation, restore storage and confirm the same attempt reaches ready with zero retained events. The registered Agent path exercises stream pressure, stalled-write cancellation and quit preparation with scripted external output and no API key. Native contracts reject malformed counters, false readiness, old epochs and late ready observations after cancellation; they also check retry ownership and monitor shutdown. Native interaction and installed-package acceptance remain separate from compilation and contract coverage.

A real `URLSession` with synthetic `URLProtocol` holds a command response after its identity reaches the local journal, while the Host storage reply reaches ready. Teardown must invoke transport cancellation, complete shutdown and preserve the same journal identity without another command request. Source contracts keep the teardown prompt armed and require response-observer settlement before waiting for composer callers.

Native draft contracts edit during the Host wait, freeze the owners, and hold a final flusher. Real temporary filesystem obstructions fail composer and Workbench saving; restoring the directory and retrying must recover the last frozen text. Late edits, revert and save actions are rejected while frozen. Mounted disabled SwiftUI bridges expose read-only AppKit editors and reject Return and marked-text submission.

Cold attachment contracts remove and restore a synthetic document directory around the real AppModel and store. Final retry restores identical images, document references and frozen submission metadata without an RPC; missing or corrupt journals and newer drafts remain unacknowledged. A held store operation exercises cancellation and shutdown before late restoration, followed by explicit recovery after cancelled observation. Cold recovery exposes inflight submissions without a current pending draft or attachment preference, including a failed attachment read repaired before final retry. Absent storage cannot acknowledge that failure through empty read results, including ordinary restoration after session navigation.

A real Loader test reaches Host readiness with accepted child and grandchild inputs, stops the entire Loader, and reads both original identities from a fresh persistence owner. Scoped descendant shutdown also retains both inputs. Explicit handle and selected-child disposal discard them; preparation failure remains idle until an explicit continuation, then executes each identity once. Maintenance-held teardown cannot issue another model request.

Host quit preparation cancels maintenance with a previously accepted waking input. Releasing maintenance must reach safe readiness with no model call and the original input still durable. Cancelling quit keeps it parked; an explicit follow-up then executes the retained and new identities once in FIFO order. Existing abort-to-idle follow-up tests preserve the fresh-wake behavior.

## Consequences

Storage faults stop new production while existing writes remain recoverable. Saving may wait indefinitely for a genuinely stalled writer until the user cancels or explicitly forces exit; force can lose unconfirmed records. This does not guarantee exactly-once external tool effects or bound process memory. The [semantic-checkpoint decision](2026-07-21-semantic-session-checkpoints.md) retains dispatch/recovery rationale, and the [single-controller decision](../simplification/2026-07-23-collapse-persistence-flush-state.md) retains serialization and adoption rationale. The [batching decision](../architecture/2026-08-08-bounded-session-persistence-write-batching.md) continues to own scheduling cadence, independently of pressure and quit authority.
