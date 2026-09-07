import z from "@deepseek-ai/schemastery";
import { Service } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
//#region lib/types/api-path.js
/**
* The /api URL prefix — single source for both halves of the web transport.
* The node half registers this prefix on the web server; both halves share the
* event paths below for the browser WebSocket downlinks.
*/
/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
const API_PATH = "/api";
/** Native mux-frame WebSocket pathname. */
const MUX_EVENTS_PATH = `${API_PATH}/events/mux`;
/** Native host-frame WebSocket pathname. */
const HOST_EVENTS_PATH = `${API_PATH}/events/host`;
/** Native response pathname for server-initiated approval and question frames. */
const RESPOND_PATH = `${API_PATH}/respond`;
//#endregion
//#region lib/types/http-bridge.js
/**
* node:http ↔ WHATWG fetch bridge for the /api transport (host side of the
* web carrier; the fetch-shaped handler itself is transport-agnostic).
*/
/** Default carrier cap for all HTTP RPC bodies: sized for the default
* aggregate image limit (200 MiB) after base64 expansion plus envelope
* headroom (~267.7 MiB required), rounded up for slack. The bridge buffers
* each body in memory, so this cap is also the per-request resident bound. */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024;
/**
* Bridge one node:http request to the fetch-shaped handler (client close
* aborts; SSE bodies stream out chunk by chunk).
* @param req - incoming node:http request (fully read before dispatch).
* @param res - node:http response the bridge writes and owns to completion.
* @param apiHandler - fetch-shaped API carrier the request is dispatched to.
* @param maxRequestBodyBytes - maximum body bytes buffered before dispatch.
*/
async function bridge(req, res, apiHandler, maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES) {
	const abort = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) abort.abort();
	});
	const declaredLength = req.headers["content-length"];
	if (declaredLength !== void 0 && Number(declaredLength) > maxRequestBodyBytes) {
		res.writeHead(413, { connection: "close" });
		res.end();
		req.destroy();
		return;
	}
	const chunks = [];
	let received = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		received += buffer.byteLength;
		if (received > maxRequestBodyBytes) {
			res.writeHead(413, { connection: "close" });
			res.end();
			req.destroy();
			return;
		}
		chunks.push(buffer);
	}
	/* v8 ignore next 3 -- `??` arms: node:http always sets url/method on server
	requests; the fields are only optional on the client-side IncomingMessage type */
	const request = new Request(new URL(req.url ?? "/", "http://dsh.internal"), {
		method: req.method ?? "GET",
		headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")),
		...chunks.length > 0 ? { body: Buffer.concat(chunks) } : {},
		signal: abort.signal
	});
	const response = await apiHandler.fetch(request);
	res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
	if (response.body === null) {
		res.end();
		return;
	}
	for await (const chunk of response.body) if (!res.write(chunk)) await new Promise((resolve) => {
		const done = () => {
			res.off("drain", done);
			res.off("close", done);
			resolve();
		};
		res.once("drain", done);
		res.once("close", done);
	});
	res.end();
}
//#endregion
//#region lib/types/loopback-hostname.js
/**
* Browser-safe, zero-dependency loopback classification shared by the `/api`
* Host fence and the package's `ctx.connection` state. The predicate stays
* package-internal; client plugins consume the derived state through Cordis.
*/
/**
* Whether a normalized URL hostname names the local loopback authority.
* @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
* @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
*/
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
//#endregion
//#region lib/types/api-request-trust.js
/**
* Browser-trust fence for every /api request. Defends the two confused-deputy
* paths a browser opens against a local HTTP API — DNS rebinding (Host names
* the attacker's domain while the socket reaches this server) and cross-site
* requests fired from a malicious page. The Host fence binds every request,
* browser-looking or not: over plain HTTP a browser attaches neither Origin
* nor Fetch-Metadata to reads (images and navigations — those
* headers go only to trustworthy destinations), so an unmarked request may
* still be a rebound browser read and Host is the one header rebinding cannot
* forge. Non-browser and remote clients pass the same fence via loopback,
* deployment-derived LAN IP literals, or a declared `trustedHosts` authority.
* Network reachability and authentication stay out of scope: binding policy
* belongs to the webserver config, and this fence is not an auth layer.
*/
function header(headers, name) {
	if (headers instanceof Headers) return headers.get(name) ?? void 0;
	const value = headers[name];
	return typeof value === "string" ? value : void 0;
}
/** Normalized URL of a Host-header authority (hostname lowercased, default port stripped, IPv6 bracketed), or undefined when unparsable. */
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return;
	}
}
/**
* Assert one configured `trustedHosts` entry is a bare authority (`host` or
* `host:port`) in canonical form: it must survive WHATWG parsing unchanged
* (case aside). Anything parsing would silently rewrite is refused as a typo
* that must fail the load loudly instead of being ignored until requests 403
* or quietly changing the grant: URL parts beyond the authority
* (`harness.internal/path`, `user@harness.internal` — which would authorize
* the embedded hostname), stripped whitespace, a dangling colon or
* zero-padded port (which would broaden an intended exact-port grant to every
* port), and non-canonical host spellings (`0x7f.0.0.1`, percent-encoding,
* unbracketed IPv6; IDN hosts are declared in punycode, the form the wire
* carries).
* @param entry - the configured value, verbatim.
*/
function assertTrustedAuthority(entry) {
	const entryUrl = parseAuthority(entry);
	if (entryUrl !== void 0 && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return;
	throw new Error(`host-connection: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`);
}
/**
* Canonical form of a parsed authority: `hostname` when no port was written,
* else `hostname:port`. The port is judged from URL parses under both special
* schemes (their default ports differ, so `:80` and `:443` still count as
* explicit), never from the raw string, where WHATWG trimming would misread
* shapes like `host:port ` as port-less.
*/
function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
/**
* Whether the request authority matches a `trustedHosts` entry. An entry with
* an explicit port matches that exact authority; a port-less entry matches the
* hostname on any port (the shape the CLI derives for IP-literal LAN serving,
* where the bound port may be OS-assigned). Both sides compare through WHATWG
* normalization, so case and a redundant `:80` never decide trust.
*/
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		const entryUrl = parseAuthority(entry);
		if (entryUrl === void 0) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
	});
}
/**
* Decide whether one /api request may reach the RPC bridge.
* @param request - Node HTTP or Fetch request facts (headers).
* @param trustedHosts - non-loopback authorities this deployment serves: exact `host:port`, or port-less `host` matching any port.
* @returns true when the Host is ours (loopback or trusted) and any attached browser markers are same-origin.
*/
function isTrustedApiRequest(request, trustedHosts) {
	const host = header(request.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
//#endregion
//#region lib/types/rpc-host.js
/** Host registry and HTTP adapter for generic Connection RPC channels. */
const INVALID_REQUEST_RPC_ID = "invalid-request";
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/** Host Connection service whose channel registrations belong to the caller fiber. */
var HostConnectionService = class extends Service {
	trustedHosts;
	interceptors = /* @__PURE__ */ new Map();
	eventSources = /* @__PURE__ */ new Map();
	downloadHandlers = /* @__PURE__ */ new Map();
	responseHandler;
	/**
	* Provide the Host half over the active HTTP server.
	* @param ctx - owning Connection plugin context.
	* @param trustedHosts - deployment authorities accepted by trusted-host channels.
	*/
	constructor(ctx, trustedHosts) {
		super(ctx, "connection");
		this.trustedHosts = trustedHosts;
	}
	/** Generic channel registry scoped to the Context reading this service. */
	get rpc() {
		const owner = this.ctx;
		return {
			handle: (channel, handler, options) => this.register(owner, channel, handler, options),
			intercept: (channel, matches, handler, options) => this.registerInterceptor(owner, channel, matches, handler, options)
		};
	}
	/** Event producers are scoped to the registering Context. */
	get events() {
		const owner = this.ctx;
		return { handle: (channel, source) => this.registerEventSource(owner, channel, source) };
	}
	/** Exact response carrier registration scoped to the registering Context. */
	get responses() {
		const owner = this.ctx;
		return { handle: (handler) => this.registerResponseHandler(owner, handler) };
	}
	/** Exact download registrations are scoped to the registering Context. */
	get downloads() {
		const owner = this.ctx;
		return { handle: (path, handler, options) => this.registerDownloadHandler(owner, path, handler, options) };
	}
	/**
	* Open the current authoritative source for one accepted socket generation.
	* @param channel - independent mux or host downlink.
	* @param signal - socket-generation cancellation.
	* @returns the source's validated frames until cancellation or disposal.
	*/
	async *openEventStream(channel, signal) {
		const registration = this.eventSources.get(channel);
		if (registration === void 0) throw new Error(`host-connection: no ${channel} event source is registered`);
		const lifetime = new AbortController();
		const abort = () => {
			lifetime.abort(signal.reason);
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		registration.active.add(lifetime);
		try {
			for await (const frame of registration.source(lifetime.signal)) yield frame;
		} finally {
			signal.removeEventListener("abort", abort);
			registration.active.delete(lifetime);
			lifetime.abort();
		}
	}
	/**
	* Compose the shared-channel Fetch handler from its registered interceptor.
	* @param channel - shared channel mounted by Connection.
	* @returns Fetch handler that fails closed for every unclaimed endpoint.
	*/
	createSharedFetchHandler(channel) {
		return { fetch: (request) => {
			const pathname = new URL(request.url).pathname;
			if (pathname === RESPOND_PATH) {
				const registration = this.responseHandler;
				if (registration === void 0) return Promise.resolve(new Response("not found", { status: 404 }));
				if (!isTrustedApiRequest(request, [])) return Promise.resolve(new Response("forbidden", { status: 403 }));
				return responseFetch(request, registration);
			}
			const download = this.downloadHandlers.get(pathname);
			if (download !== void 0) {
				if (download.options.authority === "loopback" && !isTrustedApiRequest(request, [])) return Promise.resolve(new Response("forbidden", { status: 403 }));
				return downloadFetch(request, download);
			}
			const endpoint = endpointFromPath(channel, pathname);
			const interceptor = this.interceptors.get(channel);
			if (endpoint === void 0 || interceptor === void 0 || !interceptor.matches(endpoint)) return Promise.resolve(new Response("not found", { status: 404 }));
			if (interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, [])) return Promise.resolve(new Response("forbidden", { status: 403 }));
			return interceptor.fetchHandler.fetch(request);
		} };
	}
	registerEventSource(owner, channel, source) {
		const registration = {
			source,
			active: /* @__PURE__ */ new Set()
		};
		return owner.effect(() => {
			if (this.eventSources.has(channel)) throw new Error(`host-connection: ${channel} event source is already registered`);
			this.eventSources.set(channel, registration);
			return () => {
				if (this.eventSources.get(channel) === registration) this.eventSources.delete(channel);
				for (const lifetime of registration.active) lifetime.abort(/* @__PURE__ */ new Error(`host-connection: ${channel} event source was disposed`));
				registration.active.clear();
			};
		}, `host-connection: ${channel} event source`);
	}
	registerResponseHandler(owner, handler) {
		const registration = {
			handler,
			active: /* @__PURE__ */ new Set()
		};
		return owner.effect(() => {
			if (this.responseHandler !== void 0) throw new Error("host-connection: /api/respond handler is already registered");
			this.responseHandler = registration;
			return () => {
				if (this.responseHandler === registration) this.responseHandler = void 0;
				for (const lifetime of [...registration.active]) lifetime.abort(/* @__PURE__ */ new Error("host-connection: /api/respond handler was disposed"));
				registration.active.clear();
			};
		}, "host-connection: /api/respond handler");
	}
	registerDownloadHandler(owner, path, handler, options) {
		assertDownloadPath(path);
		const registration = {
			handler,
			options,
			active: /* @__PURE__ */ new Set()
		};
		const dispose = owner.effect(() => {
			if (this.downloadHandlers.has(path)) throw new Error(`host-connection: download path ${JSON.stringify(path)} is already registered`);
			this.downloadHandlers.set(path, registration);
			let disposal;
			return () => {
				if (disposal !== void 0) return disposal;
				if (this.downloadHandlers.get(path) === registration) this.downloadHandlers.delete(path);
				const reason = /* @__PURE__ */ new Error(`host-connection: download path ${JSON.stringify(path)} was disposed`);
				disposal = Promise.all([...registration.active].map((lifetime) => lifetime.abort(reason))).then(() => void 0);
				return disposal;
			};
		}, `host-connection: ${path} download`);
		let result;
		return () => {
			if (result !== void 0) return result;
			try {
				result = Promise.resolve(dispose());
			} catch (error) {
				result = Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
			return result;
		};
	}
	register(owner, channel, handler, options) {
		assertChannel(channel);
		const trustedHosts = options.authority === "loopback" ? [] : this.trustedHosts;
		const fetchHandler = rpcFetchHandler(channel, handler);
		const route = {
			kind: "prefix",
			path: channel,
			handler: async (req, res) => {
				if (!isTrustedApiRequest(req, trustedHosts)) {
					res.writeHead(403);
					res.end("forbidden");
					return;
				}
				await bridge(req, res, fetchHandler);
			}
		};
		return owner.effect(() => owner.webServer.register(route), `host-connection: ${channel} rpc channel`);
	}
	registerInterceptor(owner, channel, matches, handler, options) {
		if (channel !== "/api") throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`);
		const interceptor = {
			matches,
			fetchHandler: rpcFetchHandler(channel, handler),
			options
		};
		return owner.effect(() => {
			if (this.interceptors.has(channel)) throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`);
			this.interceptors.set(channel, interceptor);
			return () => {
				this.interceptors.delete(channel);
			};
		}, `host-connection: ${channel} rpc interceptor`);
	}
};
async function downloadFetch(request, registration) {
	const lifetime = createDownloadLifetime(request, registration.active);
	try {
		const response = await registration.handler(request, lifetime.signal);
		if (lifetime.signal.aborted) {
			await cancelBody(response.body, lifetime.signal.reason);
			lifetime.finish();
			return new Response("request cancelled", { status: 499 });
		}
		return await streamDownloadResponse(request, response, lifetime);
	} catch (error) {
		const cancelled = lifetime.signal.aborted && error === lifetime.signal.reason;
		if (cancelled) lifetime.finish(error);
		else lifetime.fail(error);
		if (cancelled) return new Response("request cancelled", { status: 499 });
		return new Response(`handler failure: ${String(error)}`, { status: 500 });
	}
}
async function responseFetch(request, registration) {
	if (request.method !== "POST") return new Response("not found", { status: 404 });
	if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return new Response("content type must be application/json", { status: 415 });
	return withRequestLifetime(request, registration.active, async (signal) => {
		try {
			let body;
			try {
				body = await request.json();
			} catch {
				return new Response("body is not JSON", { status: 400 });
			}
			signal.throwIfAborted();
			const receipt = await registration.handler(body, signal);
			signal.throwIfAborted();
			return Response.json(receipt);
		} catch (error) {
			return new Response(`handler failure: ${String(error)}`, { status: 500 });
		}
	});
}
/** Bind one request to an owner registration's cancellation and active set. */
async function withRequestLifetime(request, active, use) {
	const lifetime = new AbortController();
	const abort = () => {
		lifetime.abort(request.signal.reason);
	};
	if (request.signal.aborted) abort();
	else request.signal.addEventListener("abort", abort, { once: true });
	active.add(lifetime);
	try {
		return await use(lifetime.signal);
	} finally {
		request.signal.removeEventListener("abort", abort);
		active.delete(lifetime);
		lifetime.abort();
	}
}
/** Track request cancellation without releasing owner activity before the body settles. */
function createDownloadLifetime(request, active) {
	const controller = new AbortController();
	let finished = false;
	let failed = false;
	let failure;
	let resolveFinished;
	const settled = new Promise((resolve) => {
		resolveFinished = resolve;
	});
	const settle = (reason, error) => {
		if (finished) return false;
		finished = true;
		if (error !== void 0) {
			failed = true;
			failure = error.value;
		}
		request.signal.removeEventListener("abort", abortFromRequest);
		active.delete(lifetime);
		if (!controller.signal.aborted) controller.abort(reason);
		resolveFinished();
		return true;
	};
	const lifetime = {
		signal: controller.signal,
		abort(reason) {
			if (!controller.signal.aborted) controller.abort(reason);
			return settled.then(() => {
				if (failed) throw failure;
			});
		},
		finish(reason) {
			return settle(reason);
		},
		fail(error) {
			return settle(error, { value: error });
		}
	};
	const abortFromRequest = () => {
		lifetime.abort(request.signal.reason).catch(() => {});
	};
	active.add(lifetime);
	if (request.signal.aborted) abortFromRequest();
	else request.signal.addEventListener("abort", abortFromRequest, { once: true });
	return lifetime;
}
/** Keep a streaming download's owner lifetime open until the returned body reaches a terminal state. */
async function streamDownloadResponse(request, response, lifetime) {
	if (request.method === "HEAD") {
		const reason = new DOMException("HEAD response does not consume a body", "AbortError");
		lifetime.abort(reason).catch(() => {});
		await cancelBody(response.body, reason);
		lifetime.finish(reason);
		return new Response(null, responseInit(response));
	}
	if (response.body === null) {
		lifetime.finish();
		return response;
	}
	const reader = response.body.getReader();
	let output;
	let terminal = false;
	const beginTerminal = () => {
		if (terminal) return false;
		terminal = true;
		lifetime.signal.removeEventListener("abort", abort);
		return true;
	};
	const releaseReader = () => {
		reader.releaseLock();
	};
	const cancelReader = async (reason) => {
		let failed = false;
		let failure;
		try {
			await reader.cancel(reason);
		} catch (error) {
			failed = true;
			failure = error;
		}
		try {
			releaseReader();
		} catch (error) {
			if (!failed) {
				failed = true;
				failure = error;
			}
		}
		if (failed) {
			lifetime.fail(failure);
			throw failure;
		}
		lifetime.finish(reason);
	};
	const abort = () => {
		if (!beginTerminal()) return;
		const reason = lifetime.signal.reason;
		const cancellation = cancelReader(reason);
		output.error(reason);
		cancellation.catch(() => {});
	};
	const body = new ReadableStream({
		start(controller) {
			output = controller;
		},
		async pull(controller) {
			try {
				const chunk = await reader.read();
				if (terminal) return;
				if (chunk.done) {
					beginTerminal();
					try {
						releaseReader();
						controller.close();
					} catch (error) {
						lifetime.fail(error);
						throw error;
					}
					lifetime.finish();
					return;
				}
				controller.enqueue(chunk.value);
			} catch (error) {
				if (!beginTerminal()) return;
				try {
					releaseReader();
					controller.error(error);
				} catch (releaseError) {
					lifetime.fail(releaseError);
					throw releaseError;
				}
				lifetime.fail(error);
			}
		},
		async cancel(reason) {
			if (!beginTerminal()) return;
			await cancelReader(reason);
		}
	});
	lifetime.signal.addEventListener("abort", abort, { once: true });
	if (lifetime.signal.aborted) abort();
	return new Response(body, responseInit(response));
}
/** Preserve response metadata while replacing a download body with its lifecycle-bound stream. */
function responseInit(response) {
	return {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	};
}
/** Cancel an abandoned source body and await its terminal settlement. */
async function cancelBody(body, reason) {
	if (body === null) return;
	await body.cancel(reason);
}
function rpcFetchHandler(channel, handler) {
	return { async fetch(request) {
		const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
		if (request.method !== "POST" || endpoint === void 0) return new Response("not found", { status: 404 });
		if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return new Response("content type must be application/json", { status: 415 });
		let body;
		try {
			body = await request.json();
		} catch {
			return new Response("body is not JSON", { status: 400 });
		}
		const message = parseClientRequest(body);
		if (message === void 0) return invalidEnvelopeResponse(body);
		if (message.method !== endpoint) return errorResponse(message.rpcId, {
			code: "bad-request",
			message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
			details: { issues: [] }
		});
		try {
			const result = await handler(endpoint, message.payload, request.signal);
			return fullResponse(message.rpcId, result);
		} catch (error) {
			return new Response(`handler failure: ${String(error)}`, { status: 500 });
		}
	} };
}
function invalidEnvelopeResponse(body) {
	const rawId = body?.rpcId;
	return errorResponse(typeof rawId === "string" ? rawId : INVALID_REQUEST_RPC_ID, {
		code: "bad-request",
		message: "invalid client-request message",
		details: { issues: [] }
	});
}
function parseClientRequest(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const candidate = value;
	if (candidate.type !== "client-request" || typeof candidate.rpcId !== "string" || candidate.rpcId.length === 0 || typeof candidate.method !== "string" || candidate.method.length === 0 || !Object.hasOwn(candidate, "payload")) return void 0;
	return {
		type: "client-request",
		rpcId: candidate.rpcId,
		method: candidate.method,
		payload: candidate.payload
	};
}
function endpointFromPath(channel, pathname) {
	if (!pathname.startsWith(`${channel}/`)) return void 0;
	const endpoint = pathname.slice(channel.length + 1);
	if (endpoint.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT_PATTERN.test(segment))) return;
	return endpoint;
}
function errorResponse(rpcId, error) {
	return fullResponse(rpcId, {
		ok: false,
		error
	});
}
function fullResponse(rpcId, result) {
	const body = {
		type: "server-response",
		rpcId,
		result
	};
	return Response.json(body);
}
function assertChannel(channel) {
	if (!CHANNEL_PATTERN.test(channel) || channel === "/api") throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`);
}
function assertDownloadPath(path) {
	if (!path.startsWith(`/api/`) || path === RESPOND_PATH) throw new Error(`connection: invalid or reserved download path ${JSON.stringify(path)}`);
	if (path.slice(5).split("/").some((segment) => segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT_PATTERN.test(segment))) throw new Error(`connection: invalid download path ${JSON.stringify(path)}`);
}
//#endregion
//#region lib/types/websocket-downlink.js
/** Host-side WebSocket carrier for the two server-to-browser event streams. */
/** Keep idle native/API event connections alive through intermediate proxies. */
const DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 3e4;
/** Grace after a typed terminal failure before an unresponsive socket is destroyed. */
const DEFAULT_WEBSOCKET_CLOSE_GRACE_MS = 1e3;
function serverRequest(frame) {
	return {
		type: "server-request",
		rpcId: frame.rpcId,
		method: frame.payload.type,
		payload: frame.payload
	};
}
function send(socket, frame) {
	return new Promise((resolve, reject) => {
		if (socket.readyState !== WebSocket.OPEN) {
			reject(/* @__PURE__ */ new Error("websocket downlink closed before frame delivery"));
			return;
		}
		socket.send(JSON.stringify(serverRequest(frame)), (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
function failureFrame(error, channel) {
	const candidate = error !== null && typeof error === "object" ? error : void 0;
	return {
		rpcId: randomUUID(),
		payload: {
			type: "stream/error",
			channel,
			error: {
				code: typeof candidate?.code === "string" ? candidate.code : "EVENT_STREAM_FAILED",
				message: typeof candidate?.message === "string" ? candidate.message : String(error),
				details: candidate?.details ?? {}
			}
		}
	};
}
/**
* Owns WebSocket negotiation and frame pumping for the connection plugin's
* two downlinks. Client messages are a protocol violation: upstream traffic
* remains on HTTP.
*/
var WebSocketDownlinks = class {
	events;
	server = new WebSocketServer({ noServer: true });
	pumps = /* @__PURE__ */ new Set();
	leases = /* @__PURE__ */ new Map();
	heartbeatTimer;
	/** @param events - Connection-owned reader for registered event sources. */
	constructor(events) {
		this.events = events;
	}
	/**
	* Upgrade one socket and pump the mux stream until either side closes.
	* @param req - HTTP upgrade request.
	* @param socket - Raw socket transferred by the HTTP server.
	* @param head - Bytes already read after the upgrade headers.
	*/
	handleMux(req, socket, head) {
		this.upgrade(req, socket, head, "mux");
	}
	/**
	* Upgrade one socket and pump the host stream until either side closes.
	* @param req - HTTP upgrade request.
	* @param socket - Raw socket transferred by the HTTP server.
	* @param head - Bytes already read after the upgrade headers.
	*/
	handleHost(req, socket, head) {
		this.upgrade(req, socket, head, "host");
	}
	/**
	* Terminate owned sockets and await the no-server acceptor plus frame pumps.
	* @returns A promise resolving after every socket and source iterator stops.
	*/
	async close() {
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = void 0;
		for (const socket of this.server.clients) {
			const lease = this.leases.get(socket);
			if (lease?.closeTimer !== void 0) clearTimeout(lease.closeTimer);
			lease?.abort.abort();
			socket.terminate();
		}
		this.leases.clear();
		await new Promise((resolve, reject) => {
			this.server.close((error) => {
				if (error === void 0) resolve();
				else reject(error);
			});
		});
		await Promise.all(this.pumps);
	}
	upgrade(req, socket, head, channel) {
		this.server.handleUpgrade(req, socket, head, (websocket) => {
			this.startHeartbeat();
			const abort = new AbortController();
			const lease = {
				channel,
				abort,
				awaitingPong: false,
				closing: false
			};
			this.leases.set(websocket, lease);
			websocket.on("pong", () => {
				lease.awaitingPong = false;
			});
			websocket.once("close", () => {
				if (lease.closeTimer !== void 0) clearTimeout(lease.closeTimer);
				this.leases.delete(websocket);
				abort.abort();
			});
			websocket.once("error", () => {
				abort.abort();
			});
			websocket.once("message", () => {
				websocket.close(1008, "downlink only");
			});
			const pump = this.pump(websocket, this.events.openEventStream(channel, abort.signal), abort, channel);
			this.pumps.add(pump);
			pump.then(() => {
				this.pumps.delete(pump);
			});
		});
	}
	/** Start one unreferenced Ping timer after the first accepted downlink. */
	startHeartbeat() {
		if (this.heartbeatTimer !== void 0) return;
		this.heartbeatTimer = setInterval(() => {
			for (const socket of this.server.clients) {
				if (socket.readyState !== WebSocket.OPEN) continue;
				const lease = this.leases.get(socket);
				if (lease === void 0 || lease.closing) continue;
				if (lease.awaitingPong) {
					this.failSocket(socket, lease, Object.assign(/* @__PURE__ */ new Error("native event peer missed its pong deadline"), {
						code: "EVENT_HEARTBEAT_TIMEOUT",
						details: { channel: lease.channel }
					}));
					continue;
				}
				lease.awaitingPong = true;
				socket.ping((error) => {
					if (error != null) this.failSocket(socket, lease, error);
				});
			}
		}, DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS);
		this.heartbeatTimer.unref();
	}
	async pump(socket, frames, abort, channel) {
		try {
			for await (const frame of frames) await send(socket, frame);
		} catch (error) {
			if (!abort.signal.aborted) try {
				await send(socket, failureFrame(error, channel));
			} catch {}
		} finally {
			abort.abort();
			if (socket.readyState === WebSocket.OPEN) {
				const lease = this.leases.get(socket);
				if (lease !== void 0) this.scheduleClose(socket, lease);
				else socket.close();
			}
		}
	}
	failSocket(socket, lease, error) {
		if (lease.closing || socket.readyState !== WebSocket.OPEN) return;
		lease.closing = true;
		lease.closeTimer = setTimeout(() => {
			socket.terminate();
		}, DEFAULT_WEBSOCKET_CLOSE_GRACE_MS);
		lease.closeTimer.unref();
		send(socket, failureFrame(error, lease.channel)).catch(() => {}).finally(() => {
			lease.abort.abort();
			if (socket.readyState === WebSocket.OPEN) socket.close(1011, "event stream failed");
		});
	}
	scheduleClose(socket, lease) {
		if (lease.closing) return;
		lease.closing = true;
		socket.close();
		lease.closeTimer = setTimeout(() => {
			socket.terminate();
		}, DEFAULT_WEBSOCKET_CLOSE_GRACE_MS);
		lease.closeTimer.unref();
	}
};
/**
* Reject an untrusted upgrade before protocol negotiation.
* @param socket - Raw HTTP socket that remains owned by the caller.
*/
function rejectWebSocketUpgrade(socket) {
	socket.end([
		"HTTP/1.1 403 Forbidden",
		"Connection: close",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Length: 9",
		"",
		"forbidden"
	].join("\r\n"));
}
//#endregion
//#region lib/types/index.js
/** Stable Cordis plugin name. */
const name = "host-connection";
/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024;
function assertImageBodyCapacity(ctx, maxRequestBodyBytes) {
	const attachments = ctx.get("attachments");
	if (attachments === void 0) return;
	const requiredImageBodyBytes = Math.ceil(attachments.imageLimits.maxMessageImageBytes * 4 / 3) + REQUEST_ENVELOPE_HEADROOM_BYTES;
	if (maxRequestBodyBytes < requiredImageBodyBytes) throw new Error(`host-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least ${String(requiredImageBodyBytes)} for the configured aggregate image limit`);
}
/** Services required before providing Connection. */
const inject = ["webServer"];
const Config = z.object({
	trustedHosts: z.array(String).default([]),
	maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES)
});
/**
* Methods gated to loopback even on a trusted-host deployment. Native dialogs
* act on the host machine; the settings and credential domains mutate the
* user's configuration and secret store, and READING them is equally
* privileged — `settings.describe` returns every exposed namespace's
* configuration and `credentials.describe` reports whether an arbitrary
* environment-variable name is configured and where from, which is
* reconnaissance no anonymous caller should have. `trustedHosts` is a
* DNS-rebinding fence, explicitly not authentication, so the whole
* configuration plane stays loopback-same-origin until a real authentication
* layer exists. `llm.discoverModels` belongs to that plane on both counts: it
* carries a draft credential, and it makes the HOST issue a GET to a URL the
* caller chose and reports back the status or the parsed body — an anonymous
* LAN caller would have a probe for whatever the host can reach and the
* browser cannot.
*
* The model catalog (`llm.providers`, `llm.models`) is deliberately NOT here:
* it carries provider ids, display names, and model lists — no endpoints,
* keys, or key state — and a LAN client's model picker legitimately needs it.
*/
const PRIVILEGED_METHODS = new Set([
	"agentPreset/read",
	"agentPreset/copy",
	"agentPreset/openDocument",
	"agentPreset/remove",
	"host/pickDirectory",
	"host/openPath",
	"settings/describe",
	"settings/openDocument",
	"settings/update",
	"settings/replace",
	"settings/mutate",
	"credentials/describe",
	"credentials/set",
	"credentials/unset",
	"llm/discoverModels"
]);
/**
* Mounts the API gateway under the browser transport prefix. Every request on
* the prefix passes the browser-trust fence first (DNS-rebinding and
* cross-site defense — [api-request-trust](./api-request-trust.ts));
* privileged methods additionally pass it with an empty trust list, which
* pins them to loopback.
* @param ctx - Host plugin context.
* @param config - resolved plugin config (schema defaults applied).
*/
function apply(ctx, config) {
	const trustedHosts = config?.trustedHosts ?? [];
	const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? 314572800;
	for (const entry of trustedHosts) assertTrustedAuthority(entry);
	assertImageBodyCapacity(ctx, maxRequestBodyBytes);
	const connection = new HostConnectionService(ctx, trustedHosts);
	const rpcHandler = connection.createSharedFetchHandler(API_PATH);
	const fetchHandler = { async fetch(request) {
		const pathname = new URL(request.url).pathname;
		const method = pathname.startsWith(`/api/`) ? pathname.slice(5) : void 0;
		if (method !== void 0 && PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, [])) return new Response("forbidden", { status: 403 });
		if (request.method === "GET" && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) return new Response("upgrade required", {
			status: 426,
			headers: {
				connection: "Upgrade",
				upgrade: "websocket"
			}
		});
		return rpcHandler.fetch(request);
	} };
	const route = {
		kind: "prefix",
		path: API_PATH,
		handler: async (req, res) => {
			if (!isTrustedApiRequest(req, trustedHosts)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			await bridge(req, res, fetchHandler, maxRequestBodyBytes);
		}
	};
	ctx.effect(() => ctx.webServer.register(route), "host-connection: /api route");
	const downlinks = new WebSocketDownlinks(connection);
	const registerDownlink = (path, handle) => {
		ctx.effect(() => ctx.webServer.registerUpgrade({
			path,
			handler: (req, socket, head) => {
				if (!isTrustedApiRequest(req, trustedHosts)) {
					rejectWebSocketUpgrade(socket);
					return;
				}
				return handle(req, socket, head);
			}
		}), `host-connection: ${path} WebSocket`);
	};
	ctx.effect(() => () => downlinks.close(), "host-connection: WebSocket downlinks");
	registerDownlink(MUX_EVENTS_PATH, (req, socket, head) => {
		downlinks.handleMux(req, socket, head);
	});
	registerDownlink(HOST_EVENTS_PATH, (req, socket, head) => {
		downlinks.handleHost(req, socket, head);
	});
}
//#endregion
export { API_PATH, Config, HOST_EVENTS_PATH, HostConnectionService, MUX_EVENTS_PATH, RESPOND_PATH, apply, inject, name };
