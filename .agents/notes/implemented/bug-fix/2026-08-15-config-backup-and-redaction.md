# Agent Note: Configuration write-backup and wire-boundary secret hardening

Status: implemented

English | [中文](2026-08-15-config-backup-and-redaction.zh.md)

## Problem

Two security gaps surfaced while diagnosing a live "DeepSeek API request failed" incident. First, `settings.yaml` and `.credentials.yaml` were rewritten by an external program (single-line flow style, `gpt-5.6` provider and its key removed) with no pre-write snapshot anywhere, so the prior state was only recoverable from a shell history, not from the product. Second, the settings redaction walker's own comment and the package README both documented a fail-closed gap: a `role('secret')` field reachable only through a union, intersect, or transform node was returned verbatim, and the session-search error path in the API proxy serialized the whole error object (`String(error)`) into a client-facing message.

## Decision

**Every settings and credentials write keeps a pre-write backup.** `backupFile` in `dsh-atomic-write` copies the current document to `<filename>.bak` (0600, absent source is a no-op) and is called inside the writer lock, before the replacement commit, by both `dsh-settings-file` (persistSection) and `dsh-credentials-local` (write). The backup always reflects the last committed state; restoring the sibling rolls back a bad write or an external edit.

**The redaction walker fails closed on unproven containers.** The default arm of `redactSecrets` now probes the schema subtree (`dict`/`inner`/`list`) for any secret-role field before passing a value through; a secret reachable only via a union, intersect, or transform node throws instead of leaking, with the field path in the message. Union/intersect branch schemas are reached through the node's `list` relation, which `SchemaNode` now names.

**The API proxy error path sends only the error's own message.** The session-search failure no longer serializes `String(error)` into the wire message; it sends `error.message` (or a stringified fallback) and keeps the full object server-side.

## Alternatives considered

**Watching and reverting external edits in place.** Rejected: a watcher cannot distinguish a hostile rewrite from a legitimate manual edit, and reverting would fight the user. A pre-write backup preserves operator freedom while making every prior state recoverable.

**Fully resolving union/intersect/transform during redaction.** Rejected: schemastery resolution is value-dependent; the walker has no value to resolve against when stripping, so a subtree probe (fail closed when any secret is reachable) is the sound boundary. The remaining unproven surface — `schema.toJSON()` carrying a secret field's `.default(...)` — stays in the README Known Limitations.

## Consequences

117 package tests (atomic-write, credentials-local, settings-file) plus 158 settings tests plus 383 api-proxy tests pass; the new branches carry their own tests (backup content/mode/no-op/rethrow; union/intersect/transform/root fail-closed; secret-free union passthrough). The runtime copies in `jiuzhang-runtime` and the Ark harness profile were rebuilt and verified with an end-to-end credentials write producing a correct 0600 `.bak`. The session-archive in-flight changes in the same api-proxy file coexist and pass.
