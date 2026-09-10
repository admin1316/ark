/** Durable Team mailbox admission, ordered dispatch and acknowledgement. */
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { TeamId, TeamMessageId } from "./brand.js";
import { TeamError, errorMessage } from "./error.js";
import { resolveActiveMember } from "./roster.js";
import { messageAccepted } from "./session-message.js";
/** Owns process-local admission and delivery state for the durable mailbox. */
export class TeamMailbox {
    ctx;
    journal;
    roster;
    lifecycle;
    maxPendingMessagesPerMember;
    maxMessageBytes;
    dispatchTails = new Map();
    activeDispatches = new Map();
    inFlightMessages = new Set();
    inFlightDispatches = new Set();
    constructor(ctx, journal, roster, lifecycle, maxPendingMessagesPerMember, maxMessageBytes) {
        this.ctx = ctx;
        this.journal = journal;
        this.roster = roster;
        this.lifecycle = lifecycle;
        this.maxPendingMessagesPerMember = maxPendingMessagesPerMember;
        this.maxMessageBytes = maxMessageBytes;
    }
    /**
     * Queue a durable peer message, then attempt delivery.
     * @param caller - exact live sending member.
     * @param request - target, content, delivery mode and pre-queue cancellation.
     * @returns durable identity and immediate acceptance observation.
     */
    async send(caller, request) {
        if (this.lifecycle.disposed)
            throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED');
        return await this.trackDispatch(this.sendAdmitted(caller, {
            ...request, signal: AbortSignal.any([request.signal, this.lifecycle.signal]),
        }));
    }
    /**
     * Checkpoint a target's receipt before acknowledging it in the Lead log.
     * @param session - exact target Session.
     * @param event - newly appended Session event.
     */
    observeSessionEvent(session, event) {
        if (this.lifecycle.disposed || event.type !== 'user/message' || event.data.source.kind !== 'team-message')
            return;
        const source = event.data.source;
        const acknowledgement = Promise.resolve().then(async () => {
            const root = this.ctx.agents.get(SessionId(source.teamId));
            if (root !== undefined)
                await this.checkpointDelivered(root, session, source.messageId);
        }).catch((error) => {
            this.ctx.logger.warn(`Team message "${source.messageId}" acknowledgement failed: ${errorMessage(error)}`);
        });
        void this.trackDispatch(acknowledgement);
    }
    /**
     * Retry pending messages relevant to a newly started member.
     * @param agent - exact live member.
     * @param signal - runtime cancellation.
     */
    async recoverFor(agent, signal) {
        signal.throwIfAborted();
        const membership = this.roster.tryMembership(agent);
        if (membership === undefined)
            return;
        const state = this.journal.state(membership.root);
        const messages = [...state.messages.values()].filter(message => !state.delivered.has(message.id)
            && (membership.role === 'lead' || message.targetId === agent.id));
        for (const message of messages) {
            signal.throwIfAborted();
            if (membership.role === 'lead' && message.delivery === 'quiet' && message.targetId !== membership.root.id
                && this.ctx.agents.get(message.targetId) === undefined)
                continue;
            await this.tryDispatch(membership.root, message, signal);
        }
    }
    /**
     * Capture admitted mailbox work before shutdown waits for it.
     * @returns admitted dispatch and acknowledgement operations.
     */
    pendingDispatches() { return [...this.inFlightDispatches]; }
    async sendAdmitted(caller, request) {
        const membership = this.roster.membership(caller);
        request.signal.throwIfAborted();
        const root = membership.root;
        const content = structuredClone(request.content);
        const queued = await this.journal.transact(root.id, async () => {
            request.signal.throwIfAborted();
            const state = this.journal.state(root);
            const target = resolveActiveMember(root, state, request.target);
            if (target.id === caller.id)
                throw new TeamError('a Team member cannot message itself', 'TEAM_SELF_MESSAGE');
            const pending = [...state.messages.values()]
                .filter(candidate => candidate.targetId === target.id && !state.delivered.has(candidate.id)).length;
            if (pending >= this.maxPendingMessagesPerMember)
                throw new TeamError(`teammate "${target.name}" has ${pending} pending messages`, 'TEAM_MAILBOX_FULL');
            const message = {
                id: TeamMessageId(`team-message-${randomUUID()}`), senderId: caller.id, senderName: membership.name,
                targetId: target.id, delivery: request.delivery, content,
            };
            if (Buffer.byteLength(JSON.stringify(this.deliveryContent(message)), 'utf8') > this.maxMessageBytes) {
                throw new TeamError(`team message exceeds ${this.maxMessageBytes} bytes`, 'TEAM_MESSAGE_TOO_LARGE');
            }
            await this.journal.appendAndFlush(root, 'team/message/queued', { version: 1, teamId: TeamId(root.id), message });
            return { message, dispatch: this.tryDispatch(root, message, request.signal) };
        });
        const accepted = await queued.dispatch;
        return { messageId: queued.message.id, status: accepted ? 'accepted' : 'queued' };
    }
    tryDispatch(root, message, signal) {
        if (this.lifecycle.disposed || this.inFlightMessages.has(message.id))
            return Promise.resolve(false);
        this.inFlightMessages.add(message.id);
        const operation = this.trackDispatch(this.tryDispatchAdmitted(root, message, AbortSignal.any([signal, this.lifecycle.signal])));
        const forget = () => { this.inFlightMessages.delete(message.id); };
        void operation.then(forget, forget);
        return operation;
    }
    trackDispatch(operation) {
        this.inFlightDispatches.add(operation);
        const forget = () => { this.inFlightDispatches.delete(operation); };
        void operation.then(forget, forget);
        return operation;
    }
    async tryDispatchAdmitted(root, message, signal) {
        const active = this.activeDispatches.get(message.targetId);
        const live = message.targetId === root.id ? root : this.ctx.agents.get(message.targetId);
        if (active !== undefined && live !== undefined && message.delivery === 'quiet'
            && this.messagePrecedes(root, message.id, active.id))
            return await this.dispatchOnce(root, message, signal);
        return await this.serializeDispatch(message, () => this.dispatchOnce(root, message, signal));
    }
    async serializeDispatch(message, operation) {
        const targetId = message.targetId;
        const prior = this.dispatchTails.get(targetId) ?? Promise.resolve();
        const dispatch = async () => {
            this.activeDispatches.set(targetId, message);
            try {
                return await operation();
            }
            finally {
                this.activeDispatches.delete(targetId);
            }
        };
        const run = prior.then(dispatch, dispatch);
        const tail = run.then(() => undefined, () => undefined);
        this.dispatchTails.set(targetId, tail);
        try {
            return await run;
        }
        finally {
            if (this.dispatchTails.get(targetId) === tail)
                this.dispatchTails.delete(targetId);
        }
    }
    async dispatchOnce(root, message, signal) {
        try {
            const target = message.targetId === root.id ? root : this.ctx.agents.get(message.targetId);
            if (target !== undefined && this.targetRecorded(target.session, message.id)) {
                return await this.checkpointDelivered(root, target.session, message.id);
            }
            const source = {
                kind: 'team-message', teamId: TeamId(root.id), messageId: message.id,
                senderId: message.senderId, senderName: message.senderName,
            };
            const content = this.deliveryContent(message);
            if (message.targetId === root.id) {
                const input = createUserMessage({ content, source });
                if (message.delivery === 'wakeup')
                    root.followup(input);
                else
                    root.inject(input);
                return await this.checkpointDelivered(root, root.session, message.id);
            }
            if (message.delivery === 'quiet') {
                if (target === undefined)
                    return false;
                target.inject(createUserMessage({ content, source }));
                return await this.checkpointDelivered(root, target.session, message.id);
            }
            if (target === undefined) {
                const recorded = await this.persistedTargetRecorded(message.targetId, message.id, signal);
                if (recorded === undefined)
                    return false;
                if (recorded) {
                    await this.markDelivered(root, message.id, message.targetId);
                    return true;
                }
            }
            await this.ctx.subagents.followup(root, message.targetId, content, { source, signal });
            await this.markDelivered(root, message.id, message.targetId);
            return true;
        }
        catch (error) {
            this.ctx.logger.warn(`team message "${message.id}" remains queued: ${errorMessage(error)}`);
            return false;
        }
    }
    messagePrecedes(root, left, right) {
        const ids = [...this.journal.state(root).messages.keys()];
        return ids.indexOf(left) < ids.indexOf(right);
    }
    async checkpointDelivered(root, target, messageId) {
        await this.ctx.sessions.flush(target);
        if (!this.targetRecorded(target, messageId))
            return false;
        await this.markDelivered(root, messageId, target.id);
        return true;
    }
    markDelivered(root, messageId, targetId) {
        return this.journal.transact(root.id, async () => {
            const state = this.journal.state(root);
            if (state.delivered.has(messageId))
                return;
            const queued = state.messages.get(messageId);
            if (queued === undefined || queued.targetId !== targetId)
                return;
            await this.journal.appendAndFlush(root, 'team/message/delivered', { version: 1, teamId: TeamId(root.id), messageId, targetId });
        });
    }
    targetRecorded(session, messageId) {
        return messageAccepted(session.events.slice(session.header.seedLength ?? 0), message => message.source.kind === 'team-message' && message.source.messageId === messageId);
    }
    deliveryContent(message) {
        return [{ type: 'text', text: `Team message ${message.id} from ${message.senderName}:` }, ...structuredClone(message.content)];
    }
    async persistedTargetRecorded(targetId, messageId, signal) {
        try {
            const stored = await this.ctx.sessionPersistence.inspect(targetId, signal);
            return messageAccepted(stored.events.slice(stored.meta.seedLength ?? 0), message => message.source.kind === 'team-message' && message.source.messageId === messageId);
        }
        catch (error) {
            this.ctx.logger.warn(`cannot inspect Team message target "${targetId}": ${errorMessage(error)}`);
            return undefined;
        }
    }
}
//# sourceMappingURL=mailbox.js.map