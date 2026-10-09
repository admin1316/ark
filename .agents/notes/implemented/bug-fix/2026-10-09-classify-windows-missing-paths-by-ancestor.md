# Agent Note: Classify Windows missing paths by their nearest existing ancestor

Status: implemented

English | [中文](2026-10-09-classify-windows-missing-paths-by-ancestor.zh.md)

## Problem

Windows can report `ENOENT` when a path traverses an ordinary file, where POSIX systems report `ENOTDIR`. Treating every `ENOENT` as an optional missing file lets Wiki readers and recovery paths hide an unsafe or malformed path as if it were absent.

## Decision

When a filesystem fallback has the affected path, the shared missing-path check walks upward from its parent until it finds an existing entry. It treats `ENOENT` as absence only when that entry is an ordinary directory; a file, symbolic link, or other inspection error keeps the original failure visible. Callers without path context retain the error-code-only check. Wiki filesystem and governance callers pass their concrete target paths, and tests exercise both a child below a file and a missing child below an ordinary directory. A child path blocked by a file must surface the host's native error (`ENOTDIR` on POSIX or `ENOENT` on Windows); it is never treated as an absent Wiki root.

## Alternatives considered

**Treat every `ENOENT` as absence.** Rejected: on Windows that conflates an absent path with a path whose ancestor is a regular file, allowing optional reads or recovery to mask malformed state.

**Branch on the operating system or accept Windows-specific errors.** Rejected: it would encode host behavior at each caller and weaken the shared fail-closed contract instead of checking the filesystem condition that caused the error.

**Skip affected Windows tests.** Rejected: the supported-platform matrix must continue to exercise the same safety contract; deterministic fixtures cover the behavior while native Windows CI verifies the platform mapping.

## Consequences

Optional reads and cleanup still tolerate genuine absence beneath a real directory, while failures below files or links propagate consistently across supported hosts. The extra ancestor inspection runs only after `ENOENT` and may perform a small number of synchronous `lstat` calls. Windows-specific fixtures no longer rely on POSIX mode bits, path separators, shell names, or permission changes that the host does not provide.
