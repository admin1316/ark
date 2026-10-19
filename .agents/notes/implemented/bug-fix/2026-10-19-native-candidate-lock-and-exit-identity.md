# Agent Note: Reject incomplete offline locks and retain exit identity checks

Status: implemented

English | [中文](2026-10-19-native-candidate-lock-and-exit-identity.zh.md)

## Problem

pnpm 11.7 can exit successfully from offline lockfile derivation while reporting an optional dependency's `resolution_failure` and omitting its descendants. In Ark's `sharp` dependency graph, missing full-metadata cache entries for `@img/sharp-wasm32` and `@emnapi/runtime` produce an incomplete lock even when ordinary metadata remains cached. The receipt correctly rejects the missing root-locked resolution. Restoring those full-metadata entries makes the same offline command reproduce the complete online lock byte for byte, so CPU support does not explain the omission.

The parent-death and `SIGTERM` race test can observe a retained process after macOS has replaced its argv with `(node)` but before `ps` reports a zombie or removes the row. Rejecting that observation immediately makes a legitimate exit fail the test; accepting arbitrary argv loss as exit or signaling a changed PID would weaken process ownership checks.

## Decision

The [runtime plan](../../../../integrations/jiuzhang/src/runtime-plan.mjs) retains the root-locked external graph, including foreign-platform optional resolutions. The [pack owner](../../../../integrations/jiuzhang/src/pack-runtime.mjs) derives its lock with `--reporter=ndjson` and passes the output to [`assertArkOfflineLockResolution`](../../../../integrations/jiuzhang/src/runtime-closure.mjs). This helper rejects an optional dependency skipped because of `resolution_failure`, even when pnpm exits zero. Its only resolution-failure exception comes from an existing root-plan `omitted-platform-workspace` edge in `optionalDependencies`: the event's direct parent name and version must match that edge's source owner, and its child name and exact `bareSpecifier` must match the planned child name and version. Foreign-platform status alone grants no exception. Normal platform skips remain permitted. Online full-metadata cache preparation is separate from the offline pack; cache incompleteness cannot change the graph the pack accepts.

The [runtime lock verifier](../../../../integrations/jiuzhang/src/runtime-closure.mjs) is shared by pre-install validation and final receipt validation. The pack checks the derived lock against the planned exact resolutions, integrity values, and dependency edges before its frozen offline install. The final receipt retains the same strict validation, independently of the package manager's diagnostics.

The [process identity helper](../../../../integrations/jiuzhang/tests/helpers/process-liveness.mjs) accepts a same-start zombie as exited without signaling it. For the same start time and the exact parenthesized executable-name placeholder, the asynchronous helper takes at most ten observations separated by 10 ms. That placeholder never authorizes a signal. Only a fresh row matching the retained start time, executable, and full argv authorizes signaling; absence and a same-start zombie establish exit. Other identity changes fail immediately, and a persistent placeholder fails after the bounded observations.

The [lifecycle tests](../../../../integrations/jiuzhang/tests/lifecycle.test.mjs) conservatively treat a same-start non-zombie row as live even when argv is unavailable. This keeps cleanup assertions from reporting success during the ambiguous interval. The original failed run did not record `ps` status, so its precise state is unavailable; local reproduction establishes the sleeping-placeholder-to-absence transition independently.

## Alternatives considered

**Prune foreign optional descendants or relax receipt checks.** The missing metadata reproduces the truncated graph independently of target support. Accepting that graph would turn an offline resolution failure into a permitted dependency change and weaken the root lock's authority.

**Trust pnpm's exit code or wait for final receipt validation.** A zero exit code does not expose the optional resolution failure, and final-only validation discovers it after installation and manifest work. Structured diagnostics plus exact pre-install validation reject incomplete derivation at its owner.

**Allow network recovery inside the pack.** This couples runtime assembly to online resolution and violates its offline install policy. Cache preparation supplies metadata separately; the pack still requires a complete root-locked result.

**Ignore process identity errors or signal by PID alone.** Either can conceal a live survivor or signal a reused process. Bounded reobservation resolves only the identified exit placeholder and retains strict identity validation for every signal.

## Consequences

The [runtime plan tests](../../../../integrations/jiuzhang/tests/runtime-plan.test.mjs) pin the retained foreign WASM chain, the single offline lock/install owner, and validation before installation. The [runtime closure tests](../../../../integrations/jiuzhang/tests/runtime-closure.test.mjs) pin strict lock validation without installed content, rejection of optional resolution failures and malformed reporter output, normal platform skips, and the exact workspace omission exception. Changed child or owner identities, an ancestor-only match, and missing parent identity cannot authorize that exception. Lifecycle regressions cover fresh matching rows, PID reuse, argv and executable drift, persistent ambiguity, conservative liveness, and a real child held unreaped by its stopped parent. The launcher shutdown protocol is unchanged; the race test's observations and signal authorization are more precise.

Source checks establish these mechanisms. A successful official runtime pack, installed candidate verification, and native interaction acceptance remain separate evidence; source tests alone do not establish release readiness or parity with the legacy application.
