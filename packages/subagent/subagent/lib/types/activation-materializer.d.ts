/**
 * Activation materialization for continuable children: one admitted
 * materialization tracked through publication or rollback, the child Agent
 * creation/resume through the activation-owner scope, and the rollback of an
 * epoch whose start edge was never published.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type SubagentActivationSetupRegistry from './activation-setup-registry.ts';
import type { Activation, ContinuationHost, Materialization, MaterializeInputs } from './continuation-state.ts';
/** The manager surface the materializer drives during publication. */
export interface ActivationMaterializerHooks {
    /** Reject materialization once the manager or this parent tree began draining. */
    assertAdmitting(parent: Agent): void;
    /** Resolve the parent's exact live ancestry for the new Activation. */
    liveLineage(agent: Agent): Agent[];
    /** Register the new child in a continuation-managed parent's owned set. */
    acquireOwnership(parent: Agent, childId: SessionId): void;
    /** Re-arm a settlement watcher after inbox or ownership changes. */
    wake(activation: Activation): void;
    /** Remove one child from its live owner's set on rollback. */
    releaseOwnership(childId: SessionId): void;
    /** Begin following the published Activation to settlement. */
    watchSettlement(activation: Activation): void;
}
/**
 * Creates and resumes continuable child Activations, tracking each admitted
 * materialization until publication or rollback settles.
 */
export declare class ActivationMaterializer {
    private readonly host;
    private readonly setupRegistry;
    /** Structural Cordis owner of every Activation handle. */
    private readonly ownerCtx;
    /** The live Activation registry, written on publication and rollback. */
    private readonly activations;
    /** Materializations admitted before drain, tracked through publication or rollback. */
    private readonly materializations;
    private readonly hooks;
    constructor(host: ContinuationHost, setupRegistry: SubagentActivationSetupRegistry, 
    /** Structural Cordis owner of every Activation handle. */
    ownerCtx: Context, 
    /** The live Activation registry, written on publication and rollback. */
    activations: Map<SessionId, Activation>, 
    /** Materializations admitted before drain, tracked through publication or rollback. */
    materializations: Set<Materialization>, hooks: ActivationMaterializerHooks);
    /**
     * Create or resume the child Agent through the private activation-owner
     * scope, install the handle in a fresh Activation, and register ownership on
     * a continuation-managed parent. Rejection leaves no Activation, no handle,
     * and no ownership membership.
     * @param inputs - the materialization inputs (child identity, provider, parent, creation).
     * @returns the resident Activation for the child.
     */
    materialize(inputs: MaterializeInputs): Promise<Activation>;
    /**
     * Perform one tracked materialization. The caller keeps the drain barrier
     * registered until this either returns a resident Activation or finishes
     * rollback.
     */
    private materializeTracked;
    /**
     * Release an Activation whose start edge was not published. The memoized
     * transaction remains in the live map until handle disposal settles, so a
     * concurrent drain or delivery observes the same closing boundary.
     * @param activation - the unpublished activation to roll back.
     */
    rollbackUnpublished(activation: Activation): Promise<void>;
}
//# sourceMappingURL=activation-materializer.d.ts.map