# Repository maintenance and cleanup boundaries

English | [中文](maintenance.zh.md)

One entry for what counts as source, generated output, and historical evidence; what may leave version control and under which preconditions; and where the current build, check, and rollback entries live.

## Authority boundaries

- `main` is the current development source entry; the HEAD at the time this page was refreshed is recorded in root README section 9.
- `release/20260913-clean-baseline` is the historical baseline reference (snapshot `9e83b626…`, hygiene commit `795c5306…`); its commits are not ancestors of `main`.
- The installed artifact `~/ark/Ark.app` carries its own release identity and provenance; it never inherits "current" from a main push.

## Directory taxonomy

- Source: `packages/`, `native/`, `integrations/`, `apps/`, `python/`, `scripts/`, and `.agents/` workflows.
- Generated and out of version control: host build outputs under `packages/*/*/lib/` and `apps/*/lib/`, plus every `*.tsbuildinfo`; `.gitignore` retires each shape and `git ls-files` reports none. `pnpm run verify-generated-tracking` fails when a retired path is staged or committed, `git add -f` included, and runs in the `ci-static` gate lane and the pre-commit hook.
- Tracked source named `lib/`: the vendored `vendor/cordis/lib/` tree and hand-written `.agents/**/lib/` modules stay under version control; neither is build output.
- Historical evidence, keep and index: `orig/` (three pre-rewrite Swift copies), the stage reports archived under `archive/` (`archive/evidence-r18.md`, `archive/handoff-r18.md`, `archive/integration-l1517-report.md`, `archive/package-audit-r18.json`), and frozen Agent Notes under `.agents/notes/archived/`.
- Rebuildable caches: `.tmp-swift-module-cache-*/` — Swift compiler outputs (`.pcm`/`.swiftmodule`/`.timestamp`); ignored and out of the index, while the product and its contract tests exclude this prefix by name and nothing consumes it as input.
- Unknown purpose, leave alone: the root `.lock` file (content `1872`, no tracked reference).

## Cleanup preconditions

- A cache may leave version control only after its content is confirmed to be tool output, no tracked file references it as input, and a rebuild regenerates it. A repository-wide output removal additionally proves the chain clean checkout → `pnpm install --frozen-lockfile` → build → tests → pack → install verification.
- Historical evidence is not deleted in hygiene rounds; it is indexed here.
- "Ignored" is not "untracked": after editing `.gitignore`, verify both separately (`git check-ignore` versus `git ls-files`).

## Build, check, and rollback entries

- Install: `pnpm install --frozen-lockfile`. Documentation gates: `pnpm run doc-sync`; the build-free subset is `tsx scripts/run-gates.ts doc-quick`.
- CI-equivalent suites: the `pnpm run check:ci` family over `scripts/run-gates.ts` modes; the coverage gate is `pnpm run test:coverage`.
- Native contracts: `swift run --package-path integrations/jiuzhang/native --skip-update JiuzhangShellContractTests`.
- Build-output cleanup: `pnpm run clean`. Rollback of the installed artifact: root README section 8.
- Generated-artifact tracking: `pnpm run verify-generated-tracking` fails when the Git index holds a retired artifact; `publint` and the `ci-artifacts` lane answer whether the built packages are valid, not whether build output may be committed.

## Known debt register

- Windows native debt: issue #28 (open) — categories and counts live there; runtime-shaped passes do not imply native parity.
- Post-merge main CI failures are recorded with run IDs in root README section 10; `serial / macos` stays disabled (`if: false`) as a governance item.

## 2026-09-16 cleanup record

- Baseline: `main` @ `4d0da264d373d6a2f8e948ac9683efcdbc947880`; work branch `chore/repo-hygiene-20260916-134459`.
- Untracked `.tmp-swift-module-cache-20260822/` (108 files, 93,877,300 logical bytes); added the precise cache ignore rule and root `.env` guards.
- Not covered by that round: no production rescan, no history rewrite, `lib/` removal deferred, Windows and remote-platform verification not run locally.

## 2026-09-17 maintenance round

- Baseline: `main` @ `0cfbf697c24206d4b7e6e66b285413af8516b5d9`; work branch `chore/code-hygiene-nonrepeat-20260917-132912`.
- The index holds no `packages/*/*/lib/`, `apps/*/lib/`, or `*.tsbuildinfo` path; `pnpm run verify-generated-tracking` now keeps it that way from the `ci-static` lane and the pre-commit hook.
- Local verification only; the installed product, the daily checkout, and the recovery archive are untouched.
