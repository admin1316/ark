# Agent Note: Restore Native endpoint arguments and durable child receipts

Status: implemented

English | [中文](2026-09-09-native-endpoint-wire-recovery.zh.md)

## Problem

Recovered source can publish a Remote name while accepting different arguments or returning a different value from the Native client. Renaming an endpoint alone does not repair that mismatch. A retried child prompt can also insert another message when its first acknowledgement was lost, and an unrelated flush listener cannot prove that the storage owner persisted it.

## Decision

Preset and subagent services bind the singular `agentPreset` and `subagent` wire namespaces without changing their Context service keys. Preset selection reuses its serialized blank-session switch, copy and selection return the preset id, and the native opener resolves a user-owned directory from its id. Read, copy, selection, and opener failures do not return raw infrastructure diagnostics.

Ark's managed profile uses the existing `includeShippedRoot: false` option so generic built-ins cannot precede and shadow the launcher's Native preset roots. The shared Native standard/code/minimal definitions own their tool catalogs, including teams, scheduling and the one-shot fork policy. Generic CLI definitions remain intact for deployments that select them.

The LLM owner supplies Native provider/model catalog envelopes and the request-object discovery interface. Provider failures are isolated, one-shot keys are not returned, and cancellation remains distinct. These read operations do not implement the missing provider configuration transaction.

The existing continuation manager owns durable prompt receipts under its child lock. It validates the caller's UUID and direct-parent identity, snapshots content before asynchronous work, and searches only the child's own log suffix. Exact retries return one original message id; conflicting reuse rejects. Acceptance is followed by the Session flush and the actual persistence owner's materialization barrier. Late cancellation does not interrupt that work, and failure does not retract an accepted message. No second queue or receipt database exists. This extends the [continuation design](../feature/2026-07-28-continuable-subagent-conversations.md), while retaining its initial-start acknowledgement and residency rules.

Child history first verifies the catalog. The Session history owner checks the expected parent against the actual source header before rendering the bounded page, preventing an intervening source replacement from authorizing another parent's history.

## Alternatives considered

**Change only route names.** Native discovery, preset copy, and prompt receipts also require different argument and response envelopes.

**Keep process-local retry records.** They disappear on restart and create a second persistence authority beside the existing inbox/event log.

**Use any successful flush callback as durability proof.** The selected persistence owner must also complete its own barrier; a notification observer is not storage.

## Consequences

Real Loader tests and a keyless snapshot cover duplicate concurrent/cold prompts, storage failure, late cancellation, and model-turn counts. Preset Loader tests cover copy/read/remove and native handoff authorization. Generated codec smokes check Native-shaped inputs and replies. Provider configuration transactions, exhaustive coverage, assembled application validation, and production promotion remain separate unclosed requirements.
