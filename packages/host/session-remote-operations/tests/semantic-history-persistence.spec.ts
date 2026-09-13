import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { SessionObservationReader } from '../../../session-query/session-query/src/observation.ts'
import { expect, it, vi } from 'vitest'
import { SemanticHistoryReader } from '../src/semantic-history.ts'

it('continues cold content without reloading JSONL after real coordinator and numeric cache eviction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ark-semantic-reader-test-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', preparedSessionCacheSize: 1 })
    const persistence = ctx.sessionPersistence as JsonlSessionPersistence
    const target = SessionId('cold-body')
    const ids = [target, ...Array.from({ length: 6 }, (_, index) => SessionId(`other-${String(index)}`))]
    const originalText = 'exact body 😀\n'.repeat(2000)
    for (const id of ids) {
      const source = Session.create(id, undefined, { version: 0, id, createdAt: 1, cwd: '/synthetic' })
      source.append('user/message', createUserMessage({ content: [{ type: 'text', text: id === target ? originalText : 'other' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      await persistence.create(source.header)
      await persistence.append(id, source.events)
    }
    const observations = new SessionObservationReader(ctx)
    const observe = vi.spyOn(observations, 'read')
    ctx.provide('sessionQuery', { observeSession: observations.read.bind(observations) } as never)
    const reader = new SemanticHistoryReader(ctx, () => async (event: SessionEvent) => {
      const data = z.json().parse(snapshotJsonValue(event.data))
      return { event: { type: event.type, seq: event.seq, time: event.time, data } }
    }, { indexBytes: 0, contentBytes: 1 })
    const page = await reader.read({ sessionId: target, view: 'semantic' }, new AbortController().signal)
    if (page.view !== 'semantic') throw new Error('expected page')
    const request = { sessionId: target, view: 'content' as const, sourceRevision: page.sourceRevision, recordId: page.records[0]!.id, maxCodeUnits: 1024 }
    const first = await reader.read(request, new AbortController().signal)
    if (first.view !== 'content') throw new Error('expected fragment')
    for (const id of ids.slice(1)) {
      using borrowed = await persistence.borrowSession(id)
      expect(borrowed.source).toBe('prepared')
    }
    const load = vi.spyOn(persistence, 'loadStored')
    const borrow = vi.spyOn(persistence, 'borrowSession')
    const snapshots = vi.spyOn(persistence, 'listSnapshots')
    observe.mockClear()
    let text = first.text
    let offset = first.nextOffset
    for (;;) {
      const part = await reader.read({ ...request, contentReadId: first.contentReadId, offset }, new AbortController().signal)
      if (part.view !== 'content') throw new Error('expected fragment')
      text += part.text
      if (part.done) break
      offset = part.nextOffset
    }
    expect(JSON.parse(text).entry.event.data.content[0].text).toBe(originalText)
    expect(observe).not.toHaveBeenCalled()
    expect(borrow).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    expect(snapshots.mock.calls.length).toBeGreaterThan(1)
    // Prove the target really was evicted: a normal observation now reloads it.
    using reloaded = await persistence.borrowSession(target)
    expect(reloaded.source).toBe('prepared')
    expect(load).toHaveBeenCalledTimes(1)
    reader.clear()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
