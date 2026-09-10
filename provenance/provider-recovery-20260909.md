# Ark provider transaction recovery — 2026-09-09

Status: the original three credential/cancellation findings have a scoped independent VERIFIED result after repair. Follow-on Settings dictionary-schema repair and coverage closure are in progress. Native FULL_GATE, candidate GUI/performance checks, GitHub publication and Production replacement are not complete.

## Scope

Canonical source is `/Users/hui/ark`, branch `codex/native-recovery-release-20260908`, based on `4aa8ef9c3589aba99bf351fd49bbbe5e5725df25`. This change concerns model-configuration and credential transaction journals, not session/turn/tool logs. Session formats and IDs are unchanged.

The pre-change source freeze is `/private/tmp/ark-v1-recovery-20260909-Bhy1Uc/source-tree.tar.gz`, SHA256 `5908940b252cded8adab1673ee95c92199594058c9489bba7ce46efb27b70983`. Its manifest covers 11,031 source entries with source-tree SHA256 `d28bac1162eeddf601c2f1cba3f6034f671dee2750353e74144ef31507d40e98`; generated workspace outputs and local secret-like configuration are excluded.

## Implemented behavior

- The existing provider transaction owner reads full, digest-validated legacy v1 plans and writes receipt-bearing records through the existing Credentials provider.
- `llm/providerTransaction` is read-only. `llm/resumeProvider` uses the persisted plan under the existing journal, namespace and credential-reference leases.
- New plans capture a raw user-section digest. Restart can use a new in-memory revision only when that digest matches. Uncommitted plans without proof safely retain the current profile and record a failed rollback outcome.
- Settings-file compares the target namespace under its file lock; unnoticed external changes to that namespace reject instead of being overwritten.
- Native Settings has explicit recovery controls, status views bound to transaction IDs, and terminal acknowledgements that cannot clear a newer pending ID. Loading Settings does not automatically restore operations.
- Queries and mutations remain lifecycle-owned through settlement. Shutdown does not turn a persisted-but-unactivated configuration into a successful live result.

## Evidence

The immutable legacy fixture contains eight journal snapshots produced by the retained implementation with synthetic data. `packages/llm/llm/tests/fixtures/legacy-v1-journals.json` remains byte-identical, SHA256 `0c470f13fde482852e6ed683b426b426e99929b40c060996182f831212cbab3d`.

| Check | Observed result |
| --- | --- |
| LLM/Settings behavior selection | Exit 0; 476 tests in 25 files |
| Real-process recovery selection | Included above: 13 cases, including five durable-boundary SIGKILL cases and eight frozen legacy fixtures across fresh processes |
| Loader snapshots | Exit 0; four snapshots, including the new native provider status/resume scenario |
| Native runtime build | Exit 0; 162 source packages, 386 entries and 16 reflection contributions |
| Native interface inventory | 74/74; no missing endpoints, wrong owners, non-strict results or duplicates |
| Native Swift contracts | Exit 0 on the host; 41/41 groups, including URLSession request/result codec checks |
| Focused lint | Exit 0 for the changed source, test and snapshot files |
| Bilingual records | Five named pairs consistent |
| `git diff --check` | Exit 0; two trailing spaces in previously generated preset outputs were normalized without changing behavior |

Runtime build input identity was re-read after the build and matched `bf0dd01c4ef895e8e135b1b35986fd9df60a0ee3da13b17d9b3907b92a711163`. The frozen review input is `/private/tmp/ark-v1-review-20260909-Els1W6`; its 38-file scope SHA256 is `d84834a609d969e841ca289d1ee21caa364b8a920472fde2dee9fd3499345177`. `REVIEW_MANIFEST.json` contains source hashes, log hashes, commands' recorded exit codes and test counts. A new GPT-5.6 Sol High reviewer is inspecting that snapshot read-only.

The first Swift build failed on nested `sandbox-exec` permissions, and the first AppKit probe failed with XPC/LaunchServices errors. Unchanged host retries passed; the failed and successful logs are separate. The first shutdown test expected live activation after its owner disappeared; it was corrected to assert the actual required persisted-but-not-live outcome and to attach its rejection handler before shutdown. No failed test was excluded.

## Limits and release state

Safe refusal is not successful recovery. Legacy records without complete plans remain unsupported rather than reconstructed from guessed requests. History already discarded by an older writer cannot be invented. Forced-process exits in this selection occur only after durable writes release their file locks; orphan-lock recovery and arbitrary power-loss recovery are not established. Real provider authentication, candidate interaction, startup timing, idle CPU, Chinese IME and Production behavior remain separate acceptance work.

No commit, push, PR, merge, candidate promotion or replacement of `/Applications/Ark.app` is recorded by these checks. The requested delivery continues through review, native coverage/FULL_GATE, isolated candidate acceptance and the authorized release workflow.

## Credential-owner revision and follow-on findings

The first frozen review returned REVISE: ordinary credential writes bypassed the LLM-only leases, delayed unset could remove a concurrent replacement, failed settings writes retained newly staged secrets, and cancellation while waiting for a namespace could still normalize a terminal v1 record. These were not covered by the earlier passing test selection.

Credentials reference writes accept digest/source conditions checked under the existing provider queue and credential-document lock. Keychain writes participate in the same managed path. Terminal provider receipts require the resulting credential under exclusion held through commit. New plans persist a before-image; rollback conditionally removes a newly staged value and retains a retryable journal if cleanup fails. Every claim callback checks cancellation before writing. No second credential store or UI-specific lock was added.

Independent read-only review of the 15-file freeze in `/private/tmp/ark-credential-cas-20260909-wISh60/review` reproduced the original windows and returned VERIFIED for those repairs only: concurrent set/unset preserved the winner and produced `credential-rejected` / `committed-not-live`; settings failure removed the staged secret; cancelled terminal normalization left its journal unchanged. Arbitrary writers bypassing the shared document lock, identical-value ABA changes, and old plans without a before-image remain outside that guarantee. Safe legacy refusal is not complete credential rollback.

The follow-on tests exposed a real Settings metadata failure for `z.dict`: dictionary key schemas were missing from live-node discovery. The existing redactor now traverses key schemas and refuses secret-bearing keys instead of exposing their names. This follow-on change is not included in the 15-file credential review freeze.

Recorded commands and logs are under `/private/tmp/ark-credential-cas-20260909-wISh60`. The initial affected selection passed 440 tests in 28 files, but exited 1 on the unchanged per-file 100% coverage requirement. The latest journal/Settings selection passed 257 tests; transaction statements/branches were 95.62%/91.48%, and redactor statements/branches were 94.5%/91.01%, so coverage still failed. The 13 real-process cases explicitly select the source tsconfig and assert source-owned service resolution. Five Loader snapshots replayed successfully before the dictionary fixture extension; they require replay after that extension. A native build emitted 162 source packages and 16 reflection contributions before the follow-on redactor changes; it is not a final-source release receipt.

The catalog freshness check currently fails on the host type graph's `ChunkRow` export at `@deepseek-ai/dsh-session/chunk-rows`. No generated catalog was hand-edited to hide that failure. GitHub main was fetched and remains at `4aa8ef9c3589aba99bf351fd49bbbe5e5725df25`. Publication and application replacement remain unperformed.

## Core coverage closure and subsequent security review

The four-file credential/transaction/redactor selection reached 100% statements, branches, functions and lines with 429 tests in 18 files (`coverage-closure.log`). Transaction types now encode terminal outcomes and mandatory failure details; recovery requires a captured journal. Credential path normalization locates a set ancestor directly within validated non-overlapping operations. Independent review confirmed that removed fallbacks were unreachable after the existing parser and path checks; input rejection, cancellation and credential CAS remained intact.

The source build emitted 162 packages, 388 entries and 16 reflection contributions with 74/74 native endpoints; its source digest is `d224c5b8c8a7555b987937cdebd794ee83177195bb7c715d2046da66029031fc`. This precedes the malformed-container repair below. Two missing publication subpaths (`dsh-session/chunk-rows`, `dsh-host-directory-picker/types`) were restored and imported successfully by their real built consumers in the isolated validation tree. The Cordis catalog's missing type/owner classifications and malformed one-line JSDoc were repaired; the actual generator updated 38 artifacts and its 97-artifact freshness check passed. Twenty-two catalog tests and ten native-build guards passed. A broader native-related selection passed 916 tests before the final type refinements. These are scoped results, not a native full-gate verdict.

The 21-file freeze at `/private/tmp/ark-credential-cas-20260909-wISh60/review-closure` has scope SHA256 `db860cc277f52a459fb80adf95ea4b2c68565fc556e5011bab72c9c4c8513838`. Its review returned REVISE for a newly demonstrated redaction leak while keeping the transaction repairs VERIFIED: secret-bearing malformed container defaults and overridden base values could pass through unchanged, despite the earlier 100% coverage. The old malformed-container passthrough test documented unsafe behavior and was replaced by safe-refusal tests.

The redactor rejects non-absent malformed object/dict/array/tuple secret containers with a fixed, value-free diagnostic, while preserving public-container behavior and unmarked tuple tails. All four container kinds have malformed-default and overridden-base checks through the Settings Remote method. The latest redactor run passed 142 tests and all four coverage metrics at 100% (`secret-shapes.log`); two new real Loader/file-backed snapshots cover both leak paths. Independent re-review of this last repair and native-wide acceptance remain pending.

A native-dependency-wide coverage audit was started with its exact scope and command in `native-coverage-command.json`. Repairs continued during that audit. It was interrupted normally after source drift and incomplete suite execution were observed; the receipt records exit 130 and `sourceUnchanged: false`, so it is diagnostic only. Four Native Code preset cases were marked skipped within a failed suite; the test file has no explicit skip or build-receipt guard, and the initialization failure requires a targeted diagnosis. The final aggregate must run in the built isolated source tree and report these cases explicitly, never count them as verified.
