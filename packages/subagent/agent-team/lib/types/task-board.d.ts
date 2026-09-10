/** Shared task commands, authorization, and runtime-enriched views. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import { TeamTaskId } from './brand.ts';
import type { TeamJournal } from './journal.ts';
import { type TeamMembership } from './roster.ts';
import type { CreateTeamTaskRequest, TeamTaskView, UpdateTeamTaskRequest } from './types.ts';
/** Owns task limits, authorization, revisions and derived views. */
export declare class TeamTaskBoard {
    private readonly journal;
    private readonly maxTasks;
    constructor(journal: TeamJournal, maxTasks: number);
    /**
     * Create an unowned pending task in the Lead log.
     * @param membership - exact caller membership.
     * @param request - task text, blockers and advisory write scopes.
     * @returns revision-one view after durability.
     */
    create(membership: TeamMembership, request: CreateTeamTaskRequest): Promise<TeamTaskView>;
    /**
     * Read one task, including its deleted tombstone.
     * @param membership - exact caller membership.
     * @param id - Team-local task identity.
     * @returns latest runtime-enriched view.
     */
    get(membership: TeamMembership, id: TeamTaskId): TeamTaskView;
    /**
     * List non-deleted tasks in creation order.
     * @param membership - exact caller membership.
     * @returns detached task views.
     */
    list(membership: TeamMembership): TeamTaskView[];
    /**
     * Compare-and-set an authorized transition.
     * @param caller - exact live calling Agent.
     * @param membership - caller's Team role and Lead.
     * @param request - identity, expected revision, action and action fields.
     * @returns committed next-revision view.
     */
    update(caller: Agent, membership: TeamMembership, request: UpdateTeamTaskRequest): Promise<TeamTaskView>;
    private dependencies;
    private writeScopes;
    private assertTaskGraph;
    private taskReady;
    private withoutOwner;
    private taskView;
}
//# sourceMappingURL=task-board.d.ts.map