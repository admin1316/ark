# Agent Note: Ark native application interface

Status: implemented

English | [中文](2026-08-22-ark-native-application-interface.zh.md)

## Problem

Ark.app rendered its visible product interface through WKWebView. A client-bundle or profile change could therefore replace the entire application layout, remove the Jiuzhang identity, or expose an API-only JSON response as the window contents. The user-visible product also remained a browser application even though it was packaged as a macOS bundle.

## Decision

Ark.app uses AppKit for application, window, menu, and backend-process lifecycle and SwiftUI for every visible control. `ArkRootView` owns the Jiuzhang lockup, workspace and session navigation, conversation composer, trajectory browser, and the three-column Wanxiang Zhijian workspace. The executable does not import or link WebKit.

Errors belong to the native surface that can resolve them: settings, composer, navigation, and knowledge operations keep separate inline error state, while Workbench file-navigation failures use a one-shot native alert. Application chrome does not project operation failures as a global banner. Appearance changes apply immediately from the app-owned local preference; a writable `ui-theme` namespace adds persistence, and its absence remains a silent local-only mode. Settings navigation uses focusable button rows with stable accessibility identifiers, selected traits, `AXPress`, initial focus on the selected page, and ordered directional-key movement. Continuous conversation-display sliders keep draft values inside their popover and write the app-owned preference once when editing ends; discrete switches write once per user action.

The local process remains a transport and model runtime, not a renderer. The native shell creates one launch token, passes it to the child as `DSH_API_TOKEN`, and uses `ArkAPIClient` to call the loopback RPC endpoints with a bearer header. The launcher always appends `native-only.cordis.patch.yml` after the user profile; that overlay sets the primary listener to `apiOnly: true`, so a stale profile cannot restore an HTML fallback. The native wiki view consumes the knowledge Remote for projects, pages, graph data, page content, and reviews; a file-backed read-only projection remains a local fallback when the Remote is unavailable.

Self-contained builds sign the application and embedded Node with separate entitlements. Node receives only the V8 JIT permissions and must execute successfully after signing; the native application keeps the Sparkle library-validation exception and does not receive JIT permissions.

## Alternatives considered

**Keep WKWebView and protect the page with an app-only token.** Rejected because it would restrict browser access without changing the fact that the application interface was HTML/CSS/JavaScript and could regress with the Web bundle.

**Delete the loopback process together with the Web interface.** Rejected because sessions, models, tools, persistence, and knowledge governance belong to that local runtime. The renderer is removed; the service remains behind a native API client.

**Build the whole interface with imperative AppKit.** Rejected because AppKit is still required for process and window ownership, while SwiftUI expresses the state-driven multi-column interface with less custom lifecycle code and remains a native macOS UI.

## Consequences

The only user-visible deliverable is Ark.app, and its accessibility tree contains native lists, buttons, text fields, and scroll views rather than a Web area. `/` returns service JSON and browser/PWA routes do not render a product interface. Client-bundle changes can no longer replace the application chrome or Jiuzhang wordmark.

A missing optional settings namespace cannot create a repeating top-level error. Transport, validation, security, and data failures remain visible in their owning interface instead of being discarded, and assistive clients can invoke settings pages through explicit native button actions.

The first native implementation polls the history tail while a session is selected; it rechecks session identity before committing an asynchronous result. Streaming chunks, approvals, questions, and richer tool cards require the two authenticated WebSocket downlinks before they can reach feature parity, so controls without a native contract remain disabled instead of pretending to work.
