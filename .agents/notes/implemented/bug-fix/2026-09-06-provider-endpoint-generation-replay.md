# Agent Note: Provider endpoint generation replay

Status: implemented

English | [中文](2026-09-06-provider-endpoint-generation-replay.zh.md)

## Problem

A version-shaped credential reference is not proof that it belongs to the next endpoint. Exempting such names from generation rotation lets a second endpoint change overwrite the previous endpoint's secret before its settings switch. Removing that exemption alone can instead generate another reference when an interrupted transaction is retried or resumed.

## Decision

The existing [LLM Remote transaction owner](../../../../packages/llm/llm/src/remote.ts) allocates a deterministic reference whenever a changed endpoint would reuse its current reference, regardless of its name. Same-endpoint rotation retains that reference. The durable plan binds the original request digest when normalization changes the request; this contains a secret digest, never its value. The journal digest covers that binding.

An exact retry or durable resume reuses the recorded plan after checking provider, namespace, settings path, input binding and journal digest. The existing atomic journal claim requires that a replay still owns that transaction: a replaced or deleted journal cannot be recreated from a stale replay snapshot. New transactions retain their separate completed-journal replacement behavior. Revision advance remains compatible with exact retries; changed operations or credentials do not. Existing ownership, secret-path, writable-source and activation checks remain required.

The resume entry carries its original journal snapshot through shared mutation admission to that claim. It must not reread a newer journal and silently classify the old resume as a new transaction. This applies to set, unset and settings-only resumes; they use the same existing journal owner.

The [execution-ownership decision](2026-09-06-provider-transaction-execution-ownership.md) protects the asynchronous operation through settlement; a journal claim alone does not establish that lifetime ownership. Reference generation and input binding remain this note's separate responsibilities.

## Alternatives considered

**Trust the versioned name.** A reference can be current for one endpoint yet stale for the next, which reproduces the premature overwrite.

**Normalize every replay against current settings.** Settings may already have switched, so this cannot reconstruct the original request or its claimed generation reliably. Replays use the durable plan instead.

## Consequences

Existing durable plans without the new original-input binding remain replayable by their exact stored input. Older request-bound journals retain their existing exact-retry upgrade. An old unsafe plan is not silently migrated during recovery; the change protects newly planned endpoint switches. It does not roll back earlier credential overwrites.

[Behavior regressions](../../../../packages/llm/llm/tests/remote-coverage.spec.ts) cover two endpoint switches, same-endpoint rotation, four persisted interruption phases, exact retry and resume, changed-input refusal, legacy plans, altered journal identity and replacement or deletion between replay read and atomic claim, including the outer resume entry. Fixtures use in-memory settings and synthetic secrets. They establish neither real-provider traffic isolation nor installed-app GUI stability.
