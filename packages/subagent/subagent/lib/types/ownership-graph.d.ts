/**
 * The live ownership graph of continuable Activations: parent→child edges,
 * manager-wide and scoped admission closing, and lineage resolution. Owns the
 * closing-scope table and the draining flag, so every admission and ownership
 * decision the manager and its components delegate to here reads one table.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { Activation } from './continuation-state.ts';
/** The manager surface the ownership graph reads and re-arms. */
export interface OwnershipGraphHooks {
    /** Read access to the live Activation registry for ownership edges. */
    readonly activations: ReadonlyMap<SessionId, Activation>;
    /** Re-arm a settlement watcher after an ownership release. */
    wake(activation: Activation): void;
}
/**
 * The continuable ownership and admission graph. The manager delegates every
 * ownership mutation, lineage lookup, and admission assertion here.
 */
export declare class OwnershipGraph {
    private readonly ctx;
    private readonly hooks;
    /**
     * Exact roots whose host teardown has begun, with the live lineage members
     * observed under each root. Entries remain until that exact root leaves the
     * Agent registry, closing admission throughout its host's teardown without
     * poisoning a later same-id replacement.
     */
    private readonly closingScopes;
    private draining;
    constructor(ctx: Context, hooks: OwnershipGraphHooks);
    /** Close manager-wide admission; every later assertion rejects. */
    closeAdmission(): void;
    /**
     * Drop one exact closing root when it leaves the Agent registry.
     * @param agent - the exact root whose teardown entry expires.
     */
    forget(agent: Agent): void;
    /**
     * Register the child in a continuation-managed parent's owned set before the
     * child can run, so that parent cannot settle while the child is live. A
     * top-level or other non-continuation Agent has no Activation and stays
     * outside the waiting graph.
     * @param parent - the continuation-managed parent owning the child.
     * @param childId - the child session id to register.
     */
    acquireOwnership(parent: Agent, childId: SessionId): void;
    /**
     * Remove one child from its live owner's set and let that owner re-check settlement.
     * @param childId - the child session id to release.
     */
    releaseOwnership(childId: SessionId): void;
    /**
     * Return the exact currently resolvable ancestry from `agent` upward. The
     * first element is always the supplied identity, even when it is already
     * stale; each ancestor after it must be the registry's current exact entry.
     * @param agent - the agent whose lineage is resolved.
     * @returns the ancestry from the agent upward.
     */
    liveLineage(agent: Agent): Agent[];
    /**
     * Return the retained member set for one exact scoped-teardown root.
     * @param root - the teardown root whose members are tracked.
     * @returns the live lineage members observed under the root.
     */
    closingMembers(root: Agent): Set<Agent>;
    /**
     * The teardown that closed continuable admission for this agent's lineage.
     * `'manager'` is the whole manager draining; an Agent is the exact scoped root
     * whose forest is closing.
     * @param agent - the agent whose lineage is tested.
     * @returns the closing teardown, or `undefined` while admission is open.
     */
    closingTeardownFor(agent: Agent): Agent | 'manager' | undefined;
    /**
     * Reject new admission once the manager or this exact parent tree began draining.
     * @param agent - the agent whose lineage is tested for admission.
     */
    assertAdmitting(agent: Agent): void;
}
//# sourceMappingURL=ownership-graph.d.ts.map