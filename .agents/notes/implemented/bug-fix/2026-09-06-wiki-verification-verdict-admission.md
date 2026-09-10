# Agent Note: Wiki verification verdict admission

Status: implemented

English | [中文](2026-09-06-wiki-verification-verdict-admission.zh.md)

## Problem

An authenticated verification receipt can record failure. Authenticity alone cannot authorize a Candidate promotion: a project-writable review mirror or a prepared promotion journal can reference a genuine failed receipt.

## Decision

[Receipt verification](../../../../packages/host/knowledge-wiki/src/verifier.ts) keeps authentic failed receipts readable for audit, but creates a passing promotion projection only from an authenticated `pass` verdict. [Promotion recovery](../../../../packages/host/knowledge-wiki/src/reviews.ts) independently requires that verdict before applying any operation of a non-Archive journal. Journal seals, exact-byte bindings, path confinement and conflict checks remain required; none substitutes for the verdict.

## Alternatives considered

**Reject only at the service entry.** A prepared journal can bypass that entry during recovery, so the recovery owner also enforces the verdict.

**Discard failed receipts.** This removes audit evidence and conflates an authentic rejection with missing or tampered evidence. Failed receipts remain stored and readable.

## Consequences

A failed receipt cannot authorize Canonical writes, Candidate removal or review resolution, including through a correctly sealed prepared journal. Such a journal is rejected rather than silently completed or deleted. Archive retains its separate policy. [Behavior regressions](../../../../packages/host/knowledge-wiki/tests/verification.spec.ts) exercise direct admission, a forged project mirror, audit readability and recovery with unchanged operation pre-state; these contracts do not establish installed-app acceptance.
