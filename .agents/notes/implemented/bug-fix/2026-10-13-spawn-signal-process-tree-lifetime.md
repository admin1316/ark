# Agent Note: Spawn cancellation follows process-tree lifetime

Status: implemented

English | [中文](2026-10-13-spawn-signal-process-tree-lifetime.zh.md)

## Problem

A direct-child outcome can settle while a same-group helper still executes. Releasing the original spawn signal at that outcome ends cancellation authority before the process-tree lifetime promised by the [subprocess service](../../../../packages/subprocess/subprocess/README.md).

## Decision

The [local provider](../../../../packages/subprocess/subprocess-local/README.md) and [E2B provider](../../../../packages/e2b/subprocess-e2b/README.md) retain the original spawn signal until their existing tree observer confirms quiescence. A failed start without an owned process releases the listener immediately. The local provider starts or reuses its memoized observer at direct-child settlement; the E2B service's existing release path owns remote observation. Neither provider makes `done` wait for the whole tree.

The spawn signal requests termination. A signal passed to `waitForExit` only bounds that observation. Consumers retain their own deadlines and failure classification, including the [external verifier's bounded wait](2026-10-13-verifier-post-exit-cancellation.md).

## Alternatives considered

**Release at the direct outcome.** This frees a listener promptly but leaves a surviving helper outside the caller's cancellation request.

**Delay `done` until the tree exits.** This conflates direct command status with teardown and allows a descendant to hold a completed command outcome open.

**Repair each consumer.** Explicit consumer termination remains useful, but requiring separate patches for Bash, verifiers, and other callers leaves the shared spawn contract incomplete.

## Consequences

One provider repair covers every caller using its spawn signal. The local observer keeps its existing timer alive while owned survivors remain, even for direct callers that do not start their own wait. Confirmed absence releases the listener and ends signalling; natural exit and failed startup leave no listener ownership behind. Existing grace periods, output collection, outcome values, and protocol fields stay unchanged.

Regression tests exercise cancellation after leader exit, listener release after natural exit, failed startup, and repeated termination. POSIX group identity can still be reused before the first observed absence, and a descendant that leaves the group escapes group signalling. Windows retains its direct-child liveness limitation. E2B SDK doubles verify the ownership rule without establishing live sandbox behavior.
