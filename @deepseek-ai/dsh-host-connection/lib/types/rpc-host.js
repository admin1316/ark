/** Host registry and HTTP adapter for generic Connection RPC channels. */
import { Service } from '@deepseek-ai/cordis';
import { bridge } from "./http-bridge.js";
import { isTrustedApiRequest } from "./api-request-trust.js";
import { API_PATH, RESPOND_PATH } from "./api-path.js";
const INVALID_REQUEST_RPC_ID = 'invalid-request';
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service {
    trustedHosts;
    interceptors = new Map();
    eventSources = new Map();
    downloadHandlers = new Map();
    responseHandler;
    /**
     * Provide the Host half over the active HTTP server.
     * @param ctx - owning Connection plugin context.
     * @param trustedHosts - deployment authorities accepted by trusted-host channels.
     */
    constructor(ctx, trustedHosts) {
        super(ctx, 'connection');
        this.trustedHosts = trustedHosts;
    }
    /** Generic channel registry scoped to the Context reading this service. */
    get rpc() {
        const owner = this.ctx;
        return {
            handle: (channel, handler, options) => this.register(owner, channel, handler, options),
            intercept: (channel, matches, handler, options) => this.registerInterceptor(owner, channel, matches, handler, options),
        };
    }
    /** Event producers are scoped to the registering Context. */
    get events() {
        const owner = this.ctx;
        return {
            handle: (channel, source) => this.registerEventSource(owner, channel, source),
        };
    }
    /** Exact response carrier registration scoped to the registering Context. */
    get responses() {
        const owner = this.ctx;
        return {
            handle: handler => this.registerResponseHandler(owner, handler),
        };
    }
    /** Exact download registrations are scoped to the registering Context. */
    get downloads() {
        const owner = this.ctx;
        return {
            handle: (path, handler, options) => this.registerDownloadHandler(owner, path, handler, options),
        };
    }
    /**
     * Open the current authoritative source for one accepted socket generation.
     * @param channel - independent mux or host downlink.
     * @param signal - socket-generation cancellation.
     * @returns the source's validated frames until cancellation or disposal.
     */
    async *openEventStream(channel, signal) {
        const registration = this.eventSources.get(channel);
        if (registration === undefined) {
            throw new Error(`host-connection: no ${channel} event source is registered`);
        }
        const lifetime = new AbortController();
        const abort = () => { lifetime.abort(signal.reason); };
        if (signal.aborted)
            abort();
        else
            signal.addEventListener('abort', abort, { once: true });
        registration.active.add(lifetime);
        try {
            for await (const frame of registration.source(lifetime.signal))
                yield frame;
        }
        finally {
            signal.removeEventListener('abort', abort);
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
        return {
            fetch: (request) => {
                const pathname = new URL(request.url).pathname;
                if (pathname === RESPOND_PATH) {
                    const registration = this.responseHandler;
                    if (registration === undefined)
                        return Promise.resolve(new Response('not found', { status: 404 }));
                    if (!isTrustedApiRequest(request, [])) {
                        return Promise.resolve(new Response('forbidden', { status: 403 }));
                    }
                    return responseFetch(request, registration);
                }
                const download = this.downloadHandlers.get(pathname);
                if (download !== undefined) {
                    if (download.options.authority === 'loopback' && !isTrustedApiRequest(request, [])) {
                        return Promise.resolve(new Response('forbidden', { status: 403 }));
                    }
                    return downloadFetch(request, download);
                }
                const endpoint = endpointFromPath(channel, pathname);
                const interceptor = this.interceptors.get(channel);
                if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
                    return Promise.resolve(new Response('not found', { status: 404 }));
                }
                if (interceptor.options.authority === 'loopback' && !isTrustedApiRequest(request, [])) {
                    return Promise.resolve(new Response('forbidden', { status: 403 }));
                }
                return interceptor.fetchHandler.fetch(request);
            },
        };
    }
    registerEventSource(owner, channel, source) {
        const registration = { source, active: new Set() };
        return owner.effect(() => {
            if (this.eventSources.has(channel)) {
                throw new Error(`host-connection: ${channel} event source is already registered`);
            }
            this.eventSources.set(channel, registration);
            return () => {
                if (this.eventSources.get(channel) === registration)
                    this.eventSources.delete(channel);
                for (const lifetime of registration.active)
                    lifetime.abort(new Error(`host-connection: ${channel} event source was disposed`));
                registration.active.clear();
            };
        }, `host-connection: ${channel} event source`);
    }
    registerResponseHandler(owner, handler) {
        const registration = {
            handler,
            active: new Set(),
        };
        return owner.effect(() => {
            if (this.responseHandler !== undefined) {
                throw new Error('host-connection: /api/respond handler is already registered');
            }
            this.responseHandler = registration;
            return () => {
                if (this.responseHandler === registration)
                    this.responseHandler = undefined;
                for (const lifetime of [...registration.active])
                    lifetime.abort(new Error('host-connection: /api/respond handler was disposed'));
                registration.active.clear();
            };
        }, 'host-connection: /api/respond handler');
    }
    registerDownloadHandler(owner, path, handler, options) {
        assertDownloadPath(path);
        const registration = {
            handler,
            options,
            active: new Set(),
        };
        const dispose = owner.effect(() => {
            if (this.downloadHandlers.has(path)) {
                throw new Error(`host-connection: download path ${JSON.stringify(path)} is already registered`);
            }
            this.downloadHandlers.set(path, registration);
            let disposal;
            return () => {
                if (disposal !== undefined)
                    return disposal;
                if (this.downloadHandlers.get(path) === registration)
                    this.downloadHandlers.delete(path);
                const reason = new Error(`host-connection: download path ${JSON.stringify(path)} was disposed`);
                disposal = Promise.all([...registration.active].map(lifetime => lifetime.abort(reason))).then(() => undefined);
                return disposal;
            };
        }, `host-connection: ${path} download`);
        let result;
        return () => {
            if (result !== undefined)
                return result;
            try {
                result = Promise.resolve(dispose());
            }
            catch (error) {
                result = Promise.reject(error instanceof Error ? error : new Error(String(error)));
            }
            return result;
        };
    }
    register(owner, channel, handler, options) {
        assertChannel(channel);
        const trustedHosts = options.authority === 'loopback' ? [] : this.trustedHosts;
        const fetchHandler = rpcFetchHandler(channel, handler);
        const route = {
            kind: 'prefix',
            path: channel,
            handler: async (req, res) => {
                if (!isTrustedApiRequest(req, trustedHosts)) {
                    res.writeHead(403);
                    res.end('forbidden');
                    return;
                }
                await bridge(req, res, fetchHandler);
            },
        };
        return owner.effect(() => owner.webServer.register(route), `host-connection: ${channel} rpc channel`);
    }
    registerInterceptor(owner, channel, matches, handler, options) {
        if (channel !== API_PATH) {
            throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`);
        }
        const interceptor = {
            matches,
            fetchHandler: rpcFetchHandler(channel, handler),
            options,
        };
        return owner.effect(() => {
            if (this.interceptors.has(channel)) {
                throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`);
            }
            this.interceptors.set(channel, interceptor);
            return () => {
                this.interceptors.delete(channel);
            };
        }, `host-connection: ${channel} rpc interceptor`);
    }
}
async function downloadFetch(request, registration) {
    const lifetime = createDownloadLifetime(request, registration.active);
    try {
        const response = await registration.handler(request, lifetime.signal);
        if (lifetime.signal.aborted) {
            await cancelBody(response.body, lifetime.signal.reason);
            lifetime.finish();
            return new Response('request cancelled', { status: 499 });
        }
        return await streamDownloadResponse(request, response, lifetime);
    }
    catch (error) {
        const cancelled = lifetime.signal.aborted && error === lifetime.signal.reason;
        if (cancelled)
            lifetime.finish(error);
        else
            lifetime.fail(error);
        if (cancelled)
            return new Response('request cancelled', { status: 499 });
        return new Response(`handler failure: ${String(error)}`, { status: 500 });
    }
}
async function responseFetch(request, registration) {
    if (request.method !== 'POST')
        return new Response('not found', { status: 404 });
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
    }
    return withRequestLifetime(request, registration.active, async (signal) => {
        try {
            let body;
            try {
                body = await request.json();
            }
            catch {
                return new Response('body is not JSON', { status: 400 });
            }
            signal.throwIfAborted();
            const receipt = await registration.handler(body, signal);
            signal.throwIfAborted();
            return Response.json(receipt);
        }
        catch (error) {
            return new Response(`handler failure: ${String(error)}`, { status: 500 });
        }
    });
}
/** Bind one request to an owner registration's cancellation and active set. */
async function withRequestLifetime(request, active, use) {
    const lifetime = new AbortController();
    const abort = () => { lifetime.abort(request.signal.reason); };
    if (request.signal.aborted)
        abort();
    else
        request.signal.addEventListener('abort', abort, { once: true });
    active.add(lifetime);
    try {
        return await use(lifetime.signal);
    }
    finally {
        request.signal.removeEventListener('abort', abort);
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
    const settled = new Promise((resolve) => { resolveFinished = resolve; });
    const settle = (reason, error) => {
        if (finished)
            return false;
        finished = true;
        if (error !== undefined) {
            failed = true;
            failure = error.value;
        }
        request.signal.removeEventListener('abort', abortFromRequest);
        active.delete(lifetime);
        if (!controller.signal.aborted)
            controller.abort(reason);
        resolveFinished();
        return true;
    };
    const lifetime = {
        signal: controller.signal,
        abort(reason) {
            if (!controller.signal.aborted)
                controller.abort(reason);
            return settled.then(() => {
                if (failed)
                    throw failure;
            });
        },
        finish(reason) {
            return settle(reason);
        },
        fail(error) {
            return settle(error, { value: error });
        },
    };
    const abortFromRequest = () => { void lifetime.abort(request.signal.reason).catch(() => { }); };
    active.add(lifetime);
    if (request.signal.aborted)
        abortFromRequest();
    else
        request.signal.addEventListener('abort', abortFromRequest, { once: true });
    return lifetime;
}
/** Keep a streaming download's owner lifetime open until the returned body reaches a terminal state. */
async function streamDownloadResponse(request, response, lifetime) {
    if (request.method === 'HEAD') {
        const reason = new DOMException('HEAD response does not consume a body', 'AbortError');
        void lifetime.abort(reason).catch(() => { });
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
        if (terminal)
            return false;
        terminal = true;
        lifetime.signal.removeEventListener('abort', abort);
        return true;
    };
    const releaseReader = () => { reader.releaseLock(); };
    const cancelReader = async (reason) => {
        let failed = false;
        let failure;
        try {
            await reader.cancel(reason);
        }
        catch (error) {
            failed = true;
            failure = error;
        }
        try {
            releaseReader();
        }
        catch (error) {
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
        if (!beginTerminal())
            return;
        const reason = lifetime.signal.reason;
        const cancellation = cancelReader(reason);
        output.error(reason);
        void cancellation.catch(() => { });
    };
    const body = new ReadableStream({
        start(controller) {
            output = controller;
        },
        async pull(controller) {
            try {
                const chunk = await reader.read();
                if (terminal)
                    return;
                if (chunk.done) {
                    beginTerminal();
                    try {
                        releaseReader();
                        controller.close();
                    }
                    catch (error) {
                        lifetime.fail(error);
                        throw error;
                    }
                    lifetime.finish();
                    return;
                }
                controller.enqueue(chunk.value);
            }
            catch (error) {
                if (!beginTerminal())
                    return;
                try {
                    releaseReader();
                    controller.error(error);
                }
                catch (releaseError) {
                    lifetime.fail(releaseError);
                    throw releaseError;
                }
                lifetime.fail(error);
            }
        },
        async cancel(reason) {
            if (!beginTerminal())
                return;
            await cancelReader(reason);
        },
    });
    lifetime.signal.addEventListener('abort', abort, { once: true });
    if (lifetime.signal.aborted)
        abort();
    return new Response(body, responseInit(response));
}
/** Preserve response metadata while replacing a download body with its lifecycle-bound stream. */
function responseInit(response) {
    return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    };
}
/** Cancel an abandoned source body and await its terminal settlement. */
async function cancelBody(body, reason) {
    if (body === null)
        return;
    await body.cancel(reason);
}
function rpcFetchHandler(channel, handler) {
    return {
        async fetch(request) {
            const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
            if (request.method !== 'POST' || endpoint === undefined) {
                return new Response('not found', { status: 404 });
            }
            const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
            if (mediaType !== 'application/json') {
                return new Response('content type must be application/json', { status: 415 });
            }
            let body;
            try {
                body = await request.json();
            }
            catch {
                return new Response('body is not JSON', { status: 400 });
            }
            const message = parseClientRequest(body);
            if (message === undefined)
                return invalidEnvelopeResponse(body);
            if (message.method !== endpoint) {
                return errorResponse(message.rpcId, {
                    code: 'bad-request',
                    message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
                    details: { issues: [] },
                });
            }
            try {
                const result = await handler(endpoint, message.payload, request.signal);
                return fullResponse(message.rpcId, result);
            }
            catch (error) {
                return new Response(`handler failure: ${String(error)}`, { status: 500 });
            }
        },
    };
}
function invalidEnvelopeResponse(body) {
    const rawId = body?.rpcId;
    const rpcId = typeof rawId === 'string' ? rawId : INVALID_REQUEST_RPC_ID;
    return errorResponse(rpcId, {
        code: 'bad-request',
        message: 'invalid client-request message',
        details: { issues: [] },
    });
}
function parseClientRequest(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const candidate = value;
    if (candidate.type !== 'client-request'
        || typeof candidate.rpcId !== 'string'
        || candidate.rpcId.length === 0
        || typeof candidate.method !== 'string'
        || candidate.method.length === 0
        || !Object.hasOwn(candidate, 'payload'))
        return undefined;
    return {
        type: 'client-request',
        rpcId: candidate.rpcId,
        method: candidate.method,
        payload: candidate.payload,
    };
}
function endpointFromPath(channel, pathname) {
    if (!pathname.startsWith(`${channel}/`))
        return undefined;
    const endpoint = pathname.slice(channel.length + 1);
    const segments = endpoint.split('/');
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
        return undefined;
    }
    return endpoint;
}
function errorResponse(rpcId, error) {
    return fullResponse(rpcId, { ok: false, error });
}
function fullResponse(rpcId, result) {
    const body = { type: 'server-response', rpcId, result };
    return Response.json(body);
}
function assertChannel(channel) {
    if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
        throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`);
    }
}
function assertDownloadPath(path) {
    if (!path.startsWith(`${API_PATH}/`) || path === RESPOND_PATH) {
        throw new Error(`connection: invalid or reserved download path ${JSON.stringify(path)}`);
    }
    const relative = path.slice(API_PATH.length + 1);
    const segments = relative.split('/');
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
        throw new Error(`connection: invalid download path ${JSON.stringify(path)}`);
    }
}
//# sourceMappingURL=rpc-host.js.map