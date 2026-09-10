import { expect, it, vi } from 'vitest'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { textResponse } from '../packages/core/agent-loop/tests/mock-adapter.ts'
import { createTeamRuntime } from '../packages/subagent/agent-team/tests/runtime.ts'

it('Native child retries preserve one durable message and one later model turn through Loader', async () => {
  const run = await createTeamRuntime(Array.from({ length: 10 }, () => textResponse('child response')))
  try {
    run.ctx.loader.builtins['native-snapshot-projections'] = SessionProjectionRegistry
    await run.ctx.loader.create({ name: 'cordis:native-snapshot-projections' })
    await run.ctx.loader.await()
    const signal = new AbortController().signal
    const child = await run.ctx.subagents.startContinuable({
      provider: 'spawn', label: 'Native worker',
      request: { parent: run.lead, prompt: [{ type: 'text', text: 'initial task' }] }, signal,
    })
    await vi.waitFor(() => { expect(run.ctx.agents.get(child.childId)).toBeUndefined() })
    const invocationId = '11111111-1111-4111-8111-111111111111'
    const prompt = () => run.ctx.subagents.remotePrompt(run.lead, child.childId,
      [{ type: 'text', text: 'one durable Native request' }], invocationId, signal)
    const first = await prompt()
    const receipts = [first, ...await Promise.all([prompt(), prompt()])]
    await vi.waitFor(() => { expect(run.ctx.agents.get(child.childId)).toBeUndefined() })
    const coldRetry = await prompt()
    const stored = await run.ctx.sessionPersistence.inspect(child.childId)
    const catalog = await run.ctx.subagents.remoteExportList(run.lead.id, signal)
    expect({
      providers: run.ctx.llm.remoteProviders(),
      catalog: { ...catalog, entries: catalog.entries.map(entry => ({ ...entry, id: '<child-id>' })) },
      // Only random message/session identities are normalized; content, flags and counts are exact.
      receipts: receipts.map(receipt => ({ ...receipt, messageId: '<message-id>' })),
      coldRetry: { ...coldRetry, messageId: '<message-id>' },
      sameMessage: receipts.every(receipt => receipt.messageId === coldRetry.messageId),
      modelTurns: run.adapter.requests.filter(request => request.sessionId === child.childId).length,
      delivered: stored.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'subagent-prompt'
        ? [{ source: { ...event.data.source, senderSessionId: '<parent-id>' }, content: event.data.content }] : []),
    }).toMatchSnapshot()
  } finally { await run.dispose() }
})
