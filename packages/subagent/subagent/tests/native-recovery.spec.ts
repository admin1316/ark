import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime, { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createTeamRuntime } from '../../agent-team/tests/runtime.ts'
import { SessionRemoteOperationsService } from '../../../host/session-remote-operations/src/index.ts'

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


it('forwards fixed raw, semantic and full content through real child mode admission without resuming either Agent', async () => {
  const run = await runtime()
  try {
    new SessionRemoteOperationsService(run.ctx)
    const signal = new AbortController().signal
    const semantic = await run.ctx.subagents.remoteHistory(run.lead.id, run.childId,
      'continuable', { view: 'semantic' }, undefined, signal)
    if (semantic.view !== 'semantic') throw new Error('expected child semantic view')
    const raw = await run.ctx.subagents.remoteHistory(run.lead.id, run.childId,
      'continuable', { view: 'raw', sourceRevision: semantic.sourceRevision, maxEvents: 1 }, undefined, signal)
    expect(raw).toMatchObject({ view: 'raw', sourceRevision: semantic.sourceRevision, asOfThroughSeq: semantic.asOfThroughSeq })
    if (raw.view !== 'raw') throw new Error('expected bound raw child page')
    expect(raw.events).toHaveLength(1)
    expect(raw.events[0]?.event.seq).toBe(semantic.asOfThroughSeq)
    const record = semantic.records.find(record => record.kind === 'assistant')
    if (record === undefined) throw new Error('expected assistant record')
    const options = { view: 'content' as const, sourceRevision: semantic.sourceRevision, recordId: record.id, maxCodeUnits: 32 }
    const first = await run.ctx.subagents.remoteHistory(run.lead.id, run.childId, 'continuable', options, undefined, signal)
    if (first.view !== 'content') throw new Error('expected child body')
    await expect(run.ctx.subagents.remoteHistory(run.lead.id, run.childId, 'one-shot',
      { ...options, contentReadId: first.contentReadId, offset: first.nextOffset }, undefined, signal))
      .rejects.toMatchObject({ failure: { code: 'subagent-not-found' } })
    const closed = await run.ctx.subagents.remoteHistory(run.lead.id, run.childId, 'continuable',
      { ...options, contentReadId: first.contentReadId, close: true }, undefined, signal)
    expect(closed).toMatchObject({ view: 'content', done: true, text: '' })
    expect(run.ctx.agents.get(run.childId)).toBeUndefined()
    await expect(run.ctx.subagents.remoteHistory(run.lead.id, run.childId, 'continuable',
      { view: 'semantic' }, undefined, AbortSignal.abort())).rejects.toMatchObject({ failure: { code: 'cancelled' } })
  } finally { await run.dispose() }
})

it('translates the legacy (beforeSeq, maxMessages) cursor form into one bounded page', async () => {
  const run = await runtime()
  try {
    new SessionRemoteOperationsService(run.ctx)
    const saved = await run.ctx.sessionPersistence.inspect(run.childId)
    const cursor = saved.events.at(-1)!.seq
    const page = await run.ctx.subagents.remoteHistory(run.lead.id, run.childId,
      'continuable', cursor, undefined, new AbortController().signal)
    if (page.view !== 'raw') throw new Error('expected a raw child page')
    // The legacy numeric cursor is exclusive, and the omitted maxMessages bound
    // falls back to the owner's own default instead of dropping the request.
    expect(page.events.map(entry => entry.event.seq))
      .toEqual(saved.events.filter(event => event.seq < cursor).map(event => event.seq))
    expect(page.events.at(-1)?.event.seq).toBe(cursor - 1)
    expect(page.hasMore).toBe(false)
  } finally { await run.dispose() }
})

it('rechecks cancellation after the owner page and refuses a malformed owner failure', async () => {
  const run = await runtime()
  try {
    new SessionRemoteOperationsService(run.ctx)
    const sessions = run.ctx.sessions
    const ownerHistory = sessions.remoteExportHistory.bind(sessions)
    const cancellation = new AbortController()
    vi.spyOn(sessions, 'remoteExportHistory').mockImplementationOnce(async (request, signal) => {
      const page = await ownerHistory(request, signal)
      cancellation.abort(new Error('the caller left while the page was read'))
      return page
    })
    await expect(run.ctx.subagents.remoteHistory(run.lead.id, run.childId, 'continuable',
      { view: 'semantic' }, undefined, cancellation.signal))
      .rejects.toMatchObject({ failure: { code: 'cancelled' } })

    // A foreign Session owner may answer with a failure whose details are not a
    // structured object; the refusal must still carry a details object.
    vi.spyOn(sessions, 'remoteExportHistory').mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal', message: 'the owner failed', details: [] },
    })
    await expect(run.ctx.subagents.remoteHistory(run.lead.id, run.childId, 'continuable',
      { view: 'semantic' }, undefined, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'internal', details: {} } })
  } finally { await run.dispose() }
})

it('refuses an unreadable catalog row and a catalog read the caller cancelled', async () => {
  const run = await runtime()
  try {
    new SessionRemoteOperationsService(run.ctx)
    const corruptId = SessionId('00000000-0000-4000-8000-0000000000c1')
    await run.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: corruptId,
      createdAt: 1,
      parentSession: run.lead.id,
      origin: 'subagent',
    })
    await run.ctx.sessionPersistence.append(corruptId, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      {
        type: 'subagent/descriptor',
        seq: 1,
        time: 2,
        data: { version: SUBAGENT_DESCRIPTOR_VERSION + 1, mode: 'continuable', provider: 'spawn', label: 'unreadable' },
      },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    // A durable row whose descriptor no reader recognizes has no continuation
    // state: the history route refuses it by name instead of guessing a mode.
    await expect(run.ctx.subagents.remoteHistory(run.lead.id, corruptId, 'continuable',
      { view: 'semantic' }, undefined, new AbortController().signal))
      .rejects.toMatchObject({
        failure: { code: 'subagent-catalog-diagnostic', details: { childSessionId: corruptId, reason: 'corrupt' } },
      })

    const cancellation = new AbortController()
    const originalList = run.ctx.subagents.listChildren.bind(run.ctx.subagents)
    vi.spyOn(run.ctx.subagents, 'listChildren').mockImplementationOnce(async (parent, signal) => {
      const authorized = await originalList(parent, signal)
      cancellation.abort(new Error('the caller left while the catalog was read'))
      return authorized
    })
    await expect(run.ctx.subagents.remoteHistory(run.lead.id, run.childId, 'continuable',
      { view: 'semantic' }, undefined, cancellation.signal))
      .rejects.toMatchObject({ failure: { code: 'cancelled' } })
  } finally { await run.dispose() }
})

it('refuses a closing content read when this deployment has no Session owner', async () => {
  // Without a mounted Session store the close has no owner to release, so the
  // route refuses it before any child authorization or persistence work.
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  await expect(ctx.subagents.remoteHistory(SessionId('ownerless-parent'), SessionId('ownerless-child'),
    'continuable', { view: 'content', sourceRevision: 'revision', recordId: 'record', contentReadId: 'read', close: true },
    undefined, new AbortController().signal))
    .rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
  await ctx.fiber.dispose()
})

it('does not authorize a same-parent replacement with another mode after the catalog read', async () => {
  const run = await runtime()
  try {
    new SessionRemoteOperationsService(run.ctx)
    const saved = await run.ctx.sessionPersistence.inspect(run.childId)
    const replacement = Session.create(run.childId, undefined, saved.meta)
    replacement.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'fixture' })
    const originalList = run.ctx.subagents.listChildren.bind(run.ctx.subagents)
    vi.spyOn(run.ctx.subagents, 'listChildren').mockImplementationOnce(async (parent, signal) => {
      const authorized = await originalList(parent, signal)
      const originalGet = run.ctx.sessions.get.bind(run.ctx.sessions)
      vi.spyOn(run.ctx.sessions, 'get').mockImplementation(id => id === run.childId ? replacement : originalGet(id))
      return authorized
    })
    await expect(run.ctx.subagents.remoteHistory(run.lead.id, run.childId, 'continuable',
      { view: 'semantic' }, undefined, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'subagent-not-found' } })
  } finally { await run.dispose() }
})
