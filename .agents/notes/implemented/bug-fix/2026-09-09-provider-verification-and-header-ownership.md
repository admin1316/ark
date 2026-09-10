# Agent Note: Provider verification and credential-header ownership

Status: implemented

English | [中文](2026-09-09-provider-verification-and-header-ownership.zh.md)

## Problem

A public model catalog can answer with any credential, so a successful metadata request does not establish authentication. Cancelling an uncooperative probe does not prove its request stopped. Literal credentials inside a generic header dictionary can also escape schema-role redaction or persist beside ordinary connection settings.

## Decision

The existing [LLM owner](../../../../packages/llm/llm/src/index.ts) owns exact-route verification admission, deadlines and cancellation settlement. A cancelled operation retains its route/model reservation until it settles. A grace timeout reports still-running work rather than claiming quiescence. Owner disposal stops admission and awaits the same work. The default adapter hook declares unsupported metadata verification; the owner then performs an explicitly classified one-token handshake without conversation history and discards its output.

The [pi-ai adapter](../../../../packages/llm/llm-pi-ai/src/adapter.ts) captures its current profile before credential resolution. Its [metadata verifier](../../../../packages/llm/llm-pi-ai/src/verification.ts) checks the exact model id, bounds declared and streamed response bytes, refuses redirects, then challenges the endpoint without credentials. A 401 or 403 challenge distinguishes authenticated metadata from mere reachability. Response cleanup failures cannot replace the already-selected HTTP or size failure.

The [header resolver](../../../../packages/llm/llm-pi-ai/src/headers.ts) admits public fields and explicit credential references separately. The existing Credentials service resolves reference values at request time. Every explicit credential-backed header is absent from the unauthenticated challenge, including vendor-specific names that look public. Non-empty literal credential-looking headers retain their on-disk data but withhold the route, expose value-free migration fields and reject new writes. Settings projects resolved, base and user layers through the same owner redactor. Empty Authorization remains a non-secret protocol override; case-insensitive duplicates reject before dispatch.

These rules complement the [provider journal decision](2026-09-09-provider-journal-recovery.md), which still owns durable configuration mutation and recovery, and the [native risk boundaries](2026-08-29-ark-native-risk-boundaries.md), which still own package and application acceptance. Neither note is superseded.

Schema acceptance does not prove a field is public: Schemastery retains undeclared fields. The same redactor therefore projects retained root and profile data through the live Config schema and hides every undeclared field without guessing credential names. Declared dictionary keys, model-capability fields and public fields across union alternatives remain available. Malformed declared values and references fail without echoing data, as do non-JSON or cyclic structures. Profile requirements carry value-free relative paths and deployment ownership. Native migration requires explicit consent plus a new credential and reuses the existing transaction; it cannot remove deployment-layer fields through user-layer edits.

Model capacities must be positive safe integers before crossing the Host result boundary. The native decoder additionally uses a failable exact integer conversion, so malformed endpoint metadata cannot trap the application. Invalid external listing capacities remain unknown, not a lower invented model limit. Native catalog discovery cancels its previous task and ignores late cancelled results; reading an installed catalog carries no credential.

## Alternatives considered

**Treat catalog success as authentication success.** A public catalog makes an invalid key indistinguishable from a valid one; the response must say reachability-only unless the challenge proves authentication.

**Release the reservation when cancellation is requested.** An adapter can ignore cancellation; releasing early admits another request while the first still runs.

**Filter challenge headers only by name.** A credential can use an arbitrary vendor header name. Explicit reference provenance, not a heuristic alone, identifies every value that must be removed.

**Erase stored literal headers during discovery.** A read cannot silently destroy user configuration. The owner hides values and withholds activation until an explicit configuration change supplies safe references.

**Rely only on configuration types or native integer conversion.** Unknown configuration fields survive schema resolution, and a JavaScript number can exceed Swift's integer range. The data owners validate the actual value before exposing it, and the native consumer independently refuses unsafe wire values.

## Consequences

Metadata authentication does not prove generation entitlement, modality support or future provider availability. Unsupported probes can consume a bounded generation request. Uncooperative work remains an explicit failure and can prevent clean shutdown. Public header fields cannot identify arbitrary undeclared secrets; callers must use credential references for those values. Base-layer dictionary keys still require a composition edit to remove, under the existing Settings merge semantics.

[Lifecycle tests](../../../../packages/llm/llm/tests/provider-verification.spec.ts), [header tests](../../../../packages/llm/llm-pi-ai/tests/headers.spec.ts), [metadata tests](../../../../packages/llm/llm-pi-ai/tests/metadata-verification.spec.ts) and the [real Loader snapshot](../../../../packages/llm/llm-pi-ai/tests/loader-composition.spec.ts) pin cancellation, exact authentication classification, secret-safe reads and refused writes. They use synthetic credentials and replace only the external model endpoint. Candidate GUI, live provider validation and production promotion remain separate acceptance work.
