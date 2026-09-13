---
description: "The deployment default used when an entry point creates an Agent that has no session-local model selection."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-default-model

English | [中文](README.zh.md)

## Summary

The deployment default used when an entry point creates an Agent that has no session-local model selection. `AgentDefaultModelConfig` provides `ctx.agentDefaultModel`; direct entry points such as `dsh --profile headless` and Host-backed entry points such as `dsh-host-session-remote-operations` read the same service instead of owning parallel provider/model defaults.

The plugin config requires `{ provider, model }`. That composition entry is the base of the `agent-default-model` Settings section; a mounted settings provider layers the user's choice over it and changes are visible on the next `currentSelection()` read. `reasoningEffort` belongs to the Settings section but deliberately not to plugin config: a complete saved selection can clear an effort when the next selected model has none, while a composition value would be inherited again.

- `ctx.agentDefaultModel.currentSelection()` returns a detached `{ provider, model, reasoningEffort? }` selection for a newly created Agent.
- `ctx.agentDefaultModel.saveSelection(selection)` saves the complete user selection. Without a settings provider it is a no-op and the composition entry remains current.

The service does not validate catalog membership. A provider route may serve an unadvertised model, and the consumer that actually opens a model request owns availability diagnostics.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

Indirectly, through the provider/model selection supplied to an entry point; request assembly and adapters own the model-visible request.

#### KV Cache effect

Changing the default affects only Agents that subsequently resolve from it. An existing session whose request log already names a selection keeps that selection, so this service does not invalidate its established prefix.

## Known Limitations and Deferred Work

- The service owns one process-wide default; per-session selection remains the entry point's responsibility.
- Without a settings provider, `saveSelection()` cannot retain a selection for a later Agent.

Session-specific model intent also belongs here. The `./session-selection` export owns the existing version-2 modelSelection projection and model/selection event contract. AgentDefaultModelConfig registers it when SessionProjectionRegistry is available. Host and legacy journal consumers share one Agent-scoped assembly adapter, reading pending intent from that projection rather than retaining independent pending caches. Matching request/header events consume pending intent; adapter-default reasoning effort remains logged use rather than an explicit restored override.

### Dev Note

None.
