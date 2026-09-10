# HTTP Server

English | [中文](web-server.zh.md)

[dsh-host-webserver](../../packages/host/webserver) is the browser HTTP carrier for the GUI host: a single `node:http` plugin providing `ctx.webServer`, a named-route registry, index.html transform callbacks, and one fallback handler that a plugin may claim. It is not part of the agent loop and not a capability seam; it knows no harness concepts, and another plugin registers every feature route, including the `/api` bridge, plugin bundles, and the HMR event stream ([layering note](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)). It serves browsers only: Electron loads the built files over `file://` and sends fetch requests through an IPC bridge instead of this server.

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## Routes

```ts type-equiv
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'
```

```ts type-equiv
/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

Match order is fixed: exact table first, then longest matching prefix, then the registered fallback. Registration order carries no request-facing semantics — named routes are composed to be disjoint, and the fallback seat answers anything no named route claims; one owner only, a second registration throws. Ark's Native composition leaves the fallback seat empty, so non-API paths return 404 and no static frontend is served.

## Config

```ts type-equiv
/** Gateway config: the listen address and the launch-scoped API token. */
interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /**
   * Launch-scoped API token. Absent, the `DSH_API_TOKEN` environment
   * variable is consulted; when neither is set, a fresh random token is
   * generated per launch (the gate is never disabled by default). Binding
   * `0.0.0.0` requires this field or the environment variable to be set
   * explicitly.
   */
  apiToken?: string
  /**
   * API-only service mode: the gateway serves JSON only — `/` answers a
   * status document, every other non-API path a JSON 404, and the SPA
   * fallback seat is unreachable. Non-API upgrade requests are rejected
   * before route dispatch; all `/api/*` HTTP and upgrade routes are untouched.
   */
  apiOnly?: boolean
  /**
   * Fixed loopback API-only listener. When set, a second server answers on
   * `127.0.0.1:apiPort` with the API surface only: `/` is the status
   * document, non-API paths JSON 404, and the SPA fallback seat is
   * unreachable; non-API upgrades are rejected before route dispatch. The
   * primary listener keeps serving the UI (unless
   * `apiOnly` is set), so a desktop app can hold the full interface while
   * external web access gets a pure API on the stable port.
   */
  apiPort?: number
}
```

`host` accepts only `127.0.0.1` (default posture) and `0.0.0.0` (deliberate network exposure); there is no TLS, auth, or origin policy, so a non-loopback bind exposes the server to that network. Ark binds loopback and applies authentication in its Host connection layer.

## The service

`WebServer` (`ctx.webServer`) listens immediately on activation; a listen failure (EADDRINUSE…) rejects initialization, and the boot process reports the failed fiber. `register(route)` adds one named route and returns its disposer; a duplicate `(kind, path)` throws because route patterns are a composition-level contract and a collision is a misconfiguration. `port` reads the listening port, including the port assigned by the OS when `config.port` is 0.

A request whose handling throws (a malformed %-escape hitting `decodeURIComponent`, a client dropping mid-body) is logged as a warning and answered 400 — or the socket destroyed when headers are already out — never a process exit. Disposal pairs `close()` with `closeAllConnections()` because a handler may hold its response open (SSE) and such connections never end on their own; without the force-close, teardown would hang. The package never prints: the URL line belongs to the shell. Per-package operational detail, including the dev-mode bundle watch pipeline, stays in the [README](../../packages/host/webserver/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconnection--hostconnectionhandle"></a>

### `ctx.connection` — `HostConnectionHandle`

Host `ctx.connection` shape consumed by transport-independent adapters.

Source: [`packages/host/connection/src/rpc.ts`](../../packages/host/connection/src/rpc.ts)

<a id="ctxnativeevents--nativeeventsservice"></a>

### `ctx.nativeEvents` — `NativeEventsService`

Sole Host owner for Native event projection and answer correlation.

```ts cordis-catalog
/**
 * Test whether one Session still owns an answerable human interaction.
 * @param sessionId - Session identity whose pending questions and approvals are inspected.
 * @returns whether at least one answerable interaction remains pending.
 */
hasPendingSession(sessionId: SessionId): boolean
```

Types: [SessionId](core.md)

Source: [`packages/host/native-events/src/index.ts`](../../packages/host/native-events/src/index.ts)

<a id="ctxwebserver--webserver"></a>

### `ctx.webServer` — `WebServer`

The browser HTTP carrier service. Activation listens immediately. Route registration order does not affect requests because configured named routes must be distinct, and the fallback handler answers anything not yet claimed during startup with 404 until its owner registers. A listen failure rejects initialization, and the boot process reports the failed fiber.

```ts cordis-catalog
/**
 * Register a named route. Duplicate (kind, path) throws — route patterns are
 * a composition-level contract, so a collision is a misconfiguration.
 * @param route - kind, path, and the owning handler.
 * @returns the disposer removing the route.
 */
register(route: WebRoute): () => void

/**
 * Register an exact-path HTTP upgrade route. Duplicate paths throw because
 * one socket can have only one protocol owner.
 * @param route - pathname and handler owning negotiation plus socket use.
 * @returns the disposer removing the route.
 */
registerUpgrade(route: WebUpgradeRoute): () => void

/**
 * Claim the fallback seat: the handler answering every request no named
 * route matches (the SPA dist server in the shipped Web composition). One
 * owner only — a second registration throws, because two fallbacks cannot
 * compose.
 * @param handler - owns the full response lifecycle of unmatched requests.
 * @returns the disposer releasing the seat.
 */
registerFallback(handler: WebRoute['handler']): () => void

/**
 * Register a raw-HTML index transform, the escape hatch for markup no
 * {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
 * registration order after rendering the structured rows. The transform
 * receives the request the index response answers, forwarded by the
 * fallback owner through {@link applyIndexTaps}; request-aware taps (the
 * launch-token plant) gate credentials on it, so an owner that cannot
 * forward the request gets the legacy request-blind behavior.
 * @param transform - pure html-to-html function over the rendered document.
 * @returns the disposer removing the transform.
 */
tapIndex(transform: (html: string, req?: IncomingMessage) => string): () => void

/**
 * Security headers the index-document owner must attach to every index
 * response: a Content-Security-Policy admitting same-origin scripts and
 * styles, the launch-scoped token cookie script (by content hash), remote
 * and data images (markdown rendering), and loopback WebSockets.
 * @returns header names to values for an index response.
 */
indexSecurityHeaders(): Record<string, string>

/**
 * Run an index.html body through the registered taps in registration order
 * — called by the fallback owner on every index response it renders. The
 * owner forwards the request being answered so request-aware taps can gate
 * credential content on it; omitting it makes credential-carrying taps fail
 * closed on all-interfaces hosts, and selects request-blind behavior only
 * where no credential decision depends on it.
 * @param html - the raw index.html body.
 * @param req - the request the index response answers, when available.
 * @returns the transformed body.
 */
applyIndexTaps(html: string, req?: IncomingMessage): string

/**
 * Gather the structured injection table: one `webserver/index-inject` emit,
 * every subscriber pushes its current rows. Fresh per call, so subscribers
 * read live state (module graph, theme preference) at emit time.
 * @returns rows in subscriber activation order.
 */
collectIndexInjections(): IndexInjection[]

/**
 * Render one index.html body: the structured injection table first, then
 * the raw `tapIndex` transforms over the result.
 * @param html - the raw index.html body.
 * @param req - the request the index response answers, when available.
 * @returns the transformed body.
 */
renderIndex(html: string, req?: IncomingMessage): string
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

<a id="webserver-events"></a>

### `webserver/*` events

<a id="webserverindex-inject--emit"></a>

#### `webserver/index-inject` — emit

Collect the structured index injection table. Emitted on every index render and every worker boot-payload request; listeners push their current rows, so a row's data is read fresh at emit time.

```ts cordis-catalog
/**
 * Collect the structured index injection table. Emitted on every index
 * render and every worker boot-payload request; listeners push their
 * current rows, so a row's data is read fresh at emit time.
 * @param table - Mutable row table; listeners append in activation order.
 * @mode emit
 */
'webserver/index-inject'(table: IndexInjection[]): void
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)
<!-- END GENERATED cordis-surface -->
