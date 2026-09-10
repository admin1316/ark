# @deepseek-ai/dsh-host-directory-picker

English | [中文](README.zh.md)

The host workspace-directory picker is a capability seam. The abstract `DirectoryPicker` service (`ctx.directoryPicker`) is its Service Definition, and its native backend (`-native`) opens one operating-system chooser on the host display. Consumers branch on the discriminated `DirectoryPickerCapabilities` map; unknown capabilities hide the action rather than failing. The capability object is stable for the service lifetime.

Native picker failures remain typed and are mapped by the Host API boundary. Design rationale, the `ctx.fs` separation, and the policy decisions live in [the directory-picker capability seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.md).

`@deepseek-ai/dsh-host-directory-picker/types` exports the client-safe `DirectoryEntry` and `DirectoryListing` types without loading the Host service.

## Model Experience

None, as the seam serves the GUI host's directory selection; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No multi-root support** — the browse contract exposes one ancestry chain per listing; per-deployment root scoping (and Windows drive-root enumeration above a drive) waits for a consumer that needs it, per the DirectoryPicker Agent Note.
