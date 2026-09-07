# @deepseek-ai/dsh-host-session-remote-operations

English | [中文](README.zh.md)

Host implementation of the generated `session/*` Remote port and the `workspaceSessionRetirer` capability. The package composes the existing Agent, Session persistence/query/projection, Workspace, LLM, attachment, title, tool-presentation, preset, queue, and job owners; it does not create a second transcript, projection, workspace, attachment, or model-catalog cache.

`SessionRemoteOperationsService` implements `list`, `search`, `create`, `history`, `models`, `selectModel`, `rename`, `fork`, `prompt`, `attachment`, `updateQueue`, and `cancel`. Creation and resume are single-flight per identity. Handles returned by `AgentRegistry` remain exact capabilities owned by this service, so permanent deletion can retire only an idle, archived, root Agent created or resumed by this Host. `WorkspaceRegistry` remains responsible for descendant ordering, persistence reservations, durable log deletion, workspace accounting, and archive-state commits.

The same service owns the exact `/api/session/export` GET/HEAD download registered through `ctx.connection.downloads`. It flushes live Sessions before reading raw durable artifacts, optionally includes descendants and referenced media, streams a bounded ZIP with cancellation, and fails before body production when the required persistence/query/attachment owners are unavailable.

An encoder or producer failure errors the response body; later encoder callbacks cannot turn it into a successful archive. Consumer cancellation waits for producer cleanup and reports cleanup failures. The [export decision](../../../.agents/notes/implemented/feature/2026-08-10-web-session-log-export.md#terminal-failure-and-cancellation) defines first-cause precedence and verification limits.

Cancellation is checked before every mutation and around asynchronous reads. History and listing read their authoritative services directly; projection and tool-presentation failures degrade only the optional view. Image retrieval requires an attachment reference in the addressed Session log, and queue editing accepts text blocks only.

## Prompt identity

Every `SessionRemotePromptRequest` carries a required opaque `invocationId`. The service validates it and persists it with the exact user message beside the optional canonical client time zone. This preserves optimistic-message reconciliation without leaking a transport RPC identity into the Session domain.

## Model Experience

### Per-session model route

#### What the model sees

The service adds no model-visible tools or prompt text. It installs the selected provider, model, and reasoning route from `SessionRemotePromptRequest` into the existing Agent request path, while the composed Agent owns the actual model content.

#### Token effect

No direct token effect from this service; the selected Agent composition, prompt, tool descriptions, and provider determine request size.

#### KV Cache effect

The service retains the selected route per session without adding model content; changing the provider, model, reasoning route, or composed prompt can invalidate provider-side reuse.

## Known Limitations and Deferred Work

- **Raw artifact requirement** — Session export returns 501 when the selected persistence backend cannot expose per-session raw artifacts; it never reconstructs an approximate log from parsed events.
