import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createAssistantMessage, createUserMessage, createToolResultMessage, CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { SessionEvent, SessionRemoteSemanticHistoryValue } from '@deepseek-ai/dsh-session'
import { SessionObservationReader } from '../../../session-query/session-query/src/observation.ts'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow/types'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SemanticHistoryReader } from '../src/semantic-history.ts'
import { SessionRemoteOperationsService } from '../src/index.ts'
import type { SemanticHistoryLimits } from '../src/semantic-history.ts'

/** One presented history entry; the content endpoint serializes the presenter's exact event echo. */
const presentedEntrySchema = z.object({
  event: z.object({ seq: z.number(), type: z.string(), time: z.number(), data: z.json() }),
})
/** Preserved content blocks of one complete user or assistant message. */
const contentBlockSchema = z.object({ type: z.string(), text: z.string() })
/** Complete user-message body. */
const userMessageBodySchema = z.object({
  kind: z.literal('user'),
  entry: z.object({ event: z.object({ data: z.object({ content: z.array(contentBlockSchema) }) }) }),
})
/** Complete assistant-message body. */
const assistantMessageBodySchema = z.object({
  kind: z.literal('assistant'),
  entry: z.object({ event: z.object({ data: z.object({
    message: z.object({ content: z.array(contentBlockSchema) }),
  }) }) }),
})
/** Recovered streamed blocks of a record with no canonical final message. */
const assistantPrefixBodySchema = z.object({
  kind: z.literal('assistant-prefix'),
  content: z.array(contentBlockSchema),
})
/** Domain evidence bundle assembled at one source cut. */
const dependencyBundleSchema = z.object({
  domain: z.enum(['tool', 'status', 'turn']),
  completeness: z.enum(['complete', 'unknown']),
  chunkCoverage: z.enum(['none', 'timing-boundaries']),
  missing: z.array(z.string()),
  entries: z.array(presentedEntrySchema),
  turns: z.array(z.json()),
})
/** Presented call/result pair of one tool record. */
const toolBodySchema = z.object({
  kind: z.literal('tool'),
  result: z.object({ view: z.object({ callSeq: z.number() }) }),
})

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
const signal = (): AbortSignal => new AbortController().signal

async function fixture(limits: SemanticHistoryLimits = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('semantic-fixture'), { meta: { cwd: '/workspace' } })
  const observations = new SessionObservationReader(ctx)
  ctx.provide('sessionQuery', { observeSession: observations.read.bind(observations) } as never)
  const present = vi.fn(async (event: SessionEvent, dependencies: readonly SessionEvent[]) => {
    const data = z.json().parse(snapshotJsonValue(event.data))
    return {
      event: { type: event.type, seq: event.seq, time: event.time, data },
      ...(event.type === 'tool/result' ? { view: { callSeq: dependencies[0]?.seq ?? -1 } } : {}),
    }
  })
  const reader = new SemanticHistoryReader(ctx, () => present, limits)
  const page = async (extra = {}): Promise<SessionRemoteSemanticHistoryValue> => {
    const result = await reader.read({ sessionId: session.id, view: 'semantic', ...extra }, signal())
    if (result.view !== 'semantic') throw new Error('expected semantic page')
    return result
  }
  const content = async (sourceRevision: string, recordId: string, maximum = 65_536): Promise<string> => {
    let offset = 0
    let joined = ''
    let contentReadId: string | undefined
    for (;;) {
      const part = await reader.read({ sessionId: session.id, view: 'content', sourceRevision, recordId, offset, maxCodeUnits: maximum, ...contentReadId === undefined ? {} : { contentReadId } }, signal())
      if (part.view !== 'content') throw new Error('expected content')
      expect(part.text.length).toBeLessThanOrEqual(maximum)
      joined += part.text
      contentReadId = part.contentReadId
      if (part.done) return joined
      expect(part.nextOffset).toBeGreaterThan(offset)
      offset = part.nextOffset
    }
  }
  return { ctx, session, reader, page, content, present }
}

function chunks(session: Session, count: number, text = 'x'): number[] {
  const seqs: number[] = []
  for (let i = 0; i < count; i += 1) seqs.push(session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text } }).seq)
  return seqs
}
function finalize(session: Session, sourceEventSeqs: number[], text: string, interrupted = false) {
  return session.append('assistant/message', {
    turn: 0, step: 0,
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'fixture', model: 'fixture' } }),
    ...interrupted ? { interrupted: true as const } : {},
  }, { surfaceOp: 'append', sourceEventSeqs })
}

describe('semantic history complete-content reads', () => {
  it('dispatches semantic and content views through the existing Host port while raw stays raw', async () => {
    const { ctx, session } = await fixture()
    ctx.provide('agents', { get: () => undefined } as never)
    const service = new SessionRemoteOperationsService(ctx)
    const source = chunks(session, 2, 'wire')
    finalize(session, source, 'wirewire')
    const page = await service.history({ sessionId: session.id, view: 'semantic' }, signal())
    if (!page.ok || page.value.view !== 'semantic') throw new Error('expected semantic result')
    const content = await service.history({ sessionId: session.id, view: 'content', sourceRevision: page.value.sourceRevision, recordId: page.value.records[0]!.id }, signal())
    if (!content.ok || content.value.view !== 'content') throw new Error('expected content result')
    const body = assistantMessageBodySchema.parse(JSON.parse(content.value.text))
    expect(body.entry.event.data.message.content[0]!.text).toBe('wirewire')
    const raw = await service.history({ sessionId: session.id }, signal())
    expect(raw.ok && raw.value.events.length).toBe(3)
    const denied = await service.history({ sessionId: session.id, expectedParentSessionId: SessionId('wrong'), view: 'semantic' }, signal())
    expect(denied).toMatchObject({ ok: false, error: { code: 'subagent-unauthorized' } })
  })

  it('resolves one historical tool scope per body and never presents an old cut with a future preset', async () => {
    const { ctx, session } = await fixture()
    ctx.provide('agents', { get: () => undefined } as never)
    const standingKeyFor = vi.fn(async (preset: string | undefined) => ({ kind: 'standing', preset }))
    ctx.provide('agentPresets', { standingKeyFor } as never)
    const toolGet = vi.fn((_name: string, scope: unknown) => ({
      presentCall: () => ({ scope }), presentResult: () => ({ scope }),
    }))
    ctx.provide('tools', { get: toolGet } as never)
    const service = new SessionRemoteOperationsService(ctx)
    session.append('agent-preset/selected', { agentPreset: 'old-preset' })
    session.append('turn/start', { turn: 0 })
    chunks(session, 50_001)
    for (let index = 0; index < 20; index += 1) {
      const callId = CallId(`scope-${String(index)}`)
      session.append('tool/call', { turn: 0, step: 0, callId, name: 'fixture', arguments: '{}' })
      session.append('tool/result', { turn: 0, step: 0, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'done' }], isError: false }) }, { surfaceOp: 'append' })
    }
    const page = await service.history({ sessionId: session.id, view: 'semantic' }, signal())
    if (!page.ok || page.value.view !== 'semantic') throw new Error('expected semantic page')
    let indexedReads = 0
    const snapshot = session.events
    const monitored = new Proxy(snapshot, { get(target, key, receiver): unknown {
      if (typeof key === 'string' && /^\d+$/.test(key)) indexedReads += 1
      // Reflect.get is typed `any`; one declared `unknown` boundary keeps the exact
      // runtime value without leaking an untyped read into the caller.
      const value: unknown = Reflect.get(target, key, receiver)
      return value
    } })
    const spy = vi.spyOn(session, 'events', 'get').mockReturnValue(monitored)
    const request = { sessionId: session.id, view: 'content' as const, sourceRevision: page.value.sourceRevision,
      recordId: page.value.dependencyRecords.tool, maxCodeUnits: 65_536 }
    const body = await service.history(request, signal())
    if (!body.ok || body.value.view !== 'content') throw new Error('expected content')
    expect(body.value.done).toBe(true)
    expect(standingKeyFor).toHaveBeenCalledExactlyOnceWith('old-preset')
    expect(toolGet).toHaveBeenCalledTimes(40)
    expect(indexedReads).toBeLessThan(200)
    spy.mockRestore()
    session.append('agent-preset/selected', { agentPreset: 'future-preset' })
    standingKeyFor.mockClear()
    toolGet.mockClear()
    const old = await service.history(request, signal())
    if (!old.ok || old.value.view !== 'content') throw new Error('expected old content')
    expect(standingKeyFor).toHaveBeenCalledExactlyOnceWith('old-preset')
    expect(old.value.text).toBe(body.value.text)
    standingKeyFor.mockClear()
    const status = await service.history({ ...request, recordId: page.value.dependencyRecords.status }, signal())
    expect(status.ok).toBe(true)
    expect(standingKeyFor).not.toHaveBeenCalled()
  })

  it('reads a >50,000 chunk answer as one complete record and exact bounded fragments', async () => {
    const { session, page, content } = await fixture()
    const source = chunks(session, 50_001, '😀')
    finalize(session, source, '😀'.repeat(50_001))
    const result = await page()
    expect(result.records).toHaveLength(1)
    const record = result.records[0]!
    expect(record.state).toBe('complete')
    expect(record.preview.length).toBeLessThanOrEqual(256)
    const body = assistantMessageBodySchema.parse(JSON.parse(await content(result.sourceRevision, record.id, 4097)))
    expect(body.entry.event.data.message.content[0]!.text).toBe('😀'.repeat(50_001))
    expect(result.pendingDomains).toEqual([])
  })

  it('preserves the active fixed cut and stable identity after a later interrupted final', async () => {
    const { session, page, content } = await fixture()
    const source = chunks(session, 50_001)
    const active = await page()
    const record = active.records[0]!
    expect(record.state).toBe('active')
    source.push(...chunks(session, 5))
    finalize(session, source, 'x'.repeat(50_006), true)
    const latest = await page()
    expect(latest.records[0]?.id).toBe(record.id)
    expect(latest.records[0]?.state).toBe('interrupted')
    const older = await page({ sourceRevision: active.sourceRevision })
    expect(older.records[0]?.state).toBe('active')
    const body = assistantPrefixBodySchema.parse(JSON.parse(await content(active.sourceRevision, record.id)))
    expect(body.kind).toBe('assistant-prefix')
    expect(body.content[0]!.text).toBe('x'.repeat(50_001))
  })

  it('separates failed and retried prefixes in the same step using canonical source linkage', async () => {
    const { session, page, content } = await fixture()
    chunks(session, 3, 'failed')
    session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'fixture' } } } })
    session.append('llm/retry-started', { retryId: RetryId('fixture-retry'), turn: 0, step: 0, retry: 1 })
    const source = chunks(session, 2, 'success')
    finalize(session, source, 'successsuccess')
    const result = await page()
    expect(result.records.map(record => record.state)).toEqual(['failed-prefix', 'complete'])
    expect(new Set(result.records.map(record => record.id)).size).toBe(2)
    const first = assistantPrefixBodySchema.parse(JSON.parse(await content(result.sourceRevision, result.records[0]!.id)))
    expect(first.content[0]!.text).toBe('failedfailedfailed')
    const second = assistantMessageBodySchema.parse(JSON.parse(await content(result.sourceRevision, result.records[1]!.id)))
    expect(second.entry.event.data.message.content[0]!.text).toBe('successsuccess')
  })

  it('continues the same cursor and full content with all caching disabled', async () => {
    const { session, page, content } = await fixture({ indexBytes: 0, contentBytes: 0, indexEntries: 0 })
    for (let i = 0; i < 5; i += 1) session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `用户😀-${String(i)}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const first = await page({ maxRecords: 2 })
    const second = await page({ sourceRevision: first.sourceRevision, beforeRecordId: first.nextBeforeRecordId, maxRecords: 2 })
    const third = await page({ sourceRevision: first.sourceRevision, beforeRecordId: second.nextBeforeRecordId, maxRecords: 2 })
    expect([...third.records, ...second.records, ...first.records].map(record => record.orderSeq)).toEqual([0, 1, 2, 3, 4])
    expect(third.hasMore).toBe(false)
    const tail = userMessageBodySchema.parse(JSON.parse(await content(first.sourceRevision, first.records[0]!.id, 3)))
    expect(tail.entry.event.data.content[0]!.text).toBe('用户😀-3')
  })

  it('rejects replacement with identical id and length and repeats parent admission for content', async () => {
    const { ctx, session, page, reader } = await fixture()
    chunks(session, 1)
    const result = await page()
    await expect(reader.read({ sessionId: session.id, expectedParentSessionId: SessionId('other'), view: 'content', sourceRevision: result.sourceRevision, recordId: result.records[0]!.id }, signal())).rejects.toMatchObject({ code: 'subagent-unauthorized' })
    const replacement = Session.create(session.id, session.events, session.header)
    vi.spyOn(ctx.sessions, 'get').mockReturnValue(replacement)
    await expect(page({ sourceRevision: result.sourceRevision })).rejects.toMatchObject({ code: 'history-stale-source' })
  })

  it('restores a cold orphaned prefix and releases every prepared lease, rejecting changed revision', async () => {
    const { ctx, session, page, content } = await fixture()
    chunks(session, 50_001, 'cold')
    vi.spyOn(ctx.sessions, 'get').mockReturnValue(undefined)
    let revision = 'fixture:one'
    const dispose = vi.fn()
    ctx.provide('sessionPersistence', { listSnapshots: async () => [{ header: session.header, revision: SessionPersistenceRevision(revision) }], borrowSession: async () => ({ source: 'prepared', inspection: { meta: session.header, events: session.events }, revision: SessionPersistenceRevision(revision), preparedSession: session, [Symbol.dispose]: dispose }) } as never)
    const first = await page()
    expect(first.records[0]?.state).toBe('orphaned-prefix')
    expect(dispose).toHaveBeenCalledTimes(1)
    const body = assistantPrefixBodySchema.parse(JSON.parse(await content(first.sourceRevision, first.records[0]!.id)))
    expect(body.content[0]!.text).toBe('cold'.repeat(50_001))
    expect(dispose).toHaveBeenCalledTimes(2)
    revision = 'fixture:two'
    await expect(page({ sourceRevision: first.sourceRevision })).rejects.toMatchObject({ code: 'history-stale-source' })
  })

  it('keeps post-finish tail chunks in the original assembler attempt', async () => {
    const { session, page, content } = await fixture()
    const source = chunks(session, 1, 'before')
    source.push(session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'fixture' } } } }).seq)
    source.push(...chunks(session, 1, 'tail'))
    finalize(session, source, 'beforetail', true)
    const result = await page()
    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.state).toBe('interrupted')
    const body = assistantMessageBodySchema.parse(JSON.parse(await content(result.sourceRevision, result.records[0]!.id)))
    expect(body.entry.event.data.message.content[0]!.text).toBe('beforetail')
  })

  it('assembles oversized content exactly once across all fragments, with bounded preview work', async () => {
    const { session, page, content } = await fixture({ contentBytes: 1 })
    chunks(session, 50_001, 'streamed-')
    const push = vi.spyOn(BlockAssembler.prototype, 'push')
    try {
      const result = await page()
      expect(push.mock.calls.length).toBeLessThanOrEqual(4096)
      push.mockClear()
      const body = assistantPrefixBodySchema.parse(JSON.parse(await content(result.sourceRevision, result.records[0]!.id, 4096)))
      expect(body.content[0]!.text).toBe('streamed-'.repeat(50_001))
      expect(push).toHaveBeenCalledTimes(50_001)
    } finally { push.mockRestore() }
  })

  it('recovers reasoning and closed text blocks in canonical assembler order', async () => {
    const { session, page, content } = await fixture()
    session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 3, text: 'reason' } })
    session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'provisional' } })
    session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'authoritative' } } })
    session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'ignored straggler' } })
    const result = await page()
    const body = assistantPrefixBodySchema.parse(JSON.parse(await content(result.sourceRevision, result.records[0]!.id)))
    expect(body.content).toEqual([{ type: 'reasoning', text: 'reason' }, { type: 'text', text: 'authoritative' }])
  })

  it('continues a live body without snapshots after append and closes it after source replacement', async () => {
    const { ctx, session, page, reader } = await fixture({ contentBytes: 1, indexBytes: 0 })
    chunks(session, 200)
    const result = await page()
    const request = { sessionId: session.id, view: 'content' as const, sourceRevision: result.sourceRevision, recordId: result.records[0]!.id, maxCodeUnits: 2 }
    const first = await reader.read(request, signal())
    if (first.view !== 'content') throw new Error('expected content')
    chunks(session, 10)
    const snapshot = vi.spyOn(session, 'events', 'get').mockImplementation(() => { throw new Error('continuation requested a full snapshot') })
    try {
      const next = await reader.read({ ...request, contentReadId: first.contentReadId, offset: first.nextOffset }, signal())
      expect(next.view).toBe('content')
      expect(snapshot).not.toHaveBeenCalled()
      const replacement = Session.create(session.id)
      vi.spyOn(ctx.sessions, 'get').mockReturnValue(replacement)
      const close = await reader.read({ ...request, contentReadId: first.contentReadId, close: true }, signal())
      expect(close.view === 'content' && close.done).toBe(true)
    } finally { snapshot.mockRestore() }
  })

  it('closes or expires an unfinished oversized reader without evicting it between fragments', async () => {
    const { session, page, reader } = await fixture({ contentBytes: 1, contentIdleMs: 10 })
    chunks(session, 200)
    const result = await page()
    const request = { sessionId: session.id, view: 'content' as const, sourceRevision: result.sourceRevision, recordId: result.records[0]!.id, maxCodeUnits: 2 }
    const first = await reader.read(request, signal())
    if (first.view !== 'content') throw new Error('expected content')
    await expect(reader.read(request, signal())).rejects.toMatchObject({ code: 'history-content-busy' })
    const closed = await reader.read({ ...request, contentReadId: first.contentReadId, close: true }, signal())
    expect(closed.view === 'content' && closed.done).toBe(true)
    const next = await reader.read(request, signal())
    if (next.view !== 'content') throw new Error('expected content')
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(reader.read({ ...request, contentReadId: next.contentReadId, offset: next.nextOffset }, signal())).rejects.toMatchObject({ code: 'history-content-expired' })
    const fresh = await reader.read(request, signal())
    expect(fresh.view).toBe('content')
    reader.clear()
    if (fresh.view !== 'content') throw new Error('expected content')
    await expect(reader.read({ ...request, contentReadId: fresh.contentReadId, offset: fresh.nextOffset }, signal())).rejects.toMatchObject({ code: 'history-content-expired' })
  })

  it('provides exact completed usage and compact timing boundaries from the existing strict owner', async () => {
    const { session, page, content } = await fixture()
    session.append('turn/start', { turn: 0 })
    session.append('step/start', { turn: 0, step: 0 })
    const source = chunks(session, 50_001)
    session.append('assistant/message', { turn: 0, step: 0,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'p', model: 'm' } }),
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 4 },
    }, { surfaceOp: 'append', sourceEventSeqs: source })
    session.append('step/end', { turn: 0, step: 0 })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    const result = await page()
    expect(result.turns[0]?.usage).toEqual({ uncachedInputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 4, routes: [{ provider: 'p', model: 'm' }] })
    expect(Object.isFrozen(result.turns[0]?.usage)).toBe(true)
    const bundle = dependencyBundleSchema.parse(JSON.parse(await content(result.sourceRevision, result.dependencyRecords.turn)))
    expect(bundle.domain).toBe('turn')
    expect(bundle.chunkCoverage).toBe('timing-boundaries')
    expect(bundle.completeness).toBe('complete')
    expect(bundle.entries.filter(entry => entry.event.type === 'assistant/chunk').map(entry => entry.event.seq))
      .toEqual([source[0], source.at(-1)])
    expect(bundle.turns).toEqual(result.turns)
  })

  it('closes workflow/PTC and status dependencies at one cut without chunk replay', async () => {
    const { session, page, content } = await fixture()
    session.append('turn/start', { turn: 0 })
    const callId = CallId('root')
    session.append('tool/call', { turn: 0, step: 0, callId, name: 'run_code', arguments: '{}' })
    const dispatch = { rootCallId: callId, parentCallId: callId, subCallId: CallId('child'), name: 'fixture', arguments: {} }
    session.append('tool/code-dispatch-start', dispatch)
    session.append('tool/code-dispatch', { ...dispatch, isError: false, content: [{ type: 'text', text: 'child result' }] })
    const runId = WorkflowRunId('workflow')
    session.append('tool-workflow/run-start', { runId, name: 'workflow' })
    session.append('tool-workflow/agent-start', { runId, seq: 1, label: 'member', childId: SessionId('member') })
    session.append('tool-workflow/agent-end', { runId, seq: 1, outcome: 'completed' })
    session.append('tool-workflow/run-end', { runId, stopReason: 'completed' })
    const commandId = CommandId('command')
    session.append('command/run', { commandId, name: 'compact', source: { kind: 'user' } })
    const compactionId = CompactionId('compact')
    session.append('compaction/start', { compactionId, sourceCommandId: commandId, turn: 0 })
    session.append('compaction/end', { compactionId, sourceCommandId: commandId, turn: 0 })
    session.append('command/done', { commandId, kind: 'success' })
    session.append('tool/result', { turn: 0, step: 0, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'result' }], isError: false }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    const result = await page()
    const tools = dependencyBundleSchema.parse(JSON.parse(await content(result.sourceRevision, result.dependencyRecords.tool)))
    expect(tools.completeness).toBe('complete')
    expect(tools.entries.map(entry => entry.event.type)).toEqual(['turn/start', 'tool/call', 'tool/code-dispatch-start', 'tool/code-dispatch', 'tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end', 'tool/result', 'turn/end'])
    const statuses = dependencyBundleSchema.parse(JSON.parse(await content(result.sourceRevision, result.dependencyRecords.status)))
    expect(statuses.completeness).toBe('complete')
    expect(statuses.entries.map(entry => entry.event.type)).toEqual(['turn/start', 'command/run', 'compaction/start', 'compaction/end', 'command/done', 'turn/end'])
    session.append('command/done', { commandId: CommandId('missing'), kind: 'error' })
    const latest = await page()
    const incomplete = dependencyBundleSchema.parse(JSON.parse(await content(latest.sourceRevision, latest.dependencyRecords.status)))
    expect(incomplete.completeness).toBe('unknown')
    expect(incomplete.missing).toContain('command-start')
    const old = dependencyBundleSchema.parse(JSON.parse(await content(result.sourceRevision, result.dependencyRecords.status)))
    expect(old).toEqual(statuses)
  })

  it('pairs a tool result with its original call outside the semantic page', async () => {
    const { session, page, content, present } = await fixture()
    const callId = CallId('paired')
    const call = session.append('tool/call', { turn: 0, step: 0, callId, name: 'fixture', arguments: '{"value":1}' })
    chunks(session, 5)
    const resultEvent = session.append('tool/result', { turn: 0, step: 0, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'result' }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    const result = await page()
    const tool = result.records.find(record => record.kind === 'tool')!
    expect(tool.callEventSeq).toBe(call.seq)
    expect(tool.resultEventSeq).toBe(resultEvent.seq)
    expect(tool.completedTurnEndSeq).toBe(session.seq - 1)
    const body = toolBodySchema.parse(JSON.parse(await content(result.sourceRevision, tool.id)))
    expect(body.result.view.callSeq).toBe(call.seq)
    expect(present.mock.calls.some(([event, dependencies]) => event.type === 'tool/result' && dependencies[0]?.seq === call.seq)).toBe(true)
  })
})
