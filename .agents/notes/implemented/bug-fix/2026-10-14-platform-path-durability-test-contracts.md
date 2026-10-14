# Agent Note: Platform paths, durable handles and observed test phases

Status: implemented

English | [中文](2026-10-14-platform-path-durability-test-contracts.zh.md)

## Problem

Filesystem paths, logical repository paths and file URLs have different contracts. Treating them as interchangeable breaks Windows module loading, signatures and retired-entrypoint detection. Windows can also report ENOENT beneath an ordinary file, and flushing a read-only stage handle can fail before a durability fault test reaches its intended operation. Tests that infer an asynchronous phase from a preceding event or fixed file poll can inject failure before the operation they describe has begun.

Converting OS inode identities to JavaScript numbers can merge distinct files above the safe integer range. That can falsely report revisited Wiki pages, accept a replaced file or remove another writer's lock. Millisecond timestamps also lose changes visible in the OS metadata. Cleanup hooks that retain mutable fixture arrays can consume the next test's resources, and a fulfilled Cordis disposal promise does not exclude logged effect failures.

## Decision

Verifier launch paths use the standard file-URL conversion. Existing repository-path projection owns slash-separated logical paths; signed receipt bytes and signature encoders remain unchanged. The Wiki missing-path predicate distinguishes absent paths from obstructing ancestors while preserving absent paths through existing directory aliases. Promotion recovery opens its owned existing stage writable on Windows before compulsory file flushing; byte, inode, link-count and post-flush checks still guard publication.

Wiki traversal, bounded reads, atomic publication, unlink, review stages, event-log sync and writer-lock release retain BigInt device/inode metadata. Read-after checks compare nanosecond timestamps. These values stay inside filesystem checks: bounded public page sizes remain numbers, and JSON, WAL and signed payload bytes keep their existing encoders. The shared governed-path resolver refuses an existing non-directory intermediate component before inspecting its child; real missing suffixes and non-missing I/O errors retain their distinct behavior.

Lifecycle tests wait for the actual callee, settled subagent end or persisted journal phase. Cache tests close the cache fiber and drain its existing domain write queue while the storage owner remains available. Claude fixtures capture each query's messages and cleanup owners before asynchronous work, retire their own HTTP transport before joining consumers, and retain failures independently of later fixtures. SQLite differential samples release both backends and reopened instances before removing their directories. Scoped cleanup observers preserve logged effect failures alongside initialization and assertion errors. Platform fault fixtures preserve the intended failure at the inspected syscall rather than assuming POSIX chmod or rename behavior.

Profile resolver fixtures wait for actual child readiness and flush the result through the IPC completion callback before exit. Bounded phase diagnostics retain the existing sample counts and timeout limits. Credential reload assertions require the complete replacement snapshot, including retained and removed keys. Benchmark subprocesses choose the platform executable suffix; this selection is not a performance result. Windows private Core tests assert the existing POSIX-only configuration refusal and pristine state rather than claiming a successful trial.

The Native owner connector remains Unix-only. Windows protocol tests use real named-pipe streams with a stat double restricted to their owned fixture endpoint. A separate untouched-filesystem control rejects the real Windows pipe without publishing authority. Native roster snapshots retain explicit Unix and Windows shell catalogs instead of normalizing the tool difference away.

The hosted macOS Native lane installs the same pinned Node and immutable pnpm dependencies before its contracts run. Its Swift fixture launches the actual `tsx` source consumer to verify the Native/XPC journal signature and duplicate refusal; a Swift-only checkout cannot exercise that consumer. The existing source aliases resolve workspace imports without adding an artifact build or changing the signature check.

The verifier helper writes its own readiness marker before the leader responds. POSIX retains real post-leader survivor tests. Windows checks actual termination of a non-detached helper, attributed to [libuv's parent-owned job](https://github.com/nodejs/node/blob/v24.19.0/deps/uv/src/win/process.c), while deadline and cancellation tests separately control the managed wait after a real leader exit. The [existing verifier wait contract](2026-10-13-verifier-post-exit-cancellation.md) retains its operation deadline and independent observation bound.

Post-leader tests bind the helper's actual startup identity before cancelling. Linux group quiescence can include the same process identity in Z/X state; diagnostics distinguish this retained entry from PID absence and reject running, replaced or unreadable identities. Windows cancellation fixtures keep a real anonymous stdin pipe open and act after actual readiness. Their termination evidence is the OS signal/job boundary, rather than an unexecuted POSIX handler. Cleanup independently joins parent and child before removing the fixture and preserves primary and cleanup errors. Windows ESRCH proves non-running or absent, not destruction of every kernel process object.

Cache count tests establish the durable creation cut before measuring the subsequent event threshold. HMR creation tests retain bounded diagnostics for the registered watcher's readiness, events, canonical paths and refresh phase without extending their time limits or substituting polling. These observations do not repair the retained HMR event-loss cause or the Windows junction publication gap.

## Alternatives considered

**Suppress filesystem errors or skip Windows suites.** This can conceal corrupted paths or bypass the refusal and protocol behavior the tests must establish.

**Increase timeouts or poll a preceding event.** A longer delay cannot identify the callee or durable phase at which the failure belongs.

**Accept missing helpers as Harness cleanup.** A spawn PID alone does not prove startup, and Windows job cleanup does not prove Harness signalling or management of a detached survivor.

**Round identities or equate promise settlement with successful cleanup.** Adjacent large inode values can collapse to the same number, while Cordis can log an effect failure and still fulfil its disposal promise. Actual owned-resource settlement and retained errors are separate checks.

## Consequences

Source and test owners use the host's path, integer precision and durability semantics without changing wire formats, signatures, permissions, retry policies or coverage thresholds. Controlled high-inode metadata proves the refusal mechanism with actual file replacement; it is not a demonstrated NTFS attack. Platform dispatch fixtures are branch-level evidence and do not establish another OS's kernel enforcement or a Windows trusted Native owner. Windows direct-child liveness and detached-descendant limitations remain explicit in the subprocess provider.

The strict PowerShell large-output prefix assertion carries bounded returned-output and retained-terminal diagnostics. Its missing-prefix cause remains unresolved until an actual Windows execution supplies those bytes; the diagnostic is not a claimed terminal repair. Source tests and hosted CI remain separate evidence from candidate task acceptance and formal installation.
