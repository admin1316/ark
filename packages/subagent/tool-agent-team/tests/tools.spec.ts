import { expect, it } from 'vitest'
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
