# Agent Note: Provider endpoint generation replay

Status: implemented

English | [中文](2026-09-06-provider-endpoint-generation-replay.zh.md)

## Problem

A version-shaped credential reference is not proof that it belongs to the next endpoint. Exempting such names from generation rotation lets a second endpoint change overwrite the previous endpoint's secret before its settings switch. Removing that exemption alone can instead generate another reference when an interrupted transaction is retried or resumed.

## Decision

The existing [LLM Remote transaction owner](../../../../packages/llm/llm/src/provider-transaction.ts) allocates a deterministic reference whenever a changed endpoint would reuse its current reference, regardless of its name. The [journal recovery decision](2026-09-09-provider-journal-recovery.md) extends rotation to configured same-endpoint references. Original-input bindings contain a secret digest, never its value; retained legacy plans and current receipt-bearing journals carry their respective bindings.

An exact retry or durable resume reuses the recorded plan after checking provider, namespace, settings path, input binding and journal digest. The existing atomic journal claim requires that a replay still owns that transaction: a replaced or deleted journal cannot be recreated from a stale replay snapshot. New transactions retain their separate completed-journal replacement behavior. Revision advance remains compatible with exact retries; changed operations or credentials do not. Existing ownership, secret-path, writable-source and activation checks remain required.

The resume entry carries its original journal snapshot through shared mutation admission to that claim. It must not reread a newer journal and silently classify the old resume as a new transaction. This applies to set, unset and settings-only resumes; they use the same existing journal owner.

The native Settings editor reads `apiKeyEnv` only at the selected provider's declared namespace and path. Missing profiles do not fall back to a namespace-wide recursive lookup. New-reference suggestions avoid configured API-key references, while existing explicit references remain unchanged. Credential-state loading, card drafts and custom-provider creation use the same resolver. These suggestions do not establish ownership: the Host still rejects cross-provider writes, and a credential save includes its profile binding in the same transaction.

The native Models form keeps expandable provider cards in an eager stack inside its scroll view. Viewport-driven lazy layout is not a draft lifecycle boundary. Live candidate sampling on macOS 26.5 exposed repeated AttributeGraph and lazy-stack layout work after changing the added provider; the source layout check does not replace native scrolling and idle-CPU acceptance.

Native settings refresh owns the Host model directory independently of selected-session metadata. Each refresh replaces even an empty directory, rejects stale completions and refreshes the selected session's choices. Conversation presentation caches retain history but not live model catalogs. A missing named credential is not a usable menu choice. The standard desktop presents one brand menu, deduplicates model ids while retaining each remaining model's route, and does not expose Token Plan variants in its ordinary API workflow. Persisted profiles and historical selections are not rewritten by presentation filtering.

The ordinary Bailian presets reuse the installed Qwen protocol implementation and canonical model capabilities with distinct ordinary endpoints and credential ownership. They send the documented `max_tokens` field and use bounded minimal generation for exact authentication verification instead of requiring a model-detail metadata endpoint. Native connection results are bound to the tested provider/model and invalidated when settings refresh. A reachability-only result stays unverified.

An OpenAI-compatible model-detail response of 404 or 405 defers verification to the existing exact-generation owner; it is not success or proof of an invalid key. Authentication rejection remains an error, and a failed generation cannot produce a verified result. This avoids requiring an optional metadata API from a provider that can serve model requests.

The [execution-ownership decision](2026-09-06-provider-transaction-execution-ownership.md) protects the asynchronous operation through settlement; a journal claim alone does not establish that lifetime ownership. Reference generation and input binding remain this note's separate responsibilities.

## Alternatives considered

**Trust the versioned name.** A reference can be current for one endpoint yet stale for the next, which reproduces the premature overwrite.

**Normalize every replay against current settings.** Settings may already have switched, so this cannot reconstruct the original request or its claimed generation reliably. Replays use the durable plan instead.

**Accept a sibling credential when a new route has no profile.** Presentation groups do not own credentials. Namespace-wide fallback can select a different provider's reference and cause a rejected save; relaxing the Host check would instead permit credential corruption.

## Consequences

Provider transaction settlement compares runtime presence with the effective profile, so removal is not mistaken for failed activation and inherited profiles remain live. An absent custom declaration permits only its exact retained whole-profile removal when the user operations are satisfied, the effective profile is absent, and no current declaration claims an overlapping path. The retained plan can complete credential cleanup or return its receipt, not authorize a new mutation. The pinned Responses parser preserves server-reported model metadata in the existing replay envelope; no proxy model is independently attested by that report.

Native invocation details project allowlisted fields from durable request headers and assistant provenance. Requested aliases never fill absent server-reported model fields; recognized pi-ai replay responses supply optional reported model and response ids. This projection does not serialize whole headers, replay signatures, or credentials. Stream throughput sums measured completed-call intervals, not the span across tools or retry backoff. Output counts can include reasoning; first-response time describes a stream event rather than visible text. These diagnostics do not independently attest the remote model or establish a performance improvement.

Complete retained plans are normalized by the [journal recovery owner](2026-09-09-provider-journal-recovery.md). A missing before-image does not authorize uncommitted edits after restart; incomplete request-bound records are refused rather than guessed. Reference generation protects new switches but cannot recover a secret already overwritten by an earlier unsafe write.

[Behavior regressions](../../../../packages/llm/llm/tests/provider-transaction.spec.ts) and [process-boundary checks](../../../../packages/llm/llm/tests/provider-process.spec.ts) exercise reference isolation, current and legacy journals, retry/resume and changed ownership through real Loader and file-storage owners with synthetic credentials. They establish neither real-provider traffic isolation nor installed-app GUI stability.
