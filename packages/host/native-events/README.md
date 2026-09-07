# @deepseek-ai/dsh-host-native-events

English | [中文](README.zh.md)

Authoritative Host projection for Ark's native event streams and interactive responses. The plugin reads the existing Session, Agent, Workspace, job, projection, approval, and user-question owners; it does not replace any of them. It registers the sole `mux` and `host` producers through `ctx.connection.events`, and pairs pending approval/question frames with the exact loopback-only `/api/respond` carrier through `ctx.connection.responses`.

The mux stream publishes session subscriptions and events, typed tool views, queue and job snapshots, projection updates, and stable approval/question requests. A reconnect receives the current baseline and every still-pending interaction with the same `rpcId`. The host stream publishes session lifecycle and running state, Agent failures, Workspace changes, archived-session changes, and the allowlisted strict Remote events. Source disposal aborts active generations and clears only this package's in-memory correlation tables; durable domain state remains with its original services.

`@deepseek-ai/dsh-host-connection` remains transport-only: it authenticates requests, owns socket lifecycle and carries envelopes. This package owns the Native projection and answer correlation, so there is no legacy API fallback or second event bus.

## Model Experience

### Native event projection

#### What the model sees

Nothing directly. The package transports already-committed Host state and human answers such as `session/projection` and `/api/respond`; it registers no prompt, tool, message, model provider, or provider request.

#### Token effect

No direct token effect. A human answer may later become ordinary Agent input through the owning interaction service, but this package does not assemble model context.

#### KV Cache effect

No independent effect; it does not alter provider request bytes.

## Known Limitations and Deferred Work

- **Pending answer correlation is process-local** — reconnect within the same Host process replays pending approvals and questions, while a Host restart relies on each domain's durable recovery contract rather than serializing this transport table.
- **Large live event bursts remain memory-backed** — each connected downlink has one bounded-lifetime in-memory queue; additional disk-backed transport buffering is intentionally deferred.
