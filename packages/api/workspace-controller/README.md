---
description: "Host Workspace follow stream and directory-picker actions over the canonical Workspace Registry."
kind: "package-reference"
---
# Workspace Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-workspace-controller` owns Host `ctx.workspaceController` and the `workspace/follow` stream. `@deepseek-ai/dsh-workspace` is the single owner of Workspace list, create, rename, delete, reorder, archive, restore, and archived-session deletion Remote methods. The package also owns `ctx.directoryPickerController` and the generated `ctx.remote.directoryPicker` namespace, because the directory-picking seam it carries is abstract and never a Loader entry of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Workspace Registry serializes mutations and returns canonical domain results inside the Remote carrier result. Consumers must unwrap both layers before treating a mutation as successful. Blank names return `arguments-invalid`, and invalid Session moves retain Workspace, Session, and optional anchor identities in their diagnostic details. Its `follow()` stream synchronously attaches to durable Workspace changes, emits one complete baseline first, then emits ordered `upsert`, `remove`, `order`, and `archived` increments. A reconnect starts another generation with a replacement baseline, so consumers do not depend on receiving every increment while disconnected.


-----

<a id="model-experience"></a>
## Model Experience

None, as Workspace organization is Host control state and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; Workspace mutations do not alter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `follow()` replaces the whole projection after reconnect and has no durable cursor or incremental catch-up protocol.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
