/** Shared admission cutoff and bounded Team shutdown. */
import { TeamError } from "./error.js";
/** Owns the cancellation fact shared by all Team runtime operations. */
export class TeamRuntimeLifecycle {
    disposalTimeoutMs;
    controller = new AbortController();
    disposalDeadline;
    constructor(disposalTimeoutMs) {
        this.disposalTimeoutMs = disposalTimeoutMs;
    }
    /** Cancellation shared by all admitted runtime operations. */
    get signal() { return this.controller.signal; }
    /** Whether shutdown has closed admission, independently of completed cleanup. */
    get disposed() { return this.signal.aborted; }
    /** Original cancellation reason used to distinguish shutdown from unexpected failure. */
    get reason() { return this.signal.reason; }
    isCancellation(reason) {
        const seen = new Set();
        let current = reason;
        while (!seen.has(current)) {
            if (this.disposed && current === this.reason)
                return true;
            if (this.disposed && current instanceof TeamError && current.code === 'TEAM_DISPOSED')
                return true;
            if (!(current instanceof Error))
                return false;
            seen.add(current);
            current = current.cause;
        }
        return false;
    }
    /** Close admission and cancel interruptible work. */
    close() {
        if (this.disposed)
            return;
        this.disposalDeadline = Date.now() + this.disposalTimeoutMs;
        this.controller.abort(new TeamError('Agent Teams service disposed', 'TEAM_DISPOSED'));
    }
    /**
     * Await admitted operations and retain failures other than runtime cancellation.
     * @param operations - operations captured after admission closes.
     * @param failures - destination for unexpected rejections or timeouts.
     */
    async settle(operations, failures) {
        if (operations.length === 0)
            return;
        try {
            const outcomes = await this.withTimeout(Promise.allSettled(operations));
            for (const outcome of outcomes) {
                if (outcome.status === 'rejected' && !this.isCancellation(outcome.reason))
                    failures.push(outcome.reason);
            }
        }
        catch (error) {
            failures.push(error);
        }
    }
    /**
     * Bound one shutdown operation.
     * @param operation - settlement that might otherwise wait indefinitely.
     * @returns the operation's result.
     */
    async withTimeout(operation) {
        let timer;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new TeamError(`Agent Teams runtime disposal exceeded ${this.disposalTimeoutMs}ms`, 'TEAM_DISPOSAL_TIMEOUT')), this.disposalDeadline === undefined ? this.disposalTimeoutMs : Math.max(0, this.disposalDeadline - Date.now()));
        });
        try {
            return await Promise.race([operation, timeout]);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
//# sourceMappingURL=lifecycle.js.map