# Ark macOS application

English | [中文](README.zh.md)

The native macOS application for Ark. AppKit owns the process and window lifecycle, SwiftUI renders every visible control, and a bearer-authenticated API-only process on an OS-assigned `127.0.0.1` port supplies sessions, models, workspaces, and knowledge data. The application does not load an HTML, CSS, JavaScript, PWA, or WKWebView interface.

- The sole user-visible artifact, application name, menu, and window name is `Ark.app` / `Ark`.
- The native client creates one launch token and sends it as a bearer credential to the loopback API; the backend exposes no browser interface.
- The process uses the product data directory, defaults to read-only permission mode, and disables telemetry.
- Local builds are ad-hoc signed. A self-contained build embeds Node and signs it with the separate V8 JIT entitlements before executing a signed-runtime smoke test.

Chat exposes recorded invocation configuration and response receipts in its process details. Requested model ids are separate from provider-reported model ids; absent or unsupported response metadata stays unknown. Receipts do not independently certify a gateway's underlying model, expose credentials, or inject new model-visible context. First-response timing measures the first stream event, not necessarily visible text. Throughput uses provider-reported output tokens, which may include reasoning, divided by the sum of completed model-stream durations; tool execution and retry backoff are excluded. Missing timing suppresses throughput instead of borrowing another call's interval.

## Build

```sh
zsh build-app.sh /path/to/output
```

Emits `Ark.app` at the output path. The icon source is `Resources/AppIcon.png` (a 1024 × 1024 Ark seal master; the build validates the exact dimensions and generates the ICNS inside the temporary build directory).

Build details, versioning, and both layouts: [engineering notes](../docs/engineering.md).
