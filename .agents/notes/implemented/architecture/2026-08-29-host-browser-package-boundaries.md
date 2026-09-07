# Agent Note: Host and browser package boundaries

Status: implemented

English | [中文](2026-08-29-host-browser-package-boundaries.zh.md)

## Problem

Connection and Remote assembly packages each published a Host entry and a browser entry. A Host-only native runtime therefore retained package identities and files whose browser code could never execute, and dependency closure could not prove that the native product contained no browser package.

## Decision

Physical HTTP, trust, Host RPC, and WebSocket behavior belongs only to `@deepseek-ai/dsh-host-connection`; `@deepseek-ai/dsh-client-connection` contains only the browser plugin. The dependency-free `host-connection/protocol` subpath is the single owner of route constants, loopback classification, and shared RPC types.

Host Agent/Session lookup and the forwarded-event allowlist belong only to `@deepseek-ai/dsh-api-remotes`; generated browser Remote contribution mounting belongs only to `@deepseek-ai/dsh-client-api-remotes`. Each package participates in exactly one TypeScript aggregate and publishes only its own runtime face.

Native strict slash Remote dispatch belongs to the Host-only `@deepseek-ai/dsh-api-gateway`. It dynamically claims registered Typert descriptors, has no Client entry or SRC fallback, and connects to `ctx.connection.rpc.intercept` through a private structural capability rather than a package or project-reference edge. `@deepseek-ai/dsh-host-apiproxy` remains an explicitly named compatibility row for 59 dot RPCs plus its existing event and download carriers; the former sixtieth unary entry, `pluginInventory/list`, belongs to the new Gateway, and ApiProxy never claims a slash endpoint.

The Web bundle mounts distinct Host and Client rows and owns the Typert Gateway row that serves browser Remote calls. The native API bundle depends only on Host packages, and its closure policy rejects every `@deepseek-ai/dsh-client-*` identity in direct links or pnpm storage.

## Alternatives considered

**Keep combined packages but omit browser rows from the native profile.** This prevents activation but still ships browser package identities and browser artifacts, so artifact closure cannot prove absence.

**Copy shared constants into each face.** This removes the package edge but creates two authorities for protocol paths and loopback semantics; drift would break transport without a type error.

**Import the combined alpha Gateway package into Native.** That restores Client, browser-stream, and SRC behavior that Ark does not consume and prevents the native closure from proving a Host-only package graph.

## Consequences

Native runtime assembly can require zero Client, Web, headless, and UI package identities while strict slash Remote registration remains dynamic. Generic Web retains the same Host and browser behavior through separate rows. Adding a cross-plane protocol fact requires updating the small shared protocol subpath rather than importing a Host implementation into a browser bundle. ApiProxy removal remains incomplete until its compatibility row and callers leave the native closure.
