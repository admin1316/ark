# Agent Note: Keep recovered source and preserved artifacts separate

Status: implemented

English | [中文](2026-09-08-source-recovery-build-boundary.zh.md)

## Problem

A preserved runtime can remain usable while restored source has missing exports or incompatible declarations. Skipping compilation because a bundle exists, or copying an installed bundle into build output, conceals these gaps and cannot establish reproducibility.

## Decision

The Host build compiles its source project graph before bundling and propagates the first failed stage. TypeScript's `noEmitOnError` is a compiler configuration option; build mode uses `--stopBuildOnErrors` to stop downstream projects. Existing artifacts are recovery inputs, not successful build evidence. Source-test aliases resolve Remote lookup and event modules to source rather than retained JavaScript.

The Host aggregate explicitly includes every workspace reachable from Ark's native runner and configured profile bundles. A manifest-graph test checks these roots so an omitted native package cannot evade compilation. Native consumers reference the Host face of split Remote packages rather than a mixed Host/Client source program.

The native build derives its compiler aggregate from the same runtime dependency owner. Source-only compiler planning cannot attest packlists or built packages; package planning still requires and hashes executable artifacts. The native build requires source-to-output mappings, generates reflection, and checks native endpoints, strict results, service owners, and generated runtime dependencies. A missing endpoint fails the build even after successful compilation. Legacy Web checks retain their own results.

Recovered call-correlation references use the existing `CallId` export without changing wire field names or identifier values. The Agent Context adapter implements both directions required by the source registry. Identification checks the authoritative live Agent entry, so a retired or stale same-ID object cannot acquire its replacement's identity.

## Alternatives considered

**Use installed bundles as build fallbacks.** This preserves a runnable copy but hides incomplete source and couples releases to one machine. Preserve that copy separately instead.

**Identify an Agent Context by its ID alone.** A retained Context can outlive its registry entry. Comparing the exact current Agent makes retirement effective in both directions.

## Consequences

Real-compiler wrapper tests cover valid source, rejected source, stage order, and preservation of existing output on a type error. Agent registry tests cover live identification, absent ownership, stale instances, and retirement. These local contracts do not establish a repository-wide gate, self-contained release, or native acceptance of the recovered source tree.
