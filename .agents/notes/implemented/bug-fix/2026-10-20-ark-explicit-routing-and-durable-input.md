# Agent Note: Explicit Ark routes, project ownership and durable input

Status: implemented

English | [中文](2026-10-20-ark-explicit-routing-and-durable-input.zh.md)

## Problem

Knowledge operations can send a credential to the wrong service when a shared key is combined with a fixed external endpoint. A mutable current-project selection can redirect work after an asynchronous boundary. Treating binary containers as UTF-8 or synthesizing research with zero sources makes successful transport look like successful knowledge processing. Clearing a draft before durable prompt admission can lose the only retryable input. Startup and teardown also need bounded ownership beyond an alive process or cancelled task handle.

## Decision

Knowledge text and image tasks select registered LLM routes independently and reuse their prepared-call protocol and credential owner. Vector search requires its own complete endpoint, model, provider label and credential reference; redirects cannot forward the credential. The `knowledge-wiki` settings namespace persists route references through revision/CAS. Empty image configuration preserves local media without a caption; empty vector configuration uses local keyword retrieval. A multi-stage task prepares both model calls before the first request, retaining the provider's credential-value rotation contract. [The package reference](../../../../packages/host/knowledge-wiki/README.md) owns the configuration and file-format limits.

Native embedding credential rotation writes a fresh independent reference before CAS-publishing the whole route. It never overwrites the active route's reference. A failed or lost CAS response retains the fresh local credential because the route may already have committed; refreshing public settings resolves that uncertainty without deleting a possibly active credential.

The native connection editor follows the surrounding settings cards, aligns route selections and groups optional vector fields behind a disclosure. Visible field labels and a distinct Save action preserve credential purpose and explicit commit semantics.

Native knowledge search and page selection cancel the superseded transport request through the existing operation owner. Clearing search or switching projects also cancels those reads. Generation checks still reject stale responses, but do not substitute for cancelling work that is no longer needed.

Knowledge ingest retains one serial drain, while each caller waits for its own project-scoped task result. Branded admission identities bind durable cancellation intent to the accepted attempt. Public queue cancellation affects pending tasks; project revocation owns active cancellation. Atomic batch admission, bounded terminal history and matching read/write byte budgets prevent a queue from writing state it cannot restore. Source completion, cancellation and retry dispositions survive history pruning. Restore validates before publishing tasks or project selection.

Research shares an in-flight operation only within the same project, topic and connection snapshot, with bounded concurrency. Its total deadline starts before local search credential preflight; expiry cancels the owner and retains capacity until work stops. Native requests freeze the Host's published budget plus a transport grace period, use an absolute deadline, and reject stale responses by operation identity. Ordinary RPC deadlines stay unchanged. Research candidates publish complete temporary files without replacing an existing page. Search preflight awaits deferred local credentials before any paid query expansion; synchronous provider selection alone cannot establish that an asynchronous credential exists.

Session projection storage owns one active write and the latest pending snapshot per session, shared by live checkpoints and cold-read writeback. Failed writes retain pending state for retry. A composite disposer drains writers before releasing the storage domain, including on failure. This coalesces disposable derived snapshots without dropping canonical session events; backpressure for required event persistence remains a separate admission design.

Every project-scoped request carries a registry-issued `projectContext`. Host admission resolves it once to an immutable project execution context; later selection changes cannot redirect reads, writes, review, queue or research work. Removal revokes the token and cancels owned operations; Host restart expires all tokens. Native responses also check project and loading generations. Automatic session summaries bind a registered secondary session workspace and its lifetime before model execution. Candidate writes share the confined filesystem owner, rejecting symbolic links in directory ancestors. File extraction rejects unsupported, binary, malformed or oversized source inputs before model analysis. Research preflights the shared web service before expansion and requires citeable sources before synthesis or publication; partial results retain their warnings.

Ordinary prompt submission retains an owner-only, synchronized draft and attachment journal until Host durability acknowledgement. Caller-stable invocation identity plus payload digest deduplicates uncertain retries against logged inbox receipts, including cold sessions. The Host flushes the owning session before returning acceptance. Native clearing compares the submitted payload with the current draft, so a later edit does not disappear. New-session migration preserves recoverability across session creation. A single writer keeps only the latest waiting snapshot per draft; send and shutdown wait for persistence. Autosave and in-flight payloads share an attachment journal where their attachments match, while their distinct durable pointers retain independent recovery ownership. Replaced journals are removed only after durable pointer publication and reference checks. These guarantees do not make arbitrary slash-command side effects idempotent and do not replace the canonical accepted-image object store.

Each backend launch has one readiness deadline, defaulting to thirty seconds with a signed metadata override, and one generation identity. Ready, failure, exit and quit invalidate its wait; a timeout stops the owned process and enters recovery only after reap. Existing bounded restart and stable-window rules remain authoritative. Backend output callbacks retain their launch identity. Shutdown cancels and awaits knowledge loading and polling, worker outcomes settle once, and cancelled or stale fallback results cannot overwrite another project.

Ark's explicit test inventory rejects unregistered, missing and duplicate tests. Required CI separates portable regressions, Swift contracts and isolated macOS packaging/install behavior. The metadata-only evaluation tool defines 24 synthetic tasks over two rounds and keeps unexecuted, skipped, synthetic and measured observations distinct. Neither a catalog entry nor an offline report certifies a provider or authorizes a paid call. [Engineering notes](../../../../integrations/jiuzhang/docs/engineering.md) own commands and installed acceptance.

## Alternatives considered

**Reuse the chat key for every service.** An independently addressed embedding or vision endpoint does not inherit ownership of another provider's credential. Explicit route selection avoids accidental cross-service disclosure and permits an honest unconfigured state.

**Read the current project after each await.** A relative path can name a different file in another project, including when both initial contents match. Immutable admission identity protects ownership independently of path and content equality.

**Clear input optimistically and restore it after an error.** A process can disappear before error handling, and a failed response does not prove the Host rejected the input. Persistent drafts plus durable receipts preserve recoverability without duplicating accepted work.

**Treat nonempty extraction or a successful model response as research success.** Binary noise and zero-source synthesis satisfy those weak conditions. Supported-format validation and source requirements reject misleading results before further paid work or publication.

**Rewrite an active credential before switching the route.** Concurrent requests can observe the old endpoint and the new secret, and a rejected CAS can leave that mismatch active. Fresh references avoid the intermediate mismatch without a cross-service rollback that could delete a committed credential.

**Extend manual release checks alone.** Unregistered suites can silently stop running. An explicit inventory and required CI jobs detect that omission while preserving separate native interaction and publication decisions.

**Limit memory by discarding queued session events.** Those events are the durable conversation authority. Only superseded derived checkpoints can be coalesced; required event storage needs explicit upstream admission and failure handling.

## Related decisions

The [native risk boundaries](2026-08-29-ark-native-risk-boundaries.md) retain candidate-only builds, secret-safe credential mutation, event-pump quiescence and Workbench recovery. [Native shell packaging](2026-08-15-ark-native-shell-recovery-and-packaging.md) retains fresh process/pipe ownership and signing order. The [lock and exit-identity decision](2026-10-19-native-candidate-lock-and-exit-identity.md) retains exact dependency and signal authority. [Image admission](../feature/2026-07-22-web-multimodal-image-input-and-durable-attachments.md) retains accepted-object durability and authorized reads; client draft recovery is the narrower extension here. [Knowledge ingest](../architecture/2026-08-19-knowledge-wiki-contract-aligned-ingest.md) retains persisted queues and canonical write rules. These are partial overlaps with independently useful rationale, so the notes remain active rather than entering the frozen archive.

## Consequences

Unconfigured cloud features explicitly stop or use local keyword retrieval. Unsupported PDF/Office imports fail before analysis until a validated parser exists. Project tokens must be reacquired after backend replacement. Durable local drafts consume bounded disk storage and require cleanup distinct from accepted message objects. A thirty-second startup default can require a deployment override on unusually slow machines.

Focused contracts cover wrong-service credential routing, project switching, unsupported binary input, zero-source research, durable retry admission, independent-process draft recovery, readiness ownership and test inventory failures. Their presence and individual results do not establish the final candidate's native interaction, installed package, privacy or release acceptance. Formal replacement and Git publication remain separate explicit user decisions; this note records no final candidate verdict or live model-quality result.
