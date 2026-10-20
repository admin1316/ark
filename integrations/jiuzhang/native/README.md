# Ark macOS application

English | [中文](README.zh.md)

The native macOS application for Ark. AppKit owns the process and window lifecycle, SwiftUI renders the application controls, and a bearer-authenticated API-only process on an OS-assigned `127.0.0.1` port supplies sessions, models, workspaces, and knowledge data. Workbench browser tabs use WebKit to render external HTTP(S) pages with their own styles and JavaScript. These pages have no bridge to Ark credentials, tools, or local files; the application shell remains native.

- The sole user-visible artifact, application name, menu, and window name is `Ark.app` / `Ark`.
- The native client creates one launch token and sends it as a bearer credential to the loopback API; the backend exposes no browser interface.
- The process uses the product data directory, defaults to read-only permission mode, and disables telemetry.
- Local builds are ad-hoc signed. A self-contained build embeds Node and signs it with the separate V8 JIT entitlements before executing a signed-runtime smoke test.

Chat exposes recorded invocation configuration and response receipts in its process details. Requested model ids are separate from provider-reported model ids; absent or unsupported response metadata stays unknown. Receipts do not independently certify a gateway's underlying model, expose credentials, or inject new model-visible context. First-response timing measures the first stream event, not necessarily visible text. Throughput uses provider-reported output tokens, which may include reasoning, divided by the sum of completed model-stream durations; tool execution and retry backoff are excluded. Missing timing suppresses throughput instead of borrowing another call's interval.

The transcript renders a movable row window with controls for earlier and newer content. Reading older rows does not advance the live event cursor. Moving away from the bottom holds the displayed bounded live-text frame through completion or cancellation until an explicit return to latest; complete messages, copy operations, and real lifecycle state continue updating. Returning from Trajectory preserves the session's row window and reading position. The [transcript publication decision](../../../.agents/notes/implemented/bug-fix/2026-09-08-native-startup-and-markdown-batching.md) owns this display policy. Historical previews must load their complete body before exposing full-message actions. Markdown tables share content-sized column widths across rows, wrap long cells, and retain native horizontal scrolling when their total width exceeds the transcript.

The toolbar opens the selected workspace in Finder or Terminal through Launch Services and reports unavailable folders or launch failures. The connection indicator reflects both event channels. Manual reconnect replaces their socket loops while preserving the mailbox and consumer; only a subsequent baseline establishes a healthy connection, and shutdown prevents reconnection from restarting the loops.

Archive rows offer Restore and Permanent Delete through a native context menu and named accessibility actions without requiring hover. An in-flight archive mutation disables both actions; permanent deletion still requires its separate confirmation. The compact hover controls and date remain visible in their existing states; the [archive action decision](../../../.agents/notes/implemented/bug-fix/2026-10-20-native-archive-action-reachability.md) records the accessibility and layout trade-off.

Model settings group knowledge connections in a card with aligned model selections, a collapsible optional vector service, and explicit Restore and Save actions. Expanded vector fields retain visible labels, including the secure credential field. Saving a connection does not certify a successful model call.

Knowledge project and file selection share one nonblocking native chooser. Repeated activation cannot stack panels, and cancellation or view teardown discards late selections. File import captures its project before opening the chooser; switching projects cannot redirect the selected files, while revoked projects and stopped application models reject the selection. New-project sheets carry their selected directory with their presentation, and editing the project name does not change that directory.

Knowledge research permits one active operation. Repeated Return or button activation does not submit another request; Cancel, project switching, and shutdown invalidate its results, cancel the transport, and await the owned task. Each request freezes the Host's advertised total research budget plus thirty seconds for cleanup and delivery, with both transfer and absolute deadlines; ordinary RPC requests retain their sixty-second timeout. Missing or invalid research budgets disable submission, and failed or timed-out requests never produce a completion notice.

Quit waits for the Host's save confirmation while keeping the interface mounted. Before irreversible teardown it freezes local input, makes AppKit editors read-only, settles pending composer submissions, and saves the latest composer and Workbench drafts. Final draft failures retain the frozen window for retry or explicit force quit; the twenty-second prompt never treats elapsed time as saving success. Cancelling quit is available before local teardown begins.

## Build

```sh
zsh build-app.sh /path/to/output
```

Emits `Ark.app` at the output path. The icon source is `Resources/AppIcon.png`, the square silver-symbol icon derived from the supplied Ark artwork. The build normalizes it to 1024 × 1024 and generates ICNS in temporary staging. In-app branding uses shared native vector paths in `ArkBrandView.swift`, with restrained silver shading in dark appearance and graphite shading in light appearance. The paths scale to compact sidebar symbols without transparent bitmap fringes.

Build details, versioning, and both layouts: [engineering notes](../docs/engineering.md).

`JiuzhangShellContractTests` runs all registered native contract groups by default. Passing group names as positional arguments runs only those groups; unknown or repeated names fail before execution. These process-level contracts do not replace isolated-candidate interaction checks for first sheet presentation and source-button actions.
