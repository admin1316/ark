# Agent Note: Generated-artifact index gate

Status: implemented

English | [中文](2026-09-17-generated-artifact-index-gate.zh.md)

## Problem

The repository retires generated build output from version control: host `lib/` trees under `packages/*/*/` and `apps/*/`, TypeScript incremental `*.tsbuildinfo`, the Swift module cache under `.tmp-swift-module-cache-*/`, and the workspace-init copies `purpose.md` and `schema.md` at the root. `.gitignore` stops accidental additions but cannot stop `git add -f`, and nothing inspected the tracked path set, so a forced add could reintroduce the retired files in a commit every other gate accepts.

A working-tree check cannot answer the question. An ordinary host build leaves those files on disk by design, so presence on disk is not evidence of tracking; the question is what the Git index holds.

## Decision

`scripts/verify-generated-tracking.ts` inspects Git index paths and nothing else. It lists the index with `git ls-files --cached -z`, splits on NUL so spaces and non-ASCII names survive, and classifies each path by shape: the exact `packages/*/*/lib/` and `apps/*/lib/` segment positions, the `.tsbuildinfo` suffix, the first-segment `.tmp-swift-module-cache-` prefix, and the two root init files. Every violation prints its path and ownership reason, and the command exits `1`.

Retained build inputs stay out of scope by construction rather than by exception list: vendored `lib/` trees under `vendor/`, hand-written `.agents/` modules merely named `lib`, tsconfig and other build definitions, and native and test inputs do not match the retired shapes.

Inspection failure is a failure. A repository Git cannot read, an unmerged index (`git ls-files --unmerged`), or a malformed listing exits non-zero with a diagnostic; only a complete, resolved scan reports zero violations.

The gate runs where the other repository gates run: id `generated-tracking` in the `ci-static`, `ci-primary`, `ci-linux-primary`, and `ci-windows-observational` graphs from `scripts/run-gates.ts`, in the local `hygiene` and `check-all` aggregates, and as a lefthook `pre-commit` job. The hook scans the whole index rather than only staged paths, because the index already contains the staged state and one full-index definition keeps the commit-time and CI answers identical.

The same index check rejects machine-owned distribution inputs: real `.env` variants and `.credentials.yaml` backups at any depth, `.sessions`, `.llm-wiki`, and `wiki` directories, and root profiles, candidate runtime/cache registries, user-authored presets and skills, logs, cache, provider state, `.ark-*` recovery/import state, Harness, Knowledge, Default Workspace, Document References, Workbench Drafts, `.dsh`, sessions, storages, attachments, terminal state, and settings files. Root identity, runtime patch, and generated settings-reference files are also machine-owned; nested source profile fixtures and example patches remain allowed. Named environment examples and recorded snapshot fixtures remain valid inputs. Personal media-tool credentials, cloud account state, install identities, and miss logs (including editor backups) are rejected by their file shapes; project media assets, manifests, recipes, and preferences remain source inputs. Imported `raw/sources` documents, diagnostic log files, gcloud credential stores, personal instruction overlays, and local Claude/Codex state (including Claude home configuration backups) are also excluded; the committed `.claude/skills` integration path, `.codex/config.toml` project configuration, and base instruction files remain source inputs. This is a path check, not content-based secret detection.

[Source privacy](../../../../.github/workflows/source-privacy.yml) scans fetched Git history with checksum-pinned Gitleaks on pull requests and main pushes. Both workflows call the same scan; the PR `all checks passed` verdict depends on its success and rejects failure, cancellation, or skipping. Its [configuration](../../../../.gitleaks.toml) retains the default rules, with narrow exceptions for Git blob metadata, exact synthetic test literals, and the historical upstream public ingestion identifier in its original commits. Output is redacted. The media skill requires an explicit telemetry ingestion key in a directly launched tool process instead of shipping one; model-facing subprocesses continue stripping ambient keys; an unconfigured installation sends no media telemetry. Local user data and offline recovery archives are outside these source checks; CI neither erases them nor rewrites history.

The same job inspects every commit tree newly reachable from the PR head (excluding its base) or main push (excluding the previous tip), using the index classifier. Intermediate files deleted before the final commit and merged side branches are included. Missing commits or invalid boundaries fail the check; existing history is not rewritten.

## Testing

`scripts/verify-generated-tracking.spec.ts` creates throwaway repositories under the OS temp directory and covers: ordinary source passing; ignored build output present only on disk passing; `git add -f` of a retired artifact failing with its path and reason; index removal with the file kept on disk passing; vendored and `.agents` `lib/` trees plus tsconfig, native, and Python inputs passing; similarly named paths (`library/`, `libx/`, a package one level too shallow, `notes.tsbuildinfo.bak`, a non-root `schema.md`, `src/lib.ts`) passing; spaced and non-ASCII names inside a retired tree failing; an unmerged index failing; and a directory Git cannot read failing instead of passing.

The CLI additionally proves the non-repository case (`--root` into a plain directory) exits non-zero rather than reporting an empty index.

Not covered: content-based or semantic detection (a generated file with a novel shape is out of scope until a rule names it), and Windows path spelling.

## Alternatives considered

**Check the working tree for retired paths.** Rejected: the host build writes exactly those paths, so a normal build would fail the gate while a forced add on a machine without a build would pass — the inverse of the property the repository needs.

**Ban paths containing `lib` or binary-looking suffixes.** Rejected: `vendor/cordis/lib/` is the vendored source of record, `.agents/**/lib/` is hand-written source, and native and test inputs carry their own retained shapes; a substring ban would need a large exception list and would still miss `*.tsbuildinfo` under other names.

**Add a dedicated workflow like `expected-filenames.yml`.** Rejected for this decision: the check needs no path-filtered trigger, it is cheap and repository-wide, and wiring it into the existing gate scheduler plus the pre-commit hook gives CI and commit-time coverage without a second quality framework.

**Check only staged paths in the hook.** Rejected: one full-index scan serves both the commit and CI, keeping a single definition of the checked path set.

**Treat a Git error as no violations.** Rejected: it turns an unreadable state into a green gate.

## Consequences

A retired artifact cannot reach a commit through `git add -f` without the commit failing, and CI fails the same way on the checked-out commit. The class list is explicit and shape-based, so a new generated-output layout is not silently banned: adding one requires editing the rule list and its spec, and the gate deliberately does not guess. Its cost is one index listing per run plus a small per-commit overhead. The gate covers tracking only: whether built packages are valid stays with `publint` and the `ci-artifacts` lane, and history already containing an artifact is not rewritten by this check.
