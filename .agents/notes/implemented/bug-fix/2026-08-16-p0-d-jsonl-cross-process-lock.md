# Agent Note: P0 D — JSONL cross-process write lock

Status: implemented

English | [中文](2026-08-16-p0-d-jsonl-cross-process-lock.zh.md)

## Problem

Two processes sharing one JSONL session root could interleave writes to the same session log: materialize (first write), append, crash repair (truncate), and delete each read-modify-write the artifact without mutual exclusion, so a torn interleaving could corrupt a committed log — the exact corruption class the load path now rejects loudly. The coordinator's per-id serialize chain protects writers inside one process only.

## Decision

Every mutating JSONL operation runs under a root-level per-id cross-process lock (`<root>/~locks/<encoded-id>.lock`) through the shared `withFileLock` owner. `appendBatch`, header materialization, `deleteStored`, and repair commit take that lock; read paths stay lock-free because append and rename define their visibility. The shared helper uses exclusive creation, a PID record, bounded waiting, and guarded dead-holder recovery. Its [recovery decision](2026-09-27-selective-upstream-runtime-reliability.md) defines the conservative failure cases and release ownership check. The lock directory is excluded from project discovery so it is never treated as a session project.

## Alternatives considered

**Reuse `withFileLock` from dsh-atomic-write without stale-holder recovery.** The original decision rejected that behavior because a crashed writer could block later mutations indefinitely. JSONL uses the shared owner, whose dead-holder recovery satisfies this requirement without duplicating the locking protocol; unproven holders and residual takeover claims still fail closed.

**Lock per log file.** Rejected: delete renames the session directory away, moving the file; a root-level per-id lock is independent of the artifact's current path and covers materialize→append→repair→delete uniformly.

## Consequences

Cross-process writers on one root are serialized per id. A valid dead-holder record can be reclaimed under the shared protocol; not every orphaned artifact is automatically recoverable. The `~locks` directory remains outside session discovery. Single-process writes also take the filesystem lock, preserving the same mutation boundary when a second process joins.
