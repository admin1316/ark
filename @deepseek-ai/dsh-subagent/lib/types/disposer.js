/**
 * Child-first teardown of continuable Activations: the memoized disposal
 * transaction, its child-first release, independent-root aggregation, and the
 * best-effort final session flush.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import { errorChain } from '@deepseek-ai/dsh-llm';
import { SubagentError } from "./error.js";
/**
 * Tears down one or more Activations child-first, preserving the delivery and
 * release ordering the settlement watcher and the parent graph depend on.
 */
export class Disposer {
    hooks;
    constructor(hooks) {
        this.hooks = hooks;
    }
    /**
     * Stop one Activation immediately, then release it child-first. The memoized
     * transaction is installed before cancellation or recursive callbacks, so
     * admission and reentrant teardown converge on the same owner.
     *
     * The final session flush is best effort and never prevents handle disposal
     * or ownership release, because retaining a child would permanently pin its
     * ancestors in `waiting`.
     * @param activation - the residency epoch to stop and release.
     * @returns the one disposal transaction owned by this Activation.
     */
    dispose(activation) {
        const existing = activation.disposal;
        if (existing !== undefined)
            return existing;
        const completion = Promise.withResolvers();
        // Presence is the admission cutoff. Assign it before the async helper starts
        // because that helper cancels Agents and may synchronously re-enter callers.
        activation.disposal = completion.promise;
        void this.finishDisposal(activation).then(completion.resolve, completion.reject);
        return completion.promise;
    }
    /**
     * Propagate stop synchronously, then finish the child-first release.
     * @param activation - the Activation whose disposal transaction is installed.
     * @returns once the handle and ownership edge are released.
     */
    async finishDisposal(activation) {
        this.hooks.wake(activation);
        const { childId } = activation;
        // Stop top-down before the first await. Slow descendant cleanup may delay
        // release, but it cannot let this ancestor continue model or tool work.
        activation.handle.agent.cancel({ kind: 'parent' });
        const idle = activation.handle.agent.whenIdle();
        const children = [...activation.ownedChildren]
            .map(child => this.hooks.activations.get(child))
            .filter((child) => child !== undefined);
        const childDisposals = children.map(child => this.dispose(child));
        const failures = [];
        try {
            // Release remains child-first even though cancellation propagated
            // top-down: every owned child completes before this handle is removed.
            const childFailures = await Promise.all(childDisposals.map(async (disposal) => {
                try {
                    await disposal;
                    return undefined;
                }
                catch (error) {
                    return error;
                }
            }));
            const reasons = childFailures.filter(reason => reason !== undefined);
            if (reasons.length > 0) {
                failures.push(new SubagentError(`subagent "${childId}" child teardown failed: ${reasons.map(reason => errorChain(reason)).join('; ')}`, 'ACTIVATION_TEARDOWN_FAILED'));
            }
            // Quiesce before the flush: a turn still running would keep
            // appending events the flush cannot cover.
            await idle;
            await this.flushFinalState(activation);
            // Capture the child-dependent edge data while the child is still live:
            // handle disposal unregisters it, and consumers read its log and scope.
            activation.observer.capture(activation.handle.agent);
        }
        catch (error) {
            failures.push(new SubagentError(`subagent "${childId}" activation teardown failed: ${errorChain(error)}`, 'ACTIVATION_TEARDOWN_FAILED', { cause: error }));
        }
        try {
            await activation.handle.dispose();
        }
        catch (error) {
            failures.push(new SubagentError(`subagent "${childId}" activation handle disposal failed: ${errorChain(error)}`, 'ACTIVATION_TEARDOWN_FAILED', { cause: error }));
        }
        let failure;
        if (failures.length === 1) {
            failure = failures[0];
        }
        else if (failures.length > 1) {
            failure = new SubagentError(`subagent "${childId}" activation teardown failed at ${failures.length} boundaries: `
                + failures.map(item => errorChain(item)).join('; '), 'ACTIVATION_TEARDOWN_FAILED', { cause: new AggregateError(failures) });
        }
        // Only now is the Activation gone: keeping the entry until disposal settles
        // makes a racing delivery wait for release rather than cold-resume into the
        // still-registered agent.
        this.hooks.activations.delete(childId);
        // BEFORE releasing ownership, while the parent still counts this child and
        // therefore cannot be judged settled. Delivering after the release would
        // race a parent watcher that resumes one microtask later, finds itself
        // childless and quiet, and disposes an Agent whose `cancel()` clears the
        // inbox this notice is sitting in.
        await this.hooks.notifySettlement(activation, activation.observer.terminal(failure));
        // Release ownership even on failure: a retained failed child would pin its
        // ancestors in `waiting` forever.
        this.hooks.releaseOwnership(childId);
        // Emit once the disposal outcome is known, so a rejecting scoped cleanup
        // cannot be reported as a successful epoch.
        activation.observer.settle(failure);
        if (failure !== undefined)
            throw failure;
    }
    /**
     * Dispose independent roots and report every branch failure after all settle.
     * @param roots - the independent Activation roots to dispose.
     * @param failureSubject - the failure report's subject.
     */
    async disposeRoots(roots, failureSubject) {
        const failures = await Promise.all(roots.map(async (activation) => {
            try {
                await this.dispose(activation);
                return undefined;
            }
            catch (error) {
                return error;
            }
        }));
        const reasons = failures.filter(failure => failure !== undefined);
        if (reasons.length > 0) {
            throw new SubagentError(`continuable subagent teardown failed for ${reasons.length} ${failureSubject}: `
                + reasons.map(reason => errorChain(reason)).join('; '), 'ACTIVATION_TEARDOWN_FAILED');
        }
    }
    /**
     * Request a best-effort final session flush after the child is quiescent.
     * Listener failure is logged because flush participation cannot identify a
     * particular persistence backend, and teardown must still release ownership.
     * @param activation - the Activation whose final events should be flushed.
     */
    async flushFinalState(activation) {
        const child = activation.handle.agent;
        try {
            await child.ctx.sessions.flush(child.session);
        }
        catch (error) {
            this.hooks.ctx.logger.warn(`subagent "${activation.childId}" best-effort final session flush failed; `
                + `the persisted state may be unavailable or stale on resume: ${errorChain(error)}`);
        }
    }
}
//# sourceMappingURL=disposer.js.map