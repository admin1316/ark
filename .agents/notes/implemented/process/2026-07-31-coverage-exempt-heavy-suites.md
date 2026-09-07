# Agent Note: Coverage-exempt heavy suites

Status: implemented

English | [中文](2026-07-31-coverage-exempt-heavy-suites.zh.md)

## Problem

The CI coverage lane (`check:ci:coverage`) had its wall clock pinned by a handful of heavy test files: in a local 6-worker full-suite profile, 555 test files aggregated 1595 seconds, with `packages/typert/generator/tests/type-model.spec.ts` alone at 885 seconds and the top 10 files holding 84% of the aggregate. These suites share one shape — every case performs whole-workspace compiler analysis or drives real subprocess fixtures — and v8 instrumentation multiplies exactly that kind of runtime.

The decisive waste: the instrumentation tax paid by child-process fixtures over `scripts/` contributed **nothing** to the per-file 100% thresholds because `coverage.include` contains package source only. Package suites remain instrumented whenever they execute source in the denominator.

## Decision

The `ci-coverage` aggregate splits into two parallel gates; every test still runs, and only the heavy suites stop paying the instrumentation tax:

- **Instrumented gate** (`test:coverage`): sets `DSH_COVERAGE_EXEMPT_HEAVY=1`, which makes `vitest.config.ts` drop the exempt suites from both projects' excludes; every remaining file runs instrumented and carries the entire threshold proof. The variable is injected through the gate's own env (the existing `Gate.env` mechanism), not the workflow-global environment, so the uninstrumented gate beside it and any local `vitest run` never see it and behave unchanged.
- **Uninstrumented gate** (`test:coverage-exempt-heavy`): runs exactly the exempt suites through paired positional filters, keeping the correctness signal whole.

Linux coverage CI and native Windows CI use [in-job partitioned coverage](2026-08-18-in-job-partitioned-coverage.md) inside the instrumented gate. Its merged report carries the same threshold proof; the exempt gate and its membership rules remain unchanged.

`scripts/coverage-exempt.ts` is the single roster point, holding the membership contract and the filter/exclude pairs so the two sides cannot drift.

### The roster, reconciled entry by entry

A suite contributes to coverage exactly when it executes measured files in-process (`coverage.include` spans the package src trees). The current roster, audited:

| Exempt suite | Measured code executed in-process | Who carries the coverage |
| --- | --- | --- |
| `scripts/install-lefthook.spec.ts`, `scripts/oxlint-contract.spec.ts`, `scripts/change-scope.spec.ts`, `scripts/translation-pairing-merge.spec.ts` | None — they test `scripts/` sources (never in `coverage.include`) and work by spawning child processes | Nothing to carry |

Typert generator source belongs to the coverage denominator, so all generator tests run in the instrumented gate. A package test can never join the exempt roster merely because another suite currently covers the same lines.

### Membership contract

A new exemption must satisfy both: it executes no coverage-measured package source in-process, and the filter and exclude select exactly the same file set. The contract text lives beside the roster in the same file.

### The gate polices the roster automatically

The per-file 100% thresholds are themselves the roster's guard; a wrong roster cannot pass silently:

- If a future exempt suite in fact solely covers some measured file, the instrumented gate goes red on the spot (that file drops below 100%).
- The converse holds too: new code covered only by an exempt suite turns the gate red immediately.

Coverage-result invariance therefore does not rest on humans maintaining the roster, in line with the misconfiguration-fails-loud convention. The only thing given up is that the exempt suites' own execution no longer produces coverage data — the table above shows that data was entirely redundant, so the final report is file-for-file identical in threshold terms.

## Alternatives considered

- **CLI `--exclude` to drop the exempt suites from the instrumented gate.** Proven ineffective: vitest 4's `cliExclude` does not participate in per-project include resolution, so under a multi-project config the exempt suites stayed selected; the env + config route replaced it.
- **Lowering worker counts or raising gate concurrency.** Measured ineffective during the incident: the lane's wall clock was pinned by the longest tail files (aggregate/wall ≈ 4× effective parallelism), and the concurrency knobs moved nothing in either direction.
- **Cross-runner sharding (`--shard` + blob merge).** Rejected because a matrix, artifact pipeline, and merge job would add a second workflow topology. The selected [in-job partitioning](2026-08-18-in-job-partitioned-coverage.md) uses Vitest shards only as local single-worker processes inside the existing job.
- **Deleting or skipping the script fixtures.** Rejected: running them uninstrumented in parallel preserves their full correctness signal without pretending they contribute package-source coverage.

## Verification

The instrumented gate fails immediately if a package suite is wrongly exempted while its source remains in the denominator. `vitest list` verifies the env toggle adds and removes exactly the current script-only set; `run-gates.spec.ts` covers the aggregate graph construction.

## Consequences

- The exempt suites execute without adding instrumentation cost to the thresholded gate; partitioned wall-clock measurements belong to the [in-job partitioning decision](2026-08-18-in-job-partitioned-coverage.md).
- `DSH_GATE_CONCURRENCY` has two schedulable gates in this lane again, so the aggregate scheduler is no longer a pass-through.
- Adding a heavy script suite to the roster requires the membership audit above; package test suites remain instrumented.
- The exempt suites no longer appear in the coverage report's file list of contributors; their correctness signal lives solely in the uninstrumented gate's pass/fail.
