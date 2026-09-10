import type { TeamId, TeamWaitResult } from './types.ts';
/** Owns current change waiters and releases each at most once. */
export declare class TeamActivity {
    private readonly waiters;
    private closed;
    /**
     * Wait for a later Team or member-status change.
     * @param id - Team whose next edge wakes the caller.
     * @param timeoutMs - integer duration from ten seconds through one hour.
     * @param signal - cancellation of this wait only.
     * @returns whether the wait ended by timeout.
     */
    wait(id: TeamId, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>;
    /**
     * Wake every current waiter for one Team.
     * @param id - Team whose waiters observe the change.
     */
    notify(id: TeamId): void;
    /** Close admission and release current waiters during disposal. */
    close(): void;
}
//# sourceMappingURL=activity.d.ts.map