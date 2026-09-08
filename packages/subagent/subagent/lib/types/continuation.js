/**
 * Internal continuable-subagent manager: stable child ids, descriptor
 * persistence, activation admission, the live ownership graph, cold resume,
 * child-first disposal, and settlement delivery to the parent, behind
 * `ctx.subagents`.
 *
 * A continuable child has one durable Session and at most one process-local
 * {@link Activation} — one residency epoch for a reconstructed child Agent. An
 * Activation is not a request, result, cancellation, or Task boundary: it may
 * execute many FIFO turns and stays resident while descendants it created are
 * still running. The Agent inbox is the only turn queue, so this manager owns
 * residency while the Agent loop owns all turn ordering and execution. No
 * continuable path creates a Task or an intermediate result-bearing wrapper.
 *
 * Because residency is this manager's alone to end, telling the parent that a
 * child settled is its job too. An external `subagent/end` listener cannot do
 * it correctly: that payload names no parent, the child handle is already
 * disposed by then, and the release that wakes the parent's own settlement
 * watcher has already run. See {@link SubagentContinuationManager.notifySettlement}.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { foldSubagentDescriptor, snapshotSubagentDescriptor } from "./descriptor.js";
import { captureDelegatedPolicyOverrides, childSessionMeta, resolveChildAgentOptions, resolveChildDepth, } from "./child-agent.js";
import { assertSubagentMaxDepth } from "./depth.js";
import { seedDescriptorTurn } from "./descriptor-seed.js";
import { SubagentError } from "./error.js";
import { ActivationMaterializer } from "./activation-materializer.js";
import { ChildLock, disposalOf } from "./continuation-state.js";
import { Disposer } from "./disposer.js";
import { OwnershipGraph } from "./ownership-graph.js";
import { SettlementWatcher } from "./settlement-watcher.js";
/**
 * The continuable-subagent orchestration service behind `ctx.subagents`. Tool
 * schema and host adapters are consumers of this one contract; foreground
 * one-shot delegation keeps calling `ctx.subagents.start()` and never enters
 * this lifecycle.
 */
export class SubagentContinuationManager {
    ctx;
    host;
    /** Child session id → its live Activation. Process-local, never durable. */
    activations = new Map();
    /** Materializations admitted before drain, tracked through publication or rollback. */
    materializations = new Set();
    locks = new ChildLock();
    ownership;
    materializer;
    disposer;
    settlementWatcher;
    /** Structural Cordis owner of every Activation handle. */
    ownerCtx;
    constructor(ctx, host, setupRegistry) {
        this.ctx = ctx;
        this.host = host;
        // Ordinary Cordis owner effects unwind in reverse registration order, which
        // cannot express the dynamic child graph. Register the private scope's
        // structural disposer FIRST and the drain SECOND, so reverse unwind invokes
        // the drain before releasing the scope; a cleanup effect on the same scope
        // as the Agent handles would let structural handle disposal bypass
        // child-first ordering.
        const scope = ctx.plugin(function activationOwner() { });
        this.ownerCtx = scope.ctx;
        this.ownership = new OwnershipGraph(ctx, {
            activations: this.activations,
            wake: (activation) => { this.wake(activation); },
        });
        this.disposer = new Disposer({
            ctx,
            activations: this.activations,
            wake: (activation) => { this.wake(activation); },
            notifySettlement: (activation, terminal) => this.settlementWatcher.notifySettlement(activation, terminal),
            releaseOwnership: (childId) => { this.ownership.releaseOwnership(childId); },
        });
        this.settlementWatcher = new SettlementWatcher({
            ctx,
            locks: this.locks,
            dispose: activation => this.disposer.dispose(activation),
            closingTeardownFor: agent => this.ownership.closingTeardownFor(agent),
            sendWaking: (parent, message, send) => { this.sendWaking(parent, message, send); },
        });
        this.materializer = new ActivationMaterializer(host, setupRegistry, this.ownerCtx, this.activations, this.materializations, {
            assertAdmitting: (parent) => { this.ownership.assertAdmitting(parent); },
            liveLineage: agent => this.ownership.liveLineage(agent),
            acquireOwnership: (parent, childId) => { this.ownership.acquireOwnership(parent, childId); },
            wake: (activation) => { this.wake(activation); },
            releaseOwnership: (childId) => { this.ownership.releaseOwnership(childId); },
            watchSettlement: (activation) => { this.settlementWatcher.watchSettlement(activation); },
        });
        ctx.on('agent/disposed', ({ agent }) => {
            this.ownership.forget(agent);
        });
        ctx.effect(function* () {
            yield scope.dispose;
            yield () => this.drain();
        }.bind(this), 'subagents.continuations()');
    }
    /**
     * Start one continuable background child: reserve its durable identity,
     * resolve the provider's detached creation spec, create the child Agent
     * through the private activation-owner scope, establish any continuable-parent
     * ownership, and submit the initial prompt. Resolves when the accepted inbox
     * insertion reaches Session persistence, without waiting for the turn to
     * finish.
     *
     * Every failure before that acceptance rejects without either id, disposing
     * any created handle and rolling back the Activation and parent ownership.
     * The caller signal owns lookup, materialization, and admission only until
     * acceptance; afterwards the manager owns the Activation independently.
     * @param spec - provider, delegation request, and caller cancellation.
     * @returns the durable child id and the accepted initial prompt's message id.
     */
    async startContinuable(spec) {
        const request = spec.request;
        const parent = request.parent;
        this.ownership.assertAdmitting(parent);
        const persistence = this.requirePersistence();
        assertSubagentMaxDepth(request.maxDepth);
        const childId = spec.childId ?? SessionId(randomUUID());
        this.assertChildIdAvailable(childId);
        const childDepth = resolveChildDepth(parent, request.maxDepth);
        // Snapshot before any await: invalid descriptor JSON rejects the call
        // before a child exists, and the detached value is what reaches the log.
        const agentProvider = request.agentOptions?.provider ?? parent.options.provider;
        const agentModel = request.agentOptions?.model ?? parent.options.model;
        const descriptor = snapshotSubagentDescriptor({
            mode: 'continuable',
            provider: spec.provider,
            label: spec.label,
            ...agentProvider !== undefined ? { agentProvider } : {},
            ...agentModel !== undefined ? { agentModel } : {},
            ...request.persona !== undefined ? { persona: request.persona } : {},
            ...request.toolFilter !== undefined ? { toolFilter: request.toolFilter } : {},
        });
        // Capture before the first await: a later parent switch belongs to the
        // parent's future, not to this child.
        const delegatedPolicies = captureDelegatedPolicyOverrides(parent);
        const prepared = await this.host.prepareContinuable(spec.provider, {
            sessionId: childId,
            parent,
            signal: spec.signal,
        });
        spec.signal.throwIfAborted();
        this.ownership.assertAdmitting(parent);
        const lineageSeedLength = prepared.seed?.length ?? 0;
        const seed = seedDescriptorTurn(childId, prepared.seed, descriptor);
        const receipt = await this.locks.run(childId, async () => {
            spec.signal.throwIfAborted();
            this.ownership.assertAdmitting(parent);
            this.assertChildIdAvailable(childId);
            if (spec.childId !== undefined) {
                const persisted = await persistence.listSnapshots(spec.signal);
                spec.signal.throwIfAborted();
                this.ownership.assertAdmitting(parent);
                this.assertChildIdAvailable(childId);
                if (persisted.some(snapshot => snapshot.header.id === childId)) {
                    throw new SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD');
                }
            }
            const activation = await this.materializer.materialize({
                childId,
                provider: spec.provider,
                parent,
                create: { seed, meta: childSessionMeta(parent, childDepth, lineageSeedLength), delegatedPolicies },
                agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
                composition: { persona: request.persona, toolFilter: request.toolFilter },
                signal: spec.signal,
            });
            return this.submitMaterialized(activation, createUserMessage({ content: request.prompt, source: { kind: 'user' } }), parent, spec.signal);
        });
        // Durability adds an await after inbox acceptance. Preserve the established
        // handoff guarantee that the caller can immediately address the returned
        // child (including creating a nested child) before the settlement watcher
        // retires a very fast first turn. The hold is process-local bookkeeping on
        // the existing Activation and is released on the next task turn.
        this.holdReceiptHandoff(childId);
        await Promise.resolve();
        return { childId, messageId: receipt.messageId, durable: true };
    }
    /** Reject one child identity already owned by a live Agent or Session. */
    assertChildIdAvailable(childId) {
        if (this.ctx.agents.get(childId) !== undefined || this.ctx.get('sessions')?.get(childId) !== undefined) {
            throw new SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD');
        }
    }
    /**
     * Deliver one later message to a known continuable child as its next FIFO
     * turn. Routing depends only on Activation residency: a `running` Activation
     * enqueues, a `waiting` one wakes the same Agent, and an absent one
     * cold-resumes a new Activation from the persisted Session. The Agent inbox
     * is the only queue, so every accepted message has one observable order.
     *
     * The caller signal owns lookup, materialization, and admission only until
     * inbox acceptance; the subsequent durability wait is not caller-cancellable,
     * so an accepted turn cannot become an ambiguous cancellation.
     * @param parent - the exact live direct parent authorizing this delivery.
     * @param childId - the durable child session id.
     * @param content - the user-role content to deliver.
     * @param options - the message source fields and caller cancellation.
     * @returns the accepted message's inbox id.
     * @throws when parent authority, availability, or admission rejects the delivery.
     */
    async followup(parent, childId, content, options) {
        return (await this.followupReceipt(parent, childId, content, options)).messageId;
    }
    /**
     * Deliver one message and return its durable/idempotent receipt. Native uses
     * this richer boundary; model-facing callers retain the MessageId-only API.
     * A new delivery enters the child's FIFO inbox, cold-resuming it if absent.
     * An exact invocation retry returns the original id without another turn;
     * reusing the key with different content or parent identity rejects.
     * After inbox acceptance, the durability wait is not caller-cancellable.
     * A persistence failure rejects without retracting the accepted message.
     * @param parent - Exact live direct parent authorizing this delivery.
     * @param childId - Durable child session id, stable across activations.
     * @param content - User-role content to enqueue, or match on an invocation retry.
     * @param options - Durable source, optional idempotency key, and pre-acceptance
     *   cancellation. A `subagent-prompt` source requires a matching canonical UUID
     *   `invocationId` and the direct parent's `senderSessionId`; other sources omit the key.
     * @returns The new or original message id with `durable: true` after persistence
     *   is established, and `duplicate` indicating a retry; it does not await turn completion.
     * @throws When authority, invocation identity, admission, materialization, or
     *   persistence fails, or caller cancellation prevents new inbox acceptance.
     */
    async followupReceipt(parent, childId, content, options) {
        this.ownership.assertAdmitting(parent);
        const message = createUserMessage({ content, source: options.source });
        this.assertInvocationContract(message, options.invocationId, parent.id);
        while (true) {
            const live = await this.locks.run(childId, async () => {
                const activation = this.activations.get(childId);
                if (activation === undefined)
                    return this.coldResume(parent, childId, message, options);
                // A delivery that arrives after the disposal transaction began must not
                // reach a handle being torn down; wait for release, then cold-resume.
                /* v8 ignore next 3 -- the send-versus-dispose cutoff: reaching this arm needs a
                 * delivery to observe the transaction inside the same critical section that opened it,
                 * which no test can schedule deterministically. The behavior is covered end-to-end by
                 * "cold-resumes a delivery that lost the race with final disposal". */
                if (activation.disposal !== undefined) {
                    return activation.disposal.then(() => undefined, () => undefined);
                }
                this.authorizeLineage(parent, activation.childId, activation.handle.agent.session.header.parentSession);
                const duplicate = this.invocationReceipt(activation.handle.agent.session.events, message, options.invocationId);
                if (duplicate !== undefined) {
                    await this.flushAccepted(activation);
                    return duplicate;
                }
                return this.submitAndFlush(activation, message, parent, options.signal);
            });
            /* v8 ignore start -- only the lost-cutoff arm above returns undefined, so only that
             * race reaches the retry below, which then cold-resumes a new Activation. */
            if (live !== undefined)
                return live;
            this.ownership.assertAdmitting(parent);
            options.signal.throwIfAborted();
            /* v8 ignore stop */
        }
    }
    /**
     * Interrupt one live continuable child's current turn. Admission is
     * synchronous and the effect is asynchronous: this authorizes the caller,
     * requests `Agent.cancel(cause, { keepInbox: true })` on the target, and
     * returns without waiting for the target to observe the signal or reach
     * quiescence. The Activation, its handle, accepted unclaimed inbox work, and
     * already-published descendants are untouched; work already claimed into the
     * interrupted turn is not requeued. Once the interrupted driver is idle, a
     * waking send resumes the parked queue.
     *
     * An absent target is an accepted no-op, which uniformly covers natural
     * completion races, repeated requests, one-shot ids, and unknown ids without
     * consulting the durable catalog. A target whose disposal transaction is
     * already open is likewise an accepted no-op after authorization.
     * @param targetSessionId - the durable child session id to interrupt.
     * @param authority - the human parent address or exact live ancestor Agent.
     * @throws {SubagentError} `UNAUTHORIZED` when the presented authority does
     *   not own the live target: a stale or self-targeting ancestor caller, a
     *   parent address that is not the live target's durable direct parent, or
     *   an ancestor outside the target's recorded live lineage.
     */
    interrupt(targetSessionId, authority) {
        if (authority.kind === 'ancestor') {
            const caller = authority.agent;
            // A stale caller is rejected even when the target is absent, so a
            // replaced same-id Agent can never probe this manager's state.
            if (this.ctx.agents.get(caller.id) !== caller) {
                throw new SubagentError(`interrupting "${targetSessionId}" requires the exact live ancestor agent`, 'UNAUTHORIZED');
            }
            if (caller.id === targetSessionId) {
                throw new SubagentError(`agent "${caller.id}" cannot interrupt itself`, 'UNAUTHORIZED');
            }
        }
        const activation = this.activations.get(targetSessionId);
        if (activation === undefined)
            return;
        if (authority.kind === 'user') {
            if (activation.handle.agent.session.header.parentSession !== authority.parentSessionId) {
                throw new SubagentError(`subagent "${targetSessionId}" belongs to another parent session`, 'UNAUTHORIZED');
            }
        }
        else if (!activation.ancestry.has(authority.agent)) {
            throw new SubagentError(`subagent "${targetSessionId}" is not a live descendant of agent "${authority.agent.id}"`, 'UNAUTHORIZED');
        }
        // Disposal already stopped the target with a whole-Activation teardown;
        // a second cancel would be a redundant signal on a closing handle.
        if (activation.disposal !== undefined)
            return;
        activation.handle.agent.cancel(authority.kind === 'user' ? { kind: 'user' } : { kind: 'parent' }, { keepInbox: true });
    }
    /**
     * Deliver explicitly selected content from one resident continuable child to
     * its durable direct parent. Sender authorization, parent resolution, and
     * send acceptance share one no-await span. Reporting neither concludes the
     * child's turn nor changes its Activation lifetime.
     * @param child - exact live reporting child; this is the authority credential.
     * @param content - selected model-facing content.
     * @param options - scheduling policy and pre-acceptance cancellation.
     * @returns the stable identity of the message accepted by the parent.
     * @throws {SubagentError} when the sender is unauthorized, the parent is not
     *   live, or continuation admission is closing.
     */
    // oxlint-disable-next-line typescript/require-await -- keep rejection semantics without yielding during admission
    async reportFrom(child, content, options) {
        options.signal.throwIfAborted();
        this.ownership.assertAdmitting(child);
        const activation = this.authorizeReporter(child);
        const parent = this.resolveReportParent(child);
        return this.deliverReport(activation, parent, content, options.delivery);
    }
    /** Authorize only the exact Agent of one resident Activation. */
    authorizeReporter(child) {
        const activation = this.activations.get(child.id);
        if (activation === undefined || activation.handle.agent !== child) {
            throw new SubagentError(`agent "${child.id}" is not a live continuable subagent and cannot report`, 'UNAUTHORIZED');
        }
        /* v8 ignore next 6 -- only a synchronous re-entrant disposer can open this
         * transaction between exact-agent authorization and this no-await cutoff. */
        if (activation.disposal !== undefined) {
            throw new SubagentError(`subagent "${child.id}" activation is being disposed; the report was not delivered`, 'ACTIVATION_CLOSING');
        }
        return activation;
    }
    /** Resolve the reporting child's live direct parent from durable lineage. */
    resolveReportParent(child) {
        const parentId = child.session.header.parentSession;
        /* v8 ignore next -- every continuation-managed child has direct-parent metadata. */
        const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId);
        if (parent === undefined) {
            throw new SubagentError('direct parent is not live; report was not delivered', 'PARENT_UNAVAILABLE');
        }
        return parent;
    }
    /** Deliver one framed report through the selected parent scheduling preset. */
    deliverReport(activation, parent, content, delivery) {
        const message = createUserMessage({
            content: [
                { type: 'text', text: `Background subagent ${activation.childId} reported:` },
                ...content,
            ],
            source: {
                kind: 'subagent-report',
                form: 'relay',
                senderSessionId: activation.childId,
            },
        });
        if (delivery === 'next-step') {
            this.sendWaking(parent, message, () => { this.sendReport(parent, message, delivery); });
        }
        else {
            this.sendReport(parent, message, delivery);
        }
        return message.id;
    }
    /**
     * Perform one waking send to a parent, accounted against that parent's own
     * Activation when it has one. Registering the id before the send is what
     * keeps a continuation-managed parent from being judged quiescent in the
     * window between a waking send and the microtask that admits it.
     * @param parent - the exact live parent receiving the waking message.
     * @param message - the message whose id is accounted.
     * @param send - the synchronous waking send to perform.
     */
    sendWaking(parent, message, send) {
        const parentActivation = this.activations.get(parent.id);
        if (parentActivation !== undefined && parentActivation.handle.agent === parent) {
            this.admitWaking(parentActivation, message.id, send);
        }
        else {
            send();
        }
    }
    /** Send one report while translating only the parent's own rejection. */
    sendReport(parent, message, delivery) {
        try {
            if (delivery === 'next-step')
                parent.steer(message);
            else
                parent.inject(message);
        }
        catch (error) {
            throw new SubagentError('direct parent is not live; report was not delivered', 'PARENT_UNAVAILABLE', { cause: error });
        }
    }
    /**
     * Close admission, await every already-admitted materialization through
     * publication or rollback, then dispose the stable live Activation forest
     * child-first. Sibling branches drain independently: one failure is recorded
     * but never prevents the remaining handles from being attempted, and the
     * aggregate rejects only after every branch settles.
     * @returns once materialization is quiescent and every live Activation released its handle.
     * @throws an aggregate error when any branch failed to release.
     */
    async drain() {
        // Close admission synchronously before the first await. Materializations
        // already past that cutoff remain tracked until their handle is installed
        // or rollback completes, producing a stable forest for the later snapshot.
        this.ownership.closeAdmission();
        await Promise.all([...this.materializations].map(materialization => materialization.settled));
        // Snapshot roots after closing admission: a root is an Activation no live
        // Activation owns, so disposing roots recurses child-first into the forest.
        const owned = new Set();
        for (const activation of this.activations.values()) {
            for (const child of activation.ownedChildren)
                owned.add(child);
        }
        const roots = [...this.activations.values()].filter(activation => !owned.has(activation.childId));
        await this.disposer.disposeRoots(roots, 'activation(s)');
    }
    /**
     * Stop only the continuable descendants of exact live host-owned parents.
     * Admission stays closed for those parent trees until each exact parent
     * leaves the Agent registry; unrelated trees and manager-wide admission stay
     * live.
     * @param parents - exact live roots whose continuable descendants must stop.
     * @returns once every retained descendant Activation released its handle.
     * @throws an aggregate error after all scoped branches settle when any failed.
     */
    async drainDescendants(parents) {
        const roots = new Set(parents.filter(parent => this.ctx.agents.get(parent.id) === parent));
        if (roots.size === 0)
            return;
        // Publish the scoped admission cutoff before the first await. Merge with an
        // earlier call for the same exact root so a converging drain cannot forget
        // descendants whose release is already in flight.
        for (const root of roots) {
            this.ownership.closingMembers(root).add(root);
        }
        const targets = [];
        for (const activation of this.activations.values()) {
            const lineage = this.ownership.liveLineage(activation.handle.agent);
            // Strict descendants only: a continuable Agent may itself be a
            // host-owned root, and its host remains responsible for that root handle.
            const owners = [...roots].filter(root => activation.handle.agent !== root
                && activation.ancestry.has(root));
            if (owners.length === 0)
                continue;
            targets.push(activation);
            for (const owner of owners) {
                const members = this.ownership.closingMembers(owner);
                members.add(activation.handle.agent);
                for (const agent of lineage)
                    members.add(agent);
            }
        }
        const materializations = [...this.materializations].filter((materialization) => {
            const owners = [...roots].filter(root => materialization.lineage.includes(root));
            for (const owner of owners) {
                const members = this.ownership.closingMembers(owner);
                for (const agent of materialization.lineage)
                    members.add(agent);
            }
            return owners.length > 0;
        });
        const ownedTargets = new Set();
        for (const activation of targets) {
            for (const child of activation.ownedChildren)
                ownedTargets.add(child);
        }
        const targetRoots = targets.filter(activation => !ownedTargets.has(activation.childId));
        // Open every selected transaction before the materialization barrier.
        // Disposal propagates cancellation top-down in the same synchronous span;
        // handle release remains child-first.
        for (const activation of targets) {
            const disposal = this.disposer.dispose(activation);
            void disposal.catch(() => undefined);
        }
        await Promise.all(materializations.map(materialization => materialization.settled));
        await this.disposer.disposeRoots(targetRoots, 'scoped activation(s)');
    }
    /**
     * Release selected resident direct children of one exact live parent without
     * closing admission for the parent's other continuable children. Owned
     * descendants are released recursively through the same lifecycle.
     * @param parent - exact live direct parent authorizing the selected release.
     * @param childIds - durable direct-child ids to release when resident.
     * @returns once every selected Activation released its handle.
     * @throws {SubagentError} `UNAUTHORIZED` when a resident target is not the
     *   parent's direct continuable child or the parent identity is stale.
     */
    async drainChildren(parent, childIds) {
        if (this.ctx.agents.get(parent.id) !== parent) {
            throw new SubagentError('selected child teardown requires the exact live parent agent', 'UNAUTHORIZED');
        }
        const targets = [];
        for (const childId of new Set(childIds)) {
            const activation = this.activations.get(childId);
            if (activation === undefined)
                continue;
            if (activation.parentSession !== parent.id || !activation.ancestry.has(parent)) {
                throw new SubagentError(`subagent "${childId}" is not a direct child of agent "${parent.id}"`, 'UNAUTHORIZED');
            }
            targets.push(activation);
        }
        // Open every transaction before the first await so cancellation propagates
        // across the selected roots in one synchronous span.
        for (const activation of targets) {
            const disposal = this.disposer.dispose(activation);
            void disposal.catch(() => undefined);
        }
        await this.disposer.disposeRoots(targets, 'selected activation(s)');
    }
    /**
     * Cold-resume a persisted child: inspect and authorize its Session, fold the
     * generic descriptor, create the Activation through `ctx.agents.resume()`,
     * and submit the waiting turn. This never dispatches through a subagent
     * provider — the persisted Session already holds the initial prefix and the
     * descriptor is the whole reconstruction input.
     */
    async coldResume(parent, childId, message, options) {
        const persistence = this.requirePersistence();
        let loaded;
        try {
            loaded = await persistence.inspect(childId, options.signal);
        }
        catch (error) {
            options.signal.throwIfAborted();
            throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error });
        }
        options.signal.throwIfAborted();
        this.ownership.assertAdmitting(parent);
        // Authorize the persisted header before folding: only the durable child's
        // exact live direct parent may continue it.
        this.authorizeLineage(parent, childId, loaded.meta.parentSession);
        const duplicate = this.invocationReceipt(loaded.events, message, options.invocationId);
        if (duplicate !== undefined)
            return duplicate;
        // Fold only the child's own suffix: a fork seed replays the parent's log,
        // which may carry an ANCESTOR's descriptor when the parent is itself a
        // continuable child.
        const descriptor = foldSubagentDescriptor(loaded.events.slice(loaded.meta.seedLength ?? 0));
        if (descriptor === undefined || descriptor.mode !== 'continuable') {
            throw new SubagentError(`subagent "${childId}" has no supported continuation state and cannot be resumed; `
                + 'do not retry send_message with this id', 'NOT_RESUMABLE');
        }
        let activation;
        try {
            activation = await this.materializer.materialize({
                childId,
                provider: descriptor.provider,
                parent,
                agentOptions: {
                    ...descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {},
                    ...descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {},
                },
                composition: { persona: descriptor.persona, toolFilter: descriptor.toolFilter },
                signal: options.signal,
            });
        }
        catch (error) {
            options.signal.throwIfAborted();
            if (error instanceof SubagentError)
                throw error;
            throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error });
        }
        return this.submitMaterialized(activation, message, parent, options.signal);
    }
    /**
     * Submit to a freshly materialized Activation or roll it back completely.
     * @param activation - the just-published Activation to admit or release.
     * @param content - the initial or resumed message content.
     * @param source - durable fields naming who supplied the accepted message.
     * @param parent - the live direct parent authorizing admission.
     * @param signal - caller cancellation owning admission until acceptance.
     * @returns the accepted inbox message id.
     */
    async submitMaterialized(activation, message, parent, signal) {
        let accepted = false;
        try {
            const receipt = this.submitAdmitted(activation, message, parent, signal);
            accepted = true;
            await this.flushAccepted(activation);
            return receipt;
        }
        catch (error) {
            if (!accepted) {
                /* v8 ignore next -- rollback disposal failures must not mask the
                 * pre-acceptance signal, drain, or lifecycle failure. */
                await this.disposer.dispose(activation).catch(() => undefined);
            }
            throw error;
        }
    }
    /** Let a settlement watcher re-observe quiescence after ownership or inbox changes. */
    wake(activation) {
        activation.poke.resolve();
        activation.poke = Promise.withResolvers();
    }
    /**
     * Submit one message as the child's next FIFO turn. The caller-visible success
     * boundary is the durability flush performed by the enclosing helper.
     */
    submit(activation, message, parent) {
        // Parent-originated delivery keeps the parent live through ownership, so
        // establish it before the message can enter the child's inbox.
        this.ownership.acquireOwnership(parent, activation.childId);
        const accepted = this.admitWaking(activation, message.id, () => {
            activation.handle.agent.followup(message);
        });
        // Past this point the caller has an id for this child, so its eventual
        // settlement is something the parent is owed an account of.
        activation.announced = true;
        return { messageId: accepted, durable: true, duplicate: false };
    }
    /**
     * Account one waking send across a resident Activation's settlement window.
     * @param activation - Activation receiving waking inbox work.
     * @param messageId - stable identity of the message about to be sent.
     * @param send - synchronous send that publishes one enqueue occurrence.
     * @returns the accepted message id.
     */
    admitWaking(activation, messageId, send) {
        // Waking Agent sends publish inbox events synchronously, so observers must
        // see this Activation as busy before the call begins.
        activation.accepted.add(messageId);
        try {
            send();
        }
        catch (error) {
            activation.accepted.delete(messageId);
            throw error;
        }
        // Accepted waking work keeps this Activation live until whenIdle() observes
        // the complete waking suffix.
        this.wake(activation);
        return messageId;
    }
    /**
     * Cross the final admission cutoff and submit without yielding. Signal abort,
     * manager drain, or Activation disposal that wins before this synchronous
     * span rejects without inbox acceptance.
     */
    submitAdmitted(activation, message, parent, signal) {
        signal.throwIfAborted();
        this.ownership.assertAdmitting(parent);
        /* v8 ignore next 6 -- only a synchronous re-entrant disposer can change
         * this field between the caller's live check and this no-await boundary. */
        if (disposalOf(activation) !== undefined) {
            throw new SubagentError(`subagent "${activation.childId}" activation is being disposed; the message was not accepted`, 'ACTIVATION_CLOSING');
        }
        this.authorizeLineage(parent, activation.childId, activation.handle.agent.session.header.parentSession);
        return this.submit(activation, message, parent);
    }
    /** Submit one admitted message and hold the child lock through durability. */
    async submitAndFlush(activation, message, parent, signal) {
        const receipt = this.submitAdmitted(activation, message, parent, signal);
        await this.flushAccepted(activation);
        return receipt;
    }
    /** Flush the exact live child session after its inbox splice was accepted. */
    async flushAccepted(activation) {
        const child = activation.handle.agent;
        const participated = await child.ctx.sessions.flush(child.session);
        if (!participated) {
            throw new SubagentError(`subagent "${activation.childId}" accepted a message without a persistence durability listener`, 'PERSISTENCE_UNAVAILABLE');
        }
    }
    /** Keep a newly returned child resident through its caller's next microtask. */
    holdReceiptHandoff(childId) {
        const activation = this.activations.get(childId);
        if (activation === undefined || activation.disposal !== undefined)
            return;
        activation.handoffHolds += 1;
        setTimeout(() => {
            activation.handoffHolds = Math.max(0, activation.handoffHolds - 1);
            this.wake(activation);
        }, 0);
    }
    /** Validate that a caller-supplied idempotency key is carried by its source. */
    assertInvocationContract(message, invocationId, parentId) {
        if (message.source.kind !== 'subagent-prompt') {
            if (invocationId !== undefined) {
                throw new SubagentError('subagent prompt invocationId requires its durable message source', 'INVALID_INVOCATION');
            }
            return;
        }
        if (invocationId === undefined) {
            throw new SubagentError('subagent prompt message source requires invocationId', 'INVALID_INVOCATION');
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(invocationId)) {
            throw new SubagentError('subagent prompt invocationId must be a canonical UUID', 'INVALID_INVOCATION');
        }
        if (message.source.invocationId !== invocationId || message.source.senderSessionId !== parentId) {
            throw new SubagentError('subagent prompt invocationId does not match its durable message source', 'INVALID_INVOCATION');
        }
    }
    /**
     * Find a prior durable/live insertion for one invocation. Reusing the key
     * with different content or authority fails loud; an exact retry returns the
     * original message id and never enqueues a second turn.
     */
    invocationReceipt(events, candidate, invocationId) {
        if (invocationId === undefined)
            return undefined;
        const matches = new Map();
        for (const event of events) {
            const messages = event.type === 'agent/inbox/spliced'
                ? event.data.inserted
                : event.type === 'user/message' ? [event.data] : [];
            for (const message of messages) {
                if (message.source.kind === 'subagent-prompt' && message.source.invocationId === invocationId) {
                    const prior = matches.get(message.id);
                    if (prior !== undefined && !isDeepStrictEqual(prior, message)) {
                        throw new SubagentError('subagent prompt message identity has conflicting persisted values', 'IDEMPOTENCY_CONFLICT');
                    }
                    matches.set(message.id, message);
                }
            }
        }
        if (matches.size === 0)
            return undefined;
        if (matches.size !== 1) {
            throw new SubagentError('subagent prompt invocationId resolves to multiple messages', 'IDEMPOTENCY_CONFLICT');
        }
        const existing = matches.values().next().value;
        /* v8 ignore next -- size === 1 above proves the iterator has one value. */
        if (existing === undefined)
            return undefined;
        const messageId = existing.id;
        if (!isDeepStrictEqual(existing.content, candidate.content)
            || existing.source.kind !== 'subagent-prompt'
            || candidate.source.kind !== 'subagent-prompt'
            || existing.source.senderSessionId !== candidate.source.senderSessionId) {
            throw new SubagentError('subagent prompt invocationId was reused with different input', 'IDEMPOTENCY_CONFLICT');
        }
        return { messageId, durable: true, duplicate: true };
    }
    /**
     * Authorize one operation against the durable direct-parent lineage. Other
     * agents, ancestors, teams, workflows, and hosts remain rejected until an
     * explicit authority protocol has a production consumer.
     */
    authorizeLineage(parent, childId, parentSession) {
        if (this.ctx.agents.get(parent.id) !== parent) {
            throw new SubagentError(`subagent "${childId}" delivery requires the exact live parent agent`, 'UNAUTHORIZED');
        }
        if (parentSession !== parent.id) {
            throw new SubagentError(`subagent "${childId}" belongs to another parent session`, 'UNAUTHORIZED');
        }
    }
    /** Resolve the persistence service continuable children require, or fail loud. */
    requirePersistence() {
        const persistence = this.ctx.get('sessionPersistence');
        if (persistence === undefined) {
            throw new SubagentError('continuable subagents require session persistence (load a dsh-session-persistence backend)', 'PERSISTENCE_UNAVAILABLE');
        }
        return persistence;
    }
}
export default SubagentContinuationManager;
//# sourceMappingURL=continuation.js.map