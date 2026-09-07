/**
 * @deepseek-ai/dsh-host-webserver — Web route-registration plugin: a node:http
 * server plus the `webServer` service (HTTP and upgrade route registries, the
 * structured index injection table with raw transform taps behind it, and the
 * single fallback seat for everything no route claims). Knows no harness concepts and serves no files; the composing
 * application's frontend plugin owns dist serving through the fallback hook.
 * Web shape only — Electron loads dist over file:// and carries fetch over an
 * IPC bridge. This package never prints: the URL line belongs to the shell.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type IndexInjection } from './injections.ts';
export { renderIndexInjections } from './injections.ts';
export type { IndexInjection, IndexInjectionPlacement } from './injections.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        webServer: WebServer;
    }
    interface Events {
        /**
         * Collect the structured index injection table. Emitted on every index
         * render and every worker boot-payload request; listeners push their
         * current rows, so a row's data is read fresh at emit time.
         * @param table - Mutable row table; listeners append in activation order.
         * @mode emit
         */
        'webserver/index-inject'(table: IndexInjection[]): void;
    }
}
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix';
/** One named route registration. */
export interface WebRoute {
    kind: WebRouteKind;
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns protocol negotiation and the upgraded socket after dispatch. */
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
/** Gateway config: the listen address and the launch-scoped API token. */
export interface Config {
    /** Listen host; the two supported values are loopback and all-interfaces. */
    host: '127.0.0.1' | '0.0.0.0';
    /** Listen port; zero requests an OS-assigned port. */
    port: number;
    /**
     * Launch-scoped API token. Absent, the `DSH_API_TOKEN` environment
     * variable is consulted; when neither is set, a fresh random token is
     * generated per launch (the gate is never disabled by default). Binding
     * `0.0.0.0` requires this field or the environment variable to be set
     * explicitly.
     */
    apiToken?: string;
    /**
     * API-only service mode: the gateway serves JSON only — `/` answers a
     * status document, every other non-API path a JSON 404, and the SPA
     * fallback seat is unreachable. Non-API upgrade requests are rejected
     * before route dispatch; all `/api/*` HTTP and upgrade routes are untouched.
     */
    apiOnly?: boolean;
    /**
     * Fixed loopback API-only listener. When set, a second server answers on
     * `127.0.0.1:apiPort` with the API surface only: `/` is the status
     * document, non-API paths JSON 404, and the SPA fallback seat is
     * unreachable; non-API upgrades are rejected before route dispatch. The
     * primary listener keeps serving the UI (unless
     * `apiOnly` is set), so a desktop app can hold the full interface while
     * external web access gets a pure API on the stable port.
     */
    apiPort?: number;
}
/**
 * The browser HTTP carrier service. Activation listens immediately. Route
 * registration order does not affect requests because configured named routes
 * must be distinct, and the fallback handler answers anything not yet claimed
 * during startup with 404 until its owner registers. A listen failure rejects
 * initialization, and the boot process reports the failed fiber.
 */
export declare class WebServer extends Service {
    private config;
    static Config: z<Config>;
    private readonly exact;
    private readonly prefixes;
    private readonly upgrades;
    private readonly upgradedSockets;
    private readonly indexTaps;
    private fallback;
    private server;
    private apiServer;
    private listenedPort;
    private indexCSP;
    private apiTokenValue;
    constructor(ctx: Context, config: Config);
    /** The listening port (the OS-assigned value when config.port is 0). */
    get port(): number;
    /** The configured bind host (the loopback or all-interfaces literal). */
    get host(): Config['host'];
    /** The effective launch-scoped API token (configured, environment, or generated). */
    get apiToken(): string;
    /**
     * Register a named route. Duplicate (kind, path) throws — route patterns are
     * a composition-level contract, so a collision is a misconfiguration.
     * @param route - kind, path, and the owning handler.
     * @returns the disposer removing the route.
     */
    register(route: WebRoute): () => void;
    /**
     * Register an exact-path HTTP upgrade route. Duplicate paths throw because
     * one socket can have only one protocol owner.
     * @param route - pathname and handler owning negotiation plus socket use.
     * @returns the disposer removing the route.
     */
    registerUpgrade(route: WebUpgradeRoute): () => void;
    /**
     * Claim the fallback seat: the handler answering every request no named
     * route matches (the SPA dist server in the shipped Web composition). One
     * owner only — a second registration throws, because two fallbacks cannot
     * compose.
     * @param handler - owns the full response lifecycle of unmatched requests.
     * @returns the disposer releasing the seat.
     */
    registerFallback(handler: WebRoute['handler']): () => void;
    /**
     * Register a raw-HTML index transform, the escape hatch for markup no
     * {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
     * registration order after rendering the structured rows.
     * @param transform - pure html-to-html function.
     * @returns the disposer removing the transform.
     */
    tapIndex(transform: (html: string) => string): () => void;
    /** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
    [Service.init](): Promise<void>;
    /** Longest-prefix-wins over the prefix table after an exact-table miss. */
    private match;
    /**
     * Security headers the index-document owner must attach to every index
     * response: a Content-Security-Policy admitting same-origin scripts and
     * styles, the launch-scoped token cookie script (by content hash), remote
     * and data images (markdown rendering), and loopback WebSockets.
     * @returns header names to values for an index response.
     */
    indexSecurityHeaders(): Record<string, string>;
    /**
     * Run an index.html body through the registered taps in registration order
     * — called by the fallback owner on every index response it renders.
     * @param html - the raw index.html body.
     * @returns the transformed body.
     */
    applyIndexTaps(html: string): string;
    /**
     * Gather the structured injection table: one `webserver/index-inject` emit,
     * every subscriber pushes its current rows. Fresh per call, so subscribers
     * read live state (module graph, theme preference) at emit time.
     * @returns rows in subscriber activation order.
     */
    collectIndexInjections(): IndexInjection[];
    /**
     * Render one index.html body: the structured injection table first, then
     * the raw `tapIndex` transforms over the result.
     * @param html - the raw index.html body.
     * @returns the transformed body.
     */
    renderIndex(html: string): string;
}
export default WebServer;
//# sourceMappingURL=index.d.ts.map