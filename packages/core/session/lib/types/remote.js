/**
 * Typed Remote port for session user flows.
 *
 * The SessionStore owns the generated `session/*` descriptors.  Host
 * composition owns the agent, persistence, attachment, and model integrations
 * needed to fulfill those descriptors; it supplies one implementation of this
 * port.  Keeping the wire contract here prevents a second Session API from
 * growing inside a transport package while retaining the existing lifecycle
 * and authorization owner.
 *
 * @module @deepseek-ai/dsh-session/remote
 */
/**
 * Build the standard unavailable failure without exposing transport internals.
 * @returns The value produced by session remote unavailable.
 */
export function sessionRemoteUnavailable() {
    return {
        ok: false,
        error: {
            code: 'session-remote-unavailable',
            message: 'session Remote operations are unavailable in this Host composition',
            details: {},
        },
    };
}
/**
 * Build the standard caller-cancelled result for direct owner tests.
 * @returns The value produced by session remote cancelled.
 */
export function sessionRemoteCancelled() {
    return {
        ok: false,
        error: {
            code: 'cancelled',
            message: 'session Remote invocation was cancelled',
            details: {},
        },
    };
}
//# sourceMappingURL=remote.js.map