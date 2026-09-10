# api/ — Host API policy

English | [中文](README.zh.md)

Host-side policy shared by API transports. The group contains no browser assembly or client runtime.

| Package | Role | ctx key |
|---|---|---|
| [`gateway/`](gateway/README.md) | Host-only strict Typert Remote dispatch for native API clients | `ctx.typertGateway` |
| [`remotes/`](remotes/README.md) | Agent/Session lookup policy and the allowlist of Host events that may cross the native API | no service; supplies Host policy |

The strict runtime path is `Typert registry + domain Remote services → gateway → host/connection → host/webserver`. [`host/connection`](../host/connection/README.md) owns authentication and physical routes, [`host/native-events`](../host/native-events/README.md) owns event/response projection, and [`host/webserver`](../host/webserver/README.md) owns the loopback listener.

## Known Limitations and Deferred Work

- The historical `remotes` name remains even though the browser Remote runtime is absent; renaming it is a separate package-identity change.
- Native calls use strict slash Remote descriptors; event downlinks, answer correlation, and streamed downloads remain separate Host carrier capabilities.
