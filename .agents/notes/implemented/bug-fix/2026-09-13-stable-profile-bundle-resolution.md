# Agent Note: Stable profile bundle resolution

Status: implemented

English | [中文](2026-09-13-stable-profile-bundle-resolution.zh.md)

## Problem

A profile resolver can report an installed bundle missing while another process atomically replaces its fallback symlink. On macOS, a pathname query traversing the replaced link can return `EINVAL`; `existsSync` collapses that error into `false`. Atomic publication of the directory entry does not make a later multi-component lookup indivisible.

## Decision

The existing `packageDirFromAnchor` owner uses Node's native `realpathSync` to capture the package directory before inspecting its manifest. Callers receive the resolved directory, so their subsequent reads use the same destination. Installation-first lookup and packages that omit `./package.json` from their exports remain supported. Missing paths fall through; unexpected resolution errors propagate. The writer retains staged symlink replacement.

## Alternatives considered

**Ignore failed existence checks in the concurrency test.** This would conceal the reproduced failure of the production bundle resolver.

**Read the symlink manually.** Concurrent replacement also produced `EINVAL` from `readlink`; native path resolution avoids another owned traversal algorithm.

## Consequences

Returned paths use canonical filesystem spelling, including macOS `/private/var`. A separate process exercises the production resolver and reads package identities during repeated replacement; failures remain assertion failures. Absolute, relative, dangling, and cyclic links retain explicit checks. This verifies filesystem resolution, not Native App acceptance, and does not promise continued reads after the selected installation directory itself is removed.
