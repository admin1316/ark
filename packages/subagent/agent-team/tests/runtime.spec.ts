import { expect, it, vi } from 'vitest'
import type { UpdateTeamTaskRequest } from '@deepseek-ai/dsh-agent-team'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { foldTeam } from '../src/fold.ts'
import { createTeamRuntime } from './runtime.ts'

it('runs task CAS, dependency and ownership checks through a real Loader composition', async () => {
  const run = await createTeamRuntime([])
  try {
    const teams = run.ctx.agentTeams
    expect(teams.membership(run.lead)).toMatchObject({ role: 'lead', name: 'lead' })
    const first = await teams.createTask(run.lead, { subject: 'Read', description: 'Read inputs', writeScopes: ['src'] })
    const blocked = await teams.createTask(run.lead, { subject: 'Write', description: 'Apply change', blockedBy: [first.id] })
    expect(blocked.ready).toBe(false)
    await expect(teams.updateTask(run.lead, { taskId: blocked.id, expectedRevision: 1, action: 'claim' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })
    const claimed = await teams.updateTask(run.lead, { taskId: first.id, expectedRevision: 1, action: 'claim' })
    expect(claimed).toMatchObject({ revision: 2, ownerName: 'lead', status: 'in_progress' })
    await expect(teams.updateTask(run.lead, { taskId: first.id, expectedRevision: 1, action: 'complete' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })
    await teams.updateTask(run.lead, { taskId: first.id, expectedRevision: 2, action: 'complete' })
    expect(teams.getTask(run.lead, blocked.id).ready).toBe(true)
    await expect(teams.updateTask(run.lead, { taskId: first.id, expectedRevision: 3, action: 'set_dependencies', blockedBy: [blocked.id] }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_DEPENDENCY_CYCLE' })
    await expect(teams.updateTask(run.lead, { taskId: first.id, expectedRevision: 3, action: 'delete' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_HAS_DEPENDENTS' })
    expect(() => teams.listTasks(new Proxy(run.lead, {}))).toThrow('not a member')
    const saved = await run.ctx.sessionPersistence.inspect(run.lead.id)
    expect(saved.events.filter(event => event.type === 'team/task')).toHaveLength(4)
  } finally { await run.dispose() }
})

it('provisions a real fresh teammate and persists its prompt before reporting active', async () => {
  const run = await createTeamRuntime([textResponse('child finished'), textResponse('lead received completion')])
  try {
    const spawned = await run.ctx.agentTeams.spawnTeammate(run.lead, {
      name: 'researcher', description: 'Read the inputs', prompt: [{ type: 'text', text: 'initial child task' }],
      provider: 'spawn', context: 'fresh', signal: new AbortController().signal,
    })
    const member = run.ctx.agents.get(spawned.member.id)
    await member?.whenIdle()
    const phases = run.lead.session.events.filter(event => event.type === 'team/member').map(event => event.data.member.phase)
    expect(phases).toEqual(['provisioning', 'active'])
    const stored = await run.ctx.sessionPersistence.inspect(spawned.member.id)
    expect(stored.meta.parentSession).toBe(run.lead.id)
    expect(stored.events.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === 'initial child task'))).toBe(true)
    expect(stored.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')).toBe(true)
    await expect(run.ctx.agentTeams.spawnTeammate(run.lead, {
      name: 'researcher', description: 'duplicate', prompt: [], provider: 'spawn', context: 'fresh', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
  } finally { await run.dispose() }
})

it('forks completed Lead history and rejects a stale caller', async () => {
  const run = await createTeamRuntime([textResponse('lead finished'), textResponse('fork finished'), textResponse('lead received completion')])
  try {
    run.lead.followup(createUserMessage({ content: [{ type: 'text', text: 'lead history' }], source: { kind: 'user' } }))
    await run.lead.whenIdle()
    const child = await run.ctx.agentTeams.spawnTeammate(run.lead, {
      name: 'reviewer', description: 'Review prior work', prompt: [{ type: 'text', text: 'review task' }],
      context: 'fork', provider: 'fork', signal: new AbortController().signal,
    })
    await run.ctx.agents.get(child.member.id)?.whenIdle()
    const stored = await run.ctx.sessionPersistence.inspect(child.member.id)
    expect(stored.meta.seedLength).toBeGreaterThan(0)
    expect(run.ctx.agentTeams.listMembers(run.lead).find(member => member.id === child.member.id)?.role).toBe('teammate')
    await expect(run.ctx.agentTeams.createTask(new Proxy(run.lead, {}), { subject: 'forged', description: 'forged' }))
      .rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
  } finally { await run.dispose() }
})

it('queues quiet mail for an inactive teammate and delivers it once on wakeup', async () => {
  const run = await createTeamRuntime(Array.from({ length: 8 }, () => textResponse('done')))
  try {
    const spawned = await run.ctx.agentTeams.spawnTeammate(run.lead, {
      name: 'worker', description: 'A worker', prompt: [{ type: 'text', text: 'initial task' }],
      provider: 'spawn', context: 'fresh', signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(run.ctx.agents.get(spawned.member.id)).toBeUndefined() })
    const quiet = await run.ctx.agentTeams.sendMessage(run.lead, {
      target: 'worker', content: [{ type: 'text', text: 'quiet context' }], delivery: 'quiet', signal: new AbortController().signal,
    })
    expect(quiet.status).toBe('queued')
    expect(run.adapter.requests.filter(request => request.sessionId === spawned.member.id)).toHaveLength(1)
    const wakeup = await run.ctx.agentTeams.sendMessage(run.lead, {
      target: 'worker', content: [{ type: 'text', text: 'next task' }], delivery: 'wakeup', signal: new AbortController().signal,
    })
    expect(wakeup.status).toBe('accepted')
    await vi.waitFor(() => { expect(run.ctx.agents.get(spawned.member.id)).toBeUndefined() })
    const stored = await run.ctx.sessionPersistence.inspect(spawned.member.id)
    const delivered = stored.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'team-message')
    expect(delivered).toHaveLength(2)
    const acknowledgements = run.lead.session.events.filter(event => event.type === 'team/message/delivered').map(event => event.data.messageId)
    expect(acknowledgements.filter(id => id === quiet.messageId)).toHaveLength(1)
    expect(acknowledgements.filter(id => id === wakeup.messageId)).toHaveLength(1)
    expect(run.adapter.requests.filter(request => request.sessionId === spawned.member.id)).toHaveLength(2)
  } finally { await run.dispose() }
})

it('refuses a task action this build does not implement without committing a revision', async () => {
  const run = await createTeamRuntime([])
  try {
    const teams = run.ctx.agentTeams
    const task = await teams.createTask(run.lead, { subject: 'Guarded', description: 'Unsupported transition', writeScopes: ['src'] })
    // A caller compiled against another protocol revision can name an action this
    // build has no transition for. The board must refuse it by name and leave the
    // durable revision untouched rather than committing a snapshot it cannot compute.
    const unsupportedAction: string = 'teleport'
    const request = { taskId: task.id, expectedRevision: task.revision, action: unsupportedAction } as UpdateTeamTaskRequest
    await expect(teams.updateTask(run.lead, request)).rejects.toMatchObject({
      code: 'TEAM_INVALID_ARGUMENT',
      message: expect.stringContaining('unsupported task action teleport') as string,
    })
    expect(teams.getTask(run.lead, task.id)).toMatchObject({ revision: 1, status: 'pending' })
    expect(run.lead.session.events.filter(event => event.type === 'team/task')).toHaveLength(1)
  } finally { await run.dispose() }
})

it('keeps the target queue usable after a dispatch failure that cannot even be described', async () => {
  const run = await createTeamRuntime(Array.from({ length: 6 }, () => textResponse('done')))
  try {
    const teams = run.ctx.agentTeams
    const spawned = await teams.spawnTeammate(run.lead, {
      name: 'worker', description: 'A worker', prompt: [{ type: 'text', text: 'initial task' }],
      provider: 'spawn', context: 'fresh', signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(run.ctx.agents.get(spawned.member.id)).toBeUndefined() })
    // The continuation owner rejects with a value that cannot even be inspected.
    // Even then the mailbox must report the failed admission to its sender, keep the
    // message queued exactly once, and leave the per-target dispatch order usable.
    const undescribable = {
      [Symbol.for('nodejs.util.inspect.custom')](): never { throw new Error('uninspectable delivery failure') },
    }
    const followup = vi.spyOn(run.ctx.subagents, 'followup').mockRejectedValueOnce(undescribable)
    await expect(teams.sendMessage(run.lead, {
      target: 'worker', content: [{ type: 'text', text: 'wake the worker' }], delivery: 'wakeup', signal: new AbortController().signal,
    })).rejects.toThrow('uninspectable delivery failure')
    expect(run.lead.session.events.filter(event => event.type === 'team/message/queued')).toHaveLength(1)
    expect(run.lead.session.events.filter(event => event.type === 'team/message/delivered')).toHaveLength(0)
    followup.mockRestore()
    const retried = await teams.sendMessage(run.lead, {
      target: 'worker', content: [{ type: 'text', text: 'next task' }], delivery: 'wakeup', signal: new AbortController().signal,
    })
    expect(retried.status).toBe('accepted')
  } finally { await run.dispose() }
})

it('reports a provisioning conflict when the durable member vanished before settle', async () => {
  const run = await createTeamRuntime(Array.from({ length: 6 }, () => textResponse('done')))
  try {
    const teams = run.ctx.agentTeams
    const startResult = Promise.withResolvers<never>()
    vi.spyOn(run.ctx.subagents, 'startContinuable').mockImplementation(() => startResult.promise)
    // Simulate a durable journal that lost the provisioning member (e.g. a
    // compacted or replaced root log): the settle must refuse instead of
    // recording a terminal phase for a teammate the journal never knew.
    let vanishNext = false
    // The roster owns its journal privately; reach it structurally for this
    // corruption simulation without importing the class.
    const journal = (teams as unknown as {
      journal: { state(root: Agent): { members: Map<string, { phase: string }> } }
    }).journal
    const stateSpy = vi.spyOn(journal, 'state').mockImplementation((root: Agent) => {
      const state = foldTeam(root.id, root.session.events)
      if (vanishNext) {
        vanishNext = false
        for (const [id, member] of state.members) {
          if (member.phase === 'provisioning') state.members.delete(id)
        }
      }
      return state
    })
    const spawning = teams.spawnTeammate(run.lead, {
      name: 'vanishing-worker', description: 'Vanished mid-provisioning', prompt: [{ type: 'text', text: 'initial child task' }],
      provider: 'spawn', context: 'fresh', signal: new AbortController().signal,
    }).catch((error: unknown) => error)
    await vi.waitFor(() => {
      expect(run.lead.session.events.some(event => event.type === 'team/member')).toBe(true)
    })
    vanishNext = true
    startResult.reject(new Error('start failed'))
    const failure = await spawning
    if (!(failure instanceof AggregateError)) throw new Error('a vanished member must report both failures')
    expect(failure.errors[0]).toBeInstanceOf(Error)
    expect(failure.errors[1]).toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
    stateSpy.mockRestore()
  } finally { await run.dispose() }
})

it('aggregates a provisioning conflict with the cleanup failure that followed it', async () => {
  const run = await createTeamRuntime(Array.from({ length: 6 }, () => textResponse('done')))
  try {
    const teams = run.ctx.agentTeams
    const start = run.ctx.subagents.startContinuable.bind(run.ctx.subagents)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let childId: string | undefined
    vi.spyOn(run.ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      childId = spec.childId
      entered.resolve(undefined)
      await release.promise
      return await start(spec)
    })
    const spawning = teams.spawnTeammate(run.lead, {
      name: 'racing-worker', description: 'Racing creation', prompt: [{ type: 'text', text: 'initial child task' }],
      provider: 'spawn', context: 'fresh', signal: new AbortController().signal,
    }).catch((error: unknown) => error)
    await entered.promise
    // A resumed Lead reconciles the still-provisioning member before its creator finishes.
    run.ctx.emit('agent/session-start', { agent: run.lead, source: 'resume' })
    await vi.waitFor(() => {
      expect(run.lead.session.events.filter(event => event.type === 'team/member').map(event => event.data.member.phase))
        .toEqual(['provisioning', 'failed'])
    })
    const cleanupFailure = new Error('continuation drain unavailable')
    const drain = vi.spyOn(run.ctx.subagents, 'drainContinuableChildren').mockRejectedValueOnce(cleanupFailure)
    release.resolve(undefined)
    const failure = await spawning
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('a conflicted provisioning must report both failures')
    expect(failure.errors).toHaveLength(2)
    expect(failure.errors[0]).toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
    expect(failure.errors[1]).toBe(cleanupFailure)
    expect(drain).toHaveBeenCalledWith(run.lead, [childId])
    expect(teams.listMembers(run.lead).find(member => member.name === 'racing-worker')?.status).toBe('failed')
    expect(run.lead.session.events.filter(event => event.type === 'team/member').map(event => event.data.member.phase))
      .toEqual(['provisioning', 'failed'])
  } finally { await run.dispose() }
})

it('retains failed provisioning without allowing a reused name', async () => {
  const run = await createTeamRuntime([])
  try {
    const request = {
      name: 'missing-provider', description: 'Unavailable provider', prompt: [{ type: 'text' as const, text: 'task' }],
      provider: 'absent', context: 'fresh' as const, signal: new AbortController().signal,
    }
    await expect(run.ctx.agentTeams.spawnTeammate(run.lead, request)).rejects.toThrow()
    expect(run.ctx.agentTeams.listMembers(run.lead).find(member => member.name === request.name)?.status).toBe('failed')
    await expect(run.ctx.agentTeams.spawnTeammate(run.lead, request)).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
    expect(run.ctx.agents.list()).toEqual([run.lead])
  } finally { await run.dispose() }
})
