/**
 * The live ownership graph of continuable Activations: parent→child edges,
 * manager-wide and scoped admission closing, and lineage resolution. Owns the
 * closing-scope table and the draining flag, so every admission and ownership
 * decision the manager and its components delegate to here reads one table.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import { SubagentError } from "./error.js";
/**
 * The continuable ownership and admission graph. The manager delegates every
 * ownership mutation, lineage lookup, and admission assertion here.
 */
export class OwnershipGraph {
    ctx;
    hooks;
    /**
     * Exact roots whose host teardown has begun, with the live lineage members
     * observed under each root. Entries remain until that exact root leaves the
     * Agent registry, closing admission throughout its host's teardown without
     * poisoning a later same-id replacement.
     */
    closingScopes = new Map();
    draining = false;
    constructor(ctx, hooks) {
        this.ctx = ctx;
        this.hooks = hooks;
    }
    /** Close manager-wide admission; every later assertion rejects. */
    closeAdmission() {
        this.draining = true;
    }
    /**
     * Drop one exact closing root when it leaves the Agent registry.
     * @param agent - the exact root whose teardown entry expires.
     */
    forget(agent) {
        this.closingScopes.delete(agent);
    }
    /**
     * Register the child in a continuation-managed parent's owned set before the
     * child can run, so that parent cannot settle while the child is live. A
     * top-level or other non-continuation Agent has no Activation and stays
     * outside the waiting graph.
     * @param parent - the continuation-managed parent owning the child.
     * @param childId - the child session id to register.
     */
    acquireOwnership(parent, childId) {
        const parentActivation = this.hooks.activations.get(parent.id);
        if (parentActivation === undefined)
            return;
        if (parentActivation.disposal !== undefined) {
            throw new SubagentError(`subagent parent "${parent.id}" is being disposed; the child was not established`, 'ACTIVATION_CLOSING');
        }
        parentActivation.ownedChildren.add(childId);
    }
    /**
     * Remove one child from its live owner's set and let that owner re-check settlement.
     * @param childId - the child session id to release.
     */
    releaseOwnership(childId) {
        for (const candidate of this.hooks.activations.values()) {
            if (candidate.ownedChildren.delete(childId))
                this.hooks.wake(candidate);
        }
    }
    /**
     * Return the exact currently resolvable ancestry from `agent` upward. The
     * first element is always the supplied identity, even when it is already
     * stale; each ancestor after it must be the registry's current exact entry.
     * @param agent - the agent whose lineage is resolved.
     * @returns the ancestry from the agent upward.
     */
    liveLineage(agent) {
        const lineage = [agent];
        const seen = new Set([agent.id]);
        let parentSession = agent.session.header.parentSession;
        while (parentSession !== undefined) {
            const parent = this.ctx.agents.get(parentSession);
            if (parent === undefined || seen.has(parent.id))
                break;
            lineage.push(parent);
            seen.add(parent.id);
            parentSession = parent.session.header.parentSession;
        }
        return lineage;
    }
    /**
     * Return the retained member set for one exact scoped-teardown root.
     * @param root - the teardown root whose members are tracked.
     * @returns the live lineage members observed under the root.
     */
    closingMembers(root) {
        const existing = this.closingScopes.get(root);
        if (existing !== undefined)
            return existing;
        const members = new Set();
        this.closingScopes.set(root, members);
        return members;
    }
    /**
     * The teardown that closed continuable admission for this agent's lineage.
     * `'manager'` is the whole manager draining; an Agent is the exact scoped root
     * whose forest is closing.
     * @param agent - the agent whose lineage is tested.
     * @returns the closing teardown, or `undefined` while admission is open.
     */
    closingTeardownFor(agent) {
        if (this.draining)
            return 'manager';
        const lineage = this.liveLineage(agent);
        for (const [root, members] of this.closingScopes) {
            if (members.has(agent) || lineage.includes(root))
                return root;
        }
        return undefined;
    }
    /**
     * Reject new admission once the manager or this exact parent tree began draining.
     * @param agent - the agent whose lineage is tested for admission.
     */
    assertAdmitting(agent) {
        const closing = this.closingTeardownFor(agent);
        if (closing === undefined)
            return;
        throw new SubagentError(closing === 'manager'
            ? 'continuable subagents are draining; the operation was not admitted'
            : `continuable subagents below parent "${closing.id}" are draining; the operation was not admitted`, 'DRAINING');
    }
}
//# sourceMappingURL=ownership-graph.js.map