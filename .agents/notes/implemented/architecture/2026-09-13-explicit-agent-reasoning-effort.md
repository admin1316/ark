# Agent Note: Preserve explicit Agent creation reasoning effort

Status: implemented

English | [中文](2026-09-13-explicit-agent-reasoning-effort.zh.md)

## Problem

The first Agent request reconstructed reasoning effort from history without reading the explicit creation option. A fresh SDK Agent configured with `max` could therefore send the adapter's `high` default. The durable header and provider request agreed with each other but failed to represent the caller's declared intent.

## Decision

The first request of each loop instance takes `AgentOptions.reasoningEffort` when supplied. Otherwise, it restores the last recorded effort only when the provider/model route matches and the header does not mark the effort as an adapter default. An absent value remains absent until request policy and exact-model preparation resolve it.

The `agent/request` waterfall can still replace the proposal. Adapter validation, effective `request/header` logging, default-origin markers, and prepared-call dispatch retain their existing ownership. Subsequent requests use the recorded proposal and rematerialize marked defaults; the creation option does not overwrite later request policy.

This clarifies initial-value precedence within [adapter-owned reasoning capabilities](2026-07-24-adapter-owned-reasoning-effort-capabilities.md); that note remains authoritative for model vocabularies, validation, defaults, and provider serialization. [Adapter-owned output defaults](2026-07-30-adapter-owned-max-token-defaults.md) are unchanged.

## Alternatives considered

**Repair only the SDK or Native caller.** The caller already carries the declared effort. An adapter-specific workaround would leave direct loop callers with the same missing option and duplicate provider-neutral request assembly.

**Always restore history first.** This discards a caller's explicit creation choice when reopening a Session. History is the fallback only when no explicit option is supplied.

**Reapply the creation option on every request.** This would erase later `agent/request` decisions and change the existing default-marker lifecycle.

## Consequences

Explicit creation choices reach the first validated and durably recorded provider request without changing the set of supported effort ids. Unsupported values still fail before provider I/O. Omitting the option preserves same-route explicit history recovery and adapter-owned default resolution.

The loop request-reconstruction tests assert the explicit first header and preserve resume/default behavior. The SDK's local HTTP provider test asserts the serialized effort, covering the caller-to-provider path without a credential or external API.
