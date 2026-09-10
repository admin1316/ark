# Agent Note: Catalog upgrades preserve native repair controls

Status: implemented

English | [中文](2026-09-09-native-catalog-upgrade-recovery.zh.md)

## Problem

An installed model catalog can remove a model or change its protocol while user settings still reference it. Rejecting that configuration before registering Settings removes the controls needed to repair it. An adapter upgrade can also lose model capabilities or historical reasoning metadata if the Harness rebuilds an incomplete descriptor.

## Decision

The existing pi-ai catalog and profile owners distinguish strict writes from deferred stored reads. Deferred reads retain only expected `PiAiCatalogError` diagnostics, keep independently valid models serviceable, and expose the affected provider in the same directory. A duplicate model id invalidates every instance of that id. New or changed profiles must pass strict validation before persistence; unchanged catalog-invalid profiles do not block an independent provider edit. Scalar validation and the existing credential redactor remain mandatory, including on no-op credential writes.

The native provider DTO retains the diagnostic, and the existing Settings card shows it without requiring a working model. Native discovery and provider mutation reuse the HTTP URL input validator before transmitting a request. These behaviors adapt the [upstream catalog recovery](https://github.com/deepseek-ai/deepseek-harness/commit/e9b3f80f0b98bd68050bae30c092dd45a0b69697) to the native consumer without importing Web panels or migrating session data.

The pi-ai version is pinned in the package and lockfile. Exhaustive capability gates classify newly introduced fields; catalog-owned fallback metadata remains on the catalog descriptor. Custom per-turn effort requires adaptive thinking so the transport cannot silently use its default effort. The existing version-2 adapter replay envelope records optional `providerThinkingLevel`, preserving the provider's historical choice without changing session format version 0 or rewriting old records.

This partially supersedes the startup catalog-validation behavior in the [declared-provider decision](../architecture/2026-08-03-pi-ai-declared-provider-catalog.md). Its route identity, immutable snapshot and credential ownership rules remain authoritative. The [credential projection decision](2026-09-09-provider-verification-and-header-ownership.md) is unchanged.

## Alternatives considered

**Remove invalid profiles or models from stored configuration.** Discovery and startup are reads, not authority to destroy user settings; silently removing the entry also removes its repair context.

**Catch every configuration exception.** Unexpected defects and malformed scalar values must remain failures; only the catalog owner's expected error class can become a repair diagnostic.

**Replace the full application with the upstream release.** The upstream Web panels and session-format migration require different consumers and acceptance. They do not establish parity for the existing native application.

## Consequences

An invalid model remains unusable until repaired, while unrelated providers can still be edited. Raw credentials still require explicit migration before any settings write. Real Loader snapshots cover invalid-catalog repair, private-endpoint request budgets and two-turn reasoning replay. Native codec tests cover repair diagnostics and rejection of invalid URLs before transport. These checks do not establish real-account access, GUI parity, startup timing or production readiness.
