# Agent Note: One pre-step decision and addressable inbox messages

Status: implemented

English | [中文](2026-07-31-claimed-pre-step-inbox-lifecycle.zh.md)

## Problem

The loop previously split one step boundary across prompt preparation, prompt admission, and a serial step hook. Claimed input could be retained or discarded by an admission result, and live queue events carried shapes that duplicated durable inbox state. Plugins had to choose whether to mutate the inbox, rewrite a submitted batch, or append directly to session history, while observers could not rely on one exact ordering.

Occurrence-local inbox wrappers also duplicated the identity already carried by every `UserMessage`. They made insertion, editing, claiming, cancellation, reconnect projection, and step entry one combined protocol even though the append-only session already owned the durable queue projection.

## Decision

The loop makes one awaited `agent/pre-step` decision for each proposed step, with identified messages and `{ turn, step, signal }`. This note owns the single decision, message addressability, and minimal live notifications. The [atomic-input decision](2026-10-20-atomic-inbox-input-commit.md) supersedes the claim-before-preparation timing: input remains a pending preview until a validated commit records its consumption and step entry together.

`PreStepDecision` is `{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }`. Reject consumes the offered input, opens no step, and closes the turn as blocked. Cancellation with `keepInbox` and preparation failure preserve uncommitted input. Enter supplies the complete batch recorded as `user/message` events with `step/start`. A listener wrapping `next()` preserves downstream changes unless it intentionally replaces them, so all message rewrites settle once in the final return value. There is no `agent/prompt-prepare`, `agent/prompt-submit`, or `agent/step` extension point.

The durable inbox remains two `UserMessage[]` lists addressed by `MessageId`. `append`, `prepend`, and `splice` take a target, while `replace(messageId, newMessage)` and `remove(messageId)` locate the pending message across both lists before committing a normalized splice. Replacement may change identity and emits the old message as discarded followed by the new message as inserted. Every insertion emits `agent/inbox/inserted { message }`; an ordinary removal records `outcome: 'canceled'` and emits `agent/inbox/discarded { message }`. Input commit records pure deletions with no outcome, then emits `agent/inbox/claimed { message, turn }`. These live events add no placement, outcome, or batch fields.

The two event surfaces have separate consumers. Observers following one message use `agent/inbox/inserted`, `claimed`, and `discarded`. Whole-queue consumers, including the Web queue projection and reconnect baseline, use the durable `agent/inbox/spliced` stream; UI edits and removals route through `Inbox.splice()` or another Inbox mutation method so the same projection records every change.

Plugins that need current-step rewriting return messages from `agent/pre-step`. Plugins that only need later context may mutate `agent.inbox` directly. Workspace context uses both paths: asynchronous filesystem projections stage one replaceable `next-step` item, while the next entering pre-step folds that item or a newly composed baseline into its final batch. Preparation preserves any staged item already selected by the preview; input commit owns its removal.

The archived [addressable queue occurrence decision](../../archived/feature/2026-07-29-addressable-queue-operations.md) describes the superseded occurrence-wrapper design. `MessageId` now owns addressability, while the retained Host queue mirror derives its snapshots from the durable splice projection.

## Alternatives considered

**Keep separate prepare and admit hooks.** This lets preparation mutate the inbox before claiming and admission rewrite afterward, but it creates two ordering surfaces for one boundary and makes cancellation ownership ambiguous.

**Let rejection requeue the claimed batch.** This preserves retry-like behavior but turns a veto into hidden queue mutation, duplicates later work unless every race is fenced, and prevents claim from being an atomic ownership transfer.

**Put placement and outcome on every live event.** Durable splices already own those facts. Repeating them on live notifications creates a second contract that can drift and is unnecessary for consumers holding the exact message identity.

## Verification

Agent-loop coverage pins one pre-step decision, exact live event payloads, balanced no-step rejection, final-batch rewriting, input appended during preparation, listener failure, and cancellation. Inbox and consumer tests pin pure commit deletions, canceled ordinary removals, agent-instructions staging, replacement, and same-step entry, plan/goal/hook behavior, UI cleanup, compaction, checkpointing, and resumed durable projection. The atomic-input decision owns crash-cut and physical-group verification.

## Consequences

The loop has one awaited decision before each step and one ownership transfer for its input. Claimed messages never return to the inbox implicitly; later insertions remain independent. Live events are symmetrical with other inbox notifications without mirroring durable metadata, and plugins can choose exact-current-step rewriting or ordinary later inbox delivery explicitly.
