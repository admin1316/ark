---
description: "Experimental Chrome DevTools inspection for a Host Cordis runtime, with Worker-owned Console, Sources, Network capture, Elements trees, and a query API."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-inspector

English | [中文](README.zh.md)

## Summary

Use this experimental inspector to inspect one running dsh Host in Chrome DevTools. It exposes Host Console evaluation, Sources and debugging, captured Host fetches, and the Cordis tree while keeping CDP state in a Worker. The package supplies no browser Client plugin; its retained Worker ingest protocol requires a separately implemented adapter.

The package is private and excluded from releases. The Worker never accesses live Cordis objects: the shared Cordis collector projects them into validated snapshots before transport. Cordis also owns plugin composition, `ctx.inspector` registration, bootstrap injection, and disposal.

## Table of Contents

- [Runtime layout](#runtime-layout)
- [Configuration](#configuration)
- [Observation API](#observation-api)
- [Cordis tree inspection](#cordis-tree-inspection)
- [Host fetch capture](#host-fetch-capture)
- [Security](#security)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="runtime-layout"></a>
## Runtime layout

The Host plugin starts the Worker and connects a dedicated `MessagePort`. Chrome DevTools connects to the Worker's CDP WebSocket. A private `node:inspector.Session` per DevTools connection attaches from the Worker to the Host main thread, so Host Console evaluation, Sources, breakpoints, and resume remain available while Host JavaScript is paused.

The source tree contains `host/` adapter and library entries, `worker/` orchestration and Chrome protocol state, and `shared/` environment-independent models and bridge protocols. `worker/realms/` retains Host and external-source protocol adapters; both run in the Worker. There is no `src/client` plugin entry or shipped `lib/client.js` bundle.

The Host and any admitted external producer send internal observation records rather than CDP messages. Records contain a source generation, sequence, source-clock timestamp, topic, and JSON payload. The Worker validates every process or network frame, owns source state and retention, and translates recognized topics to standard CDP domains.

The retained external-source protocol can declare Runtime, Console, and read-only Sources capabilities. The Worker routes requests to the registered source and validates its replies; this package does not supply the browser implementation. Target-wide pause and resume control the Host debugger only.

The Host uses the shared Cordis collector to convert reachable Context and Fiber objects into a versioned `CordisTreeSnapshot`. The Worker retains that CDP-independent representation and projects admitted source snapshots into Elements.

<a id="configuration"></a>
## Configuration

The Host plugin injects `webServer` and accepts these fields:

| Field | Default | Meaning |
|---|---:|---|
| `host` | `127.0.0.1` | Worker endpoint bind address; only loopback is accepted |
| `port` | `9230` | First Worker endpoint port; occupied ports advance upward, while `0` requests an OS-assigned port |
| `clientOrigins` | `[]` | Additional exact browser origins accepted by `/ingest`; loopback origins remain accepted |
| `captureFetch` | `true` | Wrap `globalThis.fetch` and publish every later call |
| `maxRequestBodyBytes` | 8 MiB | Per-request captured request-body prefix |
| `maxResponseBodyBytes` | 32 MiB | Per-request captured response-body prefix |
| `maxBodyChunkBytes` | 48 KiB | Raw bytes carried by one body record before base64 encoding |
| `maxJournalBytes` | 256 MiB | Worker-retained request and response body bytes |
| `maxRetainedRequests` | `2000` | Active and completed requests retained by the Worker |
| `maxSourceFrameBytes` | 128 KiB | Encoded source-frame limit |
| `maxSourceRecordsPerFrame` | `128` | Records in one source batch |
| `maxQueuedRecords` | `2048` | Per-producer records waiting for transport |
| `maxQueuedBytes` | 16 MiB | Per-producer queued encoded bytes |
| `startupTimeoutMs` | 10 seconds | Worker readiness deadline |
| `stopTimeoutMs` | 5 seconds | Graceful Worker shutdown deadline before termination |
| `clientReconnectBaseMs` | 250 ms | First Client reconnect backoff cap |
| `clientReconnectMaxMs` | 5 seconds | Maximum Client reconnect backoff cap |
| `clientRuntimeTimeoutMs` | 30 seconds | Deadline for one Worker-to-Client Runtime or Sources command |
| `queryTimeoutMs` | 10 seconds | Deadline for one non-CDP semantic query |
| `maxClientRuntimeObjects` | `10000` | Live Client object handles retained per DevTools connection |
| `maxClientRuntimeProperties` | `2000` | Property descriptors returned by one Client object inspection |
| `maxClientSourceBytes` | 8 MiB | Maximum encoded bytes read from one Client script or source map |
| `maxCordisNodes` | `2048` | Context and Fiber nodes admitted from one realm snapshot before truncation |
| `maxDisconnectedCordisTrees` | `8` | Last disconnected realm trees retained as non-live snapshots |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-inspector) is the exhaustive source for accepted fields and their declarations.

The Host logs a `devtools://` URL after the Worker listens. The same Worker serves `/json`, `/json/list`, `/json/version`, the target WebSocket under `/devtools/page/<id>`, and the Client source at `/ingest`.

<a id="observation-api"></a>
## Observation API

The Host plugin provides this service:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { InspectorJsonValue } from '@deepseek-ai/dsh-experimental-inspector'

declare const ctx: Context
declare const topic: string
declare const jsonPayload: InspectorJsonValue

ctx.inspector.publish(topic, jsonPayload)
await ctx.inspector.cordis.getTree()
```

Publishing validates lossless JSON and schedules delivery without waiting for the Worker. Each source has a bounded queue. Overflow is reported as a sequence gap and never delays the observed application operation. `cordis.getTree()` reads the Worker's latest detached semantic snapshot without creating a CDP session or enabling Runtime, Debugger, or Sources.

<a id="cordis-tree-inspection"></a>
## Cordis tree inspection

The Elements document has fixed `<host>` and `<clients>` containers. `<host>` contains the Host root Context; `<clients>` contains one `<client>` per Client source, and each `<client>` contains that realm's root Context. The Cordis root Fiber is omitted. Every other Fiber is a child of `fiber.parent`, owns exactly one Context child for `fiber.ctx`, and carries only `uid="<Cordis Fiber.uid>"`; Context elements have no attributes. Context-only `extend()`, `isolate()`, and `intercept()` layers remain direct Context descendants.

The Host and admitted external sources publish the same nested `CordisTreeSnapshot` type. Context and Fiber nodes carry opaque object handles for realm-local object lookup; Fiber nodes additionally carry Cordis `uid`. The Worker composes those realm snapshots into one `{ host, clients }` inspection tree. It assigns `BackendNodeId` values per source generation; each DevTools connection assigns its own `NodeId` values; `DOM.resolveNode` asks the owning Host or Client Runtime for a connection-local `RemoteObjectId`. `DOM.requestNode` maps that object id back to the same Elements node. `ctx.inspector.cordis.getTree()` and `DSHInspector.getCordisTree` read the detached consumer-neutral tree without routing handles or CDP ids.

Node delivery is depth-limited per DevTools connection: `DOM.getDocument` serves three document levels when the caller omits `depth`, withheld levels advertise `childNodeCount`, and expansion fetches them through `DOM.requestChildNodes` (`depth: -1` for a whole subtree). NodeIds leaving through `DOM.performSearch`, `DOM.requestNode`, or `DOM.pushNodesByBackendIdsToFrontend` first push the not-yet-sent ancestor levels as `DOM.setChildNodes` events.

Sources publish complete snapshots, while the Worker compares stable backend node identities before notifying DevTools. Unchanged snapshots emit no DOM event; additions, removals, and attribute changes use node-level CDP events, inserted-node payloads withhold their subtree, and sibling reordering replaces only that parent's children. Existing `NodeId` values and unaffected Elements expansion remain stable.

When a Client disconnects, its Console execution context and live object ids are destroyed immediately. With disconnected-tree retention enabled, Elements keeps the last tree unchanged while connection state remains in the inspection model rather than becoming an unreviewed DOM attribute. Reconnection keeps the logical source id, creates a new synthetic CDP context id for the new transport generation, and replaces the stale tree after its complete snapshot arrives. Source identity and reconnection must be supplied by the external adapter. The Worker retains at most `maxDisconnectedCordisTrees` such snapshots; zero removes them immediately.

<a id="host-fetch-capture"></a>
## Host fetch capture

Fetch capture is on by default and records the complete URL, all request and response headers, request body, response body, status, timing, errors, and cancellation. It does not redact credentials, cookies, query values, or payloads. Body capture reads clones; the caller receives the original Response as soon as the original fetch resolves.

The configured body limits bound retention rather than select fields: capture keeps the prefix and marks the result truncated. `Network.getRequestPostData` and `Network.getResponseBody` read the Worker's retained bytes. `Network.streamResourceContent` returns the buffered prefix and adds later response bytes to `Network.dataReceived` for that DevTools connection, which drives live Response and EventStream views. Direct Undici Client/Dispatcher calls and fetch references retained before plugin activation are outside this observer.

After response headers arrive, a caller-side abort can stop the observer's clone; captured bytes remain available through `Network.getResponseBody`, capture metadata records the error and truncation, and CDP emits `Network.loadingFinished` because fetch returned a Response. A fetch rejection before response headers emits `Network.loadingFailed`, with `canceled: true` for an abort.

<a id="security"></a>
## Security

The CDP target grants arbitrary code execution in both Host and connected Client realms through `Runtime.evaluate`; Host Debugger operations provide additional control. Full fetch capture includes secrets. The Worker therefore accepts only a `127.0.0.1` bind address. Client ingest additionally requires a random WebSocket subprotocol token injected by the Host and rejects non-loopback origins unless explicitly configured. The CDP socket itself has no token; loopback binding is its only access control.

<a id="model-experience"></a>
## Model Experience

None, as this developer-only inspector observes runtime activity without changing model requests.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No browser Client adapter is included** — the retained Worker source protocol is not a browser product or an Ark fallback.
- **Fetch interception covers `globalThis.fetch`** — direct Undici APIs and fetch references retained before activation are not observed.
- **Body cloning has cost** — full capture tees request and response streams up to the configured limits and can increase memory and I/O pressure. The retained-body limit does not include buffering inside the stream tee, including an oversized source chunk or data queued for a slower application reader.
- **No automatic Worker restart** — an unexpected Worker exit fails the current Inspector instance; lifecycle recovery belongs to a later change.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
