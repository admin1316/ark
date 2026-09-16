import { Context } from '@deepseek-ai/cordis'
import { CallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRemoteRawHistoryRequest, SessionRemoteRawHistoryValue } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionObservationReader } from '../../../session-query/session-query/src/observation.ts'
import { subagentIdentityProjectionDefinition } from '../../../subagent/subagent/src/projection.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionRemoteOperationsService } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
const signal = () => new AbortController().signal
async function fixture(child = false) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  const parent = SessionId('parent')
  const session = ctx.sessions.create(SessionId('bound-history'), { meta: { cwd: '/synthetic',
    ...child ? { origin: 'subagent' as const, parentSession: parent } : {} } })
  const observations = new SessionObservationReader(ctx)
  ctx.provide('sessionQuery', { observeSession: observations.read.bind(observations) } as never)
  ctx.provide('agents', { get: () => undefined } as never)
  const service = new SessionRemoteOperationsService(ctx, { semanticHistory: { indexEntries: 0, indexBytes: 0 } })
  const read = async (extra: Omit<SessionRemoteRawHistoryRequest, 'sessionId'> = {}): Promise<SessionRemoteRawHistoryValue> => {
    const result = await service.history({ sessionId: session.id, view: 'raw', ...extra }, signal())
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    return result.value
  }
  const append = (text: string) => session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return { ctx, session, service, read, append, parent }
}

it('binds raw and semantic pages to the same fixed cut across appends and cache eviction', async () => {
  const { session, service, read, append } = await fixture()
  for (let i = 0; i < 7; i++) append(String(i))
  const semantic = await service.history({ sessionId: session.id, view: 'semantic' }, signal())
  if (!semantic.ok || semantic.value.view !== 'semantic') throw new Error('missing semantic cut')
  const revision = semantic.value.sourceRevision
  const first = await read({ sourceRevision: revision, maxMessages: 2 })
  expect(first).toMatchObject({ view: 'raw', sourceRevision: revision, asOfThroughSeq: 6 })
  expect(first.projections).toBeUndefined()
  append('future')
  const seqs = first.events.map(entry => entry.event.seq)
  let page = first
  while (page.hasMore) {
    const beforeSeq = page.events[0]?.event.seq
    if (beforeSeq === undefined) throw new Error('empty page cannot advance')
    page = await read({ sourceRevision: revision, beforeSeq, maxMessages: 2 })
    expect(page.sourceRevision).toBe(revision)
    expect(page.asOfThroughSeq).toBe(6)
    seqs.unshift(...page.events.map(entry => entry.event.seq))
  }
  expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6])
  expect((await read({ sourceRevision: revision, beforeSeq: 100 })).events.at(-1)?.event.seq).toBe(6)
  expect((await read()).asOfThroughSeq).toBe(7)
})

it('uses the actual immutable observation when presentation appends to the live source', async () => {
  const { ctx, session, read } = await fixture()
  session.append('tool/call', { turn: 0, step: 0, callId: CallId('scope-call'), name: 'fixture', arguments: '{}' })
  ctx.provide('agentPresets', { standingKeyFor: vi.fn(async () => { session.append('tool/call', { turn: 0, step: 0, callId: CallId('future'), name: 'fixture', arguments: '{}' }); return undefined }) } as never)
  const page = await read()
  expect(page.asOfThroughSeq).toBe(0)
  expect(page.events.map(entry => entry.event.seq)).toEqual([0])
})

it('rejects same-length replacement, truncation and disappearance instead of merging pages', async () => {
  const { ctx, session, service, read, append } = await fixture()
  append('one'); append('two')
  const first = await read()
  const request = { sessionId: session.id, view: 'raw' as const, sourceRevision: first.sourceRevision! }
  const get = vi.spyOn(ctx.sessions, 'get')
  get.mockReturnValue(Session.create(session.id, session.events, session.header))
  expect(await service.history(request, signal())).toMatchObject({ ok: false, error: { code: 'history-stale-source' } })
  get.mockReturnValue(Session.create(session.id, session.events.slice(0, 1), session.header))
  expect(await service.history(request, signal())).toMatchObject({ ok: false, error: { code: 'history-stale-source' } })
  get.mockReturnValue(undefined)
  expect(await service.history(request, signal())).toMatchObject({ ok: false, error: { code: 'history-stale-source' } })
})

it('rejects a replacement published during asynchronous scope resolution', async () => {
  const { ctx, session, service, append } = await fixture()
  append('original')
  session.append('tool/call', { turn: 0, step: 0, callId: CallId('replace-call'), name: 'fixture', arguments: '{}' })
  const replacement = Session.create(session.id, session.events, session.header)
  ctx.provide('agentPresets', { standingKeyFor: async () => { vi.spyOn(ctx.sessions, 'get').mockReturnValue(replacement); return undefined } } as never)
  expect(await service.history({ sessionId: session.id, view: 'raw' }, signal())).toMatchObject({ ok: false, error: { code: 'history-stale-source' } })
})

it('retains the cold source lease during presentation and rejects later durable revision changes', async () => {
  const { ctx, session, service, read, append } = await fixture()
  append('cold')
  session.append('tool/call', { turn: 0, step: 0, callId: CallId('cold-call'), name: 'fixture', arguments: '{}' })
  vi.spyOn(ctx.sessions, 'get').mockReturnValue(undefined)
  let revision = 'cold:1'
  let pins = 0
  ctx.provide('sessionPersistence', { borrowSession: async () => {
    pins++
    return { source: 'prepared', inspection: { meta: session.header, events: session.events },
      revision: SessionPersistenceRevision(revision), preparedSession: session, [Symbol.dispose]: () => { pins-- } }
  } } as never)
  ctx.provide('agentPresets', { standingKeyFor: async () => { expect(pins).toBe(1); await Promise.resolve(); expect(pins).toBe(1); return undefined } } as never)
  const first = await read()
  expect(pins).toBe(0)
  revision = 'cold:2'
  expect(await service.history({ sessionId: session.id, view: 'raw', sourceRevision: first.sourceRevision! }, signal()))
    .toMatchObject({ ok: false, error: { code: 'history-stale-source' } })
  expect(pins).toBe(0)
})

it('fails closed for child origin, mode, descriptor ownership and continuation identity', async () => {
  const { ctx, session, service, parent } = await fixture(true)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(subagentIdentityProjectionDefinition)
  session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'fixture', label: 'child' })
  session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'full child content' } })
  for (const view of [undefined, 'raw', 'semantic'] as const) {
    const request = { sessionId: session.id, ...view === undefined ? {} : { view } }
    expect(await service.history(request, signal())).toMatchObject({ ok: false, error: { code: 'subagent-unauthorized' } })
  }
  const address = { sessionId: session.id, expectedParentSessionId: parent, expectedSubagentMode: 'continuable' as const }
  expect(await service.history({ ...address, expectedSubagentMode: 'one-shot', view: 'semantic' }, signal()))
    .toMatchObject({ ok: false, error: { code: 'subagent-not-found' } })
  const result = await service.history({ ...address, view: 'semantic' }, signal())
  if (!result.ok || result.value.view !== 'semantic') throw new Error('child semantic denied')
  const request = { ...address, view: 'content' as const, sourceRevision: result.value.sourceRevision,
    recordId: result.value.records[0]!.id, maxCodeUnits: 2 }
  const first = await service.history(request, signal())
  if (!first.ok || first.value.view !== 'content') throw new Error('child body denied')
  const { expectedSubagentMode: _mode, ...withoutMode } = request
  expect(await service.history({ ...withoutMode, contentReadId: first.value.contentReadId }, signal()))
    .toMatchObject({ ok: false, error: { code: 'subagent-unauthorized' } })
  expect(await service.history({ ...request, contentReadId: first.value.contentReadId, close: true }, signal()))
    .toMatchObject({ ok: true, value: { done: true, text: '' } })
})


it('revokes an unfinished child reader when its descriptor changes after admission', async () => {
  const { ctx, session, service, parent } = await fixture(true)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(subagentIdentityProjectionDefinition)
  session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'fixture', label: 'child' })
  session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'child prefix' } })
  const address = { sessionId: session.id, expectedParentSessionId: parent, expectedSubagentMode: 'continuable' as const }
  const page = await service.history({ ...address, view: 'semantic' }, signal())
  if (!page.ok || page.value.view !== 'semantic') throw new Error('expected child page')
  const request = { ...address, view: 'content' as const, sourceRevision: page.value.sourceRevision,
    recordId: page.value.records[0]!.id, maxCodeUnits: 2 }
  const first = await service.history(request, signal())
  if (!first.ok || first.value.view !== 'content') throw new Error('expected child content')
  session.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'fixture' })
  const continuation = { ...request, contentReadId: first.value.contentReadId, offset: first.value.nextOffset }
  expect(await service.history(continuation, signal())).toMatchObject({ ok: false, error: { code: 'history-stale-source' } })
  expect(await service.history(continuation, signal())).toMatchObject({ ok: false, error: { code: 'history-content-expired' } })
  expect(await service.history({ ...address, view: 'raw', sourceRevision: page.value.sourceRevision }, signal()))
    .toMatchObject({ ok: false, error: { code: 'subagent-catalog-diagnostic' } })
})

it('cancels a non-tool raw page if Host lifetime ends as its observation resolves', async () => {
  const { ctx, session, service, append } = await fixture()
  append('pending read')
  const query = ctx.sessionQuery
  const observe = query.observeSession.bind(query)
  vi.spyOn(query, 'observeSession').mockImplementationOnce(async (...args) => {
    const observed = await observe(...args)
    await ctx.fiber.dispose()
    return observed
  })
  expect(await service.history({ sessionId: session.id, view: 'raw' }, signal()))
    .toMatchObject({ ok: false, error: { code: 'cancelled' } })
})


it('keeps a one-event source check bounded across empty, new, active and completed cuts', async () => {
  const { session, service, read, append } = await fixture()
  const empty = await read({ maxEvents: 1 })
  expect(empty).toMatchObject({ asOfThroughSeq: -1, events: [], hasMore: false })
  session.append('turn/start', { turn: 1 })
  append('synthetic greeting')
  const first = await read({ maxEvents: 1 })
  expect(first.events.map(entry => entry.event.seq)).toEqual([1])
  expect(first.hasMore).toBe(true)
  session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' })
  session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'synthetic answer' } })
  const active = await read({ maxMessages: 1, maxEvents: 1 })
  expect(active.events.map(entry => entry.event.seq)).toEqual([3])
  expect(active.asOfThroughSeq).toBe(3)
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'synthetic answer' }], source: { provider: 'fixture', model: 'fixture' } }),
  }, { surfaceOp: 'append', sourceEventSeqs: [2, 3] })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const completed = await read({ maxMessages: 1, maxEvents: 1 })
  expect(completed.events.map(entry => entry.event.seq)).toEqual([5])
  expect(completed.asOfThroughSeq).toBe(5)
  if (empty.sourceRevision === undefined || active.sourceRevision === undefined || completed.sourceRevision === undefined) {
    throw new Error('bound raw pages must carry their source revision')
  }
  expect((await read({ sourceRevision: empty.sourceRevision, maxEvents: 1 })).events).toEqual([])
  expect((await read({ sourceRevision: active.sourceRevision, maxEvents: 1 })).events.map(entry => entry.event.seq)).toEqual([3])
  expect((await read({ sourceRevision: completed.sourceRevision, beforeSeq: 0, maxEvents: 1 })).events).toEqual([])
  const clamped = await read({ sourceRevision: completed.sourceRevision, beforeSeq: 100, maxEvents: 1 })
  expect(clamped.events.map(entry => entry.event.seq)).toEqual([5])

  let page = completed
  const sequences = page.events.map(entry => entry.event.seq)
  while (page.hasMore) {
    const beforeSeq = page.events[0]?.event.seq
    if (beforeSeq === undefined) throw new Error('a nonterminal page must advance')
    page = await read({ sourceRevision: completed.sourceRevision, beforeSeq, maxEvents: 1 })
    expect(page.events).toHaveLength(1)
    sequences.unshift(...page.events.map(entry => entry.event.seq))
  }
  expect(sequences).toEqual([0, 1, 2, 3, 4, 5])
  // The message boundary remains independent and retains canonical source groups.
  const messages = await read({ maxMessages: 1 })
  expect(messages.events.map(entry => entry.event.seq)).toEqual([2, 3, 4, 5])
  expect((await read({ maxMessages: 1, maxEvents: 2 })).events.map(entry => entry.event.seq)).toEqual([4, 5])
  for (const maxEvents of [0, -1, 0.5, 2_049, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(await service.history({ sessionId: session.id, view: 'raw', maxEvents }, signal()))
      .toMatchObject({ ok: false, error: { code: 'invalid-argument' } })
  }
})


it('keeps the legacy message limit and global event cap when maxEvents is omitted', async () => {
  const { session, read } = await fixture()
  for (let turn = 0; turn < 2_050; turn++) session.append('turn/start', { turn })
  for (const maxEvents of [undefined, 2_048]) {
    const page = await read({ ...maxEvents === undefined ? {} : { maxEvents }, maxMessages: 1 })
    expect(page.events).toHaveLength(2_048)
    expect(page.events[0]?.event.seq).toBe(2)
    expect(page.events.at(-1)?.event.seq).toBe(2_049)
    expect(page.hasMore).toBe(true)
  }
})
