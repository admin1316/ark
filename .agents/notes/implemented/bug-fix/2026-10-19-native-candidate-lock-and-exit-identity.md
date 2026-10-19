# Agent Note: Project optional lock paths and retain exit identity checks

Status: implemented

English | [中文](2026-10-19-native-candidate-lock-and-exit-identity.zh.md)

## Problem

Ark's runtime plan derives an external dependency graph from the root pnpm lockfile, while its receipt verifies the platform-specific installed lockfile. pnpm retains a foreign optional package's metadata but prunes its descendant edges on macOS arm64. Requiring those unreachable descendants makes a correctly locked installation fail receipt verification: the WebContainers optional branch of `sharp` requires an absent `@emnapi/runtime` resolution.

The parent-death and `SIGTERM` race test can observe a retained process after macOS has replaced its argv with `(node)` but before `ps` reports a zombie or removes the row. Rejecting that observation immediately makes a legitimate exit fail the test; accepting arbitrary argv loss as exit or signaling a changed PID would weaken process ownership checks.

## Decision

The pure [`deriveArkExternalLockGraph`](../../../../integrations/jiuzhang/src/runtime-plan.mjs) projects the root lock for Ark's `darwin-arm64` target. It retains exact package resolution, integrity, and foreign optional parent metadata, but omits descendant edges reachable only through an unsupported optional path. Optionality follows the complete path. A required visit or another supported path retains reachable descendants even after an earlier optional visit. The [receipt verifier](../../../../integrations/jiuzhang/src/runtime-closure.mjs) retains its exact integrity and resolution checks.

The [process identity helper](../../../../integrations/jiuzhang/tests/helpers/process-liveness.mjs) accepts a same-start zombie as exited without signaling it. For the same start time and the exact parenthesized executable-name placeholder, the asynchronous helper takes at most ten observations separated by 10 ms. That placeholder never authorizes a signal. Only a fresh row matching the retained start time, executable, and full argv authorizes signaling; absence and a same-start zombie establish exit. Other identity changes fail immediately, and a persistent placeholder fails after the bounded observations.

The [lifecycle tests](../../../../integrations/jiuzhang/tests/lifecycle.test.mjs) conservatively treat a same-start non-zombie row as live even when argv is unavailable. This keeps cleanup assertions from reporting success during the ambiguous interval. The original failed run did not record `ps` status, so its precise state is unavailable; local reproduction establishes the sleeping-placeholder-to-absence transition independently.

## Alternatives considered

**Relax receipt resolution or integrity checks.** This would accept genuine lock drift. Projecting the optional path to match the package manager preserves the independent verifier's authority.

**Drop every foreign package or traverse it unconditionally.** Dropping the parent loses the lock metadata pnpm retains. Traversing every child demands packages pnpm does not install, while globally pruning a previously optional node can erase descendants reached through another path.

**Ignore process identity errors or signal by PID alone.** Either can conceal a live survivor or signal a reused process. Bounded reobservation resolves only the identified exit placeholder and retains strict identity validation for every signal.

## Consequences

The [lock graph regressions](../../../../integrations/jiuzhang/tests/runtime-plan.test.mjs) pin retained parent metadata, excluded unreachable children, supported alternate paths, inherited optionality, and optional-first required visits without mutating the input graph. Lifecycle regressions cover fresh matching rows, PID reuse, argv and executable drift, persistent ambiguity, conservative liveness, and a real child held unreaped by its stopped parent. The launcher shutdown protocol is unchanged; the race test's observations and signal authorization are more precise.

Source checks establish these mechanisms. A successful official runtime pack, installed candidate verification, and native interaction acceptance remain separate evidence; source tests alone do not establish release readiness or parity with the legacy application.
