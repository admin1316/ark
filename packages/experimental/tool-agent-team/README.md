---
description: "Compatibility entry for the supported scoped Agent Teams model tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

English | [中文](README.zh.md)

## Summary

This private compatibility entry re-exports [the supported Team tools](../../subagent/tool-agent-team/README.md). Policy text, schemas, member-scope installation, preset handling, and disposal use that implementation directly. It requires the supported `ctx.agentTeams` domain.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Existing private compositions may load this package in place of `@deepseek-ai/dsh-tool-agent-team`. Mount only one of those tool entries alongside `@deepseek-ai/dsh-agent-team`. The same `freshProvider` and `forkProvider` configuration and ten scoped tools apply. The [supported package](../../subagent/tool-agent-team/README.md) owns their precise policy, authorization, errors, and shared-checkout limits.

The [experimental profile](../agent-team-profile/README.md) mounts the supported tools directly and adds the separate Remote adapter. It disables overlapping global continuable-child tools and preserves one-shot delegation.

## Understand the implementation

[`src/index.ts`](src/index.ts) re-exports the supported function plugin's `name`, `inject`, `Config`, and `apply`; there is no second tool installer or prompt policy. The package-specific [`src/invariant.ts`](src/invariant.ts) companion owns no mutable relation because durable validation belongs to the Team domain.

## Further Exploration

- [Supported Team tools](../../subagent/tool-agent-team/README.md) — behavior, config, and scope lifecycle.
- [Supported Agent Teams](../../subagent/agent-team/README.md) — roster, mailbox, and task board.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-agent-team) — this compatibility entry's schemas.

## Model Experience

### Team policy and tools

#### What the model sees

The supported `dsh-tool-agent-team` implementation supplies its Team role policy and scoped schemas, including `spawn_teammate` and `team_task_update`. Team creation requires an explicit user request; the entry adds no policy of its own.

#### Token effect

The supported policy and schemas have their normal request cost. Tool results and delivered peer messages retain the supported domain's behavior.

#### KV Cache effect

The policy prefix remains stable for the same member, configuration, and plugin generation.

## Known Limitations and Deferred Work

- This private compatibility entry is excluded from official releases.
- Mounting both tool entries duplicates registration; use exactly one per composition.
- Shared workspace coordination does not provide filesystem isolation or confinement.

### Dev Note

Tool behavior changes belong in the supported package; this entry preserves the experimental import path only.
