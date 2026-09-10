/**
 * Settlement observation and parent delivery for continuable Activations:
 * following one epoch to quiescence and owned-child release, then telling the
 * durable direct parent how the child ended.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import { boundContextSummary, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm';
import { isDeepStrictEqual } from 'node:util';
import { disposalOf, settlementSummary } from "./continuation-state.js";
/**
 * Follows each Activation to settlement and delivers its closing account to
 * the durable direct parent.
 */
export class SettlementWatcher {
    hooks;
    constructor(hooks) {
        this.hooks = hooks;
    }
    /**
     * Follow one Activation to settlement: wait for Agent quiescence, then for
     * every owned child to complete disposal, and dispose the handle once both
     * hold. A `next-turn` delivered while `waiting` wakes the same Agent and
     * returns it to `running`, so this re-observes rather than settling early.
     * @param activation - the activation to follow to settlement.
     */
    watchSettlement(activation) {
        void (async () => {
            while (disposalOf(activation) === undefined) {
                const poked = activation.poke.promise;
                await Promise.race([activation.handle.agent.whenIdle(), poked]);
                if (disposalOf(activation) !== undefined)
                    return;
                // Re-check settlement INSIDE the child lock and begin disposal in the
                // same critical section, so a concurrent delivery either wins admission
                // before the transaction opens or waits for release and cold-resumes.
                // Deciding outside the lock would let a delivery observe a not-yet
                // resident handle that this watcher is already about to tear down.
                const settling = await this.hooks.locks.run(activation.childId, () => {
                    if (disposalOf(activation) !== undefined || this.stateOf(activation) !== 'settled') {
                        return Promise.resolve({ settling: false });
                    }
                    // `dispose()` assigns its memoized transaction synchronously, so
                    // admission is closed before this critical section releases.
                    return Promise.resolve({ settling: true, done: this.hooks.dispose(activation) });
                });
                if (!settling.settling) {
                    // Still running, or waiting on descendants: re-observe after the next
                    // accepted message or ownership release.
                    if (activation.handle.agent.status !== 'running')
                        await poked;
                    continue;
                }
                try {
                    await settling.done;
                }
                catch (error) {
                    this.hooks.ctx.logger.warn(`subagent "${activation.childId}" activation teardown failed: ${errorChain(error)}`);
                }
                return;
            }
        })();
    }
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
    async notifySettlement(activation, terminal) {
        if (!activation.announced)
            return;
        try {
            const parent = this.hooks.ctx.agents.get(activation.parentSession);
            if (parent === undefined)
                return;
            const summary = settlementSummary(activation.childId, terminal.stopReason);
            const settlementId = `${activation.childId}:${String(activation.handle.agent.session.seq)}`;
            if (this.hasSettlement(parent, settlementId)) {
                await parent.ctx.sessions.flush(parent.session);
                return;
            }
            const matchingReport = terminal.output === undefined
                ? undefined
                : this.matchingReport(parent, activation.childId, terminal.output);
            const message = createUserMessage({
                content: [
                    { type: 'text', text: summary },
                    ...matchingReport !== undefined
                        ? [{ type: 'text', text: `Its closing message was already delivered as explicit report ${matchingReport.id}.` }]
                        : terminal.output === undefined
                            ? [{ type: 'text', text: 'It left no closing message.' }]
                            : [{ type: 'text', text: 'Its closing message:' }, ...terminal.output],
                ],
                source: {
                    kind: 'subagent-settled',
                    form: 'notice',
                    summary: boundContextSummary(summary),
                    senderSessionId: activation.childId,
                    settlementId,
                },
            });
            // A parent whose own teardown already began must not be woken. Waking is
            // not a queue operation: `followup()` on a quiescent Agent starts a turn,
            // and `cancel()` does not arm against a later one, so a notice arriving
            // during teardown would spend a model request on an Agent its host is
            // about to dispose — once per tree layer, since each layer's own notice
            // then wakes the layer above it. Injecting delivers to a parent still
            // reading its inbox and records the account in the log either way; it
            // does NOT survive that parent's own disposal, whose `keepInbox: false`
            // cancel durably clears whatever it never claimed.
            if (this.hooks.closingTeardownFor(parent) !== undefined) {
                parent.inject(message);
                await this.flushParent(parent);
                return;
            }
            // An idle parent has nothing else to look at, so it gets one ordinary
            // turn. A busy parent is steered instead of woken: `Inbox.claim()` takes
            // the whole next-step batch at one boundary, so several children settling
            // together cost one step rather than one turn each. Steering rather than
            // injecting closes the window where a driver retires between this status
            // read and the send, which would strand the notice unclaimed.
            this.hooks.sendWaking(parent, message, () => {
                if (parent.status === 'idle')
                    parent.followup(message);
                else
                    parent.steer(message);
            });
            await this.flushParent(parent);
        }
        catch (error) {
            this.hooks.ctx.logger.warn(`subagent "${activation.childId}" settlement notice was not delivered to its parent: `
                + errorChain(error));
        }
    }
    /** Require the parent inbox insertion to cross its existing durability barrier. */
    async flushParent(parent) {
        const participated = await parent.ctx.sessions.flush(parent.session);
        if (!participated)
            throw new Error('parent Session has no persistence durability listener');
    }
    /** Whether this child epoch's stable settlement account was already inserted. */
    hasSettlement(parent, settlementId) {
        return this.findParentMessage(parent, message => message.source.kind === 'subagent-settled'
            && message.source.settlementId === settlementId) !== undefined;
    }
    /** Find an explicit report carrying the exact closing content. */
    matchingReport(parent, childId, output) {
        return this.findParentMessage(parent, message => message.source.kind === 'subagent-report'
            && message.source.senderSessionId === childId
            && isDeepStrictEqual(message.content.slice(1), output));
    }
    /** Search newest-first without materializing a long parent transcript. */
    findParentMessage(parent, predicate) {
        for (const pending of [parent.inbox.nextStep, parent.inbox.nextTurn]) {
            for (let index = pending.length - 1; index >= 0; index -= 1) {
                const message = pending[index];
                if (message !== undefined && predicate(message))
                    return message;
            }
        }
        const events = parent.session.events;
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (event?.type === 'user/message' && predicate(event.data))
                return event.data;
            if (event?.type !== 'agent/inbox/spliced')
                continue;
            for (let inserted = event.data.inserted.length - 1; inserted >= 0; inserted -= 1) {
                const message = event.data.inserted[inserted];
                if (message !== undefined && predicate(message))
                    return message;
            }
        }
        return undefined;
    }
    /**
     * Derive residency from Agent quiescence and the owned-child set. `running`
     * covers an active admission, an open turn, or accepted waking inbox work.
     *
     * `Agent.status` alone is insufficient: it stays `idle` between an accepted
     * waking send and the microtask that admits it, so a synchronous inbox
     * observer would see `settled` while a turn is already queued. `accepted`
     * holds the ids this manager admitted but has not yet seen drained.
     */
    stateOf(activation) {
        if (activation.handle.agent.status === 'running'
            || activation.accepted.size > 0
            || activation.handoffHolds > 0)
            return 'running';
        if (activation.ownedChildren.size > 0)
            return 'waiting';
        return 'settled';
    }
}
//# sourceMappingURL=settlement-watcher.js.map