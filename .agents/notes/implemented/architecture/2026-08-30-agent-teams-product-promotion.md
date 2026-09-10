# Agent Note: Promote Agent Teams into the Subagent product role

Status: implemented

English | [中文](2026-08-30-agent-teams-product-promotion.zh.md)

## Problem

The native standard and code presets expose Team coordination, but its domain and model-tool packages were private experimental dependencies. A published profile runner or Python runtime closure could not truthfully carry those private package names, so the release graph and packaged runtime could diverge from the configured capability.

## Decision

`@deepseek-ai/dsh-agent-team` lives at `packages/subagent/agent-team` and owns the durable `ctx.agentTeams` roster, mailbox, and task DAG. `@deepseek-ai/dsh-tool-agent-team` lives at `packages/subagent/tool-agent-team` and owns the scoped Team policy and model-facing tools. They are the only Team implementations.

The profile runner, Python runtime closure, native presets, example composition, TypeScript path map, Host aggregate, tool catalog generator, and release-family assertions use those formal names and paths. The dsh release family discovers both packages from the Subagent group and their manifests carry the shared release version and public publish metadata.

No compatibility package preserves the experimental names. The pre-release compatibility policy permits the atomic rename, and retaining an alias would create a second Team identity that could mask an incomplete runtime closure. The earlier [incubation decision](../../archived/architecture/2026-08-18-experimental-agent-teams-packages.md) remains the historical record of the private-package phase.

## Alternatives considered

### Keep private experimental packages in the runtime

This loses because published packages and the Python runtime cannot depend on private experimental members without making the release graph unresolvable.

### Add a compatibility wrapper or allowlist

This loses because it preserves a second package identity and hides the same closure defect from the workspace constraints check.

### Fold Team behavior into the Subagent service or tool-subagent

This loses because the durable Team domain and its scoped model tool consumer have independent owners and lifecycle contracts. Folding them would duplicate or blur the existing service/provider/consumer boundaries.

## Consequences

Agent Teams now carries the publication, versioning, documentation, invariant, and release-payload obligations of the Subagent product role. Existing configurations must use the formal names, and the release closure includes the durable domain and scoped tool package whenever a profile declares Team. The explicit-delegation policy and isolated Agent realm remain unchanged.

## Verification

Focused Team unit and real-composition tests, workspace constraints, frozen installation, package invariants, runtime closure, and dsh release packing validate the formal package pair and its consumers.
