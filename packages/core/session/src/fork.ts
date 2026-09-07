/**
 * Session forking: the fork source vocabulary, typed rejection codes, and the
 * stateless seed/boundary mathematics. `forkSeed` and `resolveForkSource` are
 * pure functions over the store's own queries, so the fork decision logic is
 * testable without a live store.
 *
 * @module @deepseek-ai/dsh-session/fork
 */

import type { Session } from './index.ts'
import type { SessionId } from './types.ts'
import type { SessionEvent } from './types.ts'

/** A fork source: either the live session object or its live store id. */
export type SessionForkSource = Session | SessionId

/**
 * Rejection codes for session forking: the fork source id is unknown to the
 * live store (`SESSION_NOT_FOUND`) or names a session object that is not the
 * store's live instance (`SESSION_NOT_LIVE`); the requested child id is
 * already taken (`SESSION_ALREADY_EXISTS`); the boundary is not a contiguous
 * existing seq (`INVALID_BOUNDARY`); or the selected prefix ends inside an
 * open turn (`OPEN_TURN`).
 */
export type SessionForkErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_LIVE'
  | 'SESSION_ALREADY_EXISTS'
  | 'INVALID_BOUNDARY'
  | 'OPEN_TURN'

/** Typed error for session fork rejections. */
export class SessionForkError extends Error {
  constructor(message: string, public readonly code: SessionForkErrorCode) {
    super(message)
    this.name = 'SessionForkError'
  }
}

/**
 * Compute the fork seed: the contiguous event prefix ending at the requested
 * boundary (or the last event). Rejects a boundary that does not match an
 * existing seq or that ends inside an open turn.
 * @param events - the source session's event log.
 * @param sessionId - the source session id, named in rejection messages.
 * @param requestedBoundary - the inclusive boundary seq, else the last seq.
 * @returns the prefix events to seed the child session with.
 */
export function forkSeed(
  events: readonly SessionEvent[],
  sessionId: SessionId,
  requestedBoundary: number | undefined,
): SessionEvent[] {
  const lastEvent = events.at(-1)
  let boundary: number
  if (requestedBoundary !== undefined) {
    boundary = requestedBoundary
  } else {
    if (lastEvent === undefined) return []
    boundary = lastEvent.seq
  }
  if (!Number.isSafeInteger(boundary) || boundary < 0) {
    throw new SessionForkError(
      `fork boundary for session "${sessionId}" must be a non-negative safe integer, got ${String(boundary)}`,
      'INVALID_BOUNDARY',
    )
  }
  if (boundary >= events.length) {
    const lastSeq = events.at(-1)?.seq
    throw new SessionForkError(
      `fork boundary ${boundary} does not exist in session "${sessionId}" (last seq: ${lastSeq ?? 'none'})`,
      'INVALID_BOUNDARY',
    )
  }

  const boundaryEvent = events[boundary]
  if (boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
    throw new SessionForkError(
      `fork boundary ${boundary} does not match a contiguous event seq in session "${sessionId}"`,
      'INVALID_BOUNDARY',
    )
  }
  const lastTurnBoundary = events.slice(0, boundary + 1)
    .findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (lastTurnBoundary?.type === 'turn/start') {
    throw new SessionForkError(
      `fork boundary ${boundary} in session "${sessionId}" ends inside open turn ${lastTurnBoundary.data.turn}`,
      'OPEN_TURN',
    )
  }

  return events.slice(0, boundary + 1)
}

/**
 * Resolve a fork source to the store's live session instance.
 * @param source - the live session object or its store id.
 * @param get - the store's lookup (`(id) => store.get(id)`).
 * @returns the live session instance; throws `SESSION_NOT_FOUND` /
 *   `SESSION_NOT_LIVE` otherwise.
 */
export function resolveForkSource(
  source: SessionForkSource,
  get: (id: SessionId) => Session | undefined,
): Session {
  if (typeof source === 'string') {
    const session = get(source)
    if (session === undefined) throw new SessionForkError(`session "${source}" not found`, 'SESSION_NOT_FOUND')
    return session
  }

  const live = get(source.id)
  if (live === undefined) {
    throw new SessionForkError(`session "${source.id}" not found`, 'SESSION_NOT_FOUND')
  }
  if (live !== source) throw new SessionForkError(`session "${source.id}" is not the live store instance`, 'SESSION_NOT_LIVE')
  return source
}
