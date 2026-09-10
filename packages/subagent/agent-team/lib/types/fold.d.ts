import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { TeamId, TeamMessageId, TeamTaskId } from './brand.ts';
import type { TeamMemberSnapshot, TeamMessageSnapshot, TeamTaskSnapshot } from './types.ts';
/** Mutable replay state detached from the authoritative log. */
export interface TeamFoldState {
    readonly id: TeamId;
    readonly members: Map<SessionId, TeamMemberSnapshot>;
    readonly memberIdsByName: Map<string, SessionId>;
    readonly tasks: Map<TeamTaskId, TeamTaskSnapshot>;
    readonly messages: Map<TeamMessageId, TeamMessageSnapshot>;
    readonly delivered: Set<TeamMessageId>;
    nextTaskNumber: number;
}
/** Versioned record kinds replayed into the Team projection. */
export type TeamEventType = 'team/member' | 'team/task' | 'team/message/queued' | 'team/message/delivered';
/** Session envelope carrying one Team record. */
export type TeamSessionEvent = SessionEvent<TeamEventType>;
/**
 * Construct an empty fold for a root Session.
 * @param rootId - root identity selecting the Team's records.
 * @returns detached empty state.
 */
export declare function emptyTeamFoldState(rootId: SessionId): TeamFoldState;
/**
 * Identify Team-owned event tags.
 * @param event - candidate Session event.
 * @returns whether the event belongs to the Team domain.
 */
export declare function isTeamEvent(event: SessionEvent): event is TeamSessionEvent;
/**
 * Apply one validated record, ignoring records inherited by another root fork.
 * @param state - mutable Team replay state.
 * @param event - next contiguous Session event.
 */
export declare function applyTeamEvent(state: TeamFoldState, event: SessionEvent): void;
/**
 * Replay the Lead log into the current Team state.
 * @param rootId - root Session identity selecting Team records.
 * @param events - complete contiguous Session log.
 * @returns detached replay state at the supplied log end.
 */
export declare function foldTeam(rootId: SessionId, events: readonly SessionEvent[]): TeamFoldState;
//# sourceMappingURL=fold.d.ts.map