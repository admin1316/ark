# Agent Note: Backup, WebSocket, and migration-marker hardening

Status: implemented

English | [中文](2026-08-15-launch-scoped-security-hardening.zh.md)

## Problem

Three launch-scoped gaps were reproduced against a running build. First, `backupFile` in `dsh-atomic-write` copied the current document straight onto `<filename>.bak` with `copyFile`, which follows a planted symlink: a `.bak` pointing at another file made the backup overwrite that referent (settings and credentials both take this path). Second, the launch-scoped `DSH_API_TOKEN` gate checked only HTTP requests: a WebSocket upgrade to `/api/events.mux` with neither cookie nor bearer returned 101 Switching Protocols. Third, the legacy-data migration wrote its completion marker before the settings-import record, so a conflict in the record write left the marker behind; the next launch reported "already-migrated" while the import record stayed wrong.

## Decision

**`backupFile` refuses symlinks and non-regular files and commits by exclusive temp plus rename.** The pre-write backup mechanism itself was decided in the [config backup note](2026-08-15-config-backup-and-redaction.md); this note hardens its commit path. The source is opened with `O_NOFOLLOW` and judged by the opened inode (a symlink fails with ELOOP; a directory fails the regular-file check), and the copy runs through the opened handles, so no check-then-use window exists. The backup is written to a random-suffix sibling created exclusively (`wx`), chmodded, fsynced, and renamed over `.bak` — a symlink or hardlink planted at the `.bak` name is replaced by the fresh inode and its referent is untouched. Regression tests plant symlinks and hardlinks at the `.bak` name, refuse symlinked and non-regular sources, and run concurrent backups against a live writer.

**The API-token gate binds WebSocket upgrades exactly like HTTP.** The webserver's upgrade path applies the same `/api` bearer-or-SameSite-cookie check before dispatching to any protocol handler; an unauthenticated upgrade receives a raw-socket HTTP 401. Index responses additionally carry a Content-Security-Policy (same-origin resources, the token cookie script admitted by its sha256 content hash — never `unsafe-inline` — and loopback WebSockets), attached by the index-document owner through the new `indexSecurityHeaders()`; `dsh-host-frontend-static` is that owner and applies it to every index response, merging content hashes for the rendered body's other inline scripts (the boot manifest) at serve time so the dynamic client-plugin architecture keeps working.

**The migration marker commits last and atomically.** `migrateLegacyProductData` writes the `.ark-product-data-migration-v1` marker only after every copy and the settings-import record succeeded, via a `wx` temp plus rename; the record itself is rewritten atomically on every attempt so a stale or torn record from a failed attempt never stalls a retry. A non-regular file at the marker path is a conflict, not "already-migrated". The regression test reproduces the original failure (a conflicting record path), asserts no marker remains after the failed attempt, and verifies the retry converges.

## Alternatives considered

**lstat the source and `.bak` before `copyFile`.** Rejected: the check and the copy are separate operations, leaving a TOCTOU window and still writing through a `.bak` swapped between them.

**Enforce the token on the client side or in the connection plugin only.** Rejected: the server is the enforcement point; route handlers must not depend on the caller's goodwill, and the trust fence is not an authentication layer.

**Write the marker first and repair the record on retry.** Rejected: a crash or a second failure between the two writes still yields the false "already-migrated" outcome; committing last is the only order where the marker proves completeness.

## Consequences

A symlinked settings or credentials source now fails the backup loudly instead of being read through; callers with such a layout must resolve the link first. WebSocket clients that rely on the token cookie keep working unchanged (the cookie is planted on every index response); hand-rolled clients must send the bearer. The index CSP blocks off-origin subresources by design; the hash-based script source keeps the token-planting tap working without `unsafe-inline`. Migration retries converge instead of locking onto a wrong record. Later hardening ([P0 batch B](2026-08-16-p0-batch-b-sdk-web-pty.md)) made the gate never-disabled by default: the token now resolves from config `apiToken`, then `DSH_API_TOKEN`, else a random per-launch mint, and `0.0.0.0` binding requires an explicit token.
