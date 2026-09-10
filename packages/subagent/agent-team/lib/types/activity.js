/** One-shot Team waiters, separate from durable state projection. */
import { TeamError, errorMessage } from "./error.js";
/** Owns current change waiters and releases each at most once. */
export class TeamActivity {
    waiters = new Map();
    closed = false;
    /**
     * Wait for a later Team or member-status change.
     * @param id - Team whose next edge wakes the caller.
     * @param timeoutMs - integer duration from ten seconds through one hour.
     * @param signal - cancellation of this wait only.
     * @returns whether the wait ended by timeout.
     */
    async wait(id, timeoutMs, signal) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
            throw new TeamError('timeoutMs must be an integer from 10000 through 3600000', 'TEAM_INVALID_TIMEOUT');
        }
        signal.throwIfAborted();
        if (this.closed)
            return { timedOut: false };
        const changed = await new Promise((resolve, reject) => {
            const waiters = this.waiters.get(id) ?? new Set();
            this.waiters.set(id, waiters);
            let settled = false;
            const finish = (settle) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                waiters.delete(waiter);
                if (waiters.size === 0)
                    this.waiters.delete(id);
                settle();
            };
            const onAbort = () => {
                finish(() => {
                    const reason = signal.reason;
                    reject(reason instanceof Error ? reason : new TeamError(`wait_agent aborted: ${errorMessage(reason)}`, 'TEAM_WAIT_ABORTED'));
                });
            };
            const waiter = { resolve: () => finish(() => resolve(true)) };
            waiters.add(waiter);
            const timer = setTimeout(() => finish(() => resolve(false)), timeoutMs);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted)
                onAbort();
        });
        return { timedOut: !changed };
    }
    /**
     * Wake every current waiter for one Team.
     * @param id - Team whose waiters observe the change.
     */
    notify(id) {
        const waiters = this.waiters.get(id);
        if (waiters === undefined)
            return;
        this.waiters.delete(id);
        for (const waiter of waiters)
            waiter.resolve();
    }
    /** Close admission and release current waiters during disposal. */
    close() {
        this.closed = true;
        for (const waiters of this.waiters.values())
            for (const waiter of waiters)
                waiter.resolve();
        this.waiters.clear();
    }
}
//# sourceMappingURL=activity.js.map