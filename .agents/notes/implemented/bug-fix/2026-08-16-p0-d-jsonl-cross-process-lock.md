# Agent Note: P0 D — JSONL cross-process write lock

Status: implemented

English | [中文](2026-08-16-p0-d-jsonl-cross-process-lock.zh.md)

## Problem

Two processes sharing one JSONL session root could interleave writes to the same session log: materialize (first write), append, crash repair (truncate), and delete each read-modify-write the artifact without mutual exclusion, so a torn interleaving could corrupt a committed log — the exact corruption class the load path now rejects loudly. The coordinator's per-id serialize chain protects writers inside one process only.

## Decision

Every mutating JSONL operation runs under a root-level per-id cross-process lock (`<root>/.dsh-locks/<encoded-id>`). The lock file is `wx`-created with the holder's pid; a contender that finds one checks whether that pid is still alive and reclaims a stale lock left by a crashed process (`ESRCH`), so a crash cannot wedge the id. Contention backs off exponentially and fails after 10s. `appendBatch`, `deleteStored`, and `commitRepair` all take the lock; read paths (list, load, inspect) stay lock-free because the log is append-only and delete stages through a rename to the tombstone. The lock directory is excluded from project discovery so it is never mistaken for a session project. Regression tests plant a dead-pid lock (reclaimed) and run a concurrent writer pair (both appends land without interleaving).

## Alternatives considered

**Reuse `withFileLock` from dsh-atomic-write.** Rejected: it never reclaims a stale lock (orphan recovery is an operator action), so one crashed process would wedge every write to that id for 10s forever; JSONL needs automatic stale reclaim because its writes are on the hot path.

**Lock per log file.** Rejected: delete renames the session directory away, moving the file; a root-level per-id lock is independent of the artifact's current path and covers materialize→append→repair→delete uniformly.

## Consequences

Cross-process writers on one root are serialized per id; a crashed writer's lock is reclaimed on the next contender. The `.dsh-locks` directory appears under the root (excluded from discovery, never treated as a project). Single-process behavior is unchanged apart from one extra mkdir+lockfile round trip per write batch.
