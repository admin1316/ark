# @deepseek-ai/dsh-host-workbench

English | [中文](README.zh.md)

Host-only Typert Remote owner for Ark's browser-free Workbench reader. `WorkbenchRemoteService` registers only `workbench/webRead`; Files tree/read stay in the existing descriptor-confined Native owner, and Native Review owns Git. The Host method takes one strict `request` object followed by the Gateway-injected `AbortSignal`.

This package owns its filesystem and Git primitives directly. It validates the strict slash-Remote request before any filesystem access, canonicalizes the root and child path, preserves the root-confinement and bounded-read policy, and raises one typed Typert failure so the Gateway emits exactly one `RemoteResult`.

## Migration boundary

This package is now the authoritative owner of the four Workbench operations. Parent integration must redirect the temporary compatibility surface to this owner, regenerate the strict Remote artifacts, then remove that retired surface and its route. Native composition and runtime-closure deletion remain separate parent-owned steps.

## Security and behavior

- A root must be a non-empty path accepted by this package's strict schema and an absolute existing directory accepted by the authoritative owner.
- A requested path is canonicalized under that root; an escaping symlink fails with `workbench-error` and reason `outside-root`.
- File reads are bounded and binary-aware. Directory listing does not follow child symlinks.
- Git status and diff operate only when the requested root is the exact repository top level; diff is read-only and `staged` is always explicit.
- The caller's `AbortSignal` is passed unchanged. `cancelled` and `workbench-error` failures are emitted once at the strict Remote boundary.

## Model Experience

### Native Workbench read surface

#### What the model sees

Nothing. `workbench/webRead` is a Host-only browser reader and registers no prompt, tool, message, filesystem owner, model provider, or model request.

#### Token effect

No direct token effect; the package never assembles model input.

#### KV Cache effect

Independent of model-content caching because Workbench reads do not modify model input.

## Known Limitations and Deferred Work

- Parent integration still needs to redirect and remove the temporary compatibility surface, update the Gateway descriptors, and refresh the runtime receipt.
- This lane does not mount the package in the Native bundle or edit central Gateway route tables.
