# Agent Note: Coverage exclude consistency gate

Status: implemented

English | [中文](2026-08-16-coverage-exclude-consistency-gate.zh.md)

## Problem

`vitest.config.ts` carried a long static `coverage.exclude` list — per-file debt entries for client/web files and whole-package lanes. Nothing checked that a listed pattern still matched a real file. When the `self-modification` package was removed from the repository, its `packages/self-modification/*/src/**/*.{ts,tsx}` exclusion stayed behind: harmless to coverage runs, invisible to review, and the audit's P0/P1 item called for deleting dead entries and preventing re-accumulation.

## Decision

The coverage exclusion list now lives in one exported array, `coverageExcludeEntries` in `scripts/coverage-exclude.ts`, computed for the current platform and environment: the static per-file debt plus the conditional Windows/pwsh lanes. The same module owns the `windowsUnsupportedPackages` constant, which the test exclude also consumes. `vitest.config.ts` imports the array and uses it as `coverage.exclude`, and the new gate `scripts/verify-coverage-exclude.ts` imports the same array and fails when any pattern matches no regular file under the repository root. The gate runs in the package.json `hygiene` chain and in `scripts/run-gates.ts` as `coverage-exclude` — in the static gates shared by `ci-primary`/`ci-static` and in the hygiene leaves of `check-all` — so CI primary and static lanes enforce it.

One pattern is allowed to match nothing on purpose: the `packages/*/*/src/oxlint-contract-*.ts` guard, which exists because `oxlint-contract.spec.ts` writes temporary probe files under package src trees and removes them in its `finally` block — a killed run can leave one behind, and the exclusion keeps that stray file out of the per-file 100% gate. The gate allow-lists that exact pattern with a reason; any other zero-match pattern fails, and a drifted pattern falls out of the allow-list and fails too.

This change also removed the zombie entry itself: `packages/self-modification/*/src/**/*.{ts,tsx}` matched nothing and is gone.

## Alternatives considered

**Import the exported list from `vitest.config.ts` in the gate.** Keeps a single file, but the config sits outside every tsc project: importing it from a scripts gate pulls `vitest.config.ts` and `vitest.shared.ts` into the host program, which fails the project file-list rule (TS6307) and surfaces a latent `exactOptionalPropertyTypes` error in `vitest.shared.ts`. The shared module keeps the gate's import graph inside `scripts/` and type-checks cleanly.

**Extract only the static list into a shared module, leaving the platform-conditional entries inline in the config.** A smaller diff, but the gate would not see the Windows/pwsh lanes, so a renamed `sandbox-windows-acl` or `pwsh-*` file could go stale unchecked. The module computes the full list so every pattern applied on the host is validated.

**Validate the config by parsing its text.** String matching cannot enumerate the list reliably; importing the exported array needs no parser and cannot drift.

**Fail on the zero-match oxlint-contract guard too.** Deleting it would remove a documented defense against a killed test leaving a stray probe that fails the per-file threshold; the allow-list keeps the guard while still failing every genuine zombie.

## Consequences

Removing a package while its coverage exclusion stays behind now fails the hygiene and CI static lanes with the dead pattern named, instead of shipping an invisible stale entry. The cost is one small script, one shared module, and two gate registrations, plus an explicit review step any time a zero-match guard is added or edited. Platform-conditional lanes (Windows-only sandbox sources, pwsh-absent hosts) are validated only on hosts where they are active, which is the same posture vitest itself has.
