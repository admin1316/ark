/** Remote adapter over the single supported Agent Teams domain service. */
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { CreateTeamTaskRequest, UpdateTeamTaskRequest } from '@deepseek-ai/dsh-agent-team/types';
import type { TeamTaskMutationResult, TeamView } from './types.ts';
export * from '@deepseek-ai/dsh-agent-team';
export type { TeamTaskMutationResult, TeamView } from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        agentTeamRemote: TeamRemoteAdapter;
    }
}
/** Keeps the experimental Remote wire namespace without owning Team state or lifetime. */
export declare class TeamRemoteAdapter extends TypertRemoteService {
    static inject: string[];
    constructor(ctx: Context);
    /**
     * Read the current roster and non-deleted task board through the generated Remote API.
     * @param agent - exact live Team member used as the authority credential.
     * @returns detached current roster and task views.
     */
    remoteView(agent: Agent): TeamView;
    /**
     * Create one shared task through the generated Remote API.
     * @param agent - exact live Team member creating the task.
     * @param request - task text, blockers, and advisory write scopes.
     * @returns the revision-one task or a typed Team rejection.
     */
    remoteCreateTask(agent: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskMutationResult>;
    /**
     * Apply one task mutation and preserve Team rejections as business results.
     * @param agent - exact live Team member authorizing the mutation.
     * @param request - task identity, expected revision, action, and action fields.
     * @returns the committed task or a typed Team rejection.
     */
    remoteUpdateTask(agent: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskMutationResult>;
    /** Preserve Team task rejections while allowing unexpected failures to reject the Remote call. */
    private taskMutationResult;
}
export default TeamRemoteAdapter;
//# sourceMappingURL=index.d.ts.map