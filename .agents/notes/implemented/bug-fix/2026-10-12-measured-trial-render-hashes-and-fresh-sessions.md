# Agent Note: Measured-trial rendered evidence and fresh sessions

Status: implemented

English | [中文](2026-10-12-measured-trial-render-hashes-and-fresh-sessions.zh.md)

## Problem

The measured-trial reader treated the raw source-page hash and rendered tool-result hash as one value. Actual Wiki tools render a titled content block, so a valid use receipt could not pass. The reader also let separate preregistered pairs reuse the same session ID and be counted as separate observations.

## Decision

The reader keeps the three existing hash domains distinct. The proposal target hash, use receipt `contentHash`, and injected event `sourceContentHash` bind raw Wiki bytes. The injected event `contentHash` and `resultHash`, plus receipt `renderedToolResultHash`, bind the serialized rendered result. The selected injected event must bind the receipt's knowledge ID, call ID, session scope, verified page status, source hash, rendered value, event hashes, and byte count. Since the existing selected-event artifact is canonical JSON, the reader compares parsed rendered values canonically while retaining exact raw-byte SHA-256 checks for the rendered artifact.

Every baseline and candidate use in a trial has a unique session ID and unique `useId`. Call IDs and event sequences remain session-local and may repeat in fresh sessions. The authenticated owner capture continues to validate the complete retrieval, tool call/result, and provider-request chain; the measured-trial reader does not parse the complete journal.

## Alternatives considered

- **Treat the rendered hash as the raw source hash:** rejected because the real Wiki tool renders a title and content block whose bytes differ from the source page.
- **Require globally unique call IDs or event sequences:** rejected because those identities are local to a session and valid fresh conversations can reuse them.
- **Add a new journal parser or format field:** rejected because the existing authenticated capture owns complete event coherence and the frozen receipt format already carries the required hashes and session ID.

## Consequences

Valid rendered Wiki evidence can pass the reader while source-page identity remains tied to the exact proposed bytes. A preregistered observation cannot be duplicated by resubmitting it under another pair ID in the same session or by repeating a use ID across pairs or arms. These checks do not establish real evaluator or journal-signer custody; production trust provisioning and independent verification remain separate deployment gates.

## Testing

The measured-trial fixtures cover rendered/source hash separation, event-to-render binding failures, reused-session and repeated-use-ID rejection, and valid pairs whose fresh sessions reuse local call IDs and event sequences. The capture owner test passes actual `captureKnowledgeUse` and `sealCapturedUse` output into the reader with isolated test keys.
