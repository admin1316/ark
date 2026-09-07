# `@deepseek-ai/dsh-native-api-runner`

English | [中文](README.zh.md)

Dedicated executable for Ark's managed Native API sidecar. `lib/bin.js` can boot only the `jiuzhang` profile, accepts only that profile's application arguments, applies no arbitrary overlay, and disables live profile watching. Its installation manifest owns `dsh-base`, `dsh-native-api-app`, the shared profile runner, and the Ark-specific knowledge tool; it has no dependency, optional dependency, or peer edge to the generic `@deepseek-ai/dsh` CLI, Web/headless products, or any `dsh-client-*` package.

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
