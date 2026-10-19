---
description: "The API-only native desktop bundle over dsh-base."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-native-api-app`

English | [中文](README.zh.md)

## Summary

The API-only native desktop bundle over [`dsh-base`](../base/README.md). Its patch mounts only the Host rows required by native clients: storage, feedback, Workspace, projection cache and units, references, directory picking, plugin inventory, knowledge Wiki, the strict Host Remote Gateway, direct Workbench and Session Remote owners, Native event projection, `WebServer`, Host Connection, and Agent presets. It also moves model-facing rows behind per-session presets, parses the optional `--port` argument through [`dsh-cmdline`](../../boot/cmdline/README.md), defaults to an OS-assigned port, and prints the resolved `dsh native-api: http://127.0.0.1:<port>` only after the complete Loader tree settles.

The listener is fixed to loopback, requires the launch-scoped `DSH_API_TOKEN`, and sets `apiOnly: true`. The bundle mounts no frontend fallback, module scanner, Client runner, browser runtime, browser package, UI plugin, Web prompt, shell Web URL, or browser opener. `@deepseek-ai/dsh-host-connection` owns `/api`, `/api/events/mux`, `/api/events/host`, and exact download/response routes without shipping a browser entry; `@deepseek-ai/dsh-api-gateway` is Host-only and owns every dynamically registered strict slash Remote interception.

Native startup also owns the optional private knowledge channel supplied by `ARK_NATIVE_OWNER_SOCKET_PATH` and `ARK_NATIVE_OWNER_LAUNCH_TOKEN`. Its bounded, correlated Unix-socket messages are separate from loopback and readiness logs. A ready handshake supplies the registered source/build identity, role public keys and read-only artifact root; the same channel provides the Wiki verifier, journal signer, fixed-task evaluator, measured-trial reader and per-use cost resolver. The adapter sends only final request hashes and fixed metadata to this owner. The launch token binds the child process and grants no trial permission. An absent endpoint or a disabled owner publishes no trusted capability.

The channel serializes operations and waits for an owner response or socket closure after cancellation. Startup disposal aborts an unfinished handshake and joins socket closure; a handshake has a ten-second protocol limit. Receipt parsing verifies existing canonical signature bytes without changing event or WAL formats. Owner admission, key custody, guard-origin authentication and activation remain outside this Node provider; test keys and source checks establish none of them.

A separately launched guard can import `connectNativeGuardCostOwner` from the existing `startup` entry. It uses the same framing, correlation and cleanup, but its handshake retains `ownerStatus: disabled`, supplies no signing keys, and exposes only admission of a registered dispatch and settlement recording. Its `closed` promise resolves after actual socket termination, so the launcher can close its HTTP listener when the owner disappears. The App authenticates its distinct launch peer; the ordinary backend Context has no settlement method. Disabled cost ownership prevents the guard helper from starting.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

Indirectly, through the selected Agent preset; this bundle adds no prompt text or tool schema.

#### KV Cache effect

None directly.

## Known Limitations and Deferred Work

- **One loopback listener** — the bundle intentionally accepts no host or trusted-authority override; a native client must run on the same machine and carry the launch token.
- **Readiness is stdout-based** — an embedding supervisor must parse the exact post-settlement `dsh native-api:` line and reject non-loopback or out-of-range resolved ports.

### Dev Note

None.
