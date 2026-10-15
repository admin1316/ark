# Agent Note: Verifier cancellation after direct helper exit

Status: implemented

English | [中文](2026-10-13-verifier-post-exit-cancellation.zh.md)

## Problem

The external Wiki verifier can receive a valid signed response and direct helper exit while a managed descendant still runs. The local subprocess runtime removes its spawn abort listener when the direct outcome settles. An unsignalled whole-tree wait then ignores the verifier's deadline and caller cancellation, leaving the verification pending after interruption.

## Decision

The verifier passes its existing operation controller signal to the first `waitForExit` after `child.done`. An interrupted wait returns false, then the existing consumer terminates and joins the managed tree before reporting the original timeout or cancellation. Successful verification still requires complete tree exit and signature validation.

## Alternatives considered

**Terminate every tree immediately after direct exit.** Rejected because a finite descendant can legitimately finish before the existing deadline; direct exit alone does not decide whether the signed result is usable.

**Change generic subprocess waiting or add another deadline.** Rejected because other consumers own long-lived work and the verifier already has a validated operation deadline. Its consumer must pass that signal rather than changing shared semantics or adding a tunable.

## Consequences

The operation wait is interruptible without new permissions, configuration, wire fields, signing bytes, or thresholds. Cleanup still waits for managed-tree quiescence; an escaped descendant or an opaque provider that cannot finish cleanup is outside this guarantee. A surviving descendant is not classified immediately as an orphan: finite work may finish, otherwise the existing deadline triggers termination and timeout rejection.

## Verification

The owning adapter suite executes real Node helpers that return a signed result and exit while an independently observable child remains. Timeout and cancellation reject after managed cleanup; finite natural descendant exit preserves the verified result. Failure cleanup is separately owned by the fixture and is not counted as successful verifier cleanup. These probes cover the exercised local runtime, not native activation or the complete platform matrix.
