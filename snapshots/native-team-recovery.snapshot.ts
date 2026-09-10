/** Keyless model/tool transcript from the real Team Loader composition. */
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createTeamRuntime } from '../packages/subagent/agent-team/tests/runtime.ts'
import { textResponse, toolCallResponse } from '../packages/core/agent-loop/tests/mock-adapter.ts'

it('records Team task transitions and the no-active-peer wait result', async () => {
  const run = await createTeamRuntime([
    toolCallResponse('wait', 'wait_agent', {}),
    toolCallResponse('create', 'team_task_create', { subject: 'Review', description: 'Check the change', write_scopes: ['src'] }),
    toolCallResponse('list', 'team_task_list', {}),
    toolCallResponse('claim', 'team_task_update', { task_id: 'task-1', expected_revision: 1, action: 'claim' }),
    toolCallResponse('stale', 'team_task_update', { task_id: 'task-1', expected_revision: 1, action: 'complete' }),
    toolCallResponse('complete', 'team_task_update', { task_id: 'task-1', expected_revision: 2, action: 'complete' }),
    textResponse('Task completed.'),
  ])
  try {
    run.lead.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use the Team task board to review the change.' }] }))
    await run.lead.whenIdle()
    const results = run.lead.session.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(6)
    // Message envelope IDs and timestamps are generated; preserve the actual model-visible tool payloads.
    expect(results.map((event) => {
      expect(event.data.message.content).toHaveLength(1)
      const block = event.data.message.content[0]
      if (block?.type !== 'tool-result') throw new Error('expected the canonical tool-result block')
      return { callId: block.toolCallId, content: block.content, isError: block.isError === true, error: event.data.error ?? null }
    })).toMatchSnapshot()
    expect(run.ctx.agentTeams.listTasks(run.lead)).toMatchObject([{ id: 'task-1', revision: 3, status: 'completed' }])
    expect(run.lead.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  } finally { await run.dispose() }
})
