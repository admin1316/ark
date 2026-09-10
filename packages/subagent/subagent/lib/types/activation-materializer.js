/**
 * Activation materialization for continuable children: one admitted
 * materialization tracked through publication or rollback, the child Agent
 * creation/resume through the activation-owner scope, and the rollback of an
 * epoch whose start edge was never published.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import { appendDelegatedPolicyOverrides, applyChildComposition } from "./child-agent.js";
/**
 * Creates and resumes continuable child Activations, tracking each admitted
 * materialization until publication or rollback settles.
 */
export class ActivationMaterializer {
    host;
    setupRegistry;
    ownerCtx;
    activations;
    materializations;
    hooks;
    constructor(host, setupRegistry, 
    /** Structural Cordis owner of every Activation handle. */
    ownerCtx, 
    /** The live Activation registry, written on publication and rollback. */
    activations, 
    /** Materializations admitted before drain, tracked through publication or rollback. */
    materializations, hooks) {
        this.host = host;
        this.setupRegistry = setupRegistry;
        this.ownerCtx = ownerCtx;
        this.activations = activations;
        this.materializations = materializations;
        this.hooks = hooks;
    }
    /**
     * Create or resume the child Agent through the private activation-owner
     * scope, install the handle in a fresh Activation, and register ownership on
     * a continuation-managed parent. Rejection leaves no Activation, no handle,
     * and no ownership membership.
     * @param inputs - the materialization inputs (child identity, provider, parent, creation).
     * @returns the resident Activation for the child.
     */
    materialize(inputs) {
        this.hooks.assertAdmitting(inputs.parent);
        const settled = Promise.withResolvers();
        const lineage = this.hooks.liveLineage(inputs.parent);
        const materialization = {
            lineage,
            settled: settled.promise,
        };
        this.materializations.add(materialization);
        return this.materializeTracked(inputs, lineage).finally(() => {
            this.materializations.delete(materialization);
            settled.resolve();
        });
    }
    /**
     * Perform one tracked materialization. The caller keeps the drain barrier
     * registered until this either returns a resident Activation or finishes
     * rollback.
     */
    async materializeTracked(inputs, parentLineage) {
        const { childId, provider, parent, create } = inputs;
        // No id pre-check here: the child lock serializes each durable child, both
        // callers reach this only after confirming no Activation exists, and
        // `AgentRegistry.enter()` is the authoritative collision boundary for an id
        // some other owner holds — a duplicate would reject there with rollback.
        inputs.signal.throwIfAborted();
        const setup = (childCtx) => {
            // Only fresh creation seeds the delegation policy onto the child's own
            // log (after any fork seed, so fresh policy wins stale seed state); a
            // cold resume replays those persisted events instead.
            if (create !== undefined) {
                appendDelegatedPolicyOverrides(childCtx.agent.session, create.delegatedPolicies);
            }
            applyChildComposition(childCtx, parent, inputs.composition);
            return this.setupRegistry.apply(childCtx);
        };
        const observer = this.host.observeActivation(provider, childId, parent);
        // Agent creation owns rollback before handle transfer. A rejection leaves
        // no resident Activation and therefore publishes no lifecycle edge.
        const handle = create === undefined
            ? await this.ownerCtx.agents.resume({
                resumeSessionId: childId,
                agentOptions: inputs.agentOptions,
                signal: inputs.signal,
                setup,
            })
            : await this.ownerCtx.agents.create({
                sessionId: childId,
                meta: create.meta,
                seed: create.seed,
                agentOptions: inputs.agentOptions,
                signal: inputs.signal,
                setup,
            });
        const activation = {
            childId,
            // The durable lineage, not merely the caller: creation stamps this same
            // agent into the child's header, and cold resume authorized it against
            // the persisted header before materializing.
            parentSession: parent.id,
            provider,
            handle,
            ancestry: new WeakSet([handle.agent, ...parentLineage]),
            ownedChildren: new Set(),
            observer,
            disposal: undefined,
            accepted: new Set(),
            handoffHolds: 0,
            announced: false,
            poke: Promise.withResolvers(),
        };
        // After transfer, any failure must dispose the created handle, remove the
        // Activation, and roll back parent ownership before rejecting.
        this.activations.set(childId, activation);
        try {
            inputs.signal.throwIfAborted();
            this.hooks.assertAdmitting(parent);
            this.hooks.acquireOwnership(parent, childId);
            // Every accepted id leaves the inbox exactly once, through dequeue or
            // discard. Clearing it there is what lets `stateOf()` distinguish a truly
            // quiet Agent from one whose accepted turn has not been admitted yet.
            // Registered through the child's own scoped context, so scope filtering
            // already restricts both listeners to this exact agent.
            handle.agent.ctx.on('agent/inbox/claimed', ({ message }) => {
                /* v8 ignore next -- a claim of an id this manager never admitted needs
                 * another sender on the same child, which no current path allows. */
                if (activation.accepted.delete(message.id))
                    this.hooks.wake(activation);
            });
            handle.agent.ctx.on('agent/inbox/discarded', ({ message }) => {
                if (activation.accepted.delete(message.id))
                    this.hooks.wake(activation);
            });
            // Agent creation committed setup at its publication boundary;
            // revocations from here on are immediate live revocation.
            // Publish the start edge before any turn can run, so observers see this
            // epoch before its first request.
            observer.start(handle.agent);
        }
        catch (error) {
            // Listener exceptions are contained by the lifecycle emitter; a start
            // publication throw therefore leaves no residency edge to pair.
            /* v8 ignore next -- rollback failure must not mask the admission failure
             * that prevented this operation from returning an accepted message id. */
            await this.rollbackUnpublished(activation).catch(() => undefined);
            throw error;
        }
        this.hooks.watchSettlement(activation);
        return activation;
    }
    /**
     * Release an Activation whose start edge was not published. The memoized
     * transaction remains in the live map until handle disposal settles, so a
     * concurrent drain or delivery observes the same closing boundary.
     * @param activation - the unpublished activation to roll back.
     */
    rollbackUnpublished(activation) {
        return (activation.disposal ??= (async () => {
            try {
                await activation.handle.dispose();
            }
            finally {
                this.activations.delete(activation.childId);
                this.hooks.releaseOwnership(activation.childId);
            }
        })());
    }
}
//# sourceMappingURL=activation-materializer.js.map