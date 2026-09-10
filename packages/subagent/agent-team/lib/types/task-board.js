import { TeamId, TeamTaskId } from "./brand.js";
import { TeamError } from "./error.js";
import { resolveActiveMember } from "./roster.js";
import { assertTaskGraphCandidate, TeamTaskGraphError } from "./task-graph.js";
import { requiredText, writeScope } from "./validation.js";
const TASK_GRAPH_ERROR_CODES = {
    missing: 'TEAM_TASK_NOT_FOUND', duplicate: 'TEAM_INVALID_ARGUMENT', cycle: 'TEAM_TASK_DEPENDENCY_CYCLE',
};
function scopesOverlap(left, right) {
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
/** Owns task limits, authorization, revisions and derived views. */
export class TeamTaskBoard {
    journal;
    maxTasks;
    constructor(journal, maxTasks) {
        this.journal = journal;
        this.maxTasks = maxTasks;
    }
    /**
     * Create an unowned pending task in the Lead log.
     * @param membership - exact caller membership.
     * @param request - task text, blockers and advisory write scopes.
     * @returns revision-one view after durability.
     */
    create(membership, request) {
        const { root } = membership;
        return this.journal.transact(root.id, async () => {
            const state = this.journal.state(root);
            if ([...state.tasks.values()].filter(task => task.status !== 'deleted').length >= this.maxTasks) {
                throw new TeamError(`Team task limit ${this.maxTasks} reached`, 'TEAM_TASK_LIMIT');
            }
            const id = TeamTaskId(`task-${state.nextTaskNumber}`);
            if (state.tasks.has(id))
                throw new TeamError('Team task id space exhausted', 'TEAM_TASK_LIMIT');
            const task = {
                id, revision: 1, subject: requiredText(request.subject, 'subject', 200),
                description: requiredText(request.description, 'description', 16_384), status: 'pending',
                blockedBy: this.dependencies(request.blockedBy ?? [], state), writeScopes: this.writeScopes(request.writeScopes ?? []),
            };
            this.assertTaskGraph(state, task);
            await this.journal.appendAndFlush(root, 'team/task', { version: 1, teamId: TeamId(root.id), task });
            return this.taskView(root, state, task);
        });
    }
    /**
     * Read one task, including its deleted tombstone.
     * @param membership - exact caller membership.
     * @param id - Team-local task identity.
     * @returns latest runtime-enriched view.
     */
    get(membership, id) {
        const { root } = membership;
        const state = this.journal.state(root);
        const task = state.tasks.get(id);
        if (task === undefined)
            throw new TeamError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND');
        return this.taskView(root, state, task);
    }
    /**
     * List non-deleted tasks in creation order.
     * @param membership - exact caller membership.
     * @returns detached task views.
     */
    list(membership) {
        const { root } = membership;
        const state = this.journal.state(root);
        return [...state.tasks.values()].filter(task => task.status !== 'deleted').map(task => this.taskView(root, state, task));
    }
    /**
     * Compare-and-set an authorized transition.
     * @param caller - exact live calling Agent.
     * @param membership - caller's Team role and Lead.
     * @param request - identity, expected revision, action and action fields.
     * @returns committed next-revision view.
     */
    update(caller, membership, request) {
        const root = membership.root;
        return this.journal.transact(root.id, async () => {
            const state = this.journal.state(root);
            const current = state.tasks.get(request.taskId);
            if (current === undefined)
                throw new TeamError(`team task "${request.taskId}" not found`, 'TEAM_TASK_NOT_FOUND');
            if (current.revision !== request.expectedRevision)
                throw new TeamError(`stale team task "${current.id}" revision ${request.expectedRevision}; current revision is ${current.revision}`, 'TEAM_TASK_STALE_REVISION');
            if (current.status === 'deleted')
                throw new TeamError(`team task "${current.id}" is deleted`, 'TEAM_TASK_DELETED');
            if (current.revision === Number.MAX_SAFE_INTEGER)
                throw new TeamError('Team task revision space exhausted', 'TEAM_TASK_LIMIT');
            const lead = membership.role === 'lead';
            const authorizeOwner = () => {
                if (!lead && current.ownerId !== caller.id)
                    throw new TeamError('task mutation requires its owner or Team Lead', 'TEAM_TASK_UNAUTHORIZED');
            };
            let next;
            switch (request.action) {
                case 'claim':
                    if (current.ownerId !== undefined && current.ownerId !== caller.id)
                        throw new TeamError(`team task "${current.id}" is owned by another member`, 'TEAM_TASK_ALREADY_CLAIMED');
                    if (current.status !== 'pending' || !this.taskReady(state, current))
                        throw new TeamError(`team task "${current.id}" is not ready to claim`, 'TEAM_TASK_BLOCKED');
                    next = { ...current, status: 'in_progress', ownerId: caller.id };
                    break;
                case 'release':
                    authorizeOwner();
                    if (current.status !== 'in_progress')
                        throw new TeamError('only an in-progress task can be released', 'TEAM_TASK_INVALID_TRANSITION');
                    next = this.withoutOwner({ ...current, status: 'pending' });
                    break;
                case 'edit':
                    authorizeOwner();
                    if (request.subject === undefined && request.description === undefined && request.writeScopes === undefined) {
                        throw new TeamError('task edit requires subject, description, or write_scopes', 'TEAM_INVALID_ARGUMENT');
                    }
                    next = {
                        ...current, ...(request.subject === undefined ? {} : { subject: requiredText(request.subject, 'subject', 200) }),
                        ...(request.description === undefined ? {} : { description: requiredText(request.description, 'description', 16_384) }),
                        ...(request.writeScopes === undefined ? {} : { writeScopes: this.writeScopes(request.writeScopes) }),
                    };
                    break;
                case 'set_dependencies':
                    authorizeOwner();
                    if (request.blockedBy === undefined)
                        throw new TeamError('set_dependencies requires blocked_by', 'TEAM_INVALID_ARGUMENT');
                    next = { ...current, blockedBy: this.dependencies(request.blockedBy, state, current.id) };
                    break;
                case 'complete':
                    authorizeOwner();
                    if (current.status !== 'in_progress')
                        throw new TeamError('only an in-progress task can complete', 'TEAM_TASK_INVALID_TRANSITION');
                    next = { ...current, status: 'completed' };
                    break;
                case 'reopen':
                    authorizeOwner();
                    if (current.status !== 'completed')
                        throw new TeamError('only a completed task can reopen', 'TEAM_TASK_INVALID_TRANSITION');
                    next = this.withoutOwner({ ...current, status: 'pending' });
                    break;
                case 'reassign': {
                    if (!lead)
                        throw new TeamError('only the Team Lead can reassign tasks', 'TEAM_LEAD_REQUIRED');
                    if (current.status !== 'pending' && current.status !== 'in_progress')
                        throw new TeamError('only a pending or in-progress task can be reassigned', 'TEAM_TASK_INVALID_TRANSITION');
                    if (request.owner === undefined || request.owner.trim().length === 0) {
                        next = this.withoutOwner({ ...current, status: 'pending' });
                        break;
                    }
                    if (!this.taskReady(state, current))
                        throw new TeamError(`team task "${current.id}" is blocked`, 'TEAM_TASK_BLOCKED');
                    const assignee = resolveActiveMember(root, state, request.owner);
                    next = { ...current, status: 'in_progress', ownerId: assignee.id };
                    break;
                }
                case 'delete': {
                    authorizeOwner();
                    const dependent = [...state.tasks.values()].find(task => task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id));
                    if (dependent !== undefined)
                        throw new TeamError(`team task "${current.id}" still blocks "${dependent.id}"`, 'TEAM_TASK_HAS_DEPENDENTS');
                    next = { ...current, status: 'deleted' };
                    break;
                }
                default: throw new TeamError(`unsupported task action ${String(request.action)}`, 'TEAM_INVALID_ARGUMENT');
            }
            const task = { ...next, revision: current.revision + 1 };
            this.assertTaskGraph(state, task);
            await this.journal.appendAndFlush(root, 'team/task', { version: 1, teamId: TeamId(root.id), task });
            return this.taskView(root, state, task);
        });
    }
    dependencies(values, state, self) {
        const seen = new Set();
        const result = [];
        for (const id of values) {
            if (id === self)
                throw new TeamError('a team task cannot block itself', 'TEAM_TASK_DEPENDENCY_CYCLE');
            if (seen.has(id))
                throw new TeamError(`duplicate blocker "${id}"`, 'TEAM_INVALID_ARGUMENT');
            const task = state.tasks.get(id);
            if (task === undefined || task.status === 'deleted')
                throw new TeamError(`blocker task "${id}" not found`, 'TEAM_TASK_NOT_FOUND');
            seen.add(id);
            result.push(id);
        }
        return result;
    }
    writeScopes(values) { return [...new Set(values.map(writeScope))]; }
    assertTaskGraph(state, candidate) {
        try {
            assertTaskGraphCandidate(state.tasks, candidate);
        }
        catch (error) {
            if (!(error instanceof TeamTaskGraphError))
                throw error;
            throw new TeamError(error.message, TASK_GRAPH_ERROR_CODES[error.violation], { cause: error });
        }
    }
    taskReady(state, task) {
        return task.blockedBy.every(id => state.tasks.get(id)?.status === 'completed');
    }
    withoutOwner(task) {
        const { ownerId: _ownerId, ...without } = task;
        return without;
    }
    taskView(root, state, task) {
        const ownerName = task.ownerId === undefined ? undefined : task.ownerId === root.id ? 'lead' : state.members.get(task.ownerId)?.name;
        const warnings = new Set();
        for (const other of state.tasks.values()) {
            if (other.id === task.id || other.status !== 'in_progress')
                continue;
            if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right))))
                warnings.add(`write scopes overlap with ${other.id}`);
        }
        return {
            id: task.id, revision: task.revision, subject: task.subject, description: task.description, status: task.status,
            blockedBy: structuredClone(task.blockedBy), writeScopes: structuredClone(task.writeScopes),
            ...(ownerName === undefined ? {} : { ownerName }), ready: task.status === 'pending' && this.taskReady(state, task),
            writeScopeWarnings: [...warnings],
        };
    }
}
//# sourceMappingURL=task-board.js.map