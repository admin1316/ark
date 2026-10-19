import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createTeamRuntime } from '../../agent-team/tests/runtime.ts'
import { SessionRemoteOperationsService } from '../../../host/session-remote-operations/src/index.ts'

it('releases deleted child content under its original address without admitting new reads or foreign closes', async () => {
  const run = await createTeamRuntime(Array.from({ length: 12 }, () => textResponse('retained content '.repeat(32))))
  try {
    run.ctx.loader.builtins['close-test-projections'] = SessionProjectionRegistry
    await run.ctx.loader.create({ name: 'cordis:close-test-projections' })
    await run.ctx.loader.await()
    new SessionRemoteOperationsService(run.ctx, { semanticHistory: { contentReaders: 1 } })
    const signal = new AbortController().signal
    async function childContent() {
      const childId = SessionId(randomUUID())
      const settled = Promise.withResolvers<SubagentRunEndInfo>()
      const detach = run.ctx.on('subagent/end', (info) => {
        if (info.id === childId) settled.resolve(info)
      })
      try {
        await run.ctx.subagents.startContinuable({
          childId, provider: 'spawn', label: 'content close child',
          request: { parent: run.lead, prompt: [{ type: 'text', text: 'initial task' }] }, signal,
        })
        // The manager emits this edge after durable flush and handle disposal;
        // a still-live Agent must not become an assertion formatter's input.
        expect((await settled.promise).stopReason).toBe('completed')
        expect(run.ctx.agents.get(childId) === undefined).toBe(true)
      } finally { detach() }
      const page = await run.ctx.subagents.remoteHistory(run.lead.id, childId, 'continuable',
        { view: 'semantic' }, undefined, signal)
      if (page.view !== 'semantic') throw new Error('expected semantic history')
      const record = page.records.find(record => record.kind === 'assistant')
      if (record === undefined) throw new Error('expected assistant content')
      return { id: childId, options: {
        view: 'content' as const, sourceRevision: page.sourceRevision, recordId: record.id, maxCodeUnits: 32,
      } }
    }
    const first = await childContent()
    const second = await childContent()
    const fragment = await run.ctx.subagents.remoteHistory(run.lead.id, first.id, 'continuable', first.options, undefined, signal)
    if (fragment.view !== 'content') throw new Error('expected content fragment')
    expect(fragment.done).toBe(false)
    await run.ctx.sessionPersistence.delete(first.id)
    const close = { ...first.options, contentReadId: fragment.contentReadId, close: true }
    await expect(run.ctx.subagents.remoteHistory(run.lead.id, first.id, 'continuable',
      { view: 'semantic' }, undefined, signal)).rejects.toMatchObject({ failure: { code: 'subagent-not-found' } })
    await expect(run.ctx.subagents.remoteHistory(run.lead.id, second.id, 'continuable',
      second.options, undefined, signal)).rejects.toMatchObject({ failure: { code: 'history-content-busy' } })
    await expect(run.ctx.subagents.remoteHistory(SessionId('foreign-parent'), first.id, 'continuable',
      close, undefined, signal)).rejects.toHaveProperty('failure')
    await expect(run.ctx.subagents.remoteHistory(run.lead.id, first.id, 'one-shot',
      close, undefined, signal)).rejects.toHaveProperty('failure')
    await expect(run.ctx.subagents.remoteHistory(run.lead.id, first.id, 'continuable', close, undefined, signal))
      .resolves.toMatchObject({ view: 'content', done: true, text: '' })
    await expect(run.ctx.subagents.remoteHistory(run.lead.id, first.id, 'continuable', close, undefined, signal))
      .rejects.toMatchObject({ failure: { code: 'history-content-expired' } })
    const next = await run.ctx.subagents.remoteHistory(run.lead.id, second.id, 'continuable', second.options, undefined, signal)
    expect(next).toMatchObject({ view: 'content', done: false })
  } finally { await run.dispose() }
})
