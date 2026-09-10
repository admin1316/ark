/** Team service over roster, durable mailbox, task board and runtime lifetime owners. */
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { TeamId } from "./brand.js";
import { TeamError, errorMessage } from "./error.js";
import { TeamActivity } from "./activity.js";
import { TeamJournal } from "./journal.js";
import { TeamRuntimeLifecycle } from "./lifecycle.js";
import { TeamMailbox } from "./mailbox.js";
import { TeamRoster } from "./roster.js";
import { TeamTaskBoard } from "./task-board.js";
export { TeamId, TeamTaskId, TeamMessageId } from "./brand.js";
export { TeamError } from "./error.js";
export { foldTeam } from "./fold.js";
const DEFAULTS = {
    maxMembers: 8, maxTasks: 256, maxPendingMessagesPerMember: 64, maxMessageBytes: 65_536, disposalTimeoutMs: 5_000,
};
function positiveLimit(name, value) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new TeamError(`${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG');
    return value;
}
/** Agent Teams backed by the exact live Lead's durable Session log. */
export class TeamService extends Service {
    static inject = ['agents', 'sessions', 'sessionPersistence', 'subagents'];
    static Config = z.object({
        maxMembers: z.number().step(1).min(1).default(DEFAULTS.maxMembers),
        maxTasks: z.number().step(1).min(1).default(DEFAULTS.maxTasks),
        maxPendingMessagesPerMember: z.number().step(1).min(1).default(DEFAULTS.maxPendingMessagesPerMember),
        maxMessageBytes: z.number().step(1).min(1).default(DEFAULTS.maxMessageBytes),
        disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULTS.disposalTimeoutMs),
    });
    config;
    activity;
    lifecycle;
    journal;
    roster;
    mailbox;
    tasks;
    recoveries = new Set();
    constructor(ctx, config = {}) {
        super(ctx, 'agentTeams');
        this.config = {
            maxMembers: positiveLimit('maxMembers', config.maxMembers ?? DEFAULTS.maxMembers),
            maxTasks: positiveLimit('maxTasks', config.maxTasks ?? DEFAULTS.maxTasks),
            maxPendingMessagesPerMember: positiveLimit('maxPendingMessagesPerMember', config.maxPendingMessagesPerMember ?? DEFAULTS.maxPendingMessagesPerMember),
            maxMessageBytes: positiveLimit('maxMessageBytes', config.maxMessageBytes ?? DEFAULTS.maxMessageBytes),
            disposalTimeoutMs: positiveLimit('disposalTimeoutMs', config.disposalTimeoutMs ?? DEFAULTS.disposalTimeoutMs),
        };
        this.activity = new TeamActivity();
        this.lifecycle = new TeamRuntimeLifecycle(this.config.disposalTimeoutMs);
        this.journal = new TeamJournal(ctx, root => this.activity.notify(TeamId(root.id)));
        this.roster = new TeamRoster(ctx, this.journal, this.lifecycle, this.config.maxMembers);
        this.mailbox = new TeamMailbox(ctx, this.journal, this.roster, this.lifecycle, this.config.maxPendingMessagesPerMember, this.config.maxMessageBytes);
        this.tasks = new TeamTaskBoard(this.journal, this.config.maxTasks);
        ctx.on('session/event', (session, event) => this.mailbox.observeSessionEvent(session, event));
        ctx.on('agent/session-start', ({ agent }) => this.scheduleRecovery(agent));
        ctx.on('agent/status', ({ agent }) => {
            const membership = this.roster.tryMembership(agent);
            if (membership !== undefined)
                this.activity.notify(membership.id);
        });
        ctx.effect(() => () => this.disposeRuntime(), 'agentTeams.runtimeLifecycle()');
        for (const agent of ctx.agents.list())
            this.scheduleRecovery(agent);
    }
    /**
     * Require the caller's current live team membership.
     * @param agent - exact live caller.
     * @returns current Team role.
     */
    membership(agent) { return this.roster.membership(agent); }
    /**
     * Read the live member's team roster.
     * @param agent - exact live member.
     * @returns roster in creation order.
     */
    listMembers(agent) { return this.roster.list(this.roster.membership(agent)); }
    /**
     * Create a teammate under the live Lead's roster and runtime lifetime.
     * @param caller - exact Lead.
     * @param request - creation request.
     * @returns durable active member.
     */
    async spawnTeammate(caller, request) {
        return await this.roster.spawn(caller, request);
    }
    /**
     * Admit a peer message through the durable team mailbox.
     * @param caller - exact sender.
     * @param request - peer message.
     * @returns durable admission result.
     */
    async sendMessage(caller, request) {
        return await this.mailbox.send(caller, request);
    }
    /**
     * Add a task to the caller's durable team board.
     * @param caller - exact member.
     * @param request - new task fields.
     * @returns committed task view.
     */
    async createTask(caller, request) {
        return await this.tasks.create(this.roster.membership(caller), request);
    }
    /**
     * Read one task from the caller's team board.
     * @param caller - exact member.
     * @param id - task identity.
     * @returns latest task, including tombstones.
     */
    getTask(caller, id) { return this.tasks.get(this.roster.membership(caller), id); }
    /**
     * Read visible tasks from the caller's team board.
     * @param caller - exact member.
     * @returns non-deleted tasks.
     */
    listTasks(caller) { return this.tasks.list(this.roster.membership(caller)); }
    /**
     * Commit a revision-checked team task mutation.
     * @param caller - exact member.
     * @param request - revision-checked mutation.
     * @returns committed task view.
     */
    async updateTask(caller, request) {
        return await this.tasks.update(caller, this.roster.membership(caller), request);
    }
    /**
     * Wait for activity in the caller's team without retaining ownership after cancellation.
     * @param caller - exact member.
     * @param timeoutMs - bounded wait.
     * @param signal - wait cancellation.
     * @returns change or timeout.
     */
    async waitForChange(caller, timeoutMs, signal) {
        return await this.activity.wait(this.roster.membership(caller).id, timeoutMs, signal);
    }
    /**
     * Interrupt a teammate owned by the live Lead.
     * @param caller - exact Lead.
     * @param targetName - teammate name.
     * @returns status before interruption.
     */
    interrupt(caller, targetName) { return this.roster.interrupt(caller, targetName); }
    /**
     * Probe membership without admitting stale or foreign callers.
     * @param agent - candidate caller.
     * @returns membership or undefined for stale or foreign identities.
     */
    tryMembership(agent) { return this.roster.tryMembership(agent); }
    scheduleRecovery(agent) {
        queueMicrotask(() => {
            if (this.lifecycle.disposed)
                return;
            const operation = this.recoverFor(agent).catch((error) => {
                if (!this.lifecycle.disposed)
                    this.ctx.logger.warn(`Agent Teams recovery for "${agent.id}" failed: ${errorMessage(error)}`);
            });
            this.recoveries.add(operation);
            void operation.then(() => { this.recoveries.delete(operation); });
        });
    }
    async recoverFor(agent) {
        await this.roster.recoverFor(agent, this.lifecycle.signal);
        await this.mailbox.recoverFor(agent, this.lifecycle.signal);
    }
    async disposeRuntime() {
        this.lifecycle.close();
        this.activity.close();
        const failures = [];
        await this.lifecycle.settle([...this.recoveries], failures);
        await this.lifecycle.settle(this.roster.pendingCreations(), failures);
        await this.lifecycle.settle(this.mailbox.pendingDispatches(), failures);
        for (const [root, childIds] of this.roster.liveChildrenByRoot()) {
            try {
                await this.roster.stopTeammates(root, childIds);
            }
            catch (error) {
                failures.push(error);
            }
        }
        if (failures.length > 0)
            throw new AggregateError(failures, 'Agent Teams runtime disposal failed');
    }
}
export default TeamService;
//# sourceMappingURL=index.js.map