import { foldTeam } from "./fold.js";
/** Owns per-Lead transaction order and durable Team publication. */
export class TeamJournal {
    ctx;
    onCommit;
    tails = new Map();
    constructor(ctx, onCommit) {
        this.ctx = ctx;
        this.onCommit = onCommit;
    }
    /**
     * Fold authoritative state for an exact live Lead.
     * @param root - live Lead Agent.
     * @returns replay state selected by its Team identity.
     */
    state(root) { return foldTeam(root.id, root.session.events); }
    /**
     * Serialize one complete read-check-append operation for a Lead.
     * @param rootId - Lead identity selecting the queue.
     * @param operation - admitted asynchronous operation.
     * @returns the operation result.
     */
    async transact(rootId, operation) {
        const run = (this.tails.get(rootId) ?? Promise.resolve()).then(operation, operation);
        const tail = run.then(() => undefined, () => undefined);
        this.tails.set(rootId, tail);
        try {
            return await run;
        }
        finally {
            if (this.tails.get(rootId) === tail)
                this.tails.delete(rootId);
        }
    }
    /**
     * Append and flush a Team event before notifying observers.
     * @param root - exact live Lead owning the log.
     * @param type - Team event discriminant.
     * @param data - matching event payload.
     */
    async appendAndFlush(root, type, data) {
        root.session.append(type, data);
        await this.ctx.sessions.flush(root.session);
        this.onCommit(root);
    }
}
//# sourceMappingURL=journal.js.map