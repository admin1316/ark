/** Stable failures exposed by the session-persistence service. */
/** A live Session or exclusive preparation still owns the identity being deleted. */
export class SessionPersistenceDeleteBlockedError extends Error {
    sessionId;
    reason;
    /**
     * @param sessionId - identity whose deletion was refused.
     * @param reason - live publication or exclusive resume reservation.
     */
    constructor(sessionId, reason) {
        super(reason === 'live'
            ? `cannot delete session "${sessionId}" while it is live`
            : `cannot delete session "${sessionId}" while its persisted preparation is reserved`);
        this.sessionId = sessionId;
        this.reason = reason;
        this.name = 'SessionPersistenceDeleteBlockedError';
    }
}
/** The requested Session identity has no materialized durable log. */
export class SessionPersistenceNotFoundError extends Error {
    sessionId;
    /** @param sessionId - absent durable Session identity. */
    constructor(sessionId) {
        super(`session "${sessionId}" not found`);
        this.sessionId = sessionId;
        this.name = 'SessionPersistenceNotFoundError';
    }
}
//# sourceMappingURL=errors.js.map