/** Stable failures exposed by the session-persistence service. */
import type { SessionId } from '@deepseek-ai/dsh-session';
/** A live Session or exclusive preparation still owns the identity being deleted. */
export declare class SessionPersistenceDeleteBlockedError extends Error {
    readonly sessionId: SessionId;
    readonly reason: 'live' | 'reserved';
    /**
     * @param sessionId - identity whose deletion was refused.
     * @param reason - live publication or exclusive resume reservation.
     */
    constructor(sessionId: SessionId, reason: 'live' | 'reserved');
}
/** The requested Session identity has no materialized durable log. */
export declare class SessionPersistenceNotFoundError extends Error {
    readonly sessionId: SessionId;
    /** @param sessionId - absent durable Session identity. */
    constructor(sessionId: SessionId);
}
//# sourceMappingURL=errors.d.ts.map