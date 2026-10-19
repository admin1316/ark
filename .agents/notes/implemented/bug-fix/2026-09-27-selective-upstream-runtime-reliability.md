# Agent Note: Selective upstream runtime reliability fixes

Status: implemented

English | [中文](2026-09-27-selective-upstream-runtime-reliability.zh.md)

## Problem

Ark retains native consumers and a durable session model that differ from current upstream Harness. Replacing the runtime wholesale would combine unrelated session, product, and privacy changes with fixes for bounded tool output, compaction budgets, subprocess output storage, and crashed file-lock holders. The defects also belong to shared owners; separate UI refresh workarounds would not repair them.

## Decision

The source reference is upstream [dsh-v0.1.7-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2), commit `477b4f420553e8a52c2fbccc464d7561b239c443`. Ark adapts four independent fixes at their existing owners, retaining its package versions, native interface, session format, and disabled-by-default session-log upload.

- **Character caps:** [`dc07e5a50d`](https://github.com/deepseek-ai/deepseek-harness/commit/dc07e5a50dadcf03e3fb9e1b7c69bb2ba9550254), including review correction [`223ad4c373`](https://github.com/deepseek-ai/deepseek-harness/commit/223ad4c373945004f0ad64a498d7369a524ef360), supplies the surrogate-pair rule. The existing [output-retention library](../../../../packages/util/output-retention/README.md) owns the helper used by persistent Bash, persistent PowerShell, and the string editor. A cut can omit one extra UTF-16 code unit to preserve a complete pair; it never exceeds the configured cap.
- **Compaction budgets:** upstream [PR 4530](https://github.com/deepseek-ai/deepseek-harness/pull/4530) supplies output reservation. The [compaction provider](../../../../packages/compaction/compaction-basic/README.md) caps pressure at the context window minus the effective request output cap and scales ratio-based retained history against that remaining budget. Ark preserves its summary cap and small-window behavior instead of importing the upstream fixed 64K headroom default. The [routed policy decision](../architecture/2026-07-20-routed-model-context-and-compaction-policy.md) still owns routing and optional composition.
- **Subprocess spill failures:** [`cfa84ed4e3`](https://github.com/deepseek-ai/deepseek-harness/commit/cfa84ed4e373a2cd8f0068c5169cffeb24e17789) supplies failure containment. Ark keeps its existing [collector](../../../../packages/subprocess/subprocess-local/README.md) rather than importing the upstream process-binding refactor. Failed open/write operations disable the optional spill, withdraw its path, and report once while the bounded tail keeps collecting. Reporter failures are also contained.
- **Exited lock holders:** [`7e7ba139fd`](https://github.com/deepseek-ai/deepseek-harness/commit/7e7ba139fd5191ec09e310f164661c90512a6289), [`910711e6c1`](https://github.com/deepseek-ai/deepseek-harness/commit/910711e6c14c84984d5301a3a178368c9cde2533), and [`1bd3df926d`](https://github.com/deepseek-ai/deepseek-harness/commit/1bd3df926d20cb0a15777bca89011534155133b5) supply the final PID-compatible recovery mechanism. The [atomic-write helper](../../../../packages/util/atomic-write/README.md) rechecks a valid dead holder under a takeover claim. Ark additionally verifies the held file identity and record before release so a visibly replaced lock is retained. This updates the shared recovery part of the [JSONL locking decision](2026-08-16-p0-d-jsonl-cross-process-lock.md); per-session mutation ownership remains unchanged.

Ark also records a temporary output path as owned only after exclusive creation succeeds. Both the spill collector and atomic replacement preserve a pre-existing collision target; atomic cleanup failures preserve the original write error. These ownership protections are local hardening, not claims about the upstream release.

## Alternatives considered

**Upgrade to the complete upstream release.** Rejected because its newer durable projections, session format, application shells, and account defaults are separate migrations. Ark's imported history has no common ancestor with this upstream tag; a version label does not establish compatibility.

**Duplicate fixes inside native views or individual settings consumers.** Rejected because all affected callers already converge on the retained owners. The character helper adds only internal workspace references and no external dependency.

**Import fixed 64K compaction headroom and new upload defaults.** Rejected for this scope: fixed headroom would change small-window policy, and the oversized request-extension fix primarily concerns optional upload/extensions. Neither establishes the cause of native scrolling or display stalls. Ark's disabled upload default remains explicit.

**Recover locks by age or delete every leftover claim.** Rejected because age does not prove a holder exited. Incomplete records, live or unprobeable holders, and residual takeover claims fail closed. Recovery never operates on Git's index lock.

## Consequences

These changes reduce specific corruption, overflow, crash, and stale-lock failure modes. They do not establish faster rendering, better model reasoning, or that every long-conversation failure is fixed. Subprocess spill loss sacrifices full-output recovery beyond the retained tail. A dead takeover claimant can still leave a claim requiring operator investigation; PID reuse conservatively prevents takeover, and release identity checks are not an atomic compare-and-unlink against arbitrary external replacement.

Regression evidence distinguishes the old-source failure from repaired behavior. Real terminal composition, independent competing processes, and keyless runnable session snapshots cover affected execution paths. Native candidate acceptance and release receipts remain separate from source tests; production installation and user data are not modified by the backport itself.

The retention, adapter-default, routed-policy, and JSONL notes remain active because their ownership and rejected-alternative rationale still applies. This note partially updates budget and recovery behavior, not those independent decisions.
