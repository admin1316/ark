---
description: "Experimental Remote adapter for the supported Agent Teams domain, preserving roster views and task mutations."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

English | [中文](README.zh.md)

## Summary

This private package exposes roster views and task mutations over Typert. The [supported Agent Teams package](../../subagent/agent-team/README.md) owns membership, durable mail, task CAS, recovery, and disposal. The adapter requires that service; it does not register another Team domain or durable event vocabulary.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount the domain once and add the adapter only when a Remote consumer needs Team views or task mutations. Configure domain limits on `dsh-agent-team`, and use `dsh-tool-agent-team` for model tools. The [experimental profile](../agent-team-profile/README.md) composes all three.

<a id="smallest-working-setup"></a>
### Smallest working setup

An existing runtime with Agent, Subagent, and durable persistence services can add:

```yaml
- name: '@deepseek-ai/dsh-agent-team'
- name: '@deepseek-ai/dsh-tool-agent-team'
- name: '@deepseek-ai/dsh-experimental-agent-team'
```

### Browser Remote

`TeamRemoteAdapter` registers `ctx.agentTeamRemote` while retaining the `agentTeams/view`, `agentTeams/createTask`, and `agentTeams/updateTask` wire namespace. Each method requires the exact live calling Agent. `view` returns the current roster and non-deleted tasks. Creation and update return explicit domain results: stale revisions map to `team-task-conflict`, other Team rejections to `team-rejected`; unexpected exceptions remain transport failures.

`./remote` exports the generated Client contribution. `./client` retains the type-only request, view, and mutation-result DTOs. The root export re-exports supported domain APIs for existing imports; its default export is the Remote adapter. Disposing the adapter removes its registration and leaves the domain, active teammates, and durable state owned by the separately mounted domain service.

## Understand the implementation

[`src/index.ts`](src/index.ts) delegates Remote operations to `ctx.agentTeams`. [`src/types.ts`](src/types.ts) owns only Remote result and aggregate-view types; shared domain types come from the supported package. [`src/invariant.ts`](src/invariant.ts) registers an empty companion because the adapter owns no mutable Team relationship. The supported domain's invariant companion validates durable transitions.

## Further Exploration

- [Supported Agent Teams](../../subagent/agent-team/README.md) — domain limits, authorization, durable mailbox, task CAS, and lifecycle.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — shared types and service API.
- [Team tools](../../subagent/tool-agent-team/README.md) — scoped model policy and tool schemas.

## Model Experience

### Remote Team operations

#### What the model sees

The adapter adds no prompt or tool schema. `agentTeams/createTask` and `agentTeams/updateTask` mutate the supported domain's task board; subsequent `team_task_list` results expose that state through the supported Team tools.

#### Token effect

Remote roster reads and task mutations add no conversation tokens. Peer-message behavior belongs to the supported domain.

#### KV Cache effect

The adapter adds no request-prefix content.

## Known Limitations and Deferred Work

- The private Remote contract is experimental and excluded from official release payloads.
- The adapter requires one mounted supported Team domain; it cannot run independently or provide cross-process coordination.
- Remote reads expose the current task board without introducing a separate persistence or lifecycle owner.

### Dev Note

The generated Remote descriptors preserve the experimental package identity and `agentTeams` namespace; the Cordis service key is `agentTeamRemote`.
