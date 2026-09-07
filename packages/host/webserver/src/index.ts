/**
 * @deepseek-ai/dsh-host-webserver — Web route-registration plugin: a node:http
 * server plus the `webServer` service (HTTP and upgrade route registries, the
 * structured index injection table with raw transform taps behind it, and the
 * single fallback seat for everything no route claims). Knows no harness concepts and serves no files; the composing
 * application's frontend plugin owns dist serving through the fallback hook.
 * Web shape only — Electron loads dist over file:// and carries fetch over an
 * IPC bridge. This package never prints: the URL line belongs to the shell.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { renderIndexInjections, type IndexInjection } from './injections.ts'

export { renderIndexInjections } from './injections.ts'
export type { IndexInjection, IndexInjectionPlacement } from './injections.ts'

/**
 * Launch-scoped API gate: every `/api` request must carry the token as an
 * Authorization bearer or the SameSite cookie the index tap plants below.
 * The token resolves from `config.apiToken`, then `DSH_API_TOKEN`, and
 * otherwise a fresh random value is generated per launch — the gate is never
 * disabled by default, because an open `/api` lets any local process drive
 * the harness without credentials. Binding `0.0.0.0` additionally requires
 * an EXPLICIT token (config or environment): a random per-launch value would
 * be unknowable to legitimate remote clients and only masks the exposure.
 * This is authentication for one local launch, not a network binding policy
 * (the browser-trust fence owns that).
 */

/** SHA-256 halves compared in constant time, so header length cannot leak. */
function apiTokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined || provided === '') return false
  const hash = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(hash(provided), hash(expected))
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
  return header.slice('Bearer '.length)
}

function cookieToken(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  const pair = header.split(';').map(part => part.trim())
    .find(part => part.startsWith('dsh_api_token='))
  return pair?.slice('dsh_api_token='.length)
}

/** Cookie-planting script body for the index tap; base64url characters only.
 *  HttpOnly keeps the token out of page JS — the SPA never reads it, the
 *  browser attaches it to same-origin requests automatically, and a DNS
 *  rebinding page cannot exfiltrate it. */
function apiTokenCookieScript(token: string): string {
  return `document.cookie='dsh_api_token=${token};Path=/;SameSite=Strict;HttpOnly'`
}

/**
 * Body of the token injection script: cookie plant plus the bearer global.
 * The bearer global is the primary channel — an embedded networking process
 * does not reliably attach document.cookie-planted cookies to fetch/SSE — and
 * the client sends it as an `Authorization: Bearer` header on every /api call.
 */
function apiTokenIndexScriptBody(token: string): string {
  return `${apiTokenCookieScript(token)}\nwindow.__DSH_API_TOKEN__=${JSON.stringify(token)}`
}

/** Wrapped token injection script for the index tap. */
function apiTokenIndexScript(token: string): string {
  return `<script>${apiTokenIndexScriptBody(token)}</script>`
}

/** SHA-256 of an inline script body, base64-encoded for a CSP 'sha256-…' source. */
function scriptSha256(script: string): string {
  return createHash('sha256').update(script).digest('base64')
}

/**
 * Content-Security-Policy for index documents: same-origin resources only,
 * the launch-scoped token cookie script admitted by its content hash (never
 * 'unsafe-inline'), inline styles (React), and loopback WebSockets.
 * 'unsafe-eval' is required by the app architecture: the client-runner
 * evaluates dynamic client-plugin bundles in the browser. An absent token
 * emits no script hash entry.
 */
function buildIndexCSP(tokenScriptHash: string | undefined): string {
  const sources = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-eval'${tokenScriptHash === undefined ? '' : ` 'sha256-${tokenScriptHash}'`}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* http://127.0.0.1:*",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ]
  return sources.join('; ')
}

/**
 * Whether one request passes the launch-scoped API gate: matching bearer or
 * SameSite cookie when a token is configured; otherwise always.
 */
function apiTokenAuthorized(req: IncomingMessage, apiToken: string | undefined): boolean {
  if (apiToken === undefined || apiToken === '') return true
  return apiTokenMatches(bearerToken(req) ?? cookieToken(req), apiToken)
}

/**
 * Whether an upgrade request passes the launch-scoped API gate. Browser
 * WebSockets cannot set request headers, so besides the bearer/cookie
 * channels the token may ride the `?token=` query parameter. The index page
 * already exposes the token to same-origin JS, and the loopback-only fence
 * bounds the surface, so this adds no new exposure for handshakes.
 */
function upgradeApiTokenAuthorized(req: IncomingMessage, apiToken: string | undefined): boolean {
  if (apiToken === undefined || apiToken === '') return true
  if (apiTokenAuthorized(req, apiToken)) return true
  const queryToken = new URL(req.url ?? '/', 'http://x').searchParams.get('token')
  return queryToken !== null && apiTokenMatches(queryToken, apiToken)
}

/**
 * DNS-rebinding fence: on loopback binding, the Host header must name the
 * loopback (a rebinding page's origin is the attacker's domain once it
 * resolves to 127.0.0.1, so rejecting foreign Hosts blocks the cookie-
 * stealing first hop before the token gate is even reached). All-interfaces
 * binding is an explicit-token exposure owned by the browser-trust fence,
 * so it passes Hosts through. Malformed Hosts are rejected rather than
 * parsed loosely.
 */
function hostAuthorized(req: IncomingMessage, host: Config['host']): boolean {
  const value = req.headers.host
  if (typeof value !== 'string' || value === '') return false
  if (host === '0.0.0.0') return true
  try {
    const hostname = new URL(`http://${value}`).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch {
    /* v8 ignore next -- a malformed Host is rejected below, not re-thrown. */
    return false
  }
}

/** Reject an upgrade attempt on the raw socket with a plain HTTP 401. */
function rejectUpgradeUnauthorized(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 401 Unauthorized',
    'Content-Type: application/json; charset=utf-8',
    'Connection: close',
    '',
    '{"error":"missing or invalid API token"}',
    '',
  ].join('\r\n'))
}

/** Reject a non-API upgrade on an API-only listener before route dispatch. */
function rejectUpgradeNotFound(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 404 Not Found',
    'Content-Type: application/json; charset=utf-8',
    'Connection: close',
    '',
    '{"error":"not found"}',
    '',
  ].join('\r\n'))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
  interface Events {
    /**
     * Collect the structured index injection table. Emitted on every index
     * render and every worker boot-payload request; listeners push their
     * current rows, so a row's data is read fresh at emit time.
     * @param table - Mutable row table; listeners append in activation order.
     * @mode emit
     */
    'webserver/index-inject'(table: IndexInjection[]): void
  }
}

/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix'

/** One named route registration. */
export interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns protocol negotiation and the upgraded socket after dispatch. */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/** Gateway config: the listen address and the launch-scoped API token. */
export interface Config {
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

/**
 * The browser HTTP carrier service. Activation listens immediately. Route
 * registration order does not affect requests because configured named routes
 * must be distinct, and the fallback handler answers anything not yet claimed
 * during startup with 404 until its owner registers. A listen failure rejects
 * initialization, and the boot process reports the failed fiber.
 */
export class WebServer extends Service {
  static Config: z<Config> = z.object({
    host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
    port: z.natural().max(65535).required(),
    // Optional by schemastery convention (object keys accept absent input);
    // the Config interface marks it optional accordingly.
    apiToken: z.string(),
    apiOnly: z.boolean(),
    apiPort: z.natural().min(1).max(65535),
  })

  private readonly exact = new Map<string, WebRoute>()
  private readonly prefixes = new Map<string, WebRoute>()
  private readonly upgrades = new Map<string, WebUpgradeRoute>()
  private readonly upgradedSockets = new Set<Duplex>()
  private readonly indexTaps: ((html: string) => string)[] = []
  private fallback: WebRoute['handler'] | undefined
  private server!: Server
  private apiServer: Server | undefined
  private listenedPort!: number
  private indexCSP: string | undefined
  private apiTokenValue!: string

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'webServer')
  }

  /** The listening port (the OS-assigned value when config.port is 0). */
  get port(): number {
    return this.listenedPort
  }

  /** The configured bind host (the loopback or all-interfaces literal). */
  get host(): Config['host'] {
    return this.config.host
  }

  /** The effective launch-scoped API token (configured, environment, or generated). */
  get apiToken(): string {
    return this.apiTokenValue
  }

  /**
   * Register a named route. Duplicate (kind, path) throws — route patterns are
   * a composition-level contract, so a collision is a misconfiguration.
   * @param route - kind, path, and the owning handler.
   * @returns the disposer removing the route.
   */
  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  /**
   * Register an exact-path HTTP upgrade route. Duplicate paths throw because
   * one socket can have only one protocol owner.
   * @param route - pathname and handler owning negotiation plus socket use.
   * @returns the disposer removing the route.
   */
  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) {
      throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    }
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  /**
   * Claim the fallback seat: the handler answering every request no named
   * route matches (the SPA dist server in the shipped Web composition). One
   * owner only — a second registration throws, because two fallbacks cannot
   * compose.
   * @param handler - owns the full response lifecycle of unmatched requests.
   * @returns the disposer releasing the seat.
   */
  registerFallback(handler: WebRoute['handler']): () => void {
    if (this.fallback !== undefined) {
      throw new Error('webserver: fallback already registered')
    }
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  /**
   * Register a raw-HTML index transform, the escape hatch for markup no
   * {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
   * registration order after rendering the structured rows.
   * @param transform - pure html-to-html function.
   * @returns the disposer removing the transform.
   */
  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform)
    return () => {
      const at = this.indexTaps.indexOf(transform)
      if (at !== -1) this.indexTaps.splice(at, 1)
    }
  }

  /** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
  async [Service.init](): Promise<void> {
    const configured = this.config.apiToken ?? process.env.DSH_API_TOKEN
    if (this.config.host === '0.0.0.0' && (configured === undefined || configured === '')) {
      // Binding all interfaces without an explicit token would expose an
      // open API to the network — a remote code execution surface. Refuse
      // loudly instead of generating a token nobody legitimate can know.
      throw new Error('webserver: binding 0.0.0.0 requires an explicit apiToken (config apiToken or DSH_API_TOKEN)')
    }
    // Never disable the gate by default: with no configured token, mint a
    // fresh random one for this launch. The browser still authenticates via
    // the SameSite cookie planted below; local processes without the token
    // are rejected instead of being allowed to drive the harness.
    const apiToken = configured !== undefined && configured !== '' ? configured : randomBytes(32).toString('hex')
    this.apiTokenValue = apiToken
    if (this.config.apiOnly !== true) {
      // Browser surfaces plant the SameSite cookie and bearer global on every
      // index response, with a CSP hash admitting exactly that script.
      this.indexCSP = buildIndexCSP(scriptSha256(apiTokenIndexScriptBody(apiToken)))
      this.tapIndex(html => html.replace('<head>', `<head>${apiTokenIndexScript(apiToken)}`))
    }
    // Health probe for local orchestration. Deliberately outside the token
    // gate: a readiness check needs no credential, and on loopback-only
    // binding the response reveals nothing beyond liveness.
    this.register({
      kind: 'exact',
      path: '/api/health',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ status: 'ok' }))
      },
    })
    // One handler factory serves both listeners: the primary takes the
    // configured bind host and apiOnly flag, the fixed API-only listener is
    // always loopback with the API surface only.
    const makeHandle = (bindHost: Config['host'] | '127.0.0.1', apiOnly: boolean) =>
      async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
        requests; the field is only optional on the client-side IncomingMessage type */
        const rawPath = new URL(req.url ?? '/', 'http://x').pathname
        // The rebinding fence guards every request (not just /api): the index
        // page itself carries the token-planting script, so a foreign-Host
        // fetch must not reach it either.
        if (!hostAuthorized(req, bindHost)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'rejected foreign Host header' }))
          return
        }
        if ((rawPath === '/api' || rawPath.startsWith('/api/'))
          && rawPath !== '/api/health'
          && req.method !== 'OPTIONS'
          && !apiTokenAuthorized(req, apiToken)) {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'missing or invalid API token' }))
          return
        }
        if (apiOnly && rawPath !== '/api' && !rawPath.startsWith('/api/')) {
          // API-only service mode: no pages, no SPA fallback — `/` answers a
          // status document and everything else a JSON 404.
          if (rawPath === '/') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ service: 'Planet API', status: 'running' }))
            return
          }
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'not found' }))
          return
        }
        const route = this.match(rawPath)
        if (route !== undefined) {
          await route.handler(req, res)
          return
        }
        const fallback = this.fallback
        if (fallback === undefined) {
          res.writeHead(404)
          res.end()
          return
        }
        await fallback(req, res)
      }
    // Last-resort guard: handle() rejecting would otherwise be an unhandled
    // rejection killing the process on one malformed request (bad %-escape,
    // client dropping mid-body). Per-request failures log and answer 400 —
    // never a process exit.
    const attach = (server: Server, bindHost: Config['host'] | '127.0.0.1', apiOnly: boolean): void => {
      const handle = makeHandle(bindHost, apiOnly)
      server.on('request', (req, res) => {
        handle(req, res).catch((err: unknown) => {
          this.ctx.logger.warn(err instanceof Error ? err : new Error(String(err)))
          if (res.headersSent) {
            res.destroy()
            return
          }
          res.writeHead(400)
          res.end()
        })
      })
      server.on('upgrade', (req, socket, head) => {
        const onError = (error: Error): void => {
          this.ctx.logger.warn(error)
          socket.destroy()
        }
        socket.on('error', onError)
        socket.once('close', () => {
          socket.off('error', onError)
          this.upgradedSockets.delete(socket)
        })
        let route: WebUpgradeRoute | undefined
        try {
          /* v8 ignore next -- node:http always sets url on server requests. */
          const pathname = new URL(req.url ?? '/', 'http://x').pathname
          // The rebinding fence binds upgrades exactly like HTTP requests.
          if (!hostAuthorized(req, bindHost)) {
            rejectUpgradeUnauthorized(socket)
            return
          }
          if (apiOnly && pathname !== '/api' && !pathname.startsWith('/api/')) {
            rejectUpgradeNotFound(socket)
            return
          }
          // The launch-scoped API gate binds upgrade paths exactly like HTTP:
          // an unauthenticated /api WebSocket must not reach protocol handlers.
          // Browser sockets cannot set headers, hence the query-token channel.
          if ((pathname === '/api' || pathname.startsWith('/api/')) && !upgradeApiTokenAuthorized(req, apiToken)) {
            rejectUpgradeUnauthorized(socket)
            return
          }
          route = this.upgrades.get(pathname)
        } catch (error) {
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          socket.destroy()
          return
        }
        if (route === undefined) {
          socket.destroy()
          return
        }
        this.upgradedSockets.add(socket)
        try {
          Promise.resolve(route.handler(req, socket, head)).catch((error: unknown) => {
            this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
            socket.destroy()
          })
        } catch (error) {
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          socket.destroy()
        }
      })
    }
    const listen = (server: Server, port: number, host: string): Promise<number> =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          server.on('error', (err) => { this.ctx.logger.error(err) })
          resolve((server.address() as AddressInfo).port)
        })
      })
    this.server = createServer()
    attach(this.server, this.config.host, this.config.apiOnly === true)
    this.listenedPort = await listen(this.server, this.config.port, this.config.host)
    if (this.config.apiPort !== undefined) {
      // Fixed loopback API-only listener: the desktop app keeps the full UI on
      // the primary port while external web access gets a pure API here.
      this.apiServer = createServer()
      attach(this.apiServer, '127.0.0.1', true)
      await listen(this.apiServer, this.config.apiPort, '127.0.0.1')
    }

    // Node does not include upgraded sockets in closeAllConnections(). The service
    // owns them with the other connections, so it tracks and destroys them explicitly.
    // close() waits for every tracked connection, so the upgraded-socket teardown
    // must start in the same tick as closeAllConnections() or disposal deadlocks.
    this.ctx.effect(() => async () => {
      const servers = [this.server, this.apiServer].filter((server): server is Server => server !== undefined)
      const serversClosed = servers.map(server => new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => { resolve() })
      }))
      const upgradedClosed = [...this.upgradedSockets].map(socket => new Promise<void>((resolve) => {
        socket.once('close', () => { resolve() })
        socket.destroy()
      }))
      await Promise.all([...serversClosed, ...upgradedClosed])
    }, 'webServer.listen')
  }

  /** Longest-prefix-wins over the prefix table after an exact-table miss. */
  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  /**
   * Security headers the index-document owner must attach to every index
   * response: a Content-Security-Policy admitting same-origin scripts and
   * styles, the launch-scoped token cookie script (by content hash), remote
   * and data images (markdown rendering), and loopback WebSockets.
   * @returns header names to values for an index response.
   */
  indexSecurityHeaders(): Record<string, string> {
    return this.indexCSP === undefined ? {} : { 'content-security-policy': this.indexCSP }
  }

  /**
   * Run an index.html body through the registered taps in registration order
   * — called by the fallback owner on every index response it renders.
   * @param html - the raw index.html body.
   * @returns the transformed body.
   */
  applyIndexTaps(html: string): string {
    let out = html
    for (const transform of this.indexTaps) out = transform(out)
    return out
  }

  /**
   * Gather the structured injection table: one `webserver/index-inject` emit,
   * every subscriber pushes its current rows. Fresh per call, so subscribers
   * read live state (module graph, theme preference) at emit time.
   * @returns rows in subscriber activation order.
   */
  collectIndexInjections(): IndexInjection[] {
    const table: IndexInjection[] = []
    this.ctx.emit('webserver/index-inject', table)
    return table
  }

  /**
   * Render one index.html body: the structured injection table first, then
   * the raw `tapIndex` transforms over the result.
   * @param html - the raw index.html body.
   * @returns the transformed body.
   */
  renderIndex(html: string): string {
    return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()))
  }
}

export default WebServer
