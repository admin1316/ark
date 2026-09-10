# Agent Note: Provider journal recovery without invented revisions

Status: implemented

English | [中文](2026-09-09-provider-journal-recovery.zh.md)

## Problem

An application restart preserves a provider journal but resets in-memory Settings revisions. Matching that numeric revision alone can overwrite newer persisted configuration. A native client retaining only the transaction id cannot safely recreate the original edits, and a failed transport response cannot prove that the operation never committed. Retained version-1 journals also lack the completed-receipt history used by the reconstructed writer.

## Decision

The [provider transaction owner](../../../../packages/llm/llm/src/provider-transaction.ts) reads complete, digest-validated version-1 plans into the same internal representation as current receipt-bearing journals. Both keep the version-1 grant envelope; `receiptVersion: 1` identifies the current receipt history. Querying does not rewrite either form. Explicit mutation or recovery claims the exact stored record before writing the current form, retaining the available transaction identity and terminal receipt rather than inventing discarded history.

New plans bind the original raw user-section digest. Recovery can use a fresh in-memory revision only when that digest still matches. If uncommitted edits lack that proof or their before-image changed, recovery retains the stored profile and records a rolled-back outcome. Already-applied edits can be reconciled without repeating them. Unknown formats, missing plans, invalid digests and unsupported operation fields reject without clearing data. These rules supersede revision-only continuation and request-bound legacy guessing in the [endpoint-generation note](2026-09-06-provider-endpoint-generation-replay.md); its generation and exact-input provenance rules remain useful.

`llm/providerTransaction` returns the retained phase or terminal outcome without plan contents or secret values. `llm/resumeProvider` accepts a provider, transaction id and optional write-only missing credential, and executes the stored plan under the [existing shared-service leases](2026-09-06-provider-transaction-execution-ownership.md). Object key order and refreshed revisions do not change current retry identity; array order and business values do. Completed receipts remain immutable outcomes, including persisted-but-not-live failures.

Credential rotation uses a deterministic fresh reference when the supplied reference is configured or already belongs to the profile, including same-endpoint rotation. A failed settings write therefore cannot change the old active key. An existing different value at a staged reference is refused. Unsets wait for activation, while generic Settings Remote protection belongs to each calling fiber. The [file provider](../../../../packages/settings/settings-file/src/index.ts) compares the target namespace under its writer lock before replacing it, retaining unobserved sibling edits and rejecting target drift.

New credential plans persist a secret-free before-image. The [Credentials owner](../../../../packages/credentials/credentials-local/src/index.ts) checks conditional staging and deletion against ordinary writes under its existing queue and document lock, including Keychain mode. A terminal success checks the resulting reference under that exclusion through the journal commit. A changed credential is preserved and produces `committed-not-live`, not a successful receipt. Settings failure compensates a newly staged value only when the plan proves prior absence and the digest still matches; cleanup failure retains a retryable journal. Retained plans without that proof cannot authorize deleting an existing value. Cancellation is checked inside every durable claim, including terminal normalization after queue waits.

Native Settings binds status and recovery actions to the caller-held transaction id. Reading does not create an id, recovery is explicit, and a late reply cannot clear a newer id. Only a proven terminal outcome releases a failed call's pending identity. Runtime disposal stops admission and drains accepted work; disappearing activation owners produce an explicit persisted-but-not-live outcome, not successful activation.

## Alternatives considered

**Treat an unreadable journal as an empty store.** This destroys the only available operation identity and can replay already-committed work.

**Guess a restart revision or rebuild operations from the UI.** Neither reconstructs the original before-image or original intent; a refreshed form can describe a different operation.

**Overwrite the same credential reference and compensate later.** Compensation cannot recover an old secret already lost to a partial write, so staging must not modify the active reference.

**Create another database for recovery state.** The existing credential record already owns the durable transaction; another store introduces a second commit boundary.

**Check only the final credential value.** An unconditional delayed unset can already have deleted a concurrent replacement; an absence check cannot detect that loss. Conditional deletion must run in the reference owner before removing anything.

## Consequences

Safe recovery includes explicit refusal: it does not promise successful continuation for legacy plans missing before-image proof or records lacking their operations. Terminal failures remain terminal even if a later runtime can load the stored profile. Unknown earlier transaction identities cannot be reconstructed from a journal that already discarded them. Orphan file locks are not guessed or automatically removed.

Value-digest conditions protect participating writers using the same credential document, not arbitrary Keychain writers or identical-value ABA changes. A retained legacy plan cannot prove whether an existing unreferenced secret was staged by that transaction; recovery preserves it rather than guessing a deletion. Such refusal is not complete credential rollback.

The [frozen fixture](../../../../packages/llm/llm/tests/fixtures/legacy-v1-journals.json) is byte-pinned output from the retained implementation using synthetic credentials, not a rewritten current-format sample. [Behavior checks](../../../../packages/llm/llm/tests/provider-transaction.spec.ts), [fresh-process checks](../../../../packages/llm/llm/tests/provider-process.spec.ts) and the [Loader snapshot](../../../../snapshots/native-provider-recovery.snapshot.ts) cover read-only status, normalization, stale and duplicate recovery, secret-safe failures and restart. Forced exits occur after durable writes release their file locks; this is not a claim of recovery from arbitrary power loss or abandoned locks. Native codec and lifecycle contracts remain separate from candidate GUI and production acceptance.
