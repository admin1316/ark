# Agent Note: Sandbox run-guard exit-code propagation

Status: implemented

English | [中文](2026-09-18-sandbox-run-guard-exit-propagation.zh.md)

## Problem

The two e2e steps in [sandbox.yml](../../../../.github/workflows/sandbox.yml) wrap their vitest run in a shell guard whose purpose is to fail the step when the platform file did not actually run. The guard disabled errexit on purpose, so the captured output is still published when the command fails, but that also removed the only automatic propagation:

```bash
set -u +e -o pipefail
out=$(pnpm exec vitest run ... 2>&1); status=$?
echo "$out"
[ "$status" -eq 0 ]
echo "$out" | grep -qE 'Test Files[[:space:]]+2 passed \(2\)'
```

The bare test-evaluates to a non-zero status and execution continues to the summary grep, whose status becomes the step's status. A non-zero vitest exit whose output still matches the evidence pattern — an unhandled error after a passing summary, or any accepted summary line — therefore reported a green step while the test command had failed. The guard's check existed but was writable, not binding.

## Decision

Both wrappers propagate explicitly, and the captured output is still printed before any check so no log is rewritten and no success text is fabricated:

```bash
if [ "$status" -ne 0 ]; then
  echo "sandbox e2e exited with status $status" >&2
  exit "$status"
fi
if ! echo "$out" | grep -qE 'Test Files[[:space:]]+2 passed \(2\)'; then
  echo "sandbox e2e did not report 'Test Files  2 passed (2)'" >&2
  exit 1
fi
```

A non-zero test status fails the step immediately and preserves the original status; a zero status without the required execution evidence fails with exit code 1 and names the evidence that was missing. The packed-distribution step uses the same shape with its `1 passed (1)` requirement. The gate itself is unchanged: both platform files must have run, and a self-skip still fails.

[scripts/sandbox-workflow-guard.spec.ts](../../../../scripts/sandbox-workflow-guard.spec.ts) executes the real guard instead of a copy: it extracts the `run` block of each named step from the workflow and runs it under `bash` with a stub `pnpm` that produces a controlled status and output. It covers a passing status with evidence, status 7 with evidence that looks complete, a zero status with missing or skipped evidence, and a non-zero status with missing evidence.

## Alternatives considered

**Rely on the last command's status.** That is the defect itself: with errexit off, whichever command runs last owns the step status, so a trailing successful grep silently replaces a failing test command.

**Restore errexit with `set -e`.** The captured output exists precisely for the failing case, and errexit would abort at the command substitution before the guard publishes it; the explicit checks keep the diagnostic and make propagation unconditional.

**Extract the guard into a checked-in shell script.** A standalone script would be easier to test, but it restructures the steps and their evidence contract in the same change; the extraction spec runs the production text, so the copy-drift risk is covered without moving the contract.

## Consequences

A failing test command can no longer be overwritten by a matching summary line: the step exits with the test's own status and the workflow records a real failure.

Missing or self-skipped execution evidence still fails the step, now with an explicit message naming the required summary, so a runner that lost its confinement capability cannot pass as a green leg.

The regression spec runs the workflow text itself, so a future edit to either wrapper is exercised by the same four cases; it does not change any historical CI conclusion, and nothing here claims that past green steps were false.
