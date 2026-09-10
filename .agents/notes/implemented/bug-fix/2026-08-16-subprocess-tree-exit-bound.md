# Agent Note: Bounded tree-exit observation in subprocess-local

Status: implemented

English | [中文](2026-08-16-subprocess-tree-exit-bound.zh.md)

## Problem

`LocalSubprocessRuntime` teardown awaited whole-tree liveness through an unbounded `while (treeAlive()) await sleepTick()` loop: a descendant in an uninterruptible state (D-state, e.g. wedged NFS I/O) that survives SIGKILL made `waitForExit()` — and therefore service disposal, plugin HMR reload, and any `ctx.effect` teardown — hang forever.

## Decision

`observeTreeExit` now polls under a sliding absolute deadline (`2 × spec.graceMs` per terminate/waitForExit call: one grace for the SIGTERM tier, one for SIGKILL to land and be observed). On timeout with the tree still alive it sets `treeExitGivenUp`, stops polling, and reports `false` — without touching the pid-reuse guard or clearing the escalation grace timer. `terminate()` resets the give-up state and rebuilds the observer so a later escalation is still observed; `waitForExit()` reports the unconfirmed tree immediately after a prior give-up. Disposal logs a warning and proceeds instead of blocking; a handle whose exit was never confirmed stays owned (`release` keeps it in the live set) so a later dispose can still escalate. `terminateForHostExit`'s synchronous SIGKILL path is untouched.

## Alternatives considered

**Never giving up.** Rejected: that is the hang being fixed; the bounded report keeps pid-reuse protection while letting teardown proceed.

**A configurable deadline.** Rejected for this change: `graceMs` already varies per spec and doubling it is the natural bound; a new knob would need a second consumer contract.

## Consequences

Teardown of a tree with an unkillable member returns at the two-grace deadline with a warning instead of blocking the process; normal trees (which exit within the grace window) observe no change. Three new tests pin the give-up report, the disposal warning path, and the still-owned handle escalation (125 tests in the package, stable across reruns).
