# host/ — native/API host layer

English | [中文](README.zh.md)

The Host services used by native desktop and API integrations: the typed business gateway, authenticated HTTP/WebSocket carrier, loopback listener, and Host-owned desktop capabilities. The Ark sidecar composes them through [`dsh-native-api-app`](../bundle/native-api-app/README.md); the generic headless CLI does not mount this layer. All are **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`connection/`](connection/README.md) | Authenticated `/api` HTTP bridge and event WebSockets | `ctx.connection.rpc` |
| [`webserver/`](webserver/README.md) | API-only HTTP and upgrade-route carrier | `ctx.webServer` |
| [`native-events/`](native-events/README.md) | Native event projection and answer correlation | `ctx.nativeEvents` |
| [`session-remote-operations/`](session-remote-operations/README.md) | Session Remote implementation and streamed export | generated `session/*` descriptors |
| [`directory-picker/`](directory-picker/README.md) | Workspace-directory picking seam | `ctx.directoryPicker` |
| [`directory-picker-native/`](directory-picker-native/README.md) | Native directory-picker backend | registers `ctx.directoryPicker` |
| [`plugin-inventory/`](plugin-inventory/README.md) | Read-only projection of current Loader entries | Host API `pluginInventory.list` |

Domain services publish strict Remote descriptors, while `connection` exposes authenticated routes on `webserver`; `native-events` and `session-remote-operations` own the non-unary event, response, and download surfaces. The native picker is the shipped desktop provider behind the shared seam.

The subsystem references are [API gateway](../../docs/api-gateway.md), [web server](../../docs/subsystems/web-server.md), and [workspace](../../docs/subsystems/workspace.md) (the picker seam).
