/** Complete dependency validation for active Team tasks. */
import type { TeamTaskId, TeamTaskSnapshot } from './types.ts';
/** Dependency failures mapped to stable Team command errors. */
export type TeamTaskGraphViolation = 'missing' | 'duplicate' | 'cycle';
/** Task dependency error retained for command error mapping. */
export declare class TeamTaskGraphError extends Error {
    readonly violation: TeamTaskGraphViolation;
    constructor(message: string, violation: TeamTaskGraphViolation);
}
/**
 * Validate the entire active task graph with one candidate replacement.
 * @param current - task snapshots before the proposed event.
 * @param candidate - new or next-revision task snapshot.
 * @throws for missing, duplicate, self-referential, or cyclic dependencies.
 */
export declare function assertTaskGraphCandidate(current: ReadonlyMap<TeamTaskId, TeamTaskSnapshot>, candidate: TeamTaskSnapshot): void;
//# sourceMappingURL=task-graph.d.ts.map