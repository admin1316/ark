# HTTP 服务器

[English](web-server.md) | 中文

[dsh-host-webserver](../../packages/host/webserver) 提供 `ctx.webServer`，即带具名 HTTP 路由和升级路由的 `node:http` 监听器。它不了解 agent loop（智能体循环）概念，也不自行提供文件。Ark 通过 [dsh-native-api-app](../../packages/bundle/native-api-app/README.zh.md) 将它组合为经过认证、绑定 loopback 且只提供 API 的 sidecar；[API Gateway 参考](../api-gateway.zh.md) 定义分派与信任边界。原生 SwiftUI/AppKit 界面消费此 API。独立的 Workbench 浏览器使用 WebKit 渲染外部 HTTP(S) 页面，不能访问 Ark 凭据、工具或本地文件。

源码：[`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## 路由

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

匹配顺序固定：先查 exact 表，再取最长匹配前缀，最后落到已注册的回退。注册顺序不携带任何面向请求的语义：具名路由在组合上互不相交，任何未被具名路由认领的请求都由回退席位应答；席位只有一个所有者，第二次注册会抛出异常。Ark 的 Native 组合不占用回退席位，并使用 API-only 模式：`/` 返回状态文档，其他非 API 路径返回 404，不提供静态前端。

## 配置

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

`host` 仅接受 `127.0.0.1` 和 `0.0.0.0`。服务器校验 loopback Host 请求头，并使用启动级 token 认证 `/api` 请求；绑定所有接口必须显式配置 token。它不提供 TLS。Ark 绑定 loopback、启用 API-only 模式，并应用 [API Gateway 参考](../api-gateway.zh.md) 中定义的额外 Host 连接信任策略。

## 服务

`WebServer`（`ctx.webServer`）在激活时立即监听；监听失败（EADDRINUSE 等）会使初始化被拒绝，启动进程会报告失败的 fiber。`register(route)` 添加一条具名路由并返回其 disposer；重复的 `(kind, path)` 抛出异常，因为路由模式是组合层约定，冲突即配置错误。`port` 读取监听端口，包括 `config.port` 为 0 时操作系统分配的端口。

处理过程中抛出异常的请求（畸形的 % 转义撞上 `decodeURIComponent`、客户端在请求体中途断开）会记录为警告并应答 400（响应头已发出时则销毁 socket），绝不导致进程退出。dispose（资源释放）把 `close()` 与 `closeAllConnections()` 配对使用，因为处理器可能像 SSE（Server-Sent Events）那样保持响应打开，而这类连接永远不会自行结束；没有强制关闭，拆卸就会挂起。该包从不打印输出：URL 行归 shell 所有。逐包运维细节留在 [README](../../packages/host/webserver/README.zh.md) 中。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [SessionId](core.zh.md)

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
