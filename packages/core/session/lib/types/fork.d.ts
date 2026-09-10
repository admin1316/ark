/**
 * Session forking: the fork source vocabulary, typed rejection codes, and the
 * stateless seed/boundary mathematics. `forkSeed` and `resolveForkSource` are
 * pure functions over the store's own queries, so the fork decision logic is
 * testable without a live store.
 *
 * @module @deepseek-ai/dsh-session/fork
 */
import type { Session } from './index.ts';
import type { SessionId } from './types.ts';
import type { SessionEvent } from './types.ts';
/** A fork source: either the live session object or its live store id. */
export type SessionForkSource = Session | SessionId;
/**
 * Rejection codes for session forking: the fork source id is unknown to the
 * live store (`SESSION_NOT_FOUND`) or names a session object that is not the
 * store's live instance (`SESSION_NOT_LIVE`); the requested child id is
 * already taken (`SESSION_ALREADY_EXISTS`); the boundary is not a contiguous
 * existing seq (`INVALID_BOUNDARY`); or the selected prefix ends inside an
 * open turn (`OPEN_TURN`).
 */
export type SessionForkErrorCode = 'SESSION_NOT_FOUND' | 'SESSION_NOT_LIVE' | 'SESSION_ALREADY_EXISTS' | 'INVALID_BOUNDARY' | 'OPEN_TURN';
/** Typed error for session fork rejections. */
export declare class SessionForkError extends Error {
    readonly code: SessionForkErrorCode;
    constructor(message: string, code: SessionForkErrorCode);
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
export declare function forkSeed(events: readonly SessionEvent[], sessionId: SessionId, requestedBoundary: number | undefined): SessionEvent[];
/**
 * Resolve a fork source to the store's live session instance.
 * @param source - the live session object or its store id.
 * @param get - the store's lookup (`(id) => store.get(id)`).
 * @returns the live session instance; throws `SESSION_NOT_FOUND` /
 *   `SESSION_NOT_LIVE` otherwise.
 */
export declare function resolveForkSource(source: SessionForkSource, get: (id: SessionId) => Session | undefined): Session;
//# sourceMappingURL=fork.d.ts.map