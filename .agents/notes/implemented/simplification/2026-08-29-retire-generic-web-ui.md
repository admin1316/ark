# Agent Note: Retire the generic Web UI

Status: implemented

English | [中文](2026-08-29-retire-generic-web-ui.zh.md)

## Problem

The generic browser application duplicates the user-visible product work now owned by Ark's native AppKit/SwiftUI interface. Keeping both products also keeps a second shell, Client plugin runtime, static-file server, browser transport, UI package family, build plane, test lane, documentation set, and runtime dependency closure. The two interfaces can drift while a passing browser test says nothing about native behavior.

The word “web” also names a separate model capability in this repository. Removing everything with that name would delete agent search and fetch, which does not solve a UI duplication problem.

## Decision

DeepSeek Harness ships no generic browser UI. The `dsh web` alias and Web profile, `apps/web`, `packages/client`, the `dsh-web-app` bundle, the Client Cordis runner and UI, static-frontend fallback, browser-only directory picker and session export adapters, Client compiler/build/test lanes, and their current user and contributor documentation are absent.

The generic `dsh` CLI owns arbitrary profiles, plugin management, and the one-shot headless template. It does not export or depend on Ark's managed Native entry. Ark starts [`dsh-native-api-runner`](../../../../packages/boot/native-api-runner/README.md), which boots only the managed profile over [`dsh-native-api-app`](../../../../packages/bundle/native-api-app/README.md).

The native sidecar is API-only: [`dsh-host-webserver`](../../../../packages/host/webserver/README.md) listens on loopback, requires the launch-scoped bearer token, and exposes only registered `/api` HTTP and WebSocket routes. It serves no HTML, CSS, JavaScript, static files, Client bundle, or fallback application shell. Ark's visible interface remains native AppKit/SwiftUI.

## What remains

- [`packages/web`](../../../../packages/web/README.md) remains the provider-neutral search/fetch capability and model-facing tool family. It contains no browser UI.
- Host API packages remain for the native sidecar: business methods, authentication, event downlinks, persistence, and native desktop operations.
- Headless, ACP, TypeScript/Python SDK, JSON-RPC, and external UI/editor protocol integrations remain supported entry patterns.
- `website/` remains the static documentation site. It does not enter the Ark runtime or recreate the deleted application.
- Historical postmortems and prior Agent Notes remain evidence of earlier designs. Where they describe a shipped generic browser product, this note is the current authority.

## Supersession

This decision fully supersedes the current-product claims in the [Web Client architecture](../architecture/2026-07-19-gui-web-client-architecture.md), [Web composition](../architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md), [browser e2e lane](../testing/2026-07-24-web-gui-browser-e2e-lane.md), and [Web styling system](../process/2026-07-19-web-styling-system.md), plus Web-only feature notes whose implementations are absent. Those records remain unchanged so their rationale and incident history are recoverable; they do not authorize reintroducing a browser fallback.

The Host protocol, durable Session facts, model tools, and other mechanisms that native, headless, ACP, or SDK consumers still use are only partially superseded. Their owning current documentation describes the surviving behavior without a browser assumption.

## Alternatives considered

**Keep the Web UI as an independent product.** This preserves another user interface but also preserves its full dependency, build, test, accessibility, security, and release cost. There is no current product owner or acceptance target that justifies that closure.

**Keep a hidden or disabled browser fallback.** A dormant fallback still keeps executable frontend code and makes accidental reactivation possible. It also prevents dependency scans from proving that Ark's packaged runtime is native-only.

**Delete every package whose name contains “web.”** This would remove model-visible search and fetch together with the browser application. The model capability has a current consumer and a different owner, so it remains.

**Move the browser code to an archive inside the repository.** Git history plus the verified retirement archive already recover the exact bytes. A second source archive would remain searchable, packageable residue and would undermine absence checks.

## Verification

- Source and runtime closure scans reject the retired application paths, browser package names, Web CLI alias/profile, Client compiler inputs, and static frontend artifacts.
- Documentation links, generated catalogs, and package README checks pass without the retired pages; the corpus-wide bilingual pairing report still has separately tracked out-of-sync historical documents.
- The managed sidecar boots from its packaged Native runner on port 0, requires the app-owned bearer token, serves representative Host API calls and event upgrades, and rejects non-API routes.
- Native AppKit/SwiftUI interaction tests remain the user-interface acceptance authority; Host or headless tests do not substitute for them.

## Consequences

The repository and Ark runtime lose the browser UI, dynamic Client plugin ecosystem, browser-specific configuration pages, and browser snapshot lane. Integrations that need a user interface must use the native product or own a separate external protocol client.

The retained Host API and model Web capability keep their security, data-protection, error, cancellation, and persistence guarantees. Their names do not imply a visible browser product.

Reintroducing a generic browser UI requires a new product decision with an owner, independent dependency closure, authentication and trust design, accessibility contract, behavior acceptance suite, and release boundary. It cannot be added as an Ark fallback or bundled by default.
