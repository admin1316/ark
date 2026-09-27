---
description: "Atomic file replacement and cross-process writer locking for packages that must never leave partial, symlink-hijacked, or wider-permission content on disk."
kind: "package-library"
---

# @deepseek-ai/dsh-atomic-write

English | [中文](README.zh.md)

## Summary

`dsh-atomic-write` replaces a file's contents in one atomic step: readers of the target always observe either the complete old content or the complete new content, never a partial write. It also serializes read-modify-write cycles across processes with a writer lock, so concurrent writers of one file cannot resurrect each other's state. The caller states the permission bits for every replacement and the fresh inode carries them through the swap, so replacing a wider-permission file narrows it without a chmod race. It is a zero-dependency library shared by file-backed stores such as the user-settings document and the credentials store; a `cordis.yml` cannot load it, and crash durability is the caller's policy because there is no `fsync`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use `writeFileAtomic` when a file-backed store must replace one already-rendered string without ever exposing a partial, symlink-hijacked, or wider-permission state, and `withFileLock` when several processes read-modify-write the same file. The smallest path is one call with the final content and the replacement's permission bits.

### Writing a file atomically

```ts
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

declare const text: string
await writeFileAtomic('/home/u/.dsh/settings.yaml', text, { mode: 0o600 })
```

Parent directories are created as needed, and readers observe either the old or the new complete content. Cleanup applies only after the temporary file was exclusively created by this call: a refused create never removes another writer's file. Later failures attempt to close and remove the owned temporary file and rethrow the original failure, leaving the target untouched. A cleanup failure can leave that temporary file for later inspection.

### Coordinating writers

For a read-render-commit cycle that a bare atomic commit cannot make safe on its own, hold the writer lock around the operation:

```text
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

declare const render: (previous: string) => string
declare const readCurrent: () => Promise<string>

await withFileLock('/home/u/.dsh/settings.yaml', async () => {
  const previous = await readCurrent()
  await writeFileAtomic('/home/u/.dsh/settings.yaml', render(previous), { mode: 0o600 })
})
```

Only writers contend — readers never take the lock — and a contender backs off exponentially and fails with a timed-out error rather than blocking forever. How long a contender waits is stated per call through `waitMs`: the default is sized for file work alone, so a holder whose cycle includes a network round trip — a credential mutation that refreshes an expired token — states a longer one, because leaving the default would fail every other writer of that file for the duration. The retry cadence stays fixed. A contender may take over a complete PID record only when a process probe proves that its holder exited (`ESRCH`); file age is never evidence of ownership.

### Failures to plan for

The lock's parent directory must already exist, so `withFileLock` rejects an invalid parent hierarchy before running the operation. A process that exits while holding the lock leaves a sibling that a later writer can take over. Live holders, other-user holders (`EPERM`), the contender's own PID, and incomplete records remain protected. A leftover takeover claim also makes contenders time out; an operator must verify both owners before recovering that exceptional state.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is built on one separation: the atomic commit owns the swap, and the writer lock owns cross-process ordering.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `writeFileAtomic` and `withFileLock`, the package's whole surface |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; the replacement contract is exercised by unit tests) |

### Write path

`writeFileAtomic` writes a random-suffix sibling opened with exclusive create (`wx`), then renames it over the target. The exclusive open refuses to follow a symlink planted at a guessable temp path; the same-directory sibling keeps the rename on one filesystem; and the rename replaces a symlinked target itself instead of writing through to its referent.

`withFileLock` creates a `<filename>.lock` sibling with `wx`. `EEXIST` identifies contention directly; `EPERM` does so only when a fresh `lstat` confirms the lock path exists, covering Windows exclusive-create behavior without hiding an unrelated permission failure. Windows retries one unconfirmed `EPERM` because a holder may release between exclusive create and the existence probe; repeated permission errors are rethrown. The lock retains the interoperable `<pid>\n` record. A dead-holder contender serializes on a record-specific claim, then re-reads the record and probes its PID again before removing the old lock. Release checks the held file identity and record before removing it in `finally`. Contention backs off exponentially and fails when the per-call `waitMs` deadline (default two seconds) passes.

### Why the swap stays safe

- **Fresh inode, caller-stated mode** — the temp carries `mode` through the rename, so narrowing a wider-permission file has no chmod race. `mode` is required so the permission decision stays visible at every call site.
- **Readers never contend** — the rename commit is atomic, so a reader needs no lock.
- **Takeover requires proof of exit** — only `ESRCH` permits takeover, and the record and PID are checked again under the claim. A paused live writer remains protected.
- **Release preserves an observed replacement** — a different inode or PID record is not removed. These checks and unlink are separate filesystem operations, not atomic compare-and-unlink against external interference.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the consuming stores or the family this primitive belongs to.

- [User-settings file store](../../settings/settings-file/README.md) — the settings document every write replaces through this package.
- [Credentials store](../../credentials/credentials-local/README.md) — the credentials file this package locks and replaces.
- [util group map](../README.md) — the zero-dependency utility family this package belongs to.

-----

<a id="model-experience"></a>
## Model Experience

None, as this is a pure filesystem write primitive that registers nothing model-facing.

#### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the package is not the right tool. They are current package constraints, not a task backlog.

- **Atomic, not durable** — no `fsync` of the file or its directory, so after a crash the rename may be observed unwound. The file-backed stores here re-read and republish on boot, keeping durability the caller's policy.
- **String content only** — no `Buffer` or stream form until a consumer needs one.
- **Some orphan states require operator recovery** — incomplete records, live reused PIDs, and a claim left before its old lock was removed remain blocked. Contenders never remove existing claims.
- **One host and PID namespace** — shared files across hosts or separate PID namespaces are unsupported. Takeover proves the holder exited, not that child writers exited; callers that start such writers must manage their lifecycle.
- **Cooperating writers** — identity checks preserve replacements observed before release, but cannot fence an arbitrary external replacement between the final check and unlink.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

A durability-replacement that `fsync`s the file and parent directory and preserves owner-only permissions on Windows remains open (tracked as `settings-atomic-durability` in source).

</details>
