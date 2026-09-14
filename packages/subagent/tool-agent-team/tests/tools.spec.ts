import { expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as TeamTools from '../src/index.ts'
import { createTeamRuntime } from '../../agent-team/tests/runtime.ts'

it('removes every scoped Team tool when its real Loader entry unloads', async () => {
  const run = await createTeamRuntime([])
  try {
    const names = ['spawn_teammate', 'send_message', 'followup_task', 'list_agents', 'wait_agent', 'interrupt_agent',
      'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']
    for (const name of names) expect(run.ctx.tools.get(name, run.lead), name).toBeDefined()
    const entry = [...run.ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:team-test-model-tools')
    expect(entry).toBeDefined()
    await entry!.update({ disabled: true })
    for (const name of names) expect(run.ctx.tools.get(name, run.lead), name).toBeUndefined()
  } finally { await run.dispose() }
})

it('confines Team tools to the Agent scopes of the mounting composition', async () => {
  const run = await createTeamRuntime([])
  try {
    // Take over installation from the global Loader row so this test owns the
    // composition that decides which Agent scopes receive the tool set.
    const entry = [...run.ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:team-test-model-tools')
    expect(entry).toBeDefined()
    await entry!.update({ disabled: true })
    expect(run.ctx.tools.get('list_agents', run.lead)).toBeUndefined()

    const composition = createScope(run.ctx, { composition: 'team-tools' })
    const replacement = createScope(run.ctx, { composition: 'other-tools' })
    await composition.ctx.plugin(TeamTools, {})

    // A member outside the mounting composition keeps no Team surface: an
    // unknown session id is ignored, and a live non-member is left alone.
    run.ctx.emit('agent-preset/selected', SessionId('absent-member'), '')
    run.ctx.emit('agent-preset/selected', run.lead.id, '')
    await Promise.resolve()
    expect(run.ctx.tools.get('list_agents', run.lead)).toBeUndefined()

    // Joining the composition (the preset re-parents the Agent scope) installs
    // the complete surface and the role-bearing policy section for that member.
    const binding = bindScopeParent(run.lead, scopeOf(composition.ctx)!)
    run.ctx.emit('agent-preset/selected', run.lead.id, '')
    await vi.waitFor(() => { expect(run.ctx.tools.get('list_agents', run.lead)).toBeDefined() })
    const leadScope = scopeOf(run.lead.ctx)
    if (leadScope === undefined) throw new Error('lead scope missing')
    const joined = await run.ctx.systemPrompt.assemble({ scope: leadScope })
    expect(renderPrompt(joined)).toContain('Your Team role is lead')

    // Recompose away from the composition withdraws the surface for that Agent
    // while the composition itself keeps serving its own members.
    binding.rebind(scopeOf(replacement.ctx)!)
    run.ctx.emit('agent-preset/selected', run.lead.id, '')
    expect(run.ctx.tools.get('list_agents', run.lead)).toBeUndefined()
    const detachedScope = scopeOf(run.lead.ctx)
    if (detachedScope === undefined) throw new Error('lead scope missing after detach')
    expect(renderPrompt(await run.ctx.systemPrompt.assemble({ scope: detachedScope })))
      .not.toContain('Your Team role is lead')

    await replacement.dispose()
    await composition.dispose()
  } finally { await run.dispose() }
})
it('renders the base policy for a teammate whose provisioning failed while it was live', async () => {
  const run = await createTeamRuntime(['hang', 'hang', 'hang', 'hang', 'hang', 'hang'])
  try {
    let teammate: Agent | undefined
    run.ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.parentSession === run.lead.id) teammate = agent
    })
    // The teammate's durability checkpoint fails, so provisioning settles as
    // failed while the Agent that was named by it is still live and running.
    run.ctx.on('session/flush', (session) => {
      if (session.header.parentSession !== undefined) throw new Error('fixture durability failure')
    })
    let policy: string | undefined
    run.ctx.on('session/flush', async (session) => {
      if (session.id !== run.lead.id || teammate === undefined || policy !== undefined) return
      // Sampled inside the failing spawn, while the failed member is already
      // durable: the section is still installed for the live teammate Agent.
      const teammateScope = scopeOf(teammate.ctx)
      if (teammateScope === undefined) throw new Error('teammate scope missing')
      policy = renderPrompt(await run.ctx.systemPrompt.assemble({ scope: teammateScope }))
    })

    await expect(run.ctx.agentTeams.spawnTeammate(run.lead, {
      name: 'failed-worker',
      description: 'provisioning fails after the teammate exists',
      prompt: [{ type: 'text', text: 'work' }],
      context: 'fresh',
      provider: 'spawn',
      signal: new AbortController().signal,
    })).rejects.toThrow('fixture durability failure')

    expect(teammate).toBeDefined()
    expect(policy).toContain('Agent Teams is available in this session')
    expect(policy).not.toContain('Your Team role is')
  } finally { await run.dispose() }
})
