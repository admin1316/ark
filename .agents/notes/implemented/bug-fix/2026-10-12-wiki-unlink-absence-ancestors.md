# Agent Note: Directory ancestry before optional unlink absence

Status: implemented

English | [中文](2026-10-12-wiki-unlink-absence-ancestors.zh.md)

## Problem

Windows can report `ENOENT` for a child beneath an ordinary file. Treating that code alone as optional absence lets Wiki cleanup hide an invalid path, including a parent replaced before the target is opened.

## Decision

The [filesystem owner](../../../../packages/host/knowledge-wiki/src/filesystem.ts) checks ancestry at both unlink absence boundaries. Its existing ancestor traversal uses `lstat`, propagates inspection failures and stops at a filesystem root. The nearest existing parent must resolve to a directory before absence becomes a no-op.

Parent `stat` retains existing intermediate directory-alias resolution. Final-target `lstat`, `O_NOFOLLOW`, unique-link checks, inode comparison, tombstone restoration and directory fsync retain their existing owners. No platform-specific deletion implementation or public operation is added.

## Alternatives considered

**Keep the code-only missing-path check.** It accepts the invalid Windows ancestor as absence.

**Reject every missing-path error.** It breaks idempotent cleanup of genuinely absent leaves and parent directories.

**Require the immediate parent to exist.** A missing nested hierarchy still has a valid existing directory ancestor and needs no deletion.

**Patch each cleanup caller or special-case Windows.** The shared deletion operation can enforce the distinction without duplicated policy or assumptions about which platforms reuse an error code.

## Consequences

Missing-target cleanup adds ancestor inspection; existing-target deletion keeps its identity and durability sequence. The [real-filesystem interleaving tests](../../../../packages/host/knowledge-wiki/tests/filesystem-races.spec.ts) pin initial-stat and pre-open refusal, nested absence, lookup denial, unavailable roots, directory inspection failure and intermediate aliases. Error mappings on macOS do not establish actual Windows execution or installed-candidate acceptance.
