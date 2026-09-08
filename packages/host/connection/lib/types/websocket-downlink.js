/** Host-side WebSocket carrier for the two server-to-browser event streams. */
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
/** Keep idle native/API event connections alive through intermediate proxies. */
export const DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 30_000;
/** Grace after a typed terminal failure before an unresponsive socket is destroyed. */
export const DEFAULT_WEBSOCKET_CLOSE_GRACE_MS = 1_000;
function serverRequest(frame) {
    return {
        type: 'server-request',
        rpcId: frame.rpcId,
        method: frame.payload.type,
        payload: frame.payload,
    };
}
function send(socket, frame) {
    return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
            reject(new Error('websocket downlink closed before frame delivery'));
            return;
        }
        socket.send(JSON.stringify(serverRequest(frame)), (error) => {
            if (error)
                reject(error);
            else
                resolve();
        });
    });
}
function failureFrame(error, channel) {
    const candidate = error !== null && typeof error === 'object'
        ? error
        : undefined;
    return {
        rpcId: randomUUID(),
        payload: {
            type: 'stream/error',
            channel,
            error: {
                code: typeof candidate?.code === 'string' ? candidate.code : 'EVENT_STREAM_FAILED',
                message: typeof candidate?.message === 'string' ? candidate.message : String(error),
                details: candidate?.details ?? {},
            },
        },
    };
}
/**
 * Owns WebSocket negotiation and frame pumping for the connection plugin's
 * two downlinks. Client messages are a protocol violation: upstream traffic
 * remains on HTTP.
 */
export class WebSocketDownlinks {
    events;
    server = new WebSocketServer({ noServer: true });
    pumps = new Set();
    leases = new Map();
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
        this.upgrade(req, socket, head, 'mux');
    }
    /**
     * Upgrade one socket and pump the host stream until either side closes.
     * @param req - HTTP upgrade request.
     * @param socket - Raw socket transferred by the HTTP server.
     * @param head - Bytes already read after the upgrade headers.
     */
    handleHost(req, socket, head) {
        this.upgrade(req, socket, head, 'host');
    }
    /**
     * Terminate owned sockets and await the no-server acceptor plus frame pumps.
     * @returns A promise resolving after every socket and source iterator stops.
     */
    async close() {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        for (const socket of this.server.clients) {
            const lease = this.leases.get(socket);
            if (lease?.closeTimer !== undefined)
                clearTimeout(lease.closeTimer);
            lease?.abort.abort();
            socket.terminate();
        }
        this.leases.clear();
        await new Promise((resolve, reject) => {
            this.server.close((error) => {
                if (error === undefined)
                    resolve();
                else
                    reject(error);
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
                closing: false,
            };
            this.leases.set(websocket, lease);
            websocket.on('pong', () => { lease.awaitingPong = false; });
            websocket.once('close', () => {
                if (lease.closeTimer !== undefined)
                    clearTimeout(lease.closeTimer);
                this.leases.delete(websocket);
                abort.abort();
            });
            websocket.once('error', () => { abort.abort(); });
            websocket.once('message', () => {
                websocket.close(1008, 'downlink only');
            });
            const pump = this.pump(websocket, this.events.openEventStream(channel, abort.signal), abort, channel);
            this.pumps.add(pump);
            void pump.then(() => { this.pumps.delete(pump); });
        });
    }
    /** Start one unreferenced Ping timer after the first accepted downlink. */
    startHeartbeat() {
        if (this.heartbeatTimer !== undefined)
            return;
        this.heartbeatTimer = setInterval(() => {
            for (const socket of this.server.clients) {
                if (socket.readyState !== WebSocket.OPEN)
                    continue;
                const lease = this.leases.get(socket);
                if (lease === undefined || lease.closing)
                    continue;
                if (lease.awaitingPong) {
                    this.failSocket(socket, lease, Object.assign(new Error('native event peer missed its pong deadline'), {
                        code: 'EVENT_HEARTBEAT_TIMEOUT',
                        details: { channel: lease.channel },
                    }));
                    continue;
                }
                lease.awaitingPong = true;
                socket.ping((error) => {
                    if (error != null)
                        this.failSocket(socket, lease, error);
                });
            }
        }, DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS);
        this.heartbeatTimer.unref();
    }
    async pump(socket, frames, abort, channel) {
        try {
            for await (const frame of frames)
                await send(socket, frame);
        }
        catch (error) {
            if (!abort.signal.aborted) {
                try {
                    await send(socket, failureFrame(error, channel));
                }
                catch {
                    // Socket loss won the race; no downstream remains to receive the failure frame.
                }
            }
        }
        finally {
            abort.abort();
            if (socket.readyState === WebSocket.OPEN) {
                const lease = this.leases.get(socket);
                if (lease !== undefined)
                    this.scheduleClose(socket, lease);
                else
                    socket.close();
            }
        }
    }
    failSocket(socket, lease, error) {
        if (lease.closing || socket.readyState !== WebSocket.OPEN)
            return;
        lease.closing = true;
        lease.closeTimer = setTimeout(() => { socket.terminate(); }, DEFAULT_WEBSOCKET_CLOSE_GRACE_MS);
        lease.closeTimer.unref();
        void send(socket, failureFrame(error, lease.channel))
            .catch(() => { })
            .finally(() => {
            lease.abort.abort();
            if (socket.readyState === WebSocket.OPEN)
                socket.close(1011, 'event stream failed');
        });
    }
    scheduleClose(socket, lease) {
        if (lease.closing)
            return;
        lease.closing = true;
        socket.close();
        lease.closeTimer = setTimeout(() => { socket.terminate(); }, DEFAULT_WEBSOCKET_CLOSE_GRACE_MS);
        lease.closeTimer.unref();
    }
}
/**
 * Reject an untrusted upgrade before protocol negotiation.
 * @param socket - Raw HTTP socket that remains owned by the caller.
 */
export function rejectWebSocketUpgrade(socket) {
    socket.end([
        'HTTP/1.1 403 Forbidden',
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Length: 9',
        '',
        'forbidden',
    ].join('\r\n'));
}
//# sourceMappingURL=websocket-downlink.js.map