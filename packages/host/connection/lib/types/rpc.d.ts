/** Generic RPC and event contracts owned by Host Connection. */
/** Merge-extensible transport error returned by a logical RPC owner. */
export interface ConnectionRpcError {
    readonly code: string;
    readonly message: string;
    readonly details: unknown;
}
/** Transport-independent result returned by one logical RPC owner. */
export type ConnectionRpcResult<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: ConnectionRpcError;
};
/** Decoded client request carried by a Connection RPC channel. */
export interface ConnectionClientRequest {
    readonly type: 'client-request';
    readonly rpcId: string;
    readonly method: string;
    readonly payload: unknown;
}
/** Encoded server response returned by a Connection RPC channel. */
export interface ConnectionServerResponse {
    readonly type: 'server-response';
    readonly rpcId: string;
    readonly result: ConnectionRpcResult<unknown>;
}
/** Receipt returned after one server-initiated response is correlated. */
export type ConnectionResponseReceipt = {
    readonly accepted: true;
} | {
    readonly accepted: false;
    readonly reason: 'not-pending' | 'bad-response';
};
/** Logical owner of the exact `/api/respond` client-response carrier. */
export type ConnectionResponseHandler = (message: unknown, signal: AbortSignal) => ConnectionResponseReceipt | Promise<ConnectionResponseReceipt>;
/** Exact non-RPC download or export handler mounted below `/api`. */
export type ConnectionDownloadHandler = (request: Request, signal: AbortSignal) => Promise<Response>;
/** The two independent native event streams. */
export type ConnectionEventChannel = 'mux' | 'host';
/** One merge-extensible event payload; its type is also the wire method. */
export interface ConnectionEventPayload {
    readonly type: string;
    readonly [key: string]: unknown;
}
/** One event emitted by a domain event source before wire encoding. */
export interface ConnectionEventFrame {
    readonly rpcId: string;
    readonly payload: ConnectionEventPayload;
}
/** Final server-request envelope consumed by Native Ark. */
export interface ConnectionServerEvent {
    readonly type: 'server-request';
    readonly rpcId: string;
    readonly method: string;
    readonly payload: ConnectionEventPayload;
}
/** Lazy, cancellation-aware producer for one event channel. */
export type ConnectionEventSource = (signal: AbortSignal) => AsyncIterable<ConnectionEventFrame>;
/** Trust fence applied before a Host RPC channel reaches its handler. */
export type ConnectionRpcAuthority = 'trusted-host' | 'loopback';
/** Registration policy for one logical RPC channel. */
export interface ConnectionRpcHandlerOptions {
    /** Browser authority accepted by every endpoint in this channel. */
    readonly authority: ConnectionRpcAuthority;
}
/** Handler invoked after Connection has decoded the transport envelope. */
export type ConnectionRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcResult<unknown>>;
/** Synchronous ownership test for one endpoint on a shared RPC channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean;
/** Host registry for logical RPC channels carried by the current transport. */
export interface HostConnectionRpc {
    /**
       * Register one absolute channel prefix and its trust policy.
       * @param channel - absolute logical channel such as `/rpc`.
       * @param handler - decoded endpoint handler returning the existing RPC result shape.
       * @param options - channel trust policy.
       * @returns asynchronous disposer removing the channel and its physical route.
       */
    handle(channel: string, handler: ConnectionRpcHandler, options: ConnectionRpcHandlerOptions): () => Promise<void>;
    /**
     * Intercept owned endpoints on the shared `/api` channel before its fallback.
     * @param channel - reserved shared channel; currently `/api`.
     * @param matches - synchronous endpoint ownership test.
     * @param handler - decoded endpoint handler returning the existing RPC result shape.
     * @param options - trust policy for every endpoint claimed by this interceptor.
     * @returns asynchronous disposer removing the interceptor.
     */
    intercept(channel: '/api', matches: ConnectionRpcEndpointMatcher, handler: ConnectionRpcHandler, options: ConnectionRpcHandlerOptions): () => Promise<void>;
}
/** Host registry for the two physical native event streams. */
export interface HostConnectionEvents {
    /**
     * Register the authoritative producer for one event channel in this fiber.
     * @param channel - independent mux or host downlink.
     * @param source - lazy producer opened once per accepted socket generation.
     * @returns asynchronous disposer that aborts active iterators and removes the producer.
     */
    handle(channel: ConnectionEventChannel, source: ConnectionEventSource): () => Promise<void>;
}
/** Registry for the one exact response carrier paired with answerable events. */
export interface HostConnectionResponses {
    /**
     * Register the owner that validates and correlates loopback-only `/api/respond` bodies.
     * @param handler - response owner; Connection supplies decoded JSON and cancellation.
     * @returns asynchronous disposer that aborts active handlers and withdraws the route.
     */
    handle(handler: ConnectionResponseHandler): () => Promise<void>;
}
/** Registry for exact Host-owned download paths sharing Connection's trust fence. */
export interface HostConnectionDownloads {
    /**
     * Register one exact `/api/...` path and its trust policy.
     * @param path - exact absolute transport path.
     * @param handler - Host-owned GET/HEAD or download handler.
     * @param options - accepted authority.
     * @returns asynchronous disposer aborting active requests and removing the path.
     */
    handle(path: string, handler: ConnectionDownloadHandler, options: ConnectionRpcHandlerOptions): () => Promise<void>;
}
/** Read side used only by the physical WebSocket carrier. */
export interface HostConnectionEventReader {
    /** Open one registered event source for an accepted socket generation. */
    openEventStream(channel: ConnectionEventChannel, signal: AbortSignal): AsyncIterable<ConnectionEventFrame>;
}
/** Host `ctx.connection` shape consumed by transport-independent adapters. */
export interface HostConnectionHandle {
    /** Generic RPC channel registry. */
    readonly rpc: HostConnectionRpc;
    /** Scoped event-source registry. */
    readonly events: HostConnectionEvents;
    /** Exact response carrier registry for answerable event frames. */
    readonly responses: HostConnectionResponses;
    /** Exact download/export registry below the authenticated API prefix. */
    readonly downloads: HostConnectionDownloads;
}
/** Client caller for logical RPC channels carried by the current transport. */
export interface ClientConnectionRpc {
    /**
     * Call one endpoint through an already registered logical channel.
     * @param channel - absolute logical channel such as `/api`.
     * @param endpoint - channel-relative endpoint such as `goals/create`.
     * @param payload - channel-owned request payload.
     * @param signal - optional caller cancellation.
     * @returns the existing RPC success/error result; correlation stays inside Connection.
     */
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>;
}
//# sourceMappingURL=rpc.d.ts.map