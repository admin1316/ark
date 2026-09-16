/** Remote adapter over the single supported Agent Teams domain service. */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamError } from '@deepseek-ai/dsh-agent-team'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CreateTeamTaskRequest, TeamTaskView, UpdateTeamTaskRequest } from '@deepseek-ai/dsh-agent-team/types'
import type { TeamTaskMutationResult, TeamView } from './types.ts'

export * from '@deepseek-ai/dsh-agent-team'
export type { TeamTaskMutationResult, TeamView } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeamRemote: TeamRemoteAdapter
  }
}

/** Keeps the experimental Remote wire namespace without owning Team state or lifetime. */
export class TeamRemoteAdapter extends TypertRemoteService {
  static inject = ['agentTeams']

  constructor(ctx: Context) {
    super(ctx, 'agentTeamRemote', { namespace: 'agentTeams' })
  }

  /**
   * Read the current roster and non-deleted task board through the generated Remote API.
   * @param agent - exact live Team member used as the authority credential.
   * @returns detached current roster and task views.
   */
  @Remote('view')
  remoteView(agent: Agent): TeamView {
    return {
      members: this.ctx.agentTeams.listMembers(agent),
      tasks: this.ctx.agentTeams.listTasks(agent),
    }
  }

  /**
   * Create one shared task through the generated Remote API.
   * @param agent - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task or a typed Team rejection.
   */
  @Remote('createTask')
  remoteCreateTask(agent: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskMutationResult> {
    return this.taskMutationResult(this.ctx.agentTeams.createTask(agent, request))
  }

  /**
   * Apply one task mutation and preserve Team rejections as business results.
   * @param agent - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed task or a typed Team rejection.
   */
  @Remote('updateTask')
  remoteUpdateTask(agent: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskMutationResult> {
    return this.taskMutationResult(this.ctx.agentTeams.updateTask(agent, request))
  }

  /** Preserve Team task rejections while allowing unexpected failures to reject the Remote call. */
  private async taskMutationResult(operation: Promise<TeamTaskView>): Promise<TeamTaskMutationResult> {
    try {
      return { ok: true, value: await operation }
    } catch (error) {
      if (!(error instanceof TeamError)) throw error
      return {
        ok: false,
        error: {
          code: error.code === 'TEAM_TASK_STALE_REVISION' ? 'team-task-conflict' : 'team-rejected',
          message: error.message,
        },
      }
    }
  }

}

export default TeamRemoteAdapter
