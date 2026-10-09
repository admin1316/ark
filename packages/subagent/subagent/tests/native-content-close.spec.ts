import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createTeamRuntime } from '../../agent-team/tests/runtime.ts'
import { SessionRemoteOperationsService } from '../../../host/session-remote-operations/src/index.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function remoteFailureCode(operation: Promise<unknown>): Promise<string | undefined> {
  try {
    await operation
    return undefined
  } catch (error) {
    const failure = isRecord(error) ? error.failure : undefined
    const code = isRecord(failure) ? failure.code : undefined
    return typeof code === 'string' ? code : undefined
  }
}

it('releases deleted child content under its original address without admitting new reads or foreign closes', async () => {
  const run = await createTeamRuntime(Array.from({ length: 12 }, () => textResponse('retained content '.repeat(32))))
  try {
    run.ctx.loader.builtins['close-test-projections'] = SessionProjectionRegistry
    await run.ctx.loader.create({ name: 'cordis:close-test-projections' })
    await run.ctx.loader.await()
    new SessionRemoteOperationsService(run.ctx, { semanticHistory: { contentReaders: 1 } })
    const signal = new AbortController().signal
    async function childContent() {
      const child = await run.ctx.subagents.startContinuable({
        provider: 'spawn', label: 'content close child',
        request: { parent: run.lead, prompt: [{ type: 'text', text: 'initial task' }] }, signal,
      })
      await vi.waitFor(() => { expect(run.ctx.agents.get(child.childId)).toBeUndefined() })
      const page = await run.ctx.subagents.remoteHistory(run.lead.id, child.childId, 'continuable',
        { view: 'semantic' }, undefined, signal)
      if (page.view !== 'semantic') throw new Error('expected semantic history')
      const record = page.records.find(record => record.kind === 'assistant')
      if (record === undefined) throw new Error('expected assistant content')
      return { id: child.childId, options: {
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
    expect(await remoteFailureCode(run.ctx.subagents.remoteHistory(run.lead.id, first.id, 'continuable',
      { view: 'semantic' }, undefined, signal))).toBe('subagent-not-found')
    expect(await remoteFailureCode(run.ctx.subagents.remoteHistory(run.lead.id, second.id, 'continuable',
      second.options, undefined, signal))).toBe('history-content-busy')
    expect(await remoteFailureCode(run.ctx.subagents.remoteHistory(SessionId('foreign-parent'), first.id, 'continuable',
      close, undefined, signal))).toBeTruthy()
    expect(await remoteFailureCode(run.ctx.subagents.remoteHistory(run.lead.id, first.id, 'one-shot',
      close, undefined, signal))).toBeTruthy()
    const closed = await run.ctx.subagents.remoteHistory(run.lead.id, first.id, 'continuable', close, undefined, signal)
    if (closed.view !== 'content') throw new Error('closing an existing content read returned another history view')
    expect({ done: closed.done, text: closed.text }).toEqual({ done: true, text: '' })
    expect(await remoteFailureCode(run.ctx.subagents.remoteHistory(run.lead.id, first.id, 'continuable',
      close, undefined, signal))).toBe('history-content-expired')
    const next = await run.ctx.subagents.remoteHistory(run.lead.id, second.id, 'continuable', second.options, undefined, signal)
    expect(next).toMatchObject({ view: 'content', done: false })
  } finally { await run.dispose() }
})
