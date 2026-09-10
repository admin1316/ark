/** Stable failures exposed by the session-persistence service. */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** A live Session or exclusive preparation still owns the identity being deleted. */
export class SessionPersistenceDeleteBlockedError extends Error {
  /**
   * @param sessionId - identity whose deletion was refused.
   * @param reason - live publication or exclusive resume reservation.
   */
  constructor(readonly sessionId: SessionId, readonly reason: 'live' | 'reserved') {
    super(reason === 'live'
      ? `cannot delete session "${sessionId}" while it is live`
      : `cannot delete session "${sessionId}" while its persisted preparation is reserved`)
    this.name = 'SessionPersistenceDeleteBlockedError'
  }
}

/** The requested Session identity has no materialized durable log. */
export class SessionPersistenceNotFoundError extends Error {
  /** @param sessionId - absent durable Session identity. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" not found`)
    this.name = 'SessionPersistenceNotFoundError'
  }
}
