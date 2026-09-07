import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import GoalService from '@deepseek-ai/dsh-goal'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

async function scopedGoal() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(SessionId('goal-remote'))
  const agent = {} as Agent
  const agentCtx = ctx.extend({ agent })
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  Object.assign(agent, {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: agentCtx,
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } satisfies Agent)
  ctx.agents.register(agent)
  await agentCtx.plugin(GoalService)
  return { ctx, agent, goals: agentCtx.goals }
}

describe('Goal scoped Remote owner', () => {
  it('uses the agent context and preserves create/edit/pause/resume/complete/clear acknowledgements', async () => {
    const { goals } = await scopedGoal()
    const created = goals.remoteExportCreate({ objective: 'finish migration', maxGoalRounds: 3 })
    expect(created.ref.revision).toBe(1)
    const edited = goals.remoteExportEdit({ ref: created.ref, objective: 'finish native migration' })
    const paused = goals.remoteExportPause({ ref: edited.ref })
    const resumed = goals.remoteExportResume({ ref: paused.ref })
    const completed = goals.remoteExportComplete({ ref: resumed.ref })
    expect(goals.remoteExportClear({ ref: completed.ref })).toEqual({ cleared: true })
    expect(goals.typertRemote).toMatchObject({ serviceKey: 'goals', namespace: 'goal' })
    expect(remoteMethods(goals)).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'remoteExportCreate', exportName: 'create', invocation: { kind: 'context', context: 'agent' } }),
      expect.objectContaining({ method: 'remoteExportEdit', exportName: 'edit', invocation: { kind: 'context', context: 'agent' } }),
      expect.objectContaining({ method: 'remoteExportClear', exportName: 'clear', invocation: { kind: 'context', context: 'agent' } }),
    ]))
  })

  it('keeps stale compare-and-set failures machine-routable at the Remote boundary', async () => {
    const { goals } = await scopedGoal()
    const created = goals.remoteExportCreate({ objective: 'stale test' })
    let failure: unknown
    try {
      goals.remoteExportPause({ ref: { id: created.ref.id, revision: created.ref.revision + 1 } })
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toMatchObject({
      code: 'goal-error',
      details: { goalCode: 'GOAL_STALE_REVISION' },
    })
  })

  it('rejects an unscoped receiver and does not relabel non-Goal defects', async () => {
    const bare = new Context()
    const bareGoals = new GoalService(bare)
    expect(() => bareGoals.remoteExportCreate({ objective: 'unowned' }))
      .toThrow(expect.objectContaining({
        code: 'goal-error',
        details: { goalCode: 'GOAL_AGENT_NOT_LIVE' },
      }))

    const { goals } = await scopedGoal()
    vi.spyOn(goals, 'create').mockImplementationOnce(() => {
      throw new Error('unexpected storage defect')
    })
    expect(() => goals.remoteExportCreate({ objective: 'surface defect' }))
      .toThrow('unexpected storage defect')
  })
})
