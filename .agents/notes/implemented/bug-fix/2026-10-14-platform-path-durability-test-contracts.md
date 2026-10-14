# Agent Note: Platform paths, durable handles and observed test phases

Status: implemented

English | [中文](2026-10-14-platform-path-durability-test-contracts.zh.md)

## Problem

Filesystem paths, logical repository paths and file URLs have different contracts. Treating them as interchangeable breaks Windows module loading, signatures and retired-entrypoint detection. Windows can also report ENOENT beneath an ordinary file, and flushing a read-only stage handle can fail before a durability fault test reaches its intended operation. Tests that infer an asynchronous phase from a preceding event or fixed file poll can inject failure before the operation they describe has begun.

## Decision

Verifier launch paths use the standard file-URL conversion. Existing repository-path projection owns slash-separated logical paths; signed receipt bytes and signature encoders remain unchanged. The Wiki missing-path predicate distinguishes absent paths from obstructing ancestors while preserving absent paths through existing directory aliases. Promotion recovery opens its owned existing stage writable on Windows before compulsory file flushing; byte, inode, link-count and post-flush checks still guard publication.

Lifecycle tests wait for the actual callee or persisted journal phase. Cache tests close the cache fiber and drain its existing domain write queue while the storage owner remains available. Claude fixtures retire their own HTTP transport before joining consumers and retain cleanup errors. Platform fault fixtures preserve the intended failure at the inspected syscall rather than assuming POSIX chmod or rename behavior.

The Native owner connector remains Unix-only. Windows protocol tests use real named-pipe streams with a stat double restricted to their owned fixture endpoint. A separate untouched-filesystem control rejects the real Windows pipe without publishing authority. Native roster snapshots retain explicit Unix and Windows shell catalogs instead of normalizing the tool difference away.

The verifier helper writes its own readiness marker before the leader responds. POSIX retains real post-leader survivor tests. Windows checks actual disappearance of a non-detached helper, attributed to [libuv's parent-owned job](https://github.com/nodejs/node/blob/v24.x/deps/uv/src/win/process.c), while deadline and cancellation tests separately control the managed wait after a real leader exit. The [existing verifier wait contract](2026-10-13-verifier-post-exit-cancellation.md) retains its operation deadline and independent observation bound.

## Alternatives considered

**Suppress filesystem errors or skip Windows suites.** This can conceal corrupted paths or bypass the refusal and protocol behavior the tests must establish.

**Increase timeouts or poll a preceding event.** A longer delay cannot identify the callee or durable phase at which the failure belongs.

**Accept missing helpers as Harness cleanup.** A spawn PID alone does not prove startup, and Windows job cleanup does not prove Harness signalling or management of a detached survivor.

## Consequences

Source and test owners use the host's path and durability semantics without changing wire formats, signatures, permissions, retry policies or coverage thresholds. Test doubles are branch-level evidence and do not establish a Windows trusted Native owner. Windows direct-child liveness and detached-descendant limitations remain explicit in the subprocess provider.

The strict PowerShell large-output prefix assertion carries bounded returned-output and retained-terminal diagnostics. Its missing-prefix cause remains unresolved until an actual Windows execution supplies those bytes; the diagnostic is not a claimed terminal repair. Source tests and hosted CI remain separate evidence from candidate task acceptance and formal installation.
