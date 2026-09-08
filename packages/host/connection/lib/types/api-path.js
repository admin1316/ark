/**
 * The /api URL prefix — single source for both halves of the web transport.
 * The node half registers this prefix on the web server; both halves share the
 * event paths below for the browser WebSocket downlinks.
 */
/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export const API_PATH = '/api';
/** Native mux-frame WebSocket pathname. */
export const MUX_EVENTS_PATH = `${API_PATH}/events/mux`;
/** Native host-frame WebSocket pathname. */
export const HOST_EVENTS_PATH = `${API_PATH}/events/host`;
/** Native response pathname for server-initiated approval and question frames. */
export const RESPOND_PATH = `${API_PATH}/respond`;
//# sourceMappingURL=api-path.js.map