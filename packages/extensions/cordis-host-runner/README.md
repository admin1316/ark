# @deepseek-ai/dsh-cordis-host-runner

English | [中文](README.zh.md)

The Host half of model-mounted dynamic packages: the definition registry, the `node:vm` sandbox and fiber lifecycle for Host halves, and the invoke handler table. Provided as `ctx.dynamicCordisRunner`. The model-facing tools live in [`@deepseek-ai/dsh-tool-cordis`](../tool-cordis/README.md); Ark ships this Host-only path and no browser runner.

## What it does

Two phases: `define` only records, and everything with an effect hangs off a run.

- `define` / `undefine` own a definition's life. `define` trims and requires the metadata, prechecks each half's syntax by compiling it (running nothing), mints `dyn-<n>`, and records the definition against the session that asked — it has no effect to roll back, so unparseable code is refused before an id exists. `undefine` stops a running definition first, then forgets it. Neither crosses the wire: only the model's own tool call defines.
- `run` answers the model's request to run one definition, and its two shapes differ by whose business the package is. A host-only package is this process's own: the host half is evaluated in the vm under the `cordis-dynamic` group fiber and the call returns. A package with a browser half has to be carried out by a page, so `run` becomes an answerable round trip — it emits `cordis/request-run`, suspends, and is settled by a person allowing or declining it. There is no timer; the caller's `AbortSignal` (the asking turn was cancelled) is the only other way out, and it announces the cancellation so other pages stop offering an answer. Whether any page will answer is not knowable when the request is sent — a page that received it may still never answer, so a deployment with no page connected suspends like any other unanswered request and ends in `cancelled`. `run` has no wire face — `cordis_run` calls it in process.
- `runHostHalf` / `getClientCode` are the steps an allowed page walks, host half first, so a host-half failure short-circuits before the browser has moved. `runHostHalf` is idempotent by contract: a running package is bound rather than evaluated again, concurrent calls for one definition evaluate it once, and `startedHere` names the caller that did. `getClientCode` then hands that one page the browser-half source, refusing a definition that is gone, has no browser half, or is not running. Code never rides an announcement, so this is the only way it reaches a browser.
- `resolveRequestRun` closes the round trip with the answering page's verdict, and broadcasts `cordis/request-run-resolved` so every other page drops the pending affordance. The first answer wins; a later or unknown request id is accepted and ignored. A success naming a revision the registry has moved past is refused rather than applied (`accepted: false`, request still suspended), because the page that answered loaded a dispatch that is no longer live. A failing verdict unwinds the host half only when this same request evaluated it, so a page that cannot load its own half never stops a package the other pages are using.
- `stop` unwinds one live dispatch — handlers dropped, host-half fiber disposed to quiescence, `dynamicCordisRunner/retract` broadcast — and leaves the definition runnable.
- `inventory` answers the whole registry, unaddressed by session and with each row naming the session that owns it, because the run-control surface is global. Listing is not acting: every acting verb still checks that ownership. Each row also names whether the definition has a browser half, so a run-control surface offers loading it into the current page only when there is a half to load. `snapshot` is its session-scoped host-local counterpart, carrying each live host half's fiber so `cordis_inspect` can render provides/waiting/state itself (a fiber cannot cross the wire).
- `reportRenderFailure` records what a page saw a LOADED browser half do wrong at render time. Rendering happens strictly after a load succeeded, so a run has already answered `ok` by then: this report is fire-and-forget, carries no settle authority, and never touches `resolveRequestRun` or any part of the run outcome — **it is not the retired v2 `report`/ack**. The host keeps the last failure per definition across every page (a second page reporting overwrites), and a fresh run, a stop, or an undefine clears it, so the model is never shown a failure from a dispatch that no longer exists. The browser-half face keeps its own "what THIS page is showing now"; the two answer different questions rather than duplicating one. A report for a definition the reporting session does not own is dropped, because the reporting path must never fail a render.
- `invoke` routes one call from a package's browser half to a method its own host half registered with `harness.handle`. The infrastructure only routes — no host-to-browser direction exists.

A refusal from `run` or `stop` names one of `definition-missing`, `host-half-failed`, `client-half-failed`, `rejected`, `cancelled`, or `not-running`; the last three are answers rather than defects — a person declined, the asking turn ended, or there was nothing running to stop.

A definition another session defined reads as absent rather than forbidden, so nothing leaks across sessions. `invoke` and `resolveRequestRun` carry no session at all: a component's call and a page's answer are page-global facts, not one session's.

The feature's lifecycle events remain Host-owned metadata (`cordis/request-run`, `cordis/request-run-resolved`, `dynamicCordisRunner/package`, and `dynamicCordisRunner/retract`). They never carry source code or require a browser consumer.

## Storage stance

The registry is process memory and the only source of truth. The session log carries a define call's metadata — never its code — so a restarted process legitimately has no definitions, and a card whose id no longer resolves says exactly that rather than pretending it can run. Nothing here is written to disk, and no definition is restored automatically; a reloaded page holds nothing until someone runs a package again, which is what makes it bind the live host half and re-fetch the browser half.

## Trust stance

The vm sandbox isolates globals but is not a security boundary: Node globals are absent or redirect to Cordis services (`ctx.fs`, `ctx.web`, `ctx.bash`, the timer helpers), and a host half receives a façade without framework internals, yet the services it declares reach the live runtime. Treat a dynamic package like bash access — see the [self-referential toolset Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md).

## Config

| Field | Default | Meaning |
|---|---|---|
| `vmTimeoutMs` | `5000` | Milliseconds the synchronous portion of a host half may run in the vm before evaluation is aborted |

One field is all there is: a run request waits for a person, so the round trip has no deadline of its own.

## Export shape

Service package: default-exports `DynamicCordisRunnerService` (service key `dynamicCordisRunner`), with `./types` carrying the payload shapes the `dynamicCordisRunner` remote namespace and its consumers share. The `define` / `undefine` shapes stay inside the package, because they never cross the wire.

## Model Experience

### Refusals and teaching errors relayed by the cordis tools

#### What the model sees

Nothing directly: this package registers no tool and injects no prompt. Its refusals reach the model through the `cordis_*` tool results that call it — an unparseable half names the offending line, a missing definition explains that definitions live in memory only, a `rejected` or `cancelled` run reports that a person declined or the turn ended rather than that anything failed, and a failed browser-half load carries the answering page's own error text.

#### Token effect

None of its own: every message above is carried by the calling tool's result.

#### KV Cache effect

A host half that registers tools changes the next request's tool view, which invalidates prefix reuse from the first changed schema token; running or stopping a package with no tool registrations is prefix-neutral.

## Known Limitations and Deferred Work

- **A successful run covers Host activation only.** Native presentation is owned by Ark's SwiftUI shell; a Host activation result does not claim that a separate UI has rendered.

- Browser-half packages are not part of Ark's shipped Native closure; Host-only packages run without a page connection.
- A suspended run request has **no timeout**: it waits for a person until the asking turn is cancelled, so unattended automation cannot use packages with a browser half.
- `vmTimeoutMs` bounds only synchronous evaluation; an async host-half body escapes it, matching the toolset's cooperative trust stance.
- `runHostHalf` carries no request id, so "which request evaluated this host half" is attributed host-side to the most recently armed request for that definition; several concurrent run requests for one definition would need that rule revisited.
- A success answer naming a superseded revision is refused (`accepted: false`) and leaves the request suspended, so the model's call ends only through a valid answer or its own cancellation. Native Ark does not expose a browser answerer; a future external UI must own that orchestration explicitly.
- **`zod` is a runtime dependency of the generated TypeRT faces, not of `src`.** `./typert` and `./remote` resolve to `lib/typert.*.js`, which `tsc` emits unbundled with a bare `import { z } from 'zod'`, so the package must declare it (the `@deepseek-ai/dsh-goal` precedent) and `knip.json` must ignore it for this workspace — knip reads source, and these faces are build products. Nothing in `src` imports zod.
