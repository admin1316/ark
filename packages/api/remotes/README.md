# @deepseek-ai/dsh-api-remotes

English | [中文](README.zh.md)

Host-only Remote policy package. `createApiRemoteAgentResolver()` reuses live Agents, resumes ordinary cold sessions, deduplicates concurrent resumes, preserves subagent ownership, and configures the same resolver for Typert `agent` and `session` lookups.

`API_REMOTE_FORWARDED_EVENTS` is the single allowlist of Host Cordis events that may cross the native API without projection, redaction, or renaming. The Host compiler checks every entry against the declared event vocabulary and rejects scoped, waterfall, or bail events. The `./types` subpath exports the selection type used by the Host event carrier.

This package has one Host TypeScript project, no `dsh.client` metadata, no client export, and no browser bundle. [`@deepseek-ai/dsh-host-native-events`](../../host/native-events/README.md) consumes its resolver and forwarded-event policy.

## Model Experience

None, as this package owns identity and forwarding policy but registers no model-facing context.

#### KV Cache effect

No direct effect; invoked Host capabilities own any model-visible behavior.

## Known Limitations and Deferred Work

- The historical package name says “remotes,” but the browser Remote runtime is not shipped; renaming the package is a separate package-identity change.
