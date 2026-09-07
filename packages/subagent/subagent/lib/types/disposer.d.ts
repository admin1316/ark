/**
 * Child-first teardown of continuable Activations: the memoized disposal
 * transaction, its child-first release, independent-root aggregation, and the
 * best-effort final session flush.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { Activation } from './continuation-state.ts';
import type { ActivationTerminal } from './lifecycle.ts';
/** The manager surface the disposer drives during teardown. */
export interface DisposerHooks {
    readonly ctx: Context;
    /**
     * The live Activation registry: read for owned children and written only
     * when the settling Activation's entry is removed.
     */
    readonly activations: Map<SessionId, Activation>;
    /** Re-arm a settlement watcher when disposal begins. */
    wake(activation: Activation): void;
    /**
     * Tell the durable direct parent that this child settled. Must run before
     * the ownership release that lets that parent settle.
     */
    notifySettlement(activation: Activation, terminal: ActivationTerminal): Promise<void>;
    /** Remove one child from its live owner's set after handle release. */
    releaseOwnership(childId: SessionId): void;
}
/**
 * Tears down one or more Activations child-first, preserving the delivery and
 * release ordering the settlement watcher and the parent graph depend on.
 */
export declare class Disposer {
    private readonly hooks;
    constructor(hooks: DisposerHooks);
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
    dispose(activation: Activation): Promise<void>;
    /**
     * Propagate stop synchronously, then finish the child-first release.
     * @param activation - the Activation whose disposal transaction is installed.
     * @returns once the handle and ownership edge are released.
     */
    private finishDisposal;
    /**
     * Dispose independent roots and report every branch failure after all settle.
     * @param roots - the independent Activation roots to dispose.
     * @param failureSubject - the failure report's subject.
     */
    disposeRoots(roots: readonly Activation[], failureSubject: 'activation(s)' | 'scoped activation(s)' | 'selected activation(s)'): Promise<void>;
    /**
     * Request a best-effort final session flush after the child is quiescent.
     * Listener failure is logged because flush participation cannot identify a
     * particular persistence backend, and teardown must still release ownership.
     * @param activation - the Activation whose final events should be flushed.
     */
    private flushFinalState;
}
//# sourceMappingURL=disposer.d.ts.map