/** Host-side WebSocket carrier for the two server-to-browser event streams. */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { HostConnectionEventReader } from './rpc.ts';
/** Keep idle native/API event connections alive through intermediate proxies. */
export declare const DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 30000;
/** Grace after a typed terminal failure before an unresponsive socket is destroyed. */
export declare const DEFAULT_WEBSOCKET_CLOSE_GRACE_MS = 1000;
/**
 * Owns WebSocket negotiation and frame pumping for the connection plugin's
 * two downlinks. Client messages are a protocol violation: upstream traffic
 * remains on HTTP.
 */
export declare class WebSocketDownlinks {
    private readonly events;
    private readonly server;
    private readonly pumps;
    private readonly leases;
    private heartbeatTimer;
    /** @param events - Connection-owned reader for registered event sources. */
    constructor(events: HostConnectionEventReader);
    /**
     * Upgrade one socket and pump the mux stream until either side closes.
     * @param req - HTTP upgrade request.
     * @param socket - Raw socket transferred by the HTTP server.
     * @param head - Bytes already read after the upgrade headers.
     */
    handleMux(req: IncomingMessage, socket: Duplex, head: Buffer): void;
    /**
     * Upgrade one socket and pump the host stream until either side closes.
     * @param req - HTTP upgrade request.
     * @param socket - Raw socket transferred by the HTTP server.
     * @param head - Bytes already read after the upgrade headers.
     */
    handleHost(req: IncomingMessage, socket: Duplex, head: Buffer): void;
    /**
     * Terminate owned sockets and await the no-server acceptor plus frame pumps.
     * @returns A promise resolving after every socket and source iterator stops.
     */
    close(): Promise<void>;
    private upgrade;
    /** Start one unreferenced Ping timer after the first accepted downlink. */
    private startHeartbeat;
    private pump;
    private failSocket;
    private scheduleClose;
}
/**
 * Reject an untrusted upgrade before protocol negotiation.
 * @param socket - Raw HTTP socket that remains owned by the caller.
 */
export declare function rejectWebSocketUpgrade(socket: Duplex): void;
//# sourceMappingURL=websocket-downlink.d.ts.map