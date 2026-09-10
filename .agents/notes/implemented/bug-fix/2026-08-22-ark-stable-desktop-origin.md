# Agent Note: Ark stable desktop origin

Status: implemented

English | [中文](2026-08-22-ark-stable-desktop-origin.zh.md)

## Problem

The generic Web product needs a stable loopback origin because WebKit local storage is isolated by HTTP origin. An OS-assigned port changed after a backend restart, making preserved session selection, drafts, workspace views, trajectories, and plugin layouts appear reset.

## Decision

The generic Web product owns `http://127.0.0.1:3080` as its stable origin. It binds only to loopback, validates the readiness URL, gates API access with the launch token, blocks non-loopback subresources, rejects navigation away from the ready origin, and reports port conflicts.

Ark does not use a browser-owned product surface. Its AppKit/SwiftUI client reads the bearer-authenticated API URL from the `dsh native-api:` readiness line and starts with port `0`; Native/Host-owned persistence holds session selection, drafts, workspaces, trajectories, and layouts.

## Alternatives considered

- **Use an OS-assigned port for the generic Web product.** A restart changes its origin and therefore its WebKit storage partition, so persisted records appear absent.
- **Use the stable browser origin for Ark.** Ark has no visible WebKit surface, and a fixed port can be occupied by a stale process or unrelated local service.

## Consequences

The generic Web product retains a stable origin and visibly rejects conflicts. Ark avoids the `3080` startup conflict and does not restore browser-origin persistence unless a future design deliberately reintroduces a browser-owned surface with its own acceptance requirements.
