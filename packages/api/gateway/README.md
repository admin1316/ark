# @deepseek-ai/dsh-api-gateway

English | [中文](README.zh.md)

Host-only dispatcher for strict Typert Remote methods used by native API clients. `TypertGatewayService` provides `ctx.typertGateway`, dynamically claims every live or withdrawn strict `<namespace>/<method>` descriptor, validates exact named arguments, resolves lookup objects and scoped Contexts, injects carrier cancellation, validates results, and returns the nested `RemoteResult` consumed by Ark.

The package owns no HTTP server or envelope parser. It registers a loopback-only interceptor through a narrow structural `ctx.connection.rpc.intercept` capability, so the Gateway has no package or TypeScript project edge back to Host Connection. Connection continues to own bearer and authority checks, request correlation, exact response/download registrations, and the two event WebSockets.

This package has one Host TypeScript project, no `dsh.client` metadata, no client export, no SRC reflection fallback, and no browser or frontend asset. [`native-remote-routes.ts`](src/native-remote-routes.ts) records the strict descriptors consumed by Swift for coverage checks without limiting dynamic Host plugin registration.

## Carrier boundary

Only unary strict descriptors pass through this dispatcher. Native event downlinks and answer correlation are owned by `dsh-host-native-events`; streamed session export is owned by `dsh-host-session-remote-operations`; `dsh-host-connection` owns their authenticated physical routes.

## Model Experience

None, as this dispatcher carries already-selected business calls and registers no model-facing context.

#### KV Cache effect

None; invoked business services own every model-visible effect.

## Known Limitations and Deferred Work

- **Unary strict descriptors only** — event downlinks, interactive responses, and streamed downloads deliberately remain with their dedicated Native Host owners; adding another transport shape requires a separately owned carrier rather than widening this dispatcher.
