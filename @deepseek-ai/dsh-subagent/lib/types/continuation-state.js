/**
 * Shared residency state, materialization contracts, and serialization
 * machinery for the continuable-subagent manager and its domain components —
 * the ownership graph, the activation materializer, the settlement watcher,
 * and the disposer. Kept in one module so the split classes never import
 * runtime bindings back from the manager file they were extracted from.
 *
 * @module @deepseek-ai/dsh-subagent
 */
/**
 * Read one Activation's current disposal transaction. This indirection exists
 * because TypeScript would otherwise narrow repeated reads of the mutable field
 * inside a long-lived closure to constants instead of re-reading runtime state.
 * @param activation - the Activation to inspect.
 * @returns the in-flight or settled disposal, or `undefined` while resident.
 */
export function disposalOf(activation) {
    return activation.disposal;
}
/**
 * One line telling a parent that a background child is finished and why, in
 * the parent's own task vocabulary.
 * @param childId - the durable child the parent knows by id.
 * @param stopReason - how the child's last ordinary turn ended.
 * @returns the model-facing opening line of the settlement notice.
 */
export function settlementSummary(childId, stopReason) {
    const subject = `Background subagent ${childId}`;
    switch (stopReason) {
        case 'completed':
            return `${subject} finished and will do no further work unless you send it more.`;
        case 'aborted':
            return `${subject} was stopped before it finished.`;
        case 'max-tokens':
            return `${subject} ran out of room before it finished.`;
        // A pre-step rejection — a hook deny, a policy plugin — discarded input
        // the child had claimed, so the parent must not treat the task as done.
        case 'refusal':
            return `${subject} declined the task.`;
        case 'error':
            return `${subject} failed before it finished.`;
        /* v8 ignore next 4 -- `SubagentResult['stopReason']` is merge-extensible, so this arm
         * needs a backend that adds a variant; an unnameable ending is reported as unfinished
         * rather than silently as success. */
        default:
            return `${subject} ended abnormally (${String(stopReason)}) before it finished.`;
    }
}
/** Serialize each durable child's delivery, release, and disposal. */
export class ChildLock {
    tails = new Map();
    /**
     * Run `operation` after every previously queued operation for `childId`.
     * @param childId - the durable child whose operations are linearized.
     * @param operation - the critical section to run in order.
     * @returns the operation's own settlement.
     */
    run(childId, operation) {
        const previous = this.tails.get(childId) ?? Promise.resolve();
        const result = previous.then(operation, operation);
        // Absorb rejections in the chaining tail so one failed critical section
        // cannot reject an unrelated later caller.
        const tail = result.then(() => undefined, () => undefined);
        this.tails.set(childId, tail);
        void tail.then(() => {
            if (this.tails.get(childId) === tail)
                this.tails.delete(childId);
        });
        return result;
    }
}
//# sourceMappingURL=continuation-state.js.map