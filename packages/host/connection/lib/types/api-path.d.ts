/**
 * The /api URL prefix — single source for both halves of the web transport.
 * The node half registers this prefix on the web server; both halves share the
 * event paths below for the browser WebSocket downlinks.
 */
/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export declare const API_PATH = "/api";
/** Native mux-frame WebSocket pathname. */
export declare const MUX_EVENTS_PATH = "/api/events/mux";
/** Native host-frame WebSocket pathname. */
export declare const HOST_EVENTS_PATH = "/api/events/host";
/** Native response pathname for server-initiated approval and question frames. */
export declare const RESPOND_PATH = "/api/respond";
//# sourceMappingURL=api-path.d.ts.map