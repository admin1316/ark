# Agent Note: Advertise the composed governed Wiki catalog

Status: proposed

English | [中文](2026-10-09-governed-wiki-tool-exposure.zh.md)

## Problem

Ark can load its Knowledge Wiki service without a trusted verifier. The model-facing consumer nevertheless advertises all seven tools and instructs the model to use governed reads and candidate verification. Real candidate tasks then spend requests on tools whose service rejects missing authority. Disabling the complete consumer also removes the independent durable ingestion path.

## Proposal

The [tool consumer](../../../../packages/host/knowledge-wiki-tools/README.md#configuration) accepts the optional strict boolean `exposeGovernedTools`, defaulting to `true` for existing compositions. `false` omits the five governed read tools and candidate verification, registers the original ingestion consumer, and advertises ingestion only. `true` preserves the catalog and every service execution check. Catalog exposure never supplies verifier authority, signed admission, successful-use credit, or trial authorization.

The [Ark profile](../../../../integrations/jiuzhang/profile/cordis.patch.yml) selects exposure from the same launcher-owned `ARK_KNOWLEDGE_VERIFIER_CONFIG` string as the knowledge service, treating missing and whitespace-only values as absent. Nonempty invalid configuration retains the service's load failure. The launcher, model route, permissions, session formats, and verification thresholds stay unchanged.

This proposal complements the [governed knowledge decision](../../implemented/architecture/2026-10-07-knowledge-governance-and-rust-evidence.md); it does not supersede its authority or learning requirements.

## Alternatives considered

**Disable the entire tool plugin.** This removes source ingestion even though its durable queue owner remains available.

**Allow unauthenticated reads.** This weakens the knowledge service's provenance and scope checks to hide a catalog defect.

**Add a generic registry readiness API.** The observed deployment has one explicit launcher-owned choice; broadening the core registry adds a cross-package contract without resolving authority.

## Acceptance criteria

Missing configuration and explicit `true` retain the seven-tool order and existing governed denial. `false` exposes ingestion only, retains its original queue invocation and output, and omits read/verify guidance. Non-boolean input fails before registrations. Unload removes tools and guidance. Real YAML loading and a runnable keyless assembled transcript cover the false deployment, while the existing governed transcript and denial tests stay unchanged. A rebuilt isolated Native candidate must show the corrected model request and complete a same-model task before promotion is considered.

## Risks

Catalog selection is captured at plugin load and requires reload after a deployment change. A nonempty verifier string is configuration presence, not proof of a valid authority or admissible knowledge. Explicit `true` can still expose a tool that denies a particular operation. This change does not implement learning activation, repair reuse, or performance improvement.
