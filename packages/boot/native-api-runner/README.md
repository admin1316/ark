---
description: "Dedicated executable for Ark's managed Native API sidecar. lib/bin.js can boot only the jiuzhang profile, accepts only that profile's application arguments, applies no arbitrary overlay, and disables live profile watching."
kind: "package-library"
---

# `@deepseek-ai/dsh-native-api-runner`

English | [中文](README.zh.md)

## Summary

Dedicated executable for Ark's managed Native API sidecar. `lib/bin.js` can boot only the `jiuzhang` profile, accepts only that profile's application arguments, applies no arbitrary overlay, and disables live profile watching. Its installation manifest owns `dsh-base`, `dsh-native-api-app`, the shared profile runner, and the Ark-specific knowledge tool; it has no dependency, optional dependency, or peer edge to the generic `@deepseek-ai/dsh` CLI, Web/headless products, or any `dsh-client-*` package.

The Ark launcher supplies a private Node IPC connection alongside inherited stdin, stdout and stderr. This runner enables the shared [profile runner](../profile-runner/README.md)'s optional parent-disconnect handling, so loss of that connection joins the existing shutdown owner during startup or runtime. The connection carries no application messages or persisted state. A direct launch without IPC keeps the ordinary profile lifecycle.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Managed Native profile

#### What the model sees

The runner adds no model-visible text or tool schema. The selected `jiuzhang` profile and shared preset own the prompt sections and tools that the Agent receives.

#### Token effect

No direct token effect from this runner; the selected profile and preset determine the model request content.

#### KV Cache effect

Independent of model-content caching until the mounted profile or preset changes the Agent's prompt prefix.

## Known Limitations and Deferred Work

- The runner deliberately exposes no plugin-management, config-dump, Web alias, or arbitrary profile selection command.
- Runtime assembly must supply every required peer in the closed installation graph before packaging Ark.app.
- Parent-disconnect delivery depends on the backend's Node event loop; this path does not provide independent supervision of a blocked backend.

### Dev Note

None.
