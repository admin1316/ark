/** Exact Team membership and continuable-child lifecycle. */
import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent';
import { TeamId } from "./brand.js";
import { TeamError, errorMessage } from "./error.js";
import { messageAccepted } from "./session-message.js";
import { requiredText } from "./validation.js";
const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/**
 * Resolve an active teammate name or the Lead pseudo-row.
 * @param root - exact live Lead.
 * @param state - current Team fold.
 * @param rawName - member name to resolve.
 * @returns durable identity and normalized name.
 */
export function resolveActiveMember(root, state, rawName) {
    const name = rawName.trim();
    if (name === 'lead')
        return { id: root.id, name };
    const id = state.memberIdsByName.get(name);
    const member = id === undefined ? undefined : state.members.get(id);
    if (member === undefined || member.phase !== 'active')
        throw new TeamError(`active teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND');
    return { id: member.id, name };
}
/** Owns roster identities and their continuable children. */
export class TeamRoster {
    ctx;
    journal;
    lifecycle;
    maxMembers;
    inFlightCreations = new Set();
    constructor(ctx, journal, lifecycle, maxMembers) {
        this.ctx = ctx;
        this.journal = journal;
        this.lifecycle = lifecycle;
        this.maxMembers = maxMembers;
    }
    /**
     * Require membership of an exact live Agent.
     * @param agent - calling Agent identity.
     * @returns its current Team and role.
     */
    membership(agent) {
        const membership = this.tryMembership(agent);
        if (membership === undefined)
            throw new TeamError(`agent "${agent.id}" is not a member of an active Agent Team`, 'TEAM_NOT_MEMBER');
        return membership;
    }
    /**
     * Resolve membership without admitting stale identities or foreign subagents.
     * @param agent - candidate live Agent.
     * @returns current membership, or undefined when it cannot be established.
     */
    tryMembership(agent) {
        if (this.ctx.agents.get(agent.id) !== agent)
            return undefined;
        try {
            const parentId = agent.session.header.parentSession;
            if (parentId !== undefined) {
                const root = this.ctx.agents.get(parentId);
                if (root !== undefined) {
                    const member = this.journal.state(root).members.get(agent.id);
                    if (member?.phase === 'active' || member?.phase === 'provisioning') {
                        return { root, id: TeamId(root.id), role: 'teammate', name: member.name };
                    }
                }
            }
            if (this.subagentDescriptor(agent))
                return undefined;
            return { root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' };
        }
        catch {
            // Invalid Team or subagent replay cannot establish membership.
            return undefined;
        }
    }
    /**
     * List the roster with current runtime status.
     * @param membership - exact caller membership.
     * @returns Lead and teammate rows in creation order.
     */
    list(membership) {
        const { root } = membership;
        const result = [{
                id: root.id, name: 'lead', role: 'lead', status: root.status,
                ...(root.options.model === undefined ? {} : { model: root.options.model }), diagnostics: [],
            }];
        for (const member of this.journal.state(root).members.values()) {
            const live = this.ctx.agents.get(member.id);
            const model = live?.options.model ?? root.options.model;
            result.push({
                id: member.id, name: member.name, role: 'teammate',
                status: member.phase === 'failed' ? 'failed' : member.phase === 'provisioning' ? 'provisioning' : live?.status ?? 'inactive',
                description: member.description, provider: member.provider, context: member.context,
                ...(model === undefined ? {} : { model }), diagnostics: member.error === undefined ? [] : [member.error],
            });
        }
        return result;
    }
    /**
     * Admit one Lead-owned teammate creation before the shutdown cutoff.
     * @param caller - exact live Lead.
     * @param request - teammate identity, initial message, provider and cancellation.
     * @returns the active member after durable prompt acceptance.
     */
    async spawn(caller, request) {
        if (this.lifecycle.disposed)
            throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED');
        const operation = this.spawnAdmitted(caller, request);
        this.inFlightCreations.add(operation);
        try {
            return await operation;
        }
        finally {
            this.inFlightCreations.delete(operation);
        }
    }
    /**
     * Capture admitted creations before ordered disposal.
     * @returns creation operations that have not settled.
     */
    pendingCreations() { return [...this.inFlightCreations]; }
    /**
     * Reconcile provisioning when a Team Lead starts.
     * @param agent - newly started exact live Agent.
     * @param signal - runtime cancellation.
     */
    async recoverFor(agent, signal) {
        signal.throwIfAborted();
        const membership = this.tryMembership(agent);
        if (membership?.role === 'lead')
            await this.reconcileProvisioning(membership.root, signal);
    }
    /**
     * Interrupt a teammate turn without discarding its pending inbox.
     * @param caller - exact live Lead.
     * @param targetName - durable teammate name.
     * @returns status immediately before cancellation.
     */
    interrupt(caller, targetName) {
        const membership = this.membership(caller);
        if (membership.role !== 'lead')
            throw new TeamError('only the Team Lead can interrupt teammates', 'TEAM_LEAD_REQUIRED');
        const target = resolveActiveMember(membership.root, this.journal.state(membership.root), targetName);
        if (target.id === membership.root.id)
            throw new TeamError('the Team Lead cannot interrupt itself', 'TEAM_INVALID_TARGET');
        const live = this.ctx.agents.get(target.id);
        if (live === undefined)
            return { previousStatus: 'inactive' };
        const previousStatus = live.status;
        this.ctx.subagents.interrupt(target.id, { kind: 'ancestor', agent: caller });
        return { previousStatus };
    }
    /**
     * Group currently live roster children for owner-checked teardown.
     * @returns child session identities grouped by their exact current Lead.
     */
    liveChildrenByRoot() {
        const teams = new Map();
        for (const agent of this.ctx.agents.list()) {
            const rootId = agent.session.header.parentSession;
            if (rootId === undefined)
                continue;
            const root = this.ctx.agents.get(rootId);
            if (root === undefined || !this.journal.state(root).members.has(agent.id))
                continue;
            const children = teams.get(root) ?? [];
            children.push(agent.id);
            teams.set(root, children);
        }
        return teams;
    }
    /**
     * Release selected teammate activations through their continuation owner.
     * @param root - exact Lead authorizing release.
     * @param childIds - selected roster children.
     */
    async stopTeammates(root, childIds) {
        await this.lifecycle.withTimeout(this.ctx.subagents.drainContinuableChildren(root, childIds));
    }
    async spawnAdmitted(caller, request) {
        const membership = this.membership(caller);
        if (membership.role !== 'lead')
            throw new TeamError('only the Team Lead can create teammates', 'TEAM_LEAD_REQUIRED');
        const signal = AbortSignal.any([request.signal, this.lifecycle.signal]);
        signal.throwIfAborted();
        const root = membership.root;
        const name = this.memberName(request.name);
        const description = requiredText(request.description, 'description', 200);
        const childId = SessionId(randomUUID());
        const member = {
            id: childId, name, description, provider: requiredText(request.provider, 'provider', 200),
            context: request.context, phase: 'provisioning',
        };
        await this.journal.transact(root.id, async () => {
            const state = this.journal.state(root);
            if (state.memberIdsByName.has(name))
                throw new TeamError(`teammate name "${name}" was already used in this Team`, 'TEAM_MEMBER_NAME_TAKEN');
            if (state.members.size >= this.maxMembers)
                throw new TeamError(`Team member limit ${this.maxMembers} reached`, 'TEAM_MEMBER_LIMIT');
            await this.journal.appendAndFlush(root, 'team/member', { version: 1, teamId: TeamId(root.id), member });
        });
        try {
            const started = await this.ctx.subagents.startContinuable({
                childId, provider: request.provider, label: description,
                request: { prompt: request.prompt, parent: root }, signal,
            });
            await this.checkpointInitialPrompt(childId, started.messageId, signal);
        }
        catch (error) {
            const failed = { ...member, phase: 'failed', error: errorMessage(error) };
            try {
                const phase = await this.settleProvisioning(root, failed);
                await this.stopTeammates(root, [childId]);
                if (phase === 'active')
                    throw new TeamError(`teammate "${name}" became active while its creator reported failure`, 'TEAM_PROVISIONING_CONFLICT', { cause: error });
            }
            catch (recordError) {
                throw new AggregateError([error, recordError], 'teammate creation and durable failure recording both failed');
            }
            throw error;
        }
        const active = { ...member, phase: 'active' };
        if (await this.settleProvisioning(root, active) === 'failed') {
            const conflict = new TeamError(`teammate "${name}" was reconciled as failed while creation was in progress`, 'TEAM_PROVISIONING_CONFLICT');
            try {
                await this.stopTeammates(root, [childId]);
            }
            catch (cleanupError) {
                throw new AggregateError([conflict, cleanupError], 'provisioning conflict cleanup failed');
            }
            throw conflict;
        }
        return { member: this.memberView(active) };
    }
    async checkpointInitialPrompt(childId, messageId, signal) {
        for (;;) {
            signal.throwIfAborted();
            const session = this.ctx.sessions.get(childId);
            if (session === undefined) {
                const stored = await this.ctx.sessionPersistence.inspect(childId, signal);
                if (messageAccepted(stored.events.slice(stored.meta.seedLength ?? 0), message => message.id === messageId))
                    return;
                throw new TeamError(`teammate "${childId}" initial prompt was not durably accepted`, 'TEAM_PROVISIONING_CONFLICT');
            }
            const progress = Promise.withResolvers();
            void progress.promise.catch(() => undefined);
            const stopEvent = this.ctx.on('session/event', (candidate) => { if (candidate === session)
                progress.resolve(undefined); });
            const stopDisposed = this.ctx.on('session/disposed', (candidate) => { if (candidate === session)
                progress.resolve(undefined); });
            const onAbort = () => {
                const reason = signal.reason;
                progress.reject(reason instanceof Error ? reason : new TeamError(`teammate creation aborted: ${errorMessage(reason)}`, 'TEAM_DISPOSED'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            try {
                signal.throwIfAborted();
                await this.ctx.sessions.flush(session);
                if (messageAccepted(session.events.slice(session.header.seedLength ?? 0), message => message.id === messageId))
                    return;
                if (this.ctx.sessions.get(childId) !== session)
                    continue;
                await progress.promise;
            }
            finally {
                signal.removeEventListener('abort', onAbort);
                stopDisposed();
                stopEvent();
            }
        }
    }
    async reconcileProvisioning(root, signal) {
        const provisioning = [...this.journal.state(root).members.values()].filter(member => member.phase === 'provisioning');
        for (const member of provisioning) {
            signal.throwIfAborted();
            if (this.ctx.agents.get(member.id) !== undefined)
                continue;
            let phase = 'failed';
            let failure = 'provisioning did not leave a resumable child Session';
            try {
                const loaded = await this.ctx.sessionPersistence.inspect(member.id, signal);
                const suffix = loaded.events.slice(loaded.meta.seedLength ?? 0);
                const descriptor = foldSubagentDescriptor(suffix);
                const accepted = messageAccepted(suffix, message => message.source.kind === 'user');
                if (loaded.meta.parentSession === root.id && descriptor?.mode === 'continuable' && descriptor.provider === member.provider && accepted)
                    phase = 'active';
                else
                    failure = 'persisted child Session does not match the provisioned continuation';
            }
            catch (error) {
                failure = `child Session recovery failed: ${errorMessage(error)}`;
            }
            signal.throwIfAborted();
            await this.journal.transact(root.id, async () => {
                signal.throwIfAborted();
                const current = this.journal.state(root).members.get(member.id);
                if (current?.phase !== 'provisioning')
                    return;
                const settled = { ...current, phase, ...(phase === 'failed' ? { error: failure } : {}) };
                await this.journal.appendAndFlush(root, 'team/member', { version: 1, teamId: TeamId(root.id), member: settled });
            });
        }
    }
    memberView(member) {
        const live = this.ctx.agents.get(member.id);
        return {
            id: member.id, name: member.name, role: 'teammate', status: live?.status ?? 'inactive',
            description: member.description, provider: member.provider, context: member.context,
            ...(live?.options.model === undefined ? {} : { model: live.options.model }), diagnostics: [],
        };
    }
    memberName(value) {
        if (!MEMBER_NAME.test(value) || value.length > 64 || value === 'lead') {
            throw new TeamError('teammate name must be lower-kebab-case, at most 64 characters, and not "lead"', 'TEAM_INVALID_MEMBER_NAME');
        }
        return value;
    }
    settleProvisioning(root, terminal) {
        return this.journal.transact(root.id, async () => {
            const current = this.journal.state(root).members.get(terminal.id);
            if (current === undefined)
                throw new TeamError(`provisioned teammate "${terminal.id}" disappeared`, 'TEAM_PROVISIONING_CONFLICT');
            if (current.phase !== 'provisioning')
                return current.phase;
            await this.journal.appendAndFlush(root, 'team/member', { version: 1, teamId: TeamId(root.id), member: terminal });
            return terminal.phase === 'active' ? 'active' : 'failed';
        });
    }
    subagentDescriptor(agent) {
        return foldSubagentDescriptor(agent.session.events.slice(agent.session.header.seedLength ?? 0)) !== undefined;
    }
}
//# sourceMappingURL=roster.js.map