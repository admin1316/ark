# Native Host API

English | [中文](api-gateway.zh.md)

This reference describes the authenticated API-only Host used by native desktop clients. It has no browser application, static frontend, Client plugin runtime, HTML index, or public Web route. Headless, ACP, and SDK applications use their own direct or stdio transports and do not mount this listener.

## Runtime composition

Ark starts the dedicated [`dsh-native-api-runner`](../packages/boot/native-api-runner/README.md), which can boot only its managed profile and does not depend on the generic `dsh` CLI. The profile composes [`dsh-base`](../packages/bundle/base/README.md) with [`dsh-native-api-app`](../packages/bundle/native-api-app/README.md).

| Package | Responsibility |
|---|---|
| [`dsh-api-gateway`](../packages/api/gateway/README.md) | Strict slash Remote dispatch with generated argument/result validation |
| [`dsh-api-remotes`](../packages/api/remotes/README.md) | Shared Agent/Session resolution and the allowlist of forwarded Host events |
| [`dsh-host-connection`](../packages/host/connection/README.md) | Authenticated `/api` carrier, correlation, exact downloads, responses, and event WebSockets |
| [`dsh-host-native-events`](../packages/host/native-events/README.md) | Native event projection and answer correlation |
| [`dsh-host-session-remote-operations`](../packages/host/session-remote-operations/README.md) | Session Remote implementation and streamed session export |
| [`dsh-host-webserver`](../packages/host/webserver/README.md) | Authenticated loopback listener and HTTP/upgrade route lifecycle |

The native bundle fixes the listener to `127.0.0.1`, defaults to an operating-system-assigned port, sets API-only mode, and prints `dsh native-api: http://127.0.0.1:<port>` only after the complete Loader tree settles. The supervising app owns the launch-scoped `DSH_API_TOKEN` and accepts only a loopback readiness URL with a valid port.

## Authentication and routing

Every `/api` HTTP request and API WebSocket upgrade requires the launch-scoped token. HTTP clients send `Authorization: Bearer <token>`; the native process obtains the value from its own sidecar launch state rather than a user-visible document. A missing or mismatched token returns 401 before a business handler runs.

The listener also rejects a foreign `Host` on loopback, which prevents DNS rebinding from turning a remote origin into a local authority. Privileged configuration and native-desktop methods remain loopback-only even in a composition that declares additional trusted authorities.

API-only mode returns a small JSON status document at `/`, dispatches only registered `/api` routes, and returns JSON 404 responses for every other HTTP path. Non-API upgrades are rejected before route dispatch. No fallback handler can serve a file or application shell.

## Business API

Each domain service owns its generated `@Remote` contract. [`dsh-api-gateway`](../packages/api/gateway/README.md) resolves the live descriptor and serves `POST /api/<namespace>/<method>` with exact argument and result validation. The response echoes the request `rpcId` and carries either the method result or a closed business-error code. HTTP status represents carrier failures, not domain success.

The gateway resolves live Agent and Session state at call time, applies Host-owned authorization and persistence rules, and publishes changes only after their domain commit points. Large session-log export is a separate authenticated download route so it can stream bytes with backpressure rather than buffering them in an RPC envelope.

## Event downlinks

`/api/events/mux` carries per-session state and lifecycle frames; `/api/events/host` carries Host-wide invalidations and inventory changes. Both are authenticated, downlink-only WebSockets. The client establishes explicit subscriptions and treats reconnect baselines from the Host as authoritative; a failed consumer operation does not advance a cursor or acknowledge state it did not apply. Session archives stream separately from `/api/session/export`.

The forwarded Host-event set is explicit in [`dsh-api-remotes`](../packages/api/remotes/README.md). Scoped, waterfall, and bail events cannot enter that set because forwarding them would discard execution semantics.

## Boundaries

- Native AppKit/SwiftUI owns Ark's visible UI and maps user actions to this API; the Host packages render nothing.
- The generic CLI owns arbitrary profiles, plugin management, and one-shot headless execution. It does not export the managed native runner.
- [`packages/web`](../packages/web/README.md) is the model-facing search/fetch capability. It is unrelated to a browser UI and remains available to agent presets.
- A new browser product would require a new product decision, dependency closure, trust design, accessibility contract, and independent test owner. It must not reappear as an Ark fallback.

## Verification

The native bundle contract checks the exact Host row set and rejects browser packages. Installed-runtime tests boot the packaged sidecar on port 0, require the bearer token, exercise representative business calls and event upgrades, and require non-API routes to stay unavailable. Native UI acceptance remains a separate AppKit/SwiftUI behavior check.
