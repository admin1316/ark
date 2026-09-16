# Ark macOS application

English | [中文](README.zh.md)

The native macOS application for Ark. AppKit owns the process and window lifecycle, SwiftUI renders the application controls, and a bearer-authenticated API-only process on an OS-assigned `127.0.0.1` port supplies sessions, models, workspaces, and knowledge data. Workbench browser tabs use WebKit to render external HTTP(S) pages with their own styles and JavaScript. These pages have no bridge to Ark credentials, tools, or local files; the application shell remains native.

- The sole user-visible artifact, application name, menu, and window name is `Ark.app` / `Ark`.
- The native client creates one launch token and sends it as a bearer credential to the loopback API; the backend exposes no browser interface.
- The process uses the product data directory, defaults to read-only permission mode, and disables telemetry.
- Local builds are ad-hoc signed. A self-contained build embeds Node and signs it with the separate V8 JIT entitlements before executing a signed-runtime smoke test.

Chat exposes recorded invocation configuration and response receipts in its process details. Requested model ids are separate from provider-reported model ids; absent or unsupported response metadata stays unknown. Receipts do not independently certify a gateway's underlying model, expose credentials, or inject new model-visible context. First-response timing measures the first stream event, not necessarily visible text. Throughput uses provider-reported output tokens, which may include reasoning, divided by the sum of completed model-stream durations; tool execution and retry backoff are excluded. Missing timing suppresses throughput instead of borrowing another call's interval.

The transcript renders a movable row window with controls for earlier and newer content. Reading older rows does not advance the live event cursor. Historical previews must load their complete body before exposing full-message actions. Markdown tables share content-sized column widths across rows, wrap long cells, and retain native horizontal scrolling when their total width exceeds the transcript.

The toolbar opens the selected workspace in Finder or Terminal through Launch Services and reports unavailable folders or launch failures. The connection indicator reflects both event channels. Manual reconnect replaces their socket loops while preserving the mailbox and consumer; only a subsequent baseline establishes a healthy connection, and shutdown prevents reconnection from restarting the loops.

## Build

```sh
zsh build-app.sh /path/to/output
```

Emits `Ark.app` at the output path. The icon source is `Resources/AppIcon.png`, the square silver-symbol icon derived from the supplied Ark artwork. The build normalizes it to 1024 × 1024 and generates ICNS in temporary staging. In-app branding uses shared native vector paths in `ArkBrandView.swift`, with restrained silver shading in dark appearance and graphite shading in light appearance. The paths scale to compact sidebar symbols without transparent bitmap fringes.

Build details, versioning, and both layouts: [engineering notes](../docs/engineering.md).
