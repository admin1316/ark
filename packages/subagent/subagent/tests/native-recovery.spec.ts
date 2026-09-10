import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createTeamRuntime } from '../../agent-team/tests/runtime.ts'

async function runtime() {
  const run = await createTeamRuntime(Array.from({ length: 12 }, () => textResponse('done')))
  run.ctx.loader.builtins['native-test-projections'] = SessionProjectionRegistry
  await run.ctx.loader.create({ name: 'cordis:native-test-projections' })
  await run.ctx.loader.await()
  const child = await run.ctx.subagents.startContinuable({
    provider: 'spawn', label: 'native child',
    request: { parent: run.lead, prompt: [{ type: 'text', text: 'initial task' }] },
    signal: new AbortController().signal,
  })
  await vi.waitFor(() => { expect(run.ctx.agents.get(child.childId)).toBeUndefined() })
  return { ...run, childId: child.childId }
}

it('delivers simultaneous and cold Native retries once through the real Loader and persistence', async () => {
  const run = await runtime()
  try {
    const invocationId = randomUUID()
    const content = [{ type: 'text' as const, text: 'one native follow-up' }]
    const prompt = () => run.ctx.subagents.remotePrompt(run.lead, run.childId, content, invocationId, new AbortController().signal)
    const receipts = await Promise.all([prompt(), prompt(), prompt()])
    expect(new Set(receipts.map(receipt => receipt.messageId)).size).toBe(1)
    expect(receipts.filter(receipt => !receipt.duplicate)).toHaveLength(1)
    expect(receipts.every(receipt => receipt.durable)).toBe(true)
    await vi.waitFor(() => { expect(run.ctx.agents.get(run.childId)).toBeUndefined() })
    const count = run.adapter.requests.filter(request => request.sessionId === run.childId).length
    expect(await prompt()).toEqual({ ...receipts[0], duplicate: true })
    expect(run.ctx.agents.get(run.childId)).toBeUndefined()
    expect(run.adapter.requests.filter(request => request.sessionId === run.childId)).toHaveLength(count)
    const saved = await run.ctx.sessionPersistence.inspect(run.childId)
    const messages = saved.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-prompt' && event.data.source.invocationId === invocationId)
    expect(messages).toHaveLength(1)
    await expect(run.ctx.subagents.remotePrompt(run.lead, run.childId,
      [{ type: 'text', text: 'different input' }], invocationId, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'input-invalid' } })
  } finally { await run.dispose() }
})

it('rejects stale parents, malformed invocation ids and cancelled Native delivery', async () => {
  const run = await runtime()
  try {
    const content = [{ type: 'text' as const, text: 'must not enter' }]
    await expect(run.ctx.subagents.remotePrompt(new Proxy(run.lead, {}), run.childId,
      content, randomUUID(), new AbortController().signal)).rejects.toMatchObject({ failure: { code: 'subagent-unauthorized' } })
    await expect(run.ctx.subagents.remotePrompt(run.lead, run.childId,
      content, 'invalid', new AbortController().signal)).rejects.toMatchObject({ failure: { code: 'input-invalid' } })
    await expect(run.ctx.subagents.remotePrompt(run.lead, run.childId,
      content, randomUUID(), AbortSignal.abort())).rejects.toMatchObject({ failure: { code: 'cancelled' } })
    expect(run.ctx.subagents.remoteInterrupt(run.lead.id, run.childId)).toEqual({ accepted: true })
    const catalog = await run.ctx.subagents.remoteExportList(run.lead.id, new AbortController().signal)
    expect(catalog).toMatchObject({ parentAvailable: true, entries: [{ id: run.childId, kind: 'child', mode: 'continuable' }] })
    const saved = await run.ctx.sessionPersistence.inspect(run.childId)
    expect(saved.events.some(event => event.type === 'user/message' && event.data.source.kind === 'subagent-prompt')).toBe(false)
    await expect(run.ctx.subagents.remoteHistory(SessionId('foreign-parent'), run.childId,
      'continuable', undefined, 10, new AbortController().signal)).rejects.toMatchObject({ failure: { code: 'subagent-not-found' } })
  } finally { await run.dispose() }
})

it('retains accepted messages on a durability failure and retries without another insertion', async () => {
  const run = await runtime()
  try {
    let failed = false
    const removeFailure = run.ctx.on('session/flush', (session) => {
      if (session.id === run.childId && !failed) { failed = true; throw new Error('fixture durability failure') }
    })
    const invocationId = randomUUID()
    const prompt = () => run.ctx.subagents.remotePrompt(run.lead, run.childId,
      [{ type: 'text', text: 'accepted before failure' }], invocationId, new AbortController().signal)
    await expect(prompt()).rejects.toMatchObject({ failure: { code: 'internal' } })
    removeFailure()
    const receipt = await prompt()
    expect(receipt).toMatchObject({ invocationId, durable: true, duplicate: true })
    const saved = await run.ctx.sessionPersistence.inspect(run.childId)
    const ids = new Set(saved.events.flatMap(event => event.type === 'agent/inbox/spliced'
      ? event.data.inserted.filter(message => message.source.kind === 'subagent-prompt').map(message => message.id) : []))
    expect([...ids]).toEqual([receipt.messageId])
  } finally { await run.dispose() }
})

it('finishes durability after caller cancellation loses the acceptance race', async () => {
  const run = await runtime()
  try {
    const cancellation = new AbortController()
    const remove = run.ctx.on('session/flush', (session) => {
      if (session.id === run.childId) cancellation.abort()
    })
    const receipt = await run.ctx.subagents.remotePrompt(run.lead, run.childId,
      [{ type: 'text', text: 'durability owns accepted work' }], randomUUID(), cancellation.signal)
    remove()
    expect(cancellation.signal.aborted).toBe(true)
    expect(receipt).toMatchObject({ durable: true, duplicate: false })
    const saved = await run.ctx.sessionPersistence.inspect(run.childId)
    expect(saved.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === receipt.messageId))).toBe(true)
  } finally { await run.dispose() }
})
