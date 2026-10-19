# Agent Note: In-job partitioned coverage

Status: implemented

English | [中文](2026-08-18-in-job-partitioned-coverage.zh.md)

## Problem

Native Windows coverage was the longest feedback path in the complete pull-request inventory. Keeping the instrumented suite in one single-worker Vitest process avoided the worker loss and Node 24 CJS lexer failures seen with larger in-process pools, but a failure could take more than fourteen minutes to appear and the gate runner withheld the child output until completion.

The optimization must retain every test and the merged per-file 100% thresholds. It must also stay inside the existing coverage job: splitting one suite across multiple workflow jobs would add checkout, installation, artifact transfer, and a merge job to the required topology.

## Decision

The ordinary `pnpm run test:coverage` command remains one Vitest invocation. Linux coverage CI fixes `DSH_COVERAGE_PARTITIONS=4`, while native Windows fixes it at 2; no elapsed-time trigger changes either count while a run is in progress. The [coverage-exempt heavy suite](2026-07-31-coverage-exempt-heavy-suites.md) remains a separate uninstrumented gate beside the instrumented work.

When partitioning is enabled, `scripts/run-gates.ts` selects `pnpm run test:coverage:partitioned` for the instrumented gate. `scripts/coverage-partitions.ts` starts the configured Vitest children concurrently, each with one worker and one `--shard=<index>/<count>` option. Partition mode suppresses thresholds and coverage reporters in each child, gives every child a separate report directory, and writes one blob report per process.

The coordinator waits for every child, validates that the blob directory contains exactly the expected files, and then runs one `vitest --merge-reports ... --coverage` command. Only that merged command applies the repository's per-file statement, branch, function, and line thresholds, so a partition is never judged against an intentionally partial inventory.

`DSH_COVERAGE_MAX_WORKERS` continues to size the uninstrumented exempt gate and the ordinary non-partitioned path; it does not resize partition children or cap their aggregate fan-out. Linux and native Windows set that budget to 2 and admit two concurrent outer gates, giving the exempt gate one worker beside four Linux partitions or two native Windows partitions. Both Windows coverage gates require build to pass, preventing temporary Oxlint probes from racing source compilation; production-site validation remains a separate gate. The observational inventory waits only for both coverage gates to settle, so it still runs after a coverage failure; each gate's `needs` dependencies remain pass-required.

## Failure and output semantics

Partition children stream stdout and stderr through the coordinator. The coverage gate opts into `run-gates` streaming, so test progress and failures reach CI logs as they occur without buffering the complete log in the scheduler. The coordinator also retains a bounded 64 KiB combined tail per child; when a child settles unsuccessfully, it prints the spawn error, exit code, or signal and repeats that tail before validating the complete blob set, keeping the specific Vitest failure beside the final partition diagnostic.

A normal failed test still emits a blob through `--coverage.reportOnFailure`, allowing the merge to report the complete coverage state before the coordinator returns failure. Spawn failure, signal termination, non-zero exit, a missing or extra blob, or a failed merge all make the gate fail. The coordinator removes only its owned coverage tree and unlinks a link-shaped path instead of recursively following it.

## Verification

`scripts/coverage-partitions.spec.ts` pins argument construction, package-script separator removal, one-worker partitions, the single merged threshold command, failed-test merging, failure diagnostics before complete-blob validation, waiting for sibling partitions after a spawn failure, and link-safe cleanup. `scripts/run-gates.spec.ts` pins opt-in selection, invalid-count rejection, the complete Windows inventory with its blocking split, and unbuffered streamed output.

Historical native Windows comparisons on a 16-core runner measured two partitions near 405 seconds and sixteen partitions at 112.66–122.01 seconds, but the sixteen-way schedule could put more than twenty active execution units beside build and exempt coverage. The historical eight-partition setting retained separate-process isolation with a longer feedback path and a lower peak. Two historical Linux samples measured the conservative two-partition configuration at 276.68 and 282.27 seconds; that configuration was stable but halved the ordinary path's four instrumented workers. With two exempt workers in that topology, four partitions restored the fan-out to six total coverage execution units on the 16-core hosted runner and at most 36 across the failover VM's six runner instances. These historical measurements and capacity bounds do not describe the current hosted budgets; an unfinished run crossing an arbitrary elapsed-time mark is not evidence for increasing concurrency.

The two-partition setting is a preregistered scheduling-sensitivity experiment for the current hosted Windows inventory; each fixed topology requires complete end-to-end evidence. It preserves all tests, assertions, existing default and explicit deadlines, and merged per-file 100% thresholds. It establishes neither a product repair nor an out-of-memory cause. A complete pass applies to the selected topology; changing partition count also changes file grouping and contention, so it cannot by itself explain failures at eight partitions.

## Alternatives considered

**Use workflow-level sharding.** Rejected because multiple jobs repeat setup and need artifact upload, download, and a merge dependency. The selected partitioning uses multiple processes inside one job and one workspace.

**Raise the Vitest worker count inside one instrumented process.** Rejected because completed Windows trials at higher fan-out exposed worker exits, fixture instability, and Node 24 CJS lexer failures. Separate single-worker processes preserve isolation while still executing the selected partitions concurrently.

**Use one partition count on every host.** Rejected because Linux and Windows have different startup costs and resource ceilings. Each fixed configuration requires its own completed end-to-end evidence.

**Apply thresholds independently in each partition.** Rejected because every partition intentionally sees only part of the suite and would report false uncovered files. Threshold ownership belongs to the merged report.

## Consequences

Coverage pays one Vitest startup/configuration cost per partition and one report-merge cost, but it avoids another workflow topology and keeps one final threshold verdict. Partition output may interleave, while the partition start labels and Vitest file identities retain attribution.

Linux and Windows use the same coordinator with platform-specific partition counts and surrounding worker budgets. Local coverage stays simple unless a caller explicitly chooses the partitioned package script and supplies a valid count greater than one.

Future tuning starts from completed runs at one fixed configuration. Slow progress alone never raises partition count or outer concurrency, because repeated restarts would erase the only evidence needed to choose a stable setting.
