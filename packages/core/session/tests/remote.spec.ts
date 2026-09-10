import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type {
  SessionRemoteListRequest,
  SessionRemoteOperations,
  SessionRemoteResult,
} from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

describe('Session Remote port', () => {
  it('delegates a valid request through the Host-composed owner and preserves its business failure', async () => {
    const seen: SessionRemoteListRequest[] = []
    const ctx = new Context()
    ctx.provide('sessionRemoteOperations', {
      async list(request: SessionRemoteListRequest, signal: AbortSignal) {
        seen.push(request)
        expect(signal.aborted).toBe(false)
        return { ok: false, error: { code: 'session-not-found', message: 'missing', details: {} } }
      },
    } as unknown as SessionRemoteOperations)
    await ctx.plugin(SessionStore)

    const result = await ctx.sessions.remoteExportList({ cursor: 'reserved' }, new AbortController().signal)
    expect(result).toEqual({ ok: false, error: { code: 'session-not-found', message: 'missing', details: {} } })
    expect(seen).toEqual([{ cursor: 'reserved' }])
    expect(ctx.sessions.typertRemote).toMatchObject({ serviceKey: 'sessions', namespace: 'session' })
    expect(remoteMethods(ctx.sessions).map(method => method.exportName ?? method.method)).toEqual(expect.arrayContaining([
      'list', 'search', 'create', 'history', 'models', 'selectModel', 'rename', 'fork', 'prompt', 'attachment', 'updateQueue', 'cancel',
    ]))
  })

  it('does not invoke a Host owner after cancellation and reports a missing composition explicitly', async () => {
    const cancelled = new AbortController()
    cancelled.abort(new Error('test cancellation'))
    const ctx = new Context()
    let calls = 0
    ctx.provide('sessionRemoteOperations', {
      async list(): Promise<SessionRemoteResult<{ items: readonly [] }>> {
        calls += 1
        return { ok: true, value: { items: [] } }
      },
    } as unknown as SessionRemoteOperations)
    await ctx.plugin(SessionStore)

    await expect(ctx.sessions.remoteExportList({}, cancelled.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    expect(calls).toBe(0)

    const unavailable = new Context()
    await unavailable.plugin(SessionStore)
    await expect(unavailable.sessions.remoteExportList({}, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-remote-unavailable' },
    })
  })

  it('delegates every Host-owned Session operation through its typed wrapper', async () => {
    const calls: string[] = []
    const result = { ok: true, value: { marker: true } }
    const operation = (name: string) => async () => {
      calls.push(name)
      return result
    }
    const ctx = new Context()
    ctx.provide('sessionRemoteOperations', {
      list: operation('list'),
      search: operation('search'),
      create: operation('create'),
      history: operation('history'),
      models: operation('models'),
      selectModel: operation('selectModel'),
      rename: operation('rename'),
      fork: operation('fork'),
      prompt: operation('prompt'),
      attachment: operation('attachment'),
      updateQueue: operation('updateQueue'),
      cancel: operation('cancel'),
    } as unknown as SessionRemoteOperations)
    await ctx.plugin(SessionStore)
    const signal = new AbortController().signal

    const responses = await Promise.all([
      ctx.sessions.remoteExportList({}, signal),
      ctx.sessions.remoteExportSearch({} as never, signal),
      ctx.sessions.remoteExportCreate({}, signal),
      ctx.sessions.remoteExportHistory({} as never, signal),
      ctx.sessions.remoteExportModels({} as never, signal),
      ctx.sessions.remoteExportSelectModel({} as never, signal),
      ctx.sessions.remoteExportRename({} as never, signal),
      ctx.sessions.remoteExportFork({} as never, signal),
      ctx.sessions.remoteExportPrompt({} as never, signal),
      ctx.sessions.remoteExportAttachment({} as never, signal),
      ctx.sessions.remoteExportUpdateQueue({} as never, signal),
      ctx.sessions.remoteExportCancel({} as never, signal),
    ])

    expect(calls).toEqual([
      'list', 'search', 'create', 'history', 'models', 'selectModel',
      'rename', 'fork', 'prompt', 'attachment', 'updateQueue', 'cancel',
    ])
    expect(responses).toEqual(Array.from({ length: 12 }, () => result))
  })

  it('rechecks cancellation after an awaited Host operation', async () => {
    const controller = new AbortController()
    const ctx = new Context()
    ctx.provide('sessionRemoteOperations', {
      async list() {
        controller.abort(new Error('cancelled while awaiting Host'))
        return { ok: true, value: { items: [] } }
      },
    } as unknown as SessionRemoteOperations)
    await ctx.plugin(SessionStore)

    await expect(ctx.sessions.remoteExportList({}, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })
})
