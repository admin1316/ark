/** Team service over roster, durable mailbox, task board and runtime lifetime owners. */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type TeamTaskId } from './brand.ts';
import { type TeamMembership } from './roster.ts';
import type { Config, CreateTeamTaskRequest, SendTeamMessageRequest, SendTeamMessageResult, SpawnTeammateRequest, SpawnTeammateResult, TeamMemberView, TeamTaskView, TeamWaitResult, UpdateTeamTaskRequest } from './types.ts';
export type * from './types.ts';
export type { TeamMembership } from './roster.ts';
export { TeamId, TeamTaskId, TeamMessageId } from './brand.ts';
export { TeamError } from './error.ts';
export { foldTeam } from './fold.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        agentTeams: TeamService;
    }
}
/** Agent Teams backed by the exact live Lead's durable Session log. */
export declare class TeamService extends Service {
    static inject: string[];
    static Config: z<Config>;
    private readonly config;
    private readonly activity;
    private readonly lifecycle;
    private readonly journal;
    private readonly roster;
    private readonly mailbox;
    private readonly tasks;
    private readonly recoveries;
    constructor(ctx: Context, config?: Config);
    /**
     * Require the caller's current live team membership.
     * @param agent - exact live caller.
     * @returns current Team role.
     */
    membership(agent: Agent): TeamMembership;
    /**
     * Read the live member's team roster.
     * @param agent - exact live member.
     * @returns roster in creation order.
     */
    listMembers(agent: Agent): TeamMemberView[];
    /**
     * Create a teammate under the live Lead's roster and runtime lifetime.
     * @param caller - exact Lead.
     * @param request - creation request.
     * @returns durable active member.
     */
    spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>;
    /**
     * Admit a peer message through the durable team mailbox.
     * @param caller - exact sender.
     * @param request - peer message.
     * @returns durable admission result.
     */
    sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>;
    /**
     * Add a task to the caller's durable team board.
     * @param caller - exact member.
     * @param request - new task fields.
     * @returns committed task view.
     */
    createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>;
    /**
     * Read one task from the caller's team board.
     * @param caller - exact member.
     * @param id - task identity.
     * @returns latest task, including tombstones.
     */
    getTask(caller: Agent, id: TeamTaskId): TeamTaskView;
    /**
     * Read visible tasks from the caller's team board.
     * @param caller - exact member.
     * @returns non-deleted tasks.
     */
    listTasks(caller: Agent): TeamTaskView[];
    /**
     * Commit a revision-checked team task mutation.
     * @param caller - exact member.
     * @param request - revision-checked mutation.
     * @returns committed task view.
     */
    updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>;
    /**
     * Wait for activity in the caller's team without retaining ownership after cancellation.
     * @param caller - exact member.
     * @param timeoutMs - bounded wait.
     * @param signal - wait cancellation.
     * @returns change or timeout.
     */
    waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>;
    /**
     * Interrupt a teammate owned by the live Lead.
     * @param caller - exact Lead.
     * @param targetName - teammate name.
     * @returns status before interruption.
     */
    interrupt(caller: Agent, targetName: string): {
        previousStatus: 'running' | 'idle' | 'inactive';
    };
    /**
     * Probe membership without admitting stale or foreign callers.
     * @param agent - candidate caller.
     * @returns membership or undefined for stale or foreign identities.
     */
    tryMembership(agent: Agent): TeamMembership | undefined;
    private scheduleRecovery;
    private recoverFor;
    private disposeRuntime;
}
export default TeamService;
//# sourceMappingURL=index.d.ts.map