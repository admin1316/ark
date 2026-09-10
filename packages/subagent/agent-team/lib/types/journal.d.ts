/** Serialized transactions over the exact Lead Session log. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEventMap, SessionId } from '@deepseek-ai/dsh-session';
import { type TeamEventType, type TeamFoldState } from './fold.ts';
/** Owns per-Lead transaction order and durable Team publication. */
export declare class TeamJournal {
    private readonly ctx;
    private readonly onCommit;
    private readonly tails;
    constructor(ctx: Context, onCommit: (root: Agent) => void);
    /**
     * Fold authoritative state for an exact live Lead.
     * @param root - live Lead Agent.
     * @returns replay state selected by its Team identity.
     */
    state(root: Agent): TeamFoldState;
    /**
     * Serialize one complete read-check-append operation for a Lead.
     * @param rootId - Lead identity selecting the queue.
     * @param operation - admitted asynchronous operation.
     * @returns the operation result.
     */
    transact<T>(rootId: SessionId, operation: () => Promise<T>): Promise<T>;
    /**
     * Append and flush a Team event before notifying observers.
     * @param root - exact live Lead owning the log.
     * @param type - Team event discriminant.
     * @param data - matching event payload.
     */
    appendAndFlush<T extends TeamEventType>(root: Agent, type: T, data: SessionEventMap[T]): Promise<void>;
}
//# sourceMappingURL=journal.d.ts.map