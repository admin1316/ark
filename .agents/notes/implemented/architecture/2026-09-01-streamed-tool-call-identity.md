# Agent Note: Streamed tool-call identity survives empty continuation deltas

Status: implemented

English | [中文](2026-09-01-streamed-tool-call-identity.zh.md)

## Problem

The DeepSeek SSE translator assigned `id` and `name` on every tool-call delta that carried the field, so a continuation delta repeating either as an empty string erased the identity established by the call's first delta. The assembled block reached the loop with an empty name, which the tool registry refuses as `unknown tool ""`. Gateways that fill those fields with `null` erased the identity the same way, and `WireToolCallDelta` declared both as `string | undefined`, keeping the observed `null` out of the compiler's reach.

The empty identity outlived the turn. `appendToolCall` and `appendToolResult` write the block's id verbatim and no write path validates it, while `adoptSessionEvent` refuses a `tool/result` whose `callId` is empty. A session that recorded one such call was writable and no longer loadable: the persistence coordinator wrapped that refusal in `SessionPersistenceCorruptionError`.

## Decision

`acceptIdentity` accepts only a non-empty string for a tool call's `id` and `name`; `undefined`, `null`, `''`, and any non-string leave the established value in place. `WireToolCallDelta` widens `id`, `function.name`, and `function.arguments` to admit `null`, so the values gateways actually send are in the type system and the runtime guard is load-bearing rather than speculative.

A tool call still lacking `id` or `name` when the stream reaches `[DONE]` is not closed. The translator reports any pending usage, then ends the response with an error finish carrying the new `MALFORMED_TOOL_CALL` code, and emits no `block-end` at all. `closeBlock` returns which field is missing instead of substituting an empty string, so no path can assemble an unidentified tool call.

`MALFORMED_TOOL_CALL` joins the default retryable codes. The failure must arrive as an error `finish` rather than a thrown `LlmError`: the agent loop derives `agent/request-error` — the only extension point `dsh-llm-retry` listens on — from `BlockAssembler.finish`, and rethrows whatever the stream throws straight out of the turn. A thrown failure ends the turn with no retry whatever the policy says.

## Alternatives considered

**Concatenate `id` and `name` across deltas.** Rejected: they are identity, not accumulation. Concatenation produces `Globnull` against a gateway that sends `null`, and a doubled name against one that repeats a non-empty value.

**Refuse a conflicting non-empty identity mid-stream.** Deferred: a gateway that fragments a long tool name would be refused for it, and the `[DONE]` check already keeps an unusable call away from the loop.

**Relax the session reader's empty-`callId` refusal.** Rejected: an empty `callId` cannot be paired back to the provider on the next request, so accepting it moves the failure into the model request. That refusal is the durable-boundary gate; the producer was the defect.

**Refuse as soon as a call's first delta carries no `id`.** Rejected: "first delta only" is a claim about the remote encoder, so a gateway that sends `id` one delta later would be refused for nothing, and the `[DONE]` check covers every case an early check would.

## Consequences

A continuation delta repeating identity empty or null is inert, so a call keeps the identity its first delta established. A provider that never identifies a call costs a retry instead of an `unknown tool ""` result and a session that cannot be reopened. Sessions that already recorded an empty `callId` stay unreadable; recovering them is outside this change.

## Testing

`translate.spec.ts` covers empty and null continuation deltas, a repeated identical identity, parallel calls holding separate identities under empty continuations, and refusal when `id` or `name` never arrives — including that usage is reported before the failure and that no `block-end` precedes it. The two cases that documented lenient empty-identity output now assert refusal. `retry-policy.spec.ts` pins the new default retryable set.
