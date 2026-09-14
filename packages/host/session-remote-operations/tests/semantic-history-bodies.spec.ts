/** Request, index, body and presentation contracts of the semantic history reader. */
import { Context } from '@deepseek-ai/cordis'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type {
  SessionEvent, SessionRemoteHistoryContentRequest, SessionRemoteHistoryContentValue,
  SessionRemoteSemanticHistoryRequest, SessionRemoteSemanticHistoryValue,
} from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionObservationReader } from '../../../session-query/session-query/src/observation.ts'
import { subagentIdentityProjectionDefinition } from '../../../subagent/subagent/src/projection.ts'
import { SemanticHistoryReader } from '../src/semantic-history.ts'
import type { SemanticHistoryLimits } from '../src/semantic-history.ts'

type CreatePresenter = ConstructorParameters<typeof SemanticHistoryReader>[1]
type PresentEntry = ReturnType<CreatePresenter>

/** The wire envelope the Host presenter returns: the exact event echo plus optional tool scope. */
const echo: PresentEntry = async (event, dependencies) => ({
  event: { type: event.type, seq: event.seq, time: event.time, data: z.json().parse(snapshotJsonValue(event.data)) },
  ...event.type === 'tool/result' ? { view: { callSeq: dependencies[0]?.seq ?? -1 } } : {},
})

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
const signal = (): AbortSignal => new AbortController().signal
const newline = String.fromCharCode(10)

/** One refusal carrying its wire code; a missing refusal is itself a failure. */
async function refusal(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run
  } catch (error: unknown) {
    if (typeof error !== 'object' || error === null || !('code' in error) || !('message' in error)) throw error
    const code: unknown = Reflect.get(error, 'code')
    const message: unknown = Reflect.get(error, 'message')
    if (typeof code !== 'string' || typeof message !== 'string') throw error
    return { code, message }
  }
  throw new Error('expected the read to be refused')
}

async function fixture(options: { limits?: SemanticHistoryLimits; present?: PresentEntry } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('semantic-bodies'), { meta: { cwd: '/workspace' } })
  const observations = new SessionObservationReader(ctx)
  ctx.provide('sessionQuery', { observeSession: observations.read.bind(observations) } as never)
  const reader = new SemanticHistoryReader(ctx, () => options.present ?? echo, options.limits ?? {})
  const page = async (extra: Partial<Omit<SessionRemoteSemanticHistoryRequest, 'sessionId' | 'view'>> = {}): Promise<SessionRemoteSemanticHistoryValue> => {
    const result = await reader.read({ sessionId: session.id, view: 'semantic', ...extra }, signal())
    if (result.view !== 'semantic') throw new Error('expected a semantic page')
    return result
  }
  const request = (
    sourceRevision: string, recordId: string,
    extra: Partial<Omit<SessionRemoteHistoryContentRequest, 'sessionId' | 'view' | 'sourceRevision' | 'recordId'>> = {},
  ): SessionRemoteHistoryContentRequest => ({ sessionId: session.id, view: 'content', sourceRevision, recordId, ...extra })
  const fragment = async (input: SessionRemoteHistoryContentRequest): Promise<SessionRemoteHistoryContentValue> => {
    const result = await reader.read(input, signal())
    if (result.view !== 'content') throw new Error('expected a content fragment')
    return result
  }
  const content = async (sourceRevision: string, recordId: string, maximum = 65_536): Promise<string> => {
    let offset = 0
    let joined = ''
    let contentReadId: string | undefined
    for (;;) {
      const part = await fragment(request(sourceRevision, recordId, {
        offset, maxCodeUnits: maximum, ...contentReadId === undefined ? {} : { contentReadId },
      }))
      joined += part.text
      contentReadId = part.contentReadId
      if (part.done) return joined
      offset = part.nextOffset
    }
  }
  return { ctx, session, reader, page, request, fragment, content }
}

function chunks(session: Session, turn: number, step: number, count: number, text = 'x'): number[] {
  const seqs: number[] = []
  for (let index = 0; index < count; index += 1) {
    seqs.push(session.append('assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text } }).seq)
  }
  return seqs
}

const userMessage = (session: Session, text: string): SessionEvent =>
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })

/** A seq-indexed prefix with explicit holes; filter() would silently compact it. */
function prefixWithHoles(events: readonly SessionEvent[], omitted: readonly number[]): SessionEvent[] {
  const result: SessionEvent[] = []
  for (const event of events) if (!omitted.includes(event.seq)) result[event.seq] = event
  return result
}

/** Retain one immutable cut of an explicitly supplied prefix under a fixed revision. */
async function coldSource(
  ctx: Context, session: Session,
  options: { events: () => readonly SessionEvent[]; revision?: string; listSnapshotsDelayMs?: number },
) {
  const revision = options.revision ?? 'fixture:prepared'
  vi.spyOn(ctx.sessions, 'get').mockReturnValue(undefined)
  const owner = ctx.plugin({ apply: (scope: Context) => {
    scope.provide('sessionPersistence', {
      listSnapshots: async () => {
        if (options.listSnapshotsDelayMs !== undefined) {
          await new Promise(resolve => setTimeout(resolve, options.listSnapshotsDelayMs))
        }
        return [{ header: session.header, revision: SessionPersistenceRevision(revision) }]
      },
      borrowSession: async () => ({
        source: 'prepared' as const,
        inspection: { meta: session.header, events: options.events() },
        revision: SessionPersistenceRevision(revision),
        preparedSession: session,
        [Symbol.dispose]: () => {},
      }),
    } as never)
  } })
  await owner
  return owner
}

describe('semantic history request and retention contracts', () => {
  it('refuses non-integer or negative retention limits before retaining anything', () => {
    const ctx = new Context()
    contexts.push(ctx)
    const presenter: CreatePresenter = () => async () => { throw new Error('presenter must not run for rejected limits') }
    for (const limits of [
      { indexEntries: -1 }, { indexBytes: 1.5 }, { contentBytes: Number.NaN },
      { contentReaders: Number.MAX_SAFE_INTEGER + 1 }, { contentIdleMs: -1 },
    ]) {
      expect(() => new SemanticHistoryReader(ctx, presenter, limits))
        .toThrow('semantic history limits must be non-negative safe integers')
    }
    expect(() => new SemanticHistoryReader(ctx, presenter, {
      indexEntries: 0, indexBytes: 0, contentBytes: 0, contentReaders: 0, contentIdleMs: 0,
    })).not.toThrow()
  })

  it('reports an unmounted query owner and rethrows a non-query observation failure', async () => {
    const bare = new Context()
    contexts.push(bare)
    const reader = new SemanticHistoryReader(bare, () => async () => { throw new Error('presenter must not run') })
    expect(await refusal(reader.read({ sessionId: SessionId('absent'), view: 'semantic' }, signal())))
      .toEqual({ code: 'history-unavailable', message: 'session query is not mounted' })

    const { ctx, reader: wired } = await fixture()
    const failure = new Error('observation backend exploded')
    const query = ctx.sessionQuery
    vi.spyOn(query, 'observeSession').mockRejectedValue(failure)
    await expect(wired.read({ sessionId: SessionId('unavailable'), view: 'semantic', sourceRevision: 'live-0:0' }, signal()))
      .rejects.toBe(failure)
  })

  it('refuses a cursor without a cut and a close without a reader handle', async () => {
    const { session, reader } = await fixture()
    expect(await refusal(reader.read({ sessionId: session.id, view: 'semantic', beforeRecordId: 'any' }, signal())))
      .toEqual({ code: 'invalid-argument', message: 'pagination requires sourceRevision' })
    expect(await refusal(reader.read({
      sessionId: session.id, view: 'content', sourceRevision: 'live:0', recordId: 'any', close: true,
    }, signal()))).toEqual({ code: 'invalid-argument', message: 'close requires contentReadId' })
  })

  it('refuses a record id and a cursor that do not belong to the fixed cut', async () => {
    const { session, page, reader, request } = await fixture()
    userMessage(session, 'anchored')
    const first = await page()
    expect(await refusal(reader.read(request(first.sourceRevision, 'missing-record'), signal())))
      .toEqual({ code: 'invalid-argument', message: 'record does not belong to this history cut' })
    expect(await refusal(page({ sourceRevision: first.sourceRevision, beforeRecordId: 'missing-record' })))
      .toEqual({ code: 'invalid-argument', message: 'cursor does not belong to this history cut' })
  })

  it('refuses out-of-range offsets, fragment sizes, page sizes and continuations without a handle', async () => {
    const { session, page, reader, request } = await fixture()
    userMessage(session, 'bounded')
    const first = await page()
    const recordId = first.records[0]!.id
    expect(await refusal(reader.read(request(first.sourceRevision, recordId, { offset: -1 }), signal())))
      .toEqual({ code: 'invalid-argument', message: 'offset must be an integer from 0 through 9007199254740991' })
    expect(await refusal(reader.read(request(first.sourceRevision, recordId, { maxCodeUnits: 1 }), signal())))
      .toEqual({ code: 'invalid-argument', message: 'maxCodeUnits must be an integer from 2 through 65536' })
    expect(await refusal(reader.read(request(first.sourceRevision, recordId, { offset: 4 }), signal())))
      .toEqual({ code: 'invalid-argument', message: 'continuation requires contentReadId' })
    for (const maxRecords of [0, 201]) {
      expect(await refusal(page({ maxRecords }))).toEqual({
        code: 'invalid-argument', message: 'maxRecords must be an integer from 1 through 200',
      })
    }
  })

  it('refuses a cut the retained revision cannot identify', async () => {
    const { session, page } = await fixture()
    userMessage(session, 'revision')
    const first = await page()
    const identity = first.sourceRevision.slice(0, first.sourceRevision.lastIndexOf(':'))
    for (const cut of ['05', '-0', '5.0']) {
      expect(await refusal(page({ sourceRevision: identity + ':' + cut }))).toEqual({
        code: 'history-stale-source', message: 'history cut is no longer available',
      })
    }
  })

  it('holds the byte budget for an unfinished reader instead of evicting it', async () => {
    const { session, page, fragment, request } = await fixture({ limits: { contentBytes: 6_000 } })
    userMessage(session, 'a'.repeat(2_000))
    userMessage(session, 'b'.repeat(2_000))
    const first = await page()
    const retained = await fragment(request(first.sourceRevision, first.records[0]!.id, { maxCodeUnits: 2 }))
    expect(retained.done).toBe(false)
    expect(await refusal(fragment(request(first.sourceRevision, first.records[1]!.id))))
      .toEqual({ code: 'history-content-busy', message: 'content reader budget is in use' })
    const closed = await fragment(request(first.sourceRevision, first.records[0]!.id, {
      contentReadId: retained.contentReadId, close: true,
    }))
    expect(closed.done).toBe(true)
    const admitted = await fragment(request(first.sourceRevision, first.records[1]!.id, { maxCodeUnits: 2 }))
    expect(admitted.done).toBe(false)
  })

  it('refuses a non-contiguous retained prefix instead of fabricating records', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('non-contiguous'), { meta: { cwd: '/workspace' } })
    const observations = new SessionObservationReader(ctx)
    ctx.provide('sessionQuery', { observeSession: observations.read.bind(observations) } as never)
    const reader = new SemanticHistoryReader(ctx, () => async () => { throw new Error('presenter must not run') })
    const first = userMessage(session, 'present')
    const second = userMessage(session, 'tail')
    await coldSource(ctx, session, { events: () => prefixWithHoles([first, second], [first.seq]) })
    expect(await refusal(reader.read({ sessionId: session.id, view: 'semantic' }, signal())))
      .toEqual({ code: 'history-stale-source', message: 'history prefix is not contiguous' })
  })

  it('reports a live reader whose session disappeared and a cold reader without a durability owner', async () => {
    const live = await fixture()
    userMessage(live.session, 'live body')
    const livePage = await live.page()
    const liveReader = await live.fragment(live.request(livePage.sourceRevision, livePage.records[0]!.id, { maxCodeUnits: 2 }))
    expect(liveReader.done).toBe(false)
    vi.spyOn(live.ctx.sessions, 'get').mockReturnValue(undefined)
    expect(await refusal(live.fragment(live.request(livePage.sourceRevision, livePage.records[0]!.id, {
      contentReadId: liveReader.contentReadId, offset: liveReader.nextOffset,
    })))).toEqual({ code: 'history-stale-source', message: 'content source was replaced or changed' })

    const cold = await fixture()
    const prefix = userMessage(cold.session, 'cold body')
    const owner = await coldSource(cold.ctx, cold.session, { events: () => [prefix] })
    const coldPage = await cold.page()
    const coldReader = await cold.fragment(cold.request(coldPage.sourceRevision, coldPage.records[0]!.id, { maxCodeUnits: 2 }))
    expect(coldReader.done).toBe(false)
    await owner.dispose()
    expect(await refusal(cold.fragment(cold.request(coldPage.sourceRevision, coldPage.records[0]!.id, {
      contentReadId: coldReader.contentReadId, offset: coldReader.nextOffset,
    })))).toEqual({ code: 'history-stale-source', message: 'content source was replaced or changed' })
  })

  it('refuses a continuation offset that is not a content boundary', async () => {
    const { session, page, fragment, request, content } = await fixture()
    userMessage(session, String.fromCharCode(0xD83D, 0xDE00) + 'tail')
    const first = await page()
    const recordId = first.records[0]!.id
    const body = await content(first.sourceRevision, recordId)
    const lead = body.indexOf(String.fromCharCode(0xD83D))
    expect(lead).toBeGreaterThan(0)
    const retained = await fragment(request(first.sourceRevision, recordId, { maxCodeUnits: 2 }))
    expect(retained.done).toBe(false)
    for (const offset of [lead + 1, body.length + 1]) {
      expect(await refusal(fragment(request(first.sourceRevision, recordId, {
        contentReadId: retained.contentReadId, offset,
      })))).toEqual({ code: 'invalid-argument', message: 'offset is not a content boundary' })
    }
  })

  it('closes an expired cold reader idempotently while serving its retained bytes', async () => {
    const { ctx, session, page, fragment, request, content } = await fixture({ limits: { contentIdleMs: 5 } })
    const text = userMessage(session, 'e'.repeat(64))
    await coldSource(ctx, session, { events: () => [text], listSnapshotsDelayMs: 40 })
    const first = await page()
    const recordId = first.records[0]!.id
    const body = await content(first.sourceRevision, recordId)
    const retained = await fragment(request(first.sourceRevision, recordId, { maxCodeUnits: 2 }))
    expect(retained.done).toBe(false)
    const rest = await fragment(request(first.sourceRevision, recordId, {
      contentReadId: retained.contentReadId, offset: retained.nextOffset,
    }))
    expect(rest.done).toBe(true)
    expect(retained.text + rest.text).toBe(body)
    expect(await refusal(fragment(request(first.sourceRevision, recordId, {
      contentReadId: retained.contentReadId, offset: rest.nextOffset,
    })))).toEqual({ code: 'history-content-expired', message: 'content reader expired or belongs to another record' })
  })
})

describe('semantic history index, body and presentation contracts', () => {
  it('presents only the latest preset selection visible at the fixed cut', async () => {
    const { session, reader } = await fixture()
    session.append('agent-preset/selected', { agentPreset: 'first' })
    session.append('agent-preset/selected', { agentPreset: 'second' })
    const source = await reader.observe({ sessionId: session.id }, signal())
    try {
      session.append('agent-preset/selected', { agentPreset: 'future' })
      const bearing = reader.presentationSource(source.observed, source.identity, source.through, signal())
      expect(bearing.header).toBe(session.header)
      expect(bearing.events.map(event => event.type)).toEqual(['agent-preset/selected'])
      expect(bearing.events[0]?.data).toEqual({ agentPreset: 'second' })
      expect(reader.presentationSource(source.observed, source.identity, -1, signal()).events).toEqual([])
    } finally { source[Symbol.dispose]() }
  })

  it('refuses a retained index that cannot satisfy the requested cut', async () => {
    const { session, reader } = await fixture()
    userMessage(session, 'indexed')
    const source = await reader.observe({ sessionId: session.id }, signal())
    try {
      const overCut = Promise.resolve().then(() => reader
        .presentationSource(source.observed, source.identity, source.through + 1, signal()))
      expect(await refusal(overCut))
        .toEqual({ code: 'history-stale-source', message: 'history prefix is not contiguous' })
    } finally { source[Symbol.dispose]() }
  })

  it('keeps the first turn boundary and closes only the attempts of the ending turn', async () => {
    const { session, page } = await fixture()
    const opening = session.append('turn/start', { turn: 0 }).seq
    session.append('turn/start', { turn: 0 })
    chunks(session, 0, 0, 2, 'zero')
    const secondTurn = session.append('turn/start', { turn: 1 }).seq
    chunks(session, 1, 0, 2, 'one')
    const firstEnd = session.append('turn/end', { turn: 0, reason: { kind: 'completed' } }).seq
    const mid = await page()
    expect(mid.turns).toEqual([
      { turn: 0, startSeq: opening, endSeq: firstEnd, usage: null },
      { turn: 1, startSeq: secondTurn, usage: null },
    ])
    expect(mid.records.map(record => [record.turn, record.state])).toEqual([[0, 'failed-prefix'], [1, 'active']])
    const secondEnd = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }).seq
    expect((await page()).turns.map(turn => turn.endSeq)).toEqual([firstEnd, secondEnd])
  })

  it('assembles only the chunks that belong to a record own turn and step', async () => {
    const { session, page, content } = await fixture()
    session.append('turn/start', { turn: 0 })
    chunks(session, 0, 0, 1, 'a')
    session.append('turn/start', { turn: 1 })
    chunks(session, 1, 0, 1, 'b')
    chunks(session, 0, 0, 1, 'c')
    const result = await page()
    expect(result.records.map(record => record.turn)).toEqual([0, 1])
    expect(result.records[0]?.preview).toBe('ac')
    expect(result.records[1]?.preview).toBe('b')
    const body: unknown = JSON.parse(await content(result.sourceRevision, result.records[0]!.id))
    expect(body).toEqual({ kind: 'assistant-prefix', turn: 0, step: 0, content: [{ type: 'text', text: 'ac' }] })
  })

  it('previews closed text and reasoning blocks started by explicit block markers', async () => {
    const { session, page } = await fixture()
    session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'body' } })
    session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'body' } } })
    session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'block-start', index: 1, blockType: 'reasoning' } })
    session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 1, text: 'why' } })
    session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'why' } } })
    const result = await page()
    expect(result.records[0]?.preview).toBe('body' + newline + 'why')
  })

  it('skips non-text blocks and never previews a truncated surrogate half', async () => {
    const { session, page } = await fixture()
    session.append('assistant/message', {
      turn: 0, step: 0,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: CallId('preview-call'), name: 'fixture', arguments: '{}' }, { type: 'text', text: 'visible' }],
        source: { provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    userMessage(session, String.fromCharCode(0xD83D))
    const result = await page()
    expect(result.records.map(record => record.preview)).toEqual(['visible', ''])
  })

  it('separates a canonical message that carries no usable streamed source linkage', async () => {
    const { session, page, content } = await fixture()
    const unrelated = userMessage(session, 'link target')
    session.append('assistant/message', {
      turn: 0, step: 0,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'unlinked answer' }], source: { provider: 'fixture', model: 'fixture' } }),
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 0, step: 2,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'mismatched source' }], source: { provider: 'fixture', model: 'fixture' } }),
    }, { surfaceOp: 'append', sourceEventSeqs: [unrelated.seq] })
    const result = await page()
    const assistants = result.records.filter(record => record.kind === 'assistant')
    expect(assistants.map(record => [record.step, record.state])).toEqual([[0, 'complete'], [2, 'complete']])
    expect(new Set(result.records.map(record => record.id)).size).toBe(3)
    const body: unknown = JSON.parse(await content(result.sourceRevision, assistants[1]!.id))
    expect(body).toMatchObject({
      kind: 'assistant',
      entry: { event: { type: 'assistant/message' } },
    })
  })

  it('ignores a retry signal that has no attempt in flight', async () => {
    const { session, page } = await fixture()
    chunks(session, 0, 0, 2, 's')
    session.append('llm/retry-started', { retryId: RetryId('late-retry'), turn: 7, step: 7, retry: 1 })
    const result = await page()
    expect(result.records.map(record => [record.turn, record.step, record.state])).toEqual([[0, 0, 'active']])
    expect(result.records[0]?.preview).toBe('ss')
  })

  it('reports an in-flight prefix orphaned by the seed boundary instead of active', async () => {
    const { session, page } = await fixture()
    session.append('turn/start', { turn: 0 })
    chunks(session, 0, 0, 1, 'partial')
    session.append('session/end-seed', {})
    const result = await page()
    expect(result.records.map(record => record.state)).toEqual(['orphaned-prefix'])
    expect(result.records[0]?.preview).toBe('partial')
  })

  it('reports unpaired tool calls and results and presents each without inventing a peer', async () => {
    const { session, page, content } = await fixture()
    const call = session.append('tool/call', { turn: 0, step: 0, callId: CallId('orphan-call'), name: 'orphan-tool', arguments: '{}' })
    const result = session.append('tool/result', {
      turn: 0, step: 0,
      message: createToolResultMessage({ callId: CallId('orphan-result'), content: [{ type: 'text', text: 'orphan' }], isError: false }),
    }, { surfaceOp: 'append' })
    const first = await page()
    const records = first.records.filter(record => record.kind === 'tool')
    expect(records.map(record => [record.state, record.callEventSeq, record.resultEventSeq]))
      .toEqual([['unpaired', call.seq, undefined], ['unpaired', undefined, result.seq]])
    expect(records.map(record => record.preview)).toEqual(['orphan-tool', 'tool result'])
    const callBody: unknown = JSON.parse(await content(first.sourceRevision, records[0]!.id))
    expect(callBody).toMatchObject({
      kind: 'tool',
      call: { event: { seq: call.seq } },
    })
    const resultBody: unknown = JSON.parse(await content(first.sourceRevision, records[1]!.id))
    expect(resultBody).toMatchObject({
      kind: 'tool',
      result: { view: { callSeq: -1 } },
    })
  })

  it('degrades a record whose cut is not backed by the retained prefix', async () => {
    const { ctx, session, page, content } = await fixture()
    const opening = session.append('turn/start', { turn: 0 })
    const anchored = userMessage(session, 'anchored')
    const streamed = session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'streamed' } })
    const final = session.append('assistant/message', {
      turn: 0, step: 0,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'streamed' }], source: { provider: 'fixture', model: 'fixture' } }),
    }, { surfaceOp: 'append', sourceEventSeqs: [streamed.seq] })
    const end = session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    const events: SessionEvent[] = [opening, anchored, streamed, final, end]
    let prefix: readonly SessionEvent[] = events
    await coldSource(ctx, session, { events: () => prefix, revision: 'fixture:revision' })
    const first = await page()
    const revision = first.sourceRevision
    expect(first.records.map(record => [record.kind, record.preview]))
      .toEqual([['user', 'anchored'], ['assistant', 'streamed']])
    prefix = prefixWithHoles(events, [anchored.seq, streamed.seq, final.seq])
    const degraded = await page({ sourceRevision: revision })
    expect(degraded.records.map(record => [record.kind, record.time, record.preview, record.state]))
      .toEqual([['user', 0, '', 'complete'], ['assistant', 0, '', 'failed-prefix']])
    expect(JSON.parse(await content(revision, degraded.records[0]!.id)))
      .toEqual({ kind: 'assistant-prefix', turn: 0, content: [] })
    expect(JSON.parse(await content(revision, degraded.records[1]!.id)))
      .toEqual({ kind: 'assistant-prefix', turn: 0, step: 0, content: [] })
  })

  it('keeps exact turn boundaries when the retained prefix is missing below the index', async () => {
    const { ctx, session, page } = await fixture()
    const opening = session.append('turn/start', { turn: 0 })
    const before = userMessage(session, 'before hole')
    const after = userMessage(session, 'after hole')
    const end = session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    let prefix: readonly SessionEvent[] = [opening, before]
    await coldSource(ctx, session, { events: () => prefix, revision: 'fixture:timing' })
    const first = await page()
    expect(first.turns).toEqual([{ turn: 0, startSeq: opening.seq, usage: null }])
    const identity = first.sourceRevision.slice(0, first.sourceRevision.lastIndexOf(':'))
    prefix = prefixWithHoles([opening, before, after, end], [before.seq])
    const extended = await page({ sourceRevision: identity + ':' + String(end.seq) })
    expect(extended.turns).toEqual([{ turn: 0, startSeq: opening.seq, endSeq: end.seq, usage: null }])
    expect(extended.records.map(record => record.orderSeq)).toEqual([before.seq, after.seq])
  })

  it('revokes a live body when the session identity changes during presentation', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('identity-swap'), { meta: { cwd: '/workspace' } })
    const observations = new SessionObservationReader(ctx)
    ctx.provide('sessionQuery', { observeSession: observations.read.bind(observations) } as never)
    userMessage(session, 'body'.repeat(64))
    const replacement = Session.create(session.id, session.events, session.header)
    let served: Session = session
    let swap = false
    const reader = new SemanticHistoryReader(ctx, () => async (event, dependencies) => {
      if (swap) served = replacement
      return await echo(event, dependencies)
    })
    const page = await reader.read({ sessionId: session.id, view: 'semantic' }, signal())
    if (page.view !== 'semantic') throw new Error('expected a semantic page')
    vi.spyOn(ctx.sessions, 'get').mockImplementation(() => served)
    swap = true
    expect(await refusal(reader.read({
      sessionId: session.id, view: 'content', sourceRevision: page.sourceRevision,
      recordId: page.records[0]!.id, maxCodeUnits: 2,
    }, signal()))).toEqual({ code: 'history-stale-source', message: 'live source changed during observation' })
  })

  it('revokes a child body when its descriptor changes or cannot be read during presentation', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(subagentIdentityProjectionDefinition)
    const parent = SessionId('bodies-parent')
    const session = ctx.sessions.create(SessionId('bodies-child'), {
      meta: { cwd: '/workspace', origin: 'subagent', parentSession: parent },
    })
    const observations = new SessionObservationReader(ctx)
    ctx.provide('sessionQuery', { observeSession: observations.read.bind(observations) } as never)
    session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'fixture', label: 'child' })
    userMessage(session, 'child body')
    let mutate = false
    const reader = new SemanticHistoryReader(ctx, () => async (event, dependencies) => {
      if (mutate && event.type === 'user/message') {
        mutate = false
        session.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'fixture' })
      }
      return await echo(event, dependencies)
    })
    const address = { sessionId: session.id, expectedParentSessionId: parent, expectedSubagentMode: 'continuable' as const }
    const first = await reader.read({ ...address, view: 'semantic' }, signal())
    if (first.view !== 'semantic') throw new Error('expected a child page')
    const registry = ctx.sessionProjections
    const snapshot = registry.snapshot.bind(registry)
    let reads = 0
    const spy = vi.spyOn(registry, 'snapshot').mockImplementation((...args: Parameters<typeof snapshot>) => {
      reads += 1
      if (reads > 1) throw new Error('projection cache unavailable')
      return snapshot(...args)
    })
    expect(await refusal(reader.read({ ...address, view: 'semantic' }, signal())))
      .toEqual({ code: 'history-stale-source', message: 'child descriptor changed while reading history' })
    spy.mockRestore()
    mutate = true
    expect(await refusal(reader.read({
      ...address, view: 'content', sourceRevision: first.sourceRevision,
      recordId: first.records[0]!.id, maxCodeUnits: 2,
    }, signal()))).toEqual({ code: 'history-stale-source', message: 'child descriptor changed while reading history' })
  })
})

