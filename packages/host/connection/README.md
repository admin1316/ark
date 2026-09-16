---
description: "Host transport owner for native API clients."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-connection

English | [中文](README.zh.md)

## Summary

Host transport owner for native API clients. The plugin registers the single `/api` prefix, `/api/events/mux` and `/api/events/host` WebSocket upgrades, and scoped registries for strict RPC interception, `/api/respond`, exact downloads, and event producers. `@deepseek-ai/dsh-api-gateway` dynamically intercepts strict slash Remote calls; domain owners register their own download or event handlers. Connection owns only physical transport, request authority, correlation envelopes, and socket lifecycle—there is no dot-RPC fallback.

Every request must carry a loopback `Host` or a canonical authority from `trustedHosts`; the listener independently requires its launch-scoped bearer token. Privileged strict slash methods and sensitive downloads stay loopback-only, and malformed trusted authorities fail plugin load. The two WebSocket paths are downlink-only; Host teardown terminates accepted sockets, aborts their sources, and waits for source cleanup.

The `./protocol` subpath is the single owner of route constants, loopback hostname classification, and shared RPC interfaces. Native clients mirror this wire contract without importing Host implementation code.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Native API transport

#### What the model sees

Nothing. This package carries already-composed API values such as `/api` requests and registers no model-facing context.

#### Token effect

No direct token effect; this package neither assembles nor sends a provider request.

#### KV Cache effect

Independent of model-content caching because the transport does not modify a model request.

## Known Limitations and Deferred Work

- **Request bodies are buffered in memory** — `maxRequestBodyBytes` defaults to 300 MiB so the default 200 MiB aggregate image limit fits after base64 expansion; lowering resident cost requires a streaming request-body carrier.
- **Trusted hosts are reachability policy, not authentication** — non-loopback deployments still need an authentication layer before exposing privileged capabilities.

### Dev Note

None.
