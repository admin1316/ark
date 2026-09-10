# Agent Note: Provider transaction execution ownership

Status: implemented

English | [中文](2026-09-06-provider-transaction-execution-ownership.zh.md)

## Problem

An atomic journal check does not protect later asynchronous credential writes. A duplicate executor can finish the same transaction and a newer transaction can commit while an older executor awaits a credential read. Detecting the changed journal after the old write cannot restore the newer value.

## Decision

The existing [LLM transaction owner](../../../../packages/llm/llm/src/provider-transaction.ts) reserves execution through the whole operation. It acquires the provider journal, then the settings namespace, then all removed or adopted credential references. Keys within the final tier are reserved together. The fixed acquisition order and rejection of nested transaction callbacks avoid lock inversion. Provider calls are FIFO; unrelated resource sets can run independently.

Leases bind Cordis's original service identity rather than a caller's traceable proxy. Their settled promise tails and callback-execution scope contain no profile, secret, revision or durable outcome. The existing settings revision and transaction journal remain authoritative. New stale requests fail before credential staging. Exact completed-receipt replay does not reapply profile or credential mutations and rejects a journal that became active; an existing legacy journal upgrade changes metadata only.

Cancellation before claim leaves credentials and profiles unchanged. Starting durable claim is the cancellation boundary: normal commit or failure/recovery settlement retains the lease, including owner callbacks. This prevents cancellation from exposing unfinished side effects to the next executor. Pending non-cancellable I/O is not abandoned to release the lease early.

The [endpoint-generation decision](2026-09-06-provider-endpoint-generation-replay.md) remains active for reference allocation, request binding and durable replay. Execution ownership supplements those checks rather than replacing their provenance or fail-closed behavior.

The [journal recovery decision](2026-09-09-provider-journal-recovery.md) owns before-image verification, legacy normalization and explicit Native status/resume. Its format rules do not weaken these execution leases.

## Alternatives considered

**Check only at claim or after writing.** A snapshot can become stale across the credential read, and the later journal refusal detects corruption after it happened.

**Use one Host-wide mutex.** An unrelated provider would wait for another provider's I/O or owner callback despite sharing no mutable resource.

**Allow nested mutations while retaining the outer lease.** Waiting for that lease self-locks; executing through it permits a stale outer snapshot to survive a newer commit. Callback mutations instead reject explicitly.

**Abandon an operation on cancellation.** An already-started write may finish after the next transaction, so cancellation cannot release ownership before the operation settles.

## Consequences

Source regressions use synthetic services with external promise barriers to retain genuine concurrent requests, and check ordered writes, stale-revision refusal, failure release, cancellation, reference sharing and independent progress. A reentrant fixture that waits for a nested mutation inside its own held read is not used to emulate independent callers. The original old-value-overwrite scenario still fails before serialization with the external driver.

These leases coordinate one Host's shared service owners. Cross-process writers and privileged operations bypassing this owner require separate isolation; the mechanism is not a distributed storage transaction. Installed-app interaction, real-provider behavior and full coverage acceptance remain separate evidence requirements.
