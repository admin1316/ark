# Agent Note: P0 batch C — demo env track, anonymous-id permissions, envelope and telemetry redaction

Status: implemented

English | [中文](2026-08-16-p0-batch-c-demo-env-anonid-telemetry.zh.md)

## Problem

The enterprise audit's remaining launch-scoped and export-path defects. First, the ACP and JSON-RPC demo entry points loaded `.env` through the unfiltered `loadEnv` track, so a `.env` in an untrusted project directory could set `DSH_HOME` (redirecting the whole harness home) or inject `NODE_OPTIONS`/`LD_PRELOAD`-class launch variables, amplifying the node-pty override surface. Second, the anonymous user id was persisted with default umask permissions (`0o644` file / `0o755` home), exposing the stable machine identity to other local users against the repository's `0o600`/`0o700` convention. Third, two export paths leaked credentials in the clear: the fetch carrier's `subscribeEnvelopes()` observation tap handed out outbound request envelopes including `apiKey` payload fields verbatim, and FULL-mode session telemetry exported `structuredClone(event.data)` as-is with no redaction rule shipped, so user input, tool arguments, and conversation bodies went to the OTLP collector raw.

## Decision

**Demo entry points switch to the layered env track.** `dsh-acp-demo` and `dsh-jsonrpc-agent` now call `loadLayeredEnv` (project `.env` + harness-home `.env`, bootstrap-name rejection before any value is materialized) instead of `loadEnv`; the unfiltered helper stays exported for API compatibility but has no in-repo consumer left.

**The anonymous user id is owner-only.** `getOrCreateAnonymousUserId` creates the home with `0o700` and the id file with `0o600` on both the exclusive-create and overwrite paths. Regression asserts both modes.

**The envelope observation tap redacts secret payload fields.** `AbstractApiClient.onEnvelope` pushes a detached copy with `apiKey`/`accessToken`/`refreshToken` payload fields replaced by `[redacted]` when they carry string values; the wire request body is untouched. Regression asserts the observer sees the marker while the handler receives the real key.

**Session telemetry ships a built-in credential-key mask.** The coordinator's `redact()` applies `maskCredentialKeysInRecord` before the `session-telemetry/record` waterfall: any field whose name matches `/(api[_-]?key|token|secret|password|passwd|authorization|auth[_-]?header|credential)/i` anywhere in the body or attributes is replaced by `[redacted]` on the exported copy (field-name matching keeps ordinary conversation text legible). Deployment-mounted listeners still stack on top of the built-in default. JSDoc, README, and the telemetry revival Agent Note are updated from "ships NO rules" to the built-in-default semantics.

## Alternatives considered

**Redact only at the OTLP exporter.** Rejected: the coordinator is the single capture choke point, and the waterfall contract already documents that redaction applies to the exported copy only; masking before the waterfall keeps every downstream consumer covered.

**Deep-parse JSON-string payload fields (e.g. `tool/call` arguments).** Rejected: string contents are conversation text, not structured fields; field-name matching is the documented contract, and deployment rules can stack stricter masking.

**Keep `loadEnv` in the demos and document the risk.** Rejected: the product CLI already rejects bootstrap names; leaving the demo track unfiltered recreates the exact injection the audit flagged, amplified by the node-pty override channel.

## Consequences

Demo `.env` files may now reject names that the product CLI already rejected; deployments relying on a `.env` to set `DSH_*` must export those variables instead. Telemetry FULL-mode exports are no longer byte-identical to the session log — credential-shaped fields are masked by default, and deployments needing the raw copy must mount a rule that restores it. The anonymous id file's permission change is invisible to the same user and blocks other local users from reading it.
