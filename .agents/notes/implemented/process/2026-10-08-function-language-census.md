# Agent Note: Separate source coverage from language-selection evidence

Status: implemented

English | [中文](2026-10-08-function-language-census.zh.md)

## Problem

A subsystem table can omit functions, conflate source availability with active behavior, and make unmeasured retention look like a language-performance verdict. Runtime-dependent tools and composition cannot be fully verified by directory inspection.

## Decision

[The language census](../../../../scripts/rust-migration/inventory-language-fit.ts) reuses package discovery, the Cordis walker, inert YAML parsing, patch composition, and tool harvesting. Git enumerates tracked and non-ignored code in workspace-derived areas plus integration, Python, and Rust. Excluded code stays in the record. Empty required areas or incomplete package discovery reject generation. Hashes bind code, manifests, and configuration; AST declarations retain source locations, and dynamic names stay unresolved.

Coverage, semantic review, runtime verification, and language benefit have separate statuses. Function assessments reject missing source selectors; kernel eligibility never authorizes migration. The [governance decision](../architecture/2026-10-07-knowledge-governance-and-rust-evidence.md) and [tool-catalog decision](2026-07-02-tool-schema-catalog.md) retain independent ownership of promotion and executable schema harvesting; this census supersedes neither.

## Alternatives considered

**Only a subsystem table.** Rejected because new source and registration sites can disappear from review without changing the table.

**Static classification as completed verification.** Rejected because declarations prove neither activation nor representative performance, cancellation, recovery, or successful behavior.

**Another runtime registry.** Rejected because existing catalogs and composition already own those mechanisms; an audit introduces no product authority.

## Consequences

The [review reference](../../../../docs/rust-migration/full-runtime-language-matrix.md) links reproducible evidence and explicitly incomplete review. Parser/role tests cover aliases, computed access, dynamic names, comments, callable declarations, Native contract tests, and exclusions. Individual Swift/C/Python/Rust functions, user plugins, and external MCP schemas remain named gaps. The tool writes audit evidence without loading the active user profile or enabling Rust.
