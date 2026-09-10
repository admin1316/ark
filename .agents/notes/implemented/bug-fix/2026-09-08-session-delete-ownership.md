# Agent Note: Serialize session deletion and derived cleanup

Status: implemented

English | [中文](2026-09-08-session-delete-ownership.zh.md)

## Problem

Permanent deletion must not race a live Session, a reserved resume, or an admitted write. Removing only a log can leave attachments behind; reporting success before derived cleanup can leave feedback rows or let pending work recreate them.

## Decision

The persistence coordinator waits for retirement, rejects live or reserved identities, and serializes physical deletion with its existing per-ID write chain. It discards cached preparations and write state only after physical removal succeeds. The `session-persistence/deleted` notification runs after releasing that chain and is awaited. Failed derived cleanup rejects with a retry instruction; deleting an absent identity still retries the notification.

JSONL mutations reuse the cross-process lock in [atomic-write](../../../../packages/util/atomic-write/README.md). A deletion moves the ordinary session directory into a deterministic project-local `~delete` tombstone, commits the namespace change, then removes the owned contents. Discovery excludes tombstones; a repeated deletion completes a leftover tombstone. Symbolic-link deletion roots and session directories are rejected. SQLite deletes the session row and cascaded events in one schema-validated transaction without a schema migration.

## Alternatives considered

**Notify before removing bytes or while holding the write chain.** Early notification can erase derived data for a failed deletion. Holding the chain during cleanup can deadlock a subscriber that inspects persistence.

**Add a second PID-based lock with automatic stale-file removal.** Checking a PID and then removing a pathname does not prove ownership of a replacement lock. The shared lock fails closed on an orphan instead of guessing that removal is safe; operator recovery remains explicit.

## Consequences

Shared backend tests cover live and reserved refusal, absent-session retries, awaited cleanup, and subscriber failure. JSONL tests cover sibling preservation, owned attachments, hidden-directory retry, and symbolic-link refusal in both supported encodings where applicable. These checks do not prove physical power-loss recovery or production promotion. An orphan writer lock can prevent further mutations until its ownership is inspected and it is recovered; it is never silently deleted.
