import { Context } from '@deepseek-ai/cordis'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import SessionStore, { Session, SessionId, snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionRemoteSemanticHistoryValue } from '@deepseek-ai/dsh-session'
import { SessionObservationReader } from '../../../session-query/session-query/src/observation.ts'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SemanticHistoryReader } from '../src/semantic-history.ts'
import type { SemanticHistoryLimits } from '../src/semantic-history.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
const signal = (): AbortSignal => new AbortController().signal

/** Fixture with the primary session plus named extra sessions for multi-identity budgets. */
async function fixture(limits: SemanticHistoryLimits = {}, extraSessions = 0): Promise<{
  session: Session
  sessions: Session[]
  reader: SemanticHistoryReader
  page: (extra?: Record<string, unknown>, forSession?: Session) => Promise<SessionRemoteSemanticHistoryValue>
  content: (sourceRevision: string, recordId: string, maximum?: number, forSession?: Session) => Promise<string>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('semantic-edge-fixture'), { meta: { cwd: '/workspace' } })
  const sessions: Session[] = [session]
  for (let index = 0; index < extraSessions; index += 1) {
    sessions.push(ctx.sessions.create(SessionId(`semantic-edge-extra-${String(index)}`), { meta: { cwd: '/workspace' } }))
  }
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
  const page = async (extra: Record<string, unknown> = {}, forSession: Session = session): Promise<SessionRemoteSemanticHistoryValue> => {
    const result = await reader.read({ sessionId: forSession.id, view: 'semantic', ...extra }, signal())
    if (result.view !== 'semantic') throw new Error('expected semantic page')
    return result
  }
  const content = async (sourceRevision: string, recordId: string, maximum = 65_536, forSession: Session = session): Promise<string> => {
    let offset = 0
    let joined = ''
    let contentReadId: string | undefined
    for (;;) {
      const part = await reader.read({ sessionId: forSession.id, view: 'content', sourceRevision, recordId, offset, maxCodeUnits: maximum, ...contentReadId === undefined ? {} : { contentReadId } }, signal())
      if (part.view !== 'content') throw new Error('expected content')
      joined += part.text
      contentReadId = part.contentReadId
      if (part.done) return joined
      offset = part.nextOffset
    }
  }
  return { session, sessions, reader, page, content }
}

function chunks(session: Session, count: number, turn = 0): number[] {
  const seqs: number[] = []
  for (let index = 0; index < count; index += 1) {
    seqs.push(session.append('assistant/chunk', { turn, step: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } }).seq)
  }
  return seqs
}

/** Rewrites the cut tail of a wire revision to observe an older cut of the same source. */
function atCut(sourceRevision: string, through: number): string {
  return sourceRevision.replace(/:\d+$/u, `:${String(through)}`)
}

describe('semantic history validation edges', () => {
  it('rejects a non-string sourceRevision before observing the source', async () => {
    const { reader, session } = await fixture()
    await expect(reader.read({ sessionId: session.id, view: 'semantic', sourceRevision: 7 } as never, signal()))
      .rejects.toMatchObject({ code: 'invalid-argument', message: 'sourceRevision must be a string' })
  })

  it('rejects a content read without the required sourceRevision', async () => {
    const { reader, session } = await fixture()
    await expect(reader.read({ sessionId: session.id, view: 'content', recordId: 'whatever' } as never, signal()))
      .rejects.toMatchObject({ code: 'invalid-argument', message: 'content requires sourceRevision' })
  })

  it('rejects a content continuation addressed to another parent session', async () => {
    const { session, reader, page } = await fixture()
    session.append('turn/start', { turn: 0 })
    const source = chunks(session, 2)
    session.append('assistant/message', { turn: 0, step: 0, message: createAssistantMessage({
      content: [{ type: 'text', text: 'x'.repeat(40) }], source: { provider: 'fixture', model: 'fixture' },
    }) }, { surfaceOp: 'append', sourceEventSeqs: source })
    const result = await page()
    const record = result.records.find(item => item.kind === 'assistant')!
    const first = await reader.read({
      sessionId: session.id, view: 'content', sourceRevision: result.sourceRevision,
      recordId: record.id, offset: 0, maxCodeUnits: 2,
    }, signal())
    if (first.view !== 'content' || first.done) throw new Error('expected an unfinished content read')
    await expect(reader.read({
      sessionId: session.id, view: 'content', sourceRevision: result.sourceRevision,
      recordId: record.id, offset: first.nextOffset, maxCodeUnits: 2,
      contentReadId: first.contentReadId, expectedParentSessionId: SessionId('other-parent'),
    }, signal())).rejects.toMatchObject({ code: 'subagent-unauthorized', message: 'content reader belongs to another parent' })
  })
})

describe('semantic history index budgets', () => {
  it('evicts the oldest identity over the entry budget and keeps serving fresh pages', async () => {
    const { sessions, page, content } = await fixture({ indexEntries: 1 }, 1)
    for (const session of sessions) {
      session.append('turn/start', { turn: 0 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    }
    const first = await page()
    await content(first.sourceRevision, first.dependencyRecords.turn)
    // A second identity exceeds the one-entry budget and evicts the first index.
    const other = sessions[1]!
    const second = await page({}, other)
    expect(second.records.length).toBeGreaterThan(0)
    // The evicted source still serves: its index rebuilds from scratch.
    const again = await page()
    expect(again.records.length).toBeGreaterThan(0)
    expect(again.records[0]!.id).toBe(first.records[0]!.id)
  })

  it('keeps deleting indices while the byte budget stays exceeded and still serves later reads', async () => {
    const { sessions, page, content } = await fixture({ indexEntries: 8, indexBytes: 1 }, 2)
    for (const session of sessions) {
      session.append('turn/start', { turn: 0 })
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    }
    for (const session of sessions) {
      const result = await page({}, session)
      const bundle = JSON.parse(await content(result.sourceRevision, result.dependencyRecords.turn, 65_536, session)) as {
        domain: string
        entries: Array<{ event: { seq: number } }>
      }
      expect(bundle.domain).toBe('turn')
      expect(bundle.entries.length).toBeGreaterThan(0)
    }
  })
})

describe('semantic history dependency edges', () => {
  it('presents an old cut inside a growing chunk run at its own last timing observation', async () => {
    const { session, page, content } = await fixture()
    const opening = session.append('turn/start', { turn: 0 }).seq
    const seqs = chunks(session, 3)
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    const latest = await page()
    // Cut at the middle chunk: it is not a run boundary, yet it is the actual
    // last timing observation of this still-growing run at that cut. The turn
    // opener precedes both observed chunk boundaries.
    const old = await content(atCut(latest.sourceRevision, seqs[1]!), latest.dependencyRecords.turn)
    const bundle = JSON.parse(old) as { entries: Array<{ event: { seq: number } }> }
    expect(bundle.entries.map(entry => entry.event.seq)).toEqual([opening, seqs[0], seqs[1]!])
  })

  it('reports an orphan tool result as missing its parent call', async () => {
    const { session, page, content } = await fixture()
    session.append('turn/start', { turn: 0 })
    session.append('tool/result', {
      turn: 0, step: 0,
      message: createToolResultMessage({ callId: CallId('no-call'), content: [{ type: 'text', text: 'orphan' }], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    const result = await page()
    const bundle = JSON.parse(await content(result.sourceRevision, result.dependencyRecords.tool)) as {
      completeness: string
      missing: string[]
      entries: Array<{ event: { type: string }; view?: { callSeq: number } }>
    }
    expect(bundle.completeness).toBe('unknown')
    expect(bundle.missing).toContain('parent-call')
    const orphan = bundle.entries.find(entry => entry.event.type === 'tool/result')
    expect(orphan?.view?.callSeq).toBe(-1)
  })

  it('keeps one timing boundary per consecutive failed finish chunk', async () => {
    const { session, page, content } = await fixture()
    session.append('turn/start', { turn: 0 })
    for (const text of ['first', 'second']) {
      session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: text } } } })
    }
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    const result = await page()
    const bundle = JSON.parse(await content(result.sourceRevision, result.dependencyRecords.turn)) as {
      missing: string[]
      entries: Array<{ event: { type: string; data: { chunk: { type: string } } } }>
    }
    expect(bundle.missing).toEqual([])
    expect(bundle.entries.filter(entry => entry.event.type === 'assistant/chunk'
      && entry.event.data.chunk.type === 'finish').length).toBe(2)
  })

  it('audits every orphan relationship kind the dependency scanner owns', async () => {
    const { session, page, content } = await fixture()
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    session.append('tool/result', {
      turn: 0, step: 0,
      message: createToolResultMessage({ callId: CallId('orphan'), content: [{ type: 'text', text: 'orphan' }], isError: false }),
    }, { surfaceOp: 'append' })
    // Dispatch whose root call was never made.
    session.append('tool/code-dispatch-start', {
      rootCallId: CallId('missing-root'), parentCallId: CallId('missing-root'),
      subCallId: CallId('child-a'), name: 'fixture', arguments: {},
    })
    // Dispatch whose parent dispatch start was never made: the root call
    // exists, so only the unseen parent dispatch can explain the orphan.
    session.append('tool/call', { turn: 0, step: 0, callId: CallId('root-a'), name: 'fixture', arguments: '{}' })
    session.append('tool/code-dispatch', {
      rootCallId: CallId('root-a'), parentCallId: CallId('unseen-parent'),
      subCallId: CallId('child-b'), name: 'fixture', arguments: {}, isError: false, content: [{ type: 'text', text: 'x' }],
    })
    // Workflow members and runs with no matching start.
    session.append('tool-workflow/agent-start', { runId: WorkflowRunId('no-run'), seq: 1, label: 'member', childId: SessionId('member') })
    session.append('tool-workflow/agent-end', { runId: WorkflowRunId('no-member'), seq: 2, outcome: 'completed' })
    session.append('tool-workflow/run-end', { runId: WorkflowRunId('no-run-end'), stopReason: 'completed' })
    // Compaction summary with no compaction start.
    session.append('compaction/summary', {
      compactionId: CompactionId('compact'),
      summary: [{ type: 'text', text: 'compacted away' }],
      shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [],
      shadowedTokenCount: 0,
      provider: 'fixture',
      model: 'fixture',
    })
    const result = await page()
    const tools = JSON.parse(await content(result.sourceRevision, result.dependencyRecords.tool)) as { missing: string[] }
    const statuses = JSON.parse(await content(result.sourceRevision, result.dependencyRecords.status)) as { missing: string[] }
    expect(tools.missing).toContain('turn-start')
    expect(tools.missing).toContain('parent-call')
    expect(tools.missing).toContain('dispatch-start')
    expect(tools.missing).toContain('workflow-start')
    expect(tools.missing).toContain('workflow-member')
    expect(statuses.missing).toContain('turn-start')
    expect(statuses.missing).toContain('compaction-start')
  })
})
