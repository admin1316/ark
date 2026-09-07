/** Host registry and HTTP adapter for generic Connection RPC channels. */
import { Context, Service } from '@deepseek-ai/cordis';
import { type FetchHandler } from './http-bridge.ts';
import type { ConnectionEventChannel, ConnectionEventFrame, HostConnectionHandle, HostConnectionRpc } from './rpc.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Host Connection transport and RPC registrations. */
        connection: HostConnectionHandle;
    }
}
/** Host Connection service whose channel registrations belong to the caller fiber. */
export declare class HostConnectionService extends Service implements HostConnectionHandle {
    private readonly trustedHosts;
    private readonly interceptors;
    private readonly eventSources;
    private readonly downloadHandlers;
    private responseHandler;
    /**
     * Provide the Host half over the active HTTP server.
     * @param ctx - owning Connection plugin context.
     * @param trustedHosts - deployment authorities accepted by trusted-host channels.
     */
    constructor(ctx: Context, trustedHosts: readonly string[]);
    /** Generic channel registry scoped to the Context reading this service. */
    get rpc(): HostConnectionRpc;
    /** Event producers are scoped to the registering Context. */
    get events(): HostConnectionHandle['events'];
    /** Exact response carrier registration scoped to the registering Context. */
    get responses(): HostConnectionHandle['responses'];
    /** Exact download registrations are scoped to the registering Context. */
    get downloads(): HostConnectionHandle['downloads'];
    /**
     * Open the current authoritative source for one accepted socket generation.
     * @param channel - independent mux or host downlink.
     * @param signal - socket-generation cancellation.
     * @returns the source's validated frames until cancellation or disposal.
     */
    openEventStream(channel: ConnectionEventChannel, signal: AbortSignal): AsyncIterable<ConnectionEventFrame>;
    /**
     * Compose the shared-channel Fetch handler from its registered interceptor.
     * @param channel - shared channel mounted by Connection.
     * @returns Fetch handler that fails closed for every unclaimed endpoint.
     */
    createSharedFetchHandler(channel: '/api'): FetchHandler;
    private registerEventSource;
    private registerResponseHandler;
    private registerDownloadHandler;
    private register;
    private registerInterceptor;
}
//# sourceMappingURL=rpc-host.d.ts.map