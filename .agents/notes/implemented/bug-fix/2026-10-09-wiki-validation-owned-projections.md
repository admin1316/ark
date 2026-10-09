# Agent Note: Wiki projections retain their validated owner

Status: implemented

English | [中文](2026-10-09-wiki-validation-owned-projections.zh.md)

## Problem

Wiki's configured per-file coverage rejects untested error paths even when its owning tests pass. Some missing paths represent public malformed-input or filesystem races; others sit behind an existing unconditional rejection or repeat defaults for values already produced by the same validated owner. Treating those groups alike can weaken rejection rules or disguise missing tests.

## Decision

[Reviews](../../../../packages/host/knowledge-wiki/src/reviews.ts) retain semantic receipt validation and reject canonical forward actions without measured trials. The unreachable canonical mutation and recovery tails are removed. Archive, Skip, correction and rollback keep their durable path, role, byte and auxiliary-name checks. The validated promotion journal carries the operation types established by its runtime checks into the private mutation helper. Newly constructed candidate projections use the producer's required provenance and timestamp; verification metadata comes from the already authenticated receipt.

[The Wiki model projection](../../../../packages/host/knowledge-wiki/src/index.ts) emits review metadata and provenance from one admitted pass. Content admission still checks current bytes before model exposure. The external verifier's private subprocess helper uses its caller's resolved timeout; the verifier hashes the candidate path validated before invocation. No public optional field becomes mandatory.

Model reads capture the session and project scope that authorized the service request before awaiting the Wiki lookup. Retrieved and injected events use that same session owner, and source content hashes remain optional across both projections.

[The learning reducer](../../../../packages/host/knowledge-wiki/src/learning-evaluation.ts) narrows pairs only after both arms have verified status. Incomplete and unverified pairs retain their unknown result. The graph narrows metric names after the required-name check and binds WAL validation to the actual trial supplied by the promotion owner. Authenticated replay preserves existing target sources through all journal transitions; current admission equality still rejects a changed canonical revision.

Static analysis explicitly lists the five Wiki fixture plugins loaded by snapshot YAML as entry files. Unused fixture-helper exports and one script type re-export are removed without changing the helper bodies, loaded plugin exports or evaluation CLI. This distinguishes actual dynamic entry points from internal test implementation.

## Alternatives considered

**Lower coverage thresholds or exclude affected files.** This hides missing malformed-input and race coverage. The existing per-file thresholds and source selection remain unchanged.

**Manufacture impossible private state.** Replacing local maps or owner-produced objects with artificial getters would exercise states the public entry path cannot reach. Public malformed-input tests and real filesystem interleavings cover the actual rejection rules; private duplicate defaults are removed only where the validated caller or replay invariant guarantees the value.

**Enable canonical writes to cover their dormant tails.** Semantic receipt success cannot authorize measured utility or a canonical transition. The forward-action rejection stays in force.

## Consequences

The implementation has fewer private projections and repeated fallbacks. It does not add a knowledge writer, evaluator custody, trial access, model capability, Rust activation, permission or release-policy change. Synthetic signing fixtures exercise the verifier and replay algorithms; they cannot attest production authority or cross-conversation learning.

## Testing

The owning tests cover public malformed envelopes, bounded artifact traversal, current-byte provenance mismatch, Archive recovery, terminal journal states and exact historical trial relations. [Filesystem and governance tests](../../../../packages/host/knowledge-wiki/tests/governance-filesystem-coverage-closure.spec.ts) interleave real inode changes and verify that failed transitions preserve prior state and close opened descriptors. Source coverage, keyless replay, candidate build, Native behavior, current-revision CI and formal acceptance remain separate evidence.
