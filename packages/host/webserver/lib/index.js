import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
//#region lib/types/injections.js
/**
* Structured index injections: the typed rows plugins contribute to the boot
* HTML instead of raw `tapIndex` string transforms. Rows are pure
* JSON-serializable data because one table feeds two renderers: the served
* form renders rows into the index.html text ({@link renderIndexInjections}),
* and a static worker deployment ships the same rows over its boot payload
* for a page-side interpreter. Anything not expressible as a row stays on
* `tapIndex`, which runs after row rendering.
*/
/** Escape a row value before placing it in a quoted HTML attribute. */
function escapeHtmlAttribute(value) {
	return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function assertNever(row) {
	throw new Error(`webserver: unknown index injection row ${JSON.stringify(row)}`);
}
/** Render one row to markup with its placement. */
function renderRow(row) {
	switch (row.kind) {
		case "global": return {
			placement: "head",
			markup: `<script>globalThis[${JSON.stringify(row.name).replaceAll("<", "\\u003c")}] = ${row.value === void 0 ? "undefined" : JSON.stringify(row.value).replaceAll("<", "\\u003c")}<\/script>`
		};
		case "script": return {
			placement: row.placement,
			markup: `<script>${row.text}<\/script>`
		};
		case "script-src": return {
			placement: row.placement,
			markup: `<script src="${escapeHtmlAttribute(row.src)}"><\/script>`
		};
		case "script-preload": return {
			placement: "head",
			markup: `<link rel="preload" as="script" href="${escapeHtmlAttribute(row.src)}">`
		};
		case "style": return {
			placement: "head",
			markup: `<style>${row.text}</style>`
		};
		case "html": return {
			placement: row.placement,
			markup: row.html
		};
		default: return assertNever(row);
	}
}
/** Insert `markup` into `html` at `at`. */
function splice(html, at, markup) {
	return `${html.slice(0, at)}${markup}${html.slice(at)}`;
}
/**
* Render rows into an index.html body: head rows immediately after the
* opening head tag, body rows immediately after the opening body tag, each
* group in table order.
* @param html - the raw index.html body.
* @param rows - the collected injection table.
* @returns the html with every row rendered.
*/
function renderIndexInjections(html, rows) {
	let head = "";
	let body = "";
	for (const row of rows) {
		const rendered = renderRow(row);
		if (rendered.placement === "head") head += rendered.markup;
		else body += rendered.markup;
	}
	let out = html;
	if (head !== "") {
		const open = /<head(?:\s[^>]*)?>/i.exec(out);
		out = open === null ? `${head}${out}` : splice(out, open.index + open[0].length, head);
	}
	if (body !== "") {
		const open = /<body(?:\s[^>]*)?>/i.exec(out);
		out = open === null ? `${out}${body}` : splice(out, open.index + open[0].length, body);
	}
	return out;
}
//#endregion
//#region lib/types/index.js
/**
* @deepseek-ai/dsh-host-webserver — Web route-registration plugin: a node:http
* server plus the `webServer` service (HTTP and upgrade route registries, the
* structured index injection table with raw transform taps behind it, and the
* single fallback seat for everything no route claims). Knows no harness concepts and serves no files; the composing
* application's frontend plugin owns dist serving through the fallback hook.
* Web shape only — Electron loads dist over file:// and carries fetch over an
* IPC bridge. This package never prints: the URL line belongs to the shell.
*/
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
function apiTokenMatches(provided, expected) {
	if (provided === void 0 || provided === "") return false;
	const hash = (value) => createHash("sha256").update(value).digest();
	return timingSafeEqual(hash(provided), hash(expected));
}
function bearerToken(req) {
	const header = req.headers.authorization;
	if (typeof header !== "string" || !header.startsWith("Bearer ")) return void 0;
	return header.slice(7);
}
function cookieToken(req) {
	const header = req.headers.cookie;
	if (typeof header !== "string") return void 0;
	return header.split(";").map((part) => part.trim()).find((part) => part.startsWith("dsh_api_token="))?.slice(14);
}
/** Cookie-planting script body for the index tap; base64url characters only.
*  HttpOnly keeps the token out of page JS — the SPA never reads it, the
*  browser attaches it to same-origin requests automatically, and a DNS
*  rebinding page cannot exfiltrate it. */
function apiTokenCookieScript(token) {
	return `document.cookie='dsh_api_token=${token};Path=/;SameSite=Strict;HttpOnly'`;
}
/**
* Body of the token injection script: cookie plant plus the bearer global.
* The bearer global is the primary channel — an embedded networking process
* does not reliably attach document.cookie-planted cookies to fetch/SSE — and
* the client sends it as an `Authorization: Bearer` header on every /api call.
*/
function apiTokenIndexScriptBody(token) {
	return `${apiTokenCookieScript(token)}\nwindow.__DSH_API_TOKEN__=${JSON.stringify(token)}`;
}
/** Wrapped token injection script for the index tap. */
function apiTokenIndexScript(token) {
	return `<script>${apiTokenIndexScriptBody(token)}<\/script>`;
}
/** SHA-256 of an inline script body, base64-encoded for a CSP 'sha256-…' source. */
function scriptSha256(script) {
	return createHash("sha256").update(script).digest("base64");
}
/**
* Content-Security-Policy for index documents: same-origin resources only,
* the launch-scoped token cookie script admitted by its content hash (never
* 'unsafe-inline'), inline styles (React), and loopback WebSockets.
* 'unsafe-eval' is required by the app architecture: the client-runner
* evaluates dynamic client-plugin bundles in the browser. An absent token
* emits no script hash entry.
*/
function buildIndexCSP(tokenScriptHash) {
	return [
		"default-src 'self'",
		`script-src 'self' 'unsafe-eval'${tokenScriptHash === void 0 ? "" : ` 'sha256-${tokenScriptHash}'`}`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https:",
		"font-src 'self' data:",
		"connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* http://127.0.0.1:*",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"base-uri 'none'"
	].join("; ");
}
/**
* Whether one request passes the launch-scoped API gate: matching bearer or
* SameSite cookie when a token is configured; otherwise always.
*/
function apiTokenAuthorized(req, apiToken) {
	if (apiToken === void 0 || apiToken === "") return true;
	return apiTokenMatches(bearerToken(req) ?? cookieToken(req), apiToken);
}
/**
* Whether an upgrade request passes the launch-scoped API gate. Browser
* WebSockets cannot set request headers, so besides the bearer/cookie
* channels the token may ride the `?token=` query parameter. The index page
* already exposes the token to same-origin JS, and the loopback-only fence
* bounds the surface, so this adds no new exposure for handshakes.
*/
function upgradeApiTokenAuthorized(req, apiToken) {
	if (apiToken === void 0 || apiToken === "") return true;
	if (apiTokenAuthorized(req, apiToken)) return true;
	const queryToken = new URL(req.url ?? "/", "http://x").searchParams.get("token");
	return queryToken !== null && apiTokenMatches(queryToken, apiToken);
}
/**
* Whether an index-document request may receive the token-planting script:
* the regular bearer/cookie channels, plus the same `?token=` bootstrap
* query the upgrade path accepts for a header-less first load. All-interfaces
* binding is the reason this channel exists at the index: the explicit token
* that binding requires protects nothing if every unauthenticated page fetch
* is also handed the token in the HTML, and a remote GET of `/` is
* indistinguishable from the legitimate browser's first load.
*/
function indexTokenAuthorized(req, apiToken) {
	return upgradeApiTokenAuthorized(req, apiToken);
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
function hostAuthorized(req, host) {
	const value = req.headers.host;
	if (typeof value !== "string" || value === "") return false;
	if (host === "0.0.0.0") return true;
	try {
		const hostname = new URL(`http://${value}`).hostname;
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
	} catch {
		/* v8 ignore next -- a malformed Host is rejected below, not re-thrown. */
		return false;
	}
}
/** Reject an upgrade attempt on the raw socket with a plain HTTP 401. */
function rejectUpgradeUnauthorized(socket) {
	socket.end([
		"HTTP/1.1 401 Unauthorized",
		"Content-Type: application/json; charset=utf-8",
		"Connection: close",
		"",
		"{\"error\":\"missing or invalid API token\"}",
		""
	].join("\r\n"));
}
/** Reject a non-API upgrade on an API-only listener before route dispatch. */
function rejectUpgradeNotFound(socket) {
	socket.end([
		"HTTP/1.1 404 Not Found",
		"Content-Type: application/json; charset=utf-8",
		"Connection: close",
		"",
		"{\"error\":\"not found\"}",
		""
	].join("\r\n"));
}
/**
* The browser HTTP carrier service. Activation listens immediately. Route
* registration order does not affect requests because configured named routes
* must be distinct, and the fallback handler answers anything not yet claimed
* during startup with 404 until its owner registers. A listen failure rejects
* initialization, and the boot process reports the failed fiber.
*/
var WebServer = class extends Service {
	config;
	static Config = z.object({
		host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
		port: z.natural().max(65535).required(),
		apiToken: z.string(),
		apiOnly: z.boolean(),
		apiPort: z.natural().min(1).max(65535)
	});
	exact = /* @__PURE__ */ new Map();
	prefixes = /* @__PURE__ */ new Map();
	upgrades = /* @__PURE__ */ new Map();
	upgradedSockets = /* @__PURE__ */ new Set();
	indexTaps = [];
	fallback;
	server;
	apiServer;
	listenedPort;
	indexCSP;
	apiTokenValue;
	constructor(ctx, config) {
		super(ctx, "webServer");
		this.config = config;
	}
	/** The listening port (the OS-assigned value when config.port is 0). */
	get port() {
		return this.listenedPort;
	}
	/** The configured bind host (the loopback or all-interfaces literal). */
	get host() {
		return this.config.host;
	}
	/** The effective launch-scoped API token (configured, environment, or generated). */
	get apiToken() {
		return this.apiTokenValue;
	}
	/**
	* Register a named route. Duplicate (kind, path) throws — route patterns are
	* a composition-level contract, so a collision is a misconfiguration.
	* @param route - kind, path, and the owning handler.
	* @returns the disposer removing the route.
	*/
	register(route) {
		const table = route.kind === "exact" ? this.exact : this.prefixes;
		if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
		table.set(route.path, route);
		return () => {
			table.delete(route.path);
		};
	}
	/**
	* Register an exact-path HTTP upgrade route. Duplicate paths throw because
	* one socket can have only one protocol owner.
	* @param route - pathname and handler owning negotiation plus socket use.
	* @returns the disposer removing the route.
	*/
	registerUpgrade(route) {
		if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
		this.upgrades.set(route.path, route);
		return () => {
			this.upgrades.delete(route.path);
		};
	}
	/**
	* Claim the fallback seat: the handler answering every request no named
	* route matches (the SPA dist server in the shipped Web composition). One
	* owner only — a second registration throws, because two fallbacks cannot
	* compose.
	* @param handler - owns the full response lifecycle of unmatched requests.
	* @returns the disposer releasing the seat.
	*/
	registerFallback(handler) {
		if (this.fallback !== void 0) throw new Error("webserver: fallback already registered");
		this.fallback = handler;
		return () => {
			this.fallback = void 0;
		};
	}
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
	tapIndex(transform) {
		this.indexTaps.push(transform);
		return () => {
			const at = this.indexTaps.indexOf(transform);
			if (at !== -1) this.indexTaps.splice(at, 1);
		};
	}
	/** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
	async [Service.init]() {
		const configured = this.config.apiToken ?? process.env.DSH_API_TOKEN;
		if (this.config.host === "0.0.0.0" && (configured === void 0 || configured === "")) throw new Error("webserver: binding 0.0.0.0 requires an explicit apiToken (config apiToken or DSH_API_TOKEN)");
		const apiToken = configured !== void 0 && configured !== "" ? configured : randomBytes(32).toString("hex");
		this.apiTokenValue = apiToken;
		if (this.config.apiOnly !== true) {
			this.indexCSP = buildIndexCSP(scriptSha256(apiTokenIndexScriptBody(apiToken)));
			this.tapIndex((html, req) => {
				if (this.config.host === "0.0.0.0" && (req === void 0 || !indexTokenAuthorized(req, apiToken))) return html;
				return html.replace("<head>", `<head>${apiTokenIndexScript(apiToken)}`);
			});
		}
		this.register({
			kind: "exact",
			path: "/api/health",
			handler: (_req, res) => {
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ status: "ok" }));
			}
		});
		const makeHandle = (bindHost, apiOnly) => async (req, res) => {
			/* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
			requests; the field is only optional on the client-side IncomingMessage type */
			const rawPath = new URL(req.url ?? "/", "http://x").pathname;
			if (!hostAuthorized(req, bindHost)) {
				res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "rejected foreign Host header" }));
				return;
			}
			if ((rawPath === "/api" || rawPath.startsWith("/api/")) && rawPath !== "/api/health" && req.method !== "OPTIONS" && !apiTokenAuthorized(req, apiToken)) {
				res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "missing or invalid API token" }));
				return;
			}
			if (apiOnly && rawPath !== "/api" && !rawPath.startsWith("/api/")) {
				if (rawPath === "/") {
					res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						service: "Planet API",
						status: "running"
					}));
					return;
				}
				res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "not found" }));
				return;
			}
			const route = this.match(rawPath);
			if (route !== void 0) {
				await route.handler(req, res);
				return;
			}
			const fallback = this.fallback;
			if (fallback === void 0) {
				res.writeHead(404);
				res.end();
				return;
			}
			await fallback(req, res);
		};
		const attach = (server, bindHost, apiOnly) => {
			const handle = makeHandle(bindHost, apiOnly);
			server.on("request", (req, res) => {
				handle(req, res).catch((err) => {
					this.ctx.logger.warn(err instanceof Error ? err : new Error(String(err)));
					if (res.headersSent) {
						res.destroy();
						return;
					}
					res.writeHead(400);
					res.end();
				});
			});
			server.on("upgrade", (req, socket, head) => {
				const onError = (error) => {
					this.ctx.logger.warn(error);
					socket.destroy();
				};
				socket.on("error", onError);
				socket.once("close", () => {
					socket.off("error", onError);
					this.upgradedSockets.delete(socket);
				});
				let route;
				try {
					/* v8 ignore next -- node:http always sets url on server requests. */
					const pathname = new URL(req.url ?? "/", "http://x").pathname;
					if (!hostAuthorized(req, bindHost)) {
						rejectUpgradeUnauthorized(socket);
						return;
					}
					if (apiOnly && pathname !== "/api" && !pathname.startsWith("/api/")) {
						rejectUpgradeNotFound(socket);
						return;
					}
					if ((pathname === "/api" || pathname.startsWith("/api/")) && !upgradeApiTokenAuthorized(req, apiToken)) {
						rejectUpgradeUnauthorized(socket);
						return;
					}
					route = this.upgrades.get(pathname);
				} catch (error) {
					this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
					socket.destroy();
					return;
				}
				if (route === void 0) {
					socket.destroy();
					return;
				}
				this.upgradedSockets.add(socket);
				try {
					Promise.resolve(route.handler(req, socket, head)).catch((error) => {
						this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
						socket.destroy();
					});
				} catch (error) {
					this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
					socket.destroy();
				}
			});
		};
		const listen = (server, port, host) => new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, host, () => {
				server.off("error", reject);
				server.on("error", (err) => {
					this.ctx.logger.error(err);
				});
				resolve(server.address().port);
			});
		});
		this.server = createServer();
		attach(this.server, this.config.host, this.config.apiOnly === true);
		this.listenedPort = await listen(this.server, this.config.port, this.config.host);
		if (this.config.apiPort !== void 0) {
			this.apiServer = createServer();
			attach(this.apiServer, "127.0.0.1", true);
			await listen(this.apiServer, this.config.apiPort, "127.0.0.1");
		}
		this.ctx.effect(() => async () => {
			const serversClosed = [this.server, this.apiServer].filter((server) => server !== void 0).map((server) => new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => {
					resolve();
				});
			}));
			const upgradedClosed = [...this.upgradedSockets].map((socket) => new Promise((resolve) => {
				socket.once("close", () => {
					resolve();
				});
				socket.destroy();
			}));
			await Promise.all([...serversClosed, ...upgradedClosed]);
		}, "webServer.listen");
	}
	/** Longest-prefix-wins over the prefix table after an exact-table miss. */
	match(pathname) {
		const exact = this.exact.get(pathname);
		if (exact !== void 0) return exact;
		let best;
		for (const [prefix, route] of this.prefixes) {
			if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
			if (best === void 0 || prefix.length > best.path.length) best = route;
		}
		return best;
	}
	/**
	* Security headers the index-document owner must attach to every index
	* response: a Content-Security-Policy admitting same-origin scripts and
	* styles, the launch-scoped token cookie script (by content hash), remote
	* and data images (markdown rendering), and loopback WebSockets.
	* @returns header names to values for an index response.
	*/
	indexSecurityHeaders() {
		return this.indexCSP === void 0 ? {} : { "content-security-policy": this.indexCSP };
	}
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
	applyIndexTaps(html, req) {
		let out = html;
		for (const transform of this.indexTaps) out = transform(out, req);
		return out;
	}
	/**
	* Gather the structured injection table: one `webserver/index-inject` emit,
	* every subscriber pushes its current rows. Fresh per call, so subscribers
	* read live state (module graph, theme preference) at emit time.
	* @returns rows in subscriber activation order.
	*/
	collectIndexInjections() {
		const table = [];
		this.ctx.emit("webserver/index-inject", table);
		return table;
	}
	/**
	* Render one index.html body: the structured injection table first, then
	* the raw `tapIndex` transforms over the result.
	* @param html - the raw index.html body.
	* @param req - the request the index response answers, when available.
	* @returns the transformed body.
	*/
	renderIndex(html, req) {
		return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()), req);
	}
};
//#endregion
export { WebServer, WebServer as default, renderIndexInjections };
