---
description: "Human slash-command registry for interactive UIs: plugin-owned commands that run directly against an agent without creating a model message, for users and maintainers composing or extending command surfaces."
kind: "package-reference"
---

# @deepseek-ai/dsh-commands

English | [中文](README.zh.md)

## Summary

`dsh-commands` lets a user type `/command [input]` in an interactive Harness UI and run it directly against the receiving agent without creating a model message. Plugins register commands with a name, description, optional input hint and image-acceptance flag, and an abortable handler; interactive adapters discover and dispatch them per agent. A command-producing plugin mounted under an agent's context can register an exact agent-scoped command that shadows the global one of the same name. Each command run is recorded in the session log, and its result is rendered by the adapter, never entering model history. Slash commands ship with the `dsh` CLI and the Web client.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose this service when an interactive UI should let users drive agent-side behavior with slash commands instead of model prompts. UI-less demo spines and ACP automation provide no command adapter and do not need it.

### Registering a command

A plugin registers a command with `ctx.commands.register()`: a lowercase name, a description shown in discovery, an optional `input` hint, and a handler that runs against the receiving agent.

```text
ctx.commands.register({
  name: 'plan',
  description: 'Enter plan mode',
  input: { hint: '<message>' },
  handler: ({ agent, rawInput }) => {
    // Runs directly against the agent; no model message is created.
    return { kind: 'success', text: 'plan mode selected' }
  },
})
```

The handler returns `success` or `error` plus optional UI text that the adapter renders. `recordInput` defaults to true; a command whose own authoritative domain event already carries the payload sets it to false so the session log does not duplicate the input. Registering the same name twice in one scope throws.

### Command syntax

A command line starts with a slash at byte zero, a lowercase name containing letters, digits, `_` or `-`, and then either end-of-input or whitespace. Everything after the name — including separator whitespace — is the command's `rawInput`, and the command owns its own grammar for it. Lines that are not syntactically a command, or that name an unknown command, are rejected by the adapter instead of becoming a model prompt.

### Agent-scoped commands

A plain registration is global. A command-producing plugin mounted beneath an agent's own context declares its `commands` injection and registers an exact agent-scoped command, which shadows the global definition of the same name for that agent only.

### Image attachments

A command may declare `input.images` to accept composer image attachments. The executor enforces the declaration: images sent to a non-declaring command, an absent attachment store, or an over-limit batch each settle as an error before the handler runs. Admitted images reach the handler as frozen ordered `ImageBlock`s on `invocation.attachments`, and the handler owns their model-visible use — the registry never schedules them itself.

### Dispatching from an adapter

Native adapters submit `session/command` with `sessionId`, a caller-persisted `invocationId`, the exact `line`, and ordered `images`. The Host checks live or cold receipts before resolving an Agent. `completed` replays the durable result, `running` observes the same owned execution, and `unknown` preserves the identity without repeating the handler. Reusing an identity with different content fails; a different invocation cannot queue behind an active command in the same session. `list(agent)` and `find(agent, name)` serve discovery after agent-scoped shadowing. Same-process adapters may explicitly use `executeLocal(agent, line, images, signal)`; it has no Remote route or durable retry contract.

### Cancellation

The Host owns durable command cancellation independently of the response transport. A disconnected caller may query the same identity while the handler remains active. Shutdown waits for the entered handler; it cannot publish a terminal record while uncooperative work continues. A durable run without a confirmed terminal record returns `unknown` after restart. Local-only dispatch stops awaiting on caller abort, so its handler must cooperate to stop external effects.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is covered in [Use this package](#use-this-package); this section explains how the registry is built and where its contracts live.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `CommandRuntime` service: registration, scoping, dispatch, lifecycle events |
| [`src/types.ts`](src/types.ts) | Command definition, descriptor, execution, and result types |
| [`src/brand.ts`](src/brand.ts) | `CommandId` brand for lifecycle pairing ids |
| [`src/receipts.ts`](src/receipts.ts) | Input digest and host-only receipt projection over existing log events |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion pairing `command/run` with `command/done` per session log |

### Lifecycle events

Durable `execute()` flushes `command/run` with the invocation identity and input digest before entering the handler, then flushes `command/done` before returning `completed`. A successful result may name an earlier authoritative domain event through `sourceEventSeq`; handler exceptions become terminal error results. Both events are standalone log-only appends without turn wrappers. The receipt projection references those original records instead of creating a second ledger. A failed durability barrier returns `unknown`; it never authorizes another handler run. Admission misses (invalid syntax or unknown name) log nothing. Local-only dispatch uses ordinary checkpoints and teardown for persistence.

### Scoping

Registrations live in global and agent-scoped layers merged per agent via `ScopedLayers`. The child-injection shape — a command-producing plugin mounted beneath `agent.ctx` declares its own `commands` injection — preserves agent scope without making the core agent loop depend on a UI service. Duplicate names within one layer fail during registration, and registration or removal notifies every `commands/change` observer so live adapters can refresh discovery; observer failures are logged and cannot veto the mutation or starve later observers.

### Image admission

Image enforcement happens in the executor, not the composer: an admitted batch is committed through `admitEncodedImages` against the `attachments` store, a rejected batch publishes no durable object, and cancellation is honored before the handler runs so a retrying caller never duplicates state. Handlers that cannot use the images return an error, so the dispatching composer keeps the originals.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared command vocabulary to the design evidence and adjacent surfaces.

- [Commands subsystem reference](../../../docs/subsystems/commands.md) — registry semantics, input metadata, and the `ctx.commands` cordis surface.
- [Command registration Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-plugin-command-registration.md) — the boundary and dispatch contract behind this service.
- [Interaction group map](../README.md) — adjacent approval, permission, and question packages.
- [Plan mode package](../../plan/plan-mode/README.md) — a shipped command producer that drives model-visible work.

-----

<a id="model-experience"></a>
## Model Experience

### Direct human commands

#### What the model sees

The registry itself submits nothing. Known slash commands execute in the UI command plane, and their `CommandResult` text is not submitted as a user message. Unknown slash-command input is rejected by shipped adapters instead of becoming a model prompt. A command producer may explicitly use the receiving `Agent`; for example, [`dsh-plan-mode`](../../plan/plan-mode/README.md#model-and-human-interactions) submits the optional message in `/plan [message]` after selecting plan mode. Image attachments follow the same rule: the executor only admits them into durable attachment objects, and a declaring producer decides whether and how they become model-visible message content.

#### Token effect

Command discovery, execution, and UI output add no model tokens. Explicit agent work scheduled by a command producer has the same token effect as the corresponding agent input.

#### KV Cache effect

Registry metadata, command input, and direct output never enter a model request and do not affect its cache. A mutated domain owns any later cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the registry does not offer. They are current package constraints, not a UI backlog.

- **Only unstructured text input** — forms, completion schemas, and typed arguments remain command-owned parsing concerns.
- **External effects remain handler-owned** — a durable receipt prevents automatic handler repetition, but cannot guarantee exactly-once effects across external systems; an interrupted result requires inspection instead of automatic retry.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
