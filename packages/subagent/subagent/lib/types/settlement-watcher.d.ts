/**
 * Settlement observation and parent delivery for continuable Activations:
 * following one epoch to quiescence and owned-child release, then telling the
 * durable direct parent how the child ended.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ActivationTerminal } from './lifecycle.ts';
import type { Activation, ChildLock } from './continuation-state.ts';
/** The manager surface the settlement watcher drives. */
export interface SettlementWatcherHooks {
    readonly ctx: Context;
    /** Per-child lock serializing delivery, release, and disposal. */
    readonly locks: ChildLock;
    /** Open the Activation's disposal transaction; admission converges on it. */
    dispose(activation: Activation): Promise<void>;
    /** The closing teardown for a lineage, or `undefined` while admission is open. */
    closingTeardownFor(agent: Agent): Agent | 'manager' | undefined;
    /** Account one waking send across a resident Activation's settlement window. */
    sendWaking(parent: Agent, message: ReturnType<typeof createUserMessage>, send: () => void): void;
}
/**
 * Follows each Activation to settlement and delivers its closing account to
 * the durable direct parent.
 */
export declare class SettlementWatcher {
    private readonly hooks;
    constructor(hooks: SettlementWatcherHooks);
    /**
     * Follow one Activation to settlement: wait for Agent quiescence, then for
     * every owned child to complete disposal, and dispose the handle once both
     * hold. A `next-turn` delivered while `waiting` wakes the same Agent and
     * returns it to `running`, so this re-observes rather than settling early.
     * @param activation - the activation to follow to settlement.
     */
    watchSettlement(activation: Activation): void;
    /**
     * Tell the durable direct parent that this child produced everything it is
     * going to. Unconditional for every child the caller received an id for: it
     * does not consider whether the child reported, because the cases that most
     * need it — a token ceiling, a model failure, cancellation, teardown — are
     * exactly the ones where the child never got to choose. A materialization
     * rolled back before its first acceptance stays silent, since the caller was
     * told that child was not established. A parent that is no longer live is not
     * an error; the child's own Session remains the durable record either way.
     * A parent whose own lineage is already closing receives the notice without a
     * wake, because teardown is not a reason to start a turn.
     *
     * Delivery is flushed through the parent's existing Session persistence
     * owner before ownership is released. Failures are logged and contained so a
     * broken parent cannot pin the child forever. A stable settlement id prevents
     * duplicate insertion if this boundary is re-entered, while a byte-identical
     * explicit report suppresses repeated closing content.
     * @param activation - the settling Activation, still owned by its parent.
     * @param terminal - how this epoch ended, as the terminal edge will report it.
     */
    notifySettlement(activation: Activation, terminal: ActivationTerminal): Promise<void>;
    /** Require the parent inbox insertion to cross its existing durability barrier. */
    private flushParent;
    /** Whether this child epoch's stable settlement account was already inserted. */
    private hasSettlement;
    /** Find an explicit report carrying the exact closing content. */
    private matchingReport;
    /** Search newest-first without materializing a long parent transcript. */
    private findParentMessage;
    /**
     * Derive residency from Agent quiescence and the owned-child set. `running`
     * covers an active admission, an open turn, or accepted waking inbox work.
     *
     * `Agent.status` alone is insufficient: it stays `idle` between an accepted
     * waking send and the microtask that admits it, so a synchronous inbox
     * observer would see `settled` while a turn is already queued. `accepted`
     * holds the ids this manager admitted but has not yet seen drained.
     */
    private stateOf;
}
//# sourceMappingURL=settlement-watcher.d.ts.map