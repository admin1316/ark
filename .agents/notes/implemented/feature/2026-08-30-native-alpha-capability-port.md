# Agent Note: Native Ark port of the DSH alpha capabilities

Status: implemented

English | [中文](2026-08-30-native-alpha-capability-port.zh.md)

## Problem

DSH 0.1.2-alpha.1 adds conversation presentation, exact usage, provider and subagent controls, image request projection, ACP/SDK controls, optional DeepSeek request extensions, public WebFetch, and several recovery fixes. Ark cannot restore the retired Web UI because its visible surface is a native AppKit/SwiftUI product.

## Decision

Ark keeps all visible conversation, settings, navigation, language, typography, image, and provider-login controls in native SwiftUI/AppKit. The Host remains an API-only sidecar and carries the shared session, attachment, token-meter, process, ACP, SDK, WebFetch, plugin-inventory, session-log, and model-route behavior.

Completed native answers default to collapsed process details and system-prompt rows, expose an exact replay-validated usage disclosure, support adaptive or draggable content width, compact turn navigation, adjustable conversation size, and proportional Markdown tables. The native language and provider-login registries are value-owned and unloadable; missing optional Host locale support falls back to a non-secret local preference.

Request-image projection is deterministic and shared by attachment storage, DeepSeek Files, inline fallback, pi-ai, and token pressure. It bounds pixels and bytes, preserves alpha, converts unsupported sample depths, offloads old images by fixed quanta, and resolves local image paths only inside the model execution world. Durable JSONL provenance uses compact sequence ranges and warns when a torn tail is repaired.

Subagent route selection is opt-in and allowlist-backed. Child options inherit provider, model, reasoning effort, and output limits unless an authorized route changes them; Claude Code and Codex adapters pass their configured model through their own launch protocols. ACP and SDK paths validate initialization, model controls, images, permissions, cancellation, session state, and teardown without exposing a browser transport.

PTC is the model-facing name for the former Code Mode presentation while the `code` spelling and durable records remain readable. The official DeepSeek adapter has opt-in plugin-package and incremental session-log request extensions. Public WebFetch is enabled only through the address-validating, connection-pinned provider with fixed URL and response bounds.

## Alternatives considered

**Restore the alpha Web client.** Rejected because Ark's product invariant requires native visible UI; the sidecar is limited to authenticated API transport.

**Infer exact usage from a sample or estimate image tokens heuristically.** Rejected because an expandable exact disclosure must be withheld when lifecycle boundaries, bucket completeness, route attribution, or totals are not provable.

**Let model-selectable subagents use the live provider catalog.** Rejected because a changing catalog could widen authorization during a session; each eligible parent captures a validated allowlist.

**Use an ordinary DNS lookup for WebFetch.** Rejected because DNS rebinding could change a validated public hostname into a private destination; the provider validates the complete answer set and pins connections.

## Testing

The source and built Host aggregates compile, the Native Swift contract binary passes chat, localization, extension, image, process, and backend-recovery checks, the Ark static integration checks pass, the SDK stdio initialize/shutdown path passes, ACP tests pass 68/68, attachment tests pass 78/78, JSONL persistence tests pass 244/244, subprocess tests excluding the OS `ps` exit-hook lane pass 141 with 2 platform skips, SDK client tests pass 47/47, headless tests pass 10/10, and pi-ai configuration/conversion tests pass 83/83. Loopback-listening tests remain environment-blocked in the restricted runner; the external pi-ai 0.84.2 package is represented in the manifest and lockfile but is not present in the local dependency cache.

## Consequences

The native product gains the alpha conversation and recovery behavior without reintroducing browser assets. Exact disclosures may be absent for malformed or incomplete historical lifecycles, which is safer than presenting invented numbers. Image normalization and request versions add bounded derived storage and CPU work, while fixed caches, singleflight, and process recovery reduce repeated work and stuck conversations. A fresh dependency install is still required before the pi-ai 0.84.2 runtime-specific fields can be exercised locally.
