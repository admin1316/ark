import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  SessionPromptInvocationId,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { WorkspaceSessionDeletionBlockedError } from '@deepseek-ai/dsh-workspace'
import SessionRemoteOperationsService, { SESSION_EXPORT_PATH } from '../src/index.ts'

const contexts: Context[] = []
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function header(id: string, cwd: string): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt: 10, cwd }
}

function emptySession(id: string, cwd: string): Session {
  return Session.create(SessionId(id), undefined, header(id, cwd))
}

interface MutableHarness {
  readonly ctx: Context
  readonly sessions: Map<string, Session>
  readonly agents: Map<string, ReturnType<typeof fakeAgent>>
  readonly roots: ReturnType<typeof fakeAgent>[]
  archivedSessionIds: SessionId[]
  createCalls: number
}

function fakeAgent(session: Session, options: {
  status?: 'idle' | 'running'
  nextTurn?: UserMessage[]
  nextStep?: UserMessage[]
} = {}) {
  const nextTurn = options.nextTurn ?? []
  const nextStep = options.nextStep ?? []
  const cancel = vi.fn()
  const steer = vi.fn()
  const followup = vi.fn()
  return {
    id: session.id,
    session,
    options: { provider: 'provider', model: 'model' },
    status: options.status ?? 'idle',
    ctx: new Context(),
    inbox: {
      nextTurn,
      nextStep,
      get hasPending() { return nextTurn.length > 0 || nextStep.length > 0 },
      replace(id: string, message: UserMessage) {
        const index = [...nextTurn, ...nextStep].findIndex(item => item.id === id)
        if (index < 0) return false
        if (index < nextTurn.length) nextTurn[index] = message
        else nextStep[index - nextTurn.length] = message
        return true
      },
      remove(id: string) {
        const turn = nextTurn.findIndex(item => item.id === id)
        if (turn >= 0) return nextTurn.splice(turn, 1)[0]
        const step = nextStep.findIndex(item => item.id === id)
        return step >= 0 ? nextStep.splice(step, 1)[0] : undefined
      },
    },
    cancel,
    steer,
    followup,
    runMaintenance: <Value>(operation: (signal: AbortSignal) => Promise<Value>) =>
      operation(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
    send: vi.fn(),
  }
}

async function harness(cwd: string): Promise<MutableHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  const sessions = new Map<string, Session>()
  const agents = new Map<string, ReturnType<typeof fakeAgent>>()
  const roots: ReturnType<typeof fakeAgent>[] = []
  const state: MutableHarness = {
    ctx,
    sessions,
    agents,
    roots,
    archivedSessionIds: [],
    createCalls: 0,
  }

  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'provider', model: 'model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 1,
      maxImagesPerMessage: 1,
      maxMessageImageBytes: 1,
      maxImagePixels: 1,
      maxImageDimension: 1,
      mediaTypes: ['image/png'],
    },
  } as never)
  ctx.provide('commands', {
    execute: (_agent: unknown, line: string) => {
      if (line === '/ok') {
        return Promise.resolve({ commandId: 'command-1', result: { kind: 'success', text: 'done' } })
      }
      if (line === '/bad') {
        return Promise.resolve({ commandId: 'command-2', result: { kind: 'error', text: 'not allowed' } })
      }
      return Promise.resolve(undefined)
    },
  } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'provider', name: 'Provider' }],
    listModels: () => Promise.resolve([]),
    resolveCallConfig: (selection: unknown) => Promise.resolve(selection),
  } as never)
  ctx.provide('sessions', {
    get: (id: SessionId) => sessions.get(String(id)),
    list: () => [...sessions.values()],
    flush: () => Promise.resolve(false),
  } as never)
  ctx.provide('sessionQuery', {
    searchSessions: () => {
      const session = [...sessions.values()][0]
      return Promise.resolve({
        items: session === undefined
          ? []
          : [{
            header: session.header,
            bestMatch: {
              sessionId: session.id,
              surface: 'current',
              type: 'user/message',
              snippet: 'matching prompt',
            },
          }],
      })
    },
    traceSession: () => Promise.resolve({ ancestors: [] }),
  } as never)
  ctx.provide('sessionTitle', {
    rename: (_session: Session, title: string) => ({ title: title.trim(), eventSeq: 0 }),
  } as never)
  ctx.provide('agents', {
    get: (id: SessionId) => agents.get(String(id)),
    list: () => [...agents.values()],
    roots: () => [...roots],
    isOwnedBy: () => false,
    async create(options: { sessionId: SessionId; meta?: { cwd?: string } }) {
      state.createCalls += 1
      const session = emptySession(String(options.sessionId), options.meta?.cwd ?? cwd)
      const agent = fakeAgent(session)
      sessions.set(String(session.id), session)
      agents.set(String(session.id), agent)
      roots.push(agent)
      return {
        agent,
        async dispose() {
          sessions.delete(String(session.id))
          agents.delete(String(session.id))
          roots.splice(roots.indexOf(agent), 1)
        },
      }
    },
    resume: () => Promise.reject(new Error('not needed by this harness')),
  } as never)
  ctx.provide('workspaceRegistry', {
    get: () => undefined,
    list: () => [],
    sessionAdmissionRevision: () => 0,
    assertSessionAdmission: () => {},
    get archivedSessionIds() { return state.archivedSessionIds },
  } as never)

  await ctx.plugin(SessionRemoteOperationsService, { cwd })
  return state
}

describe('SessionRemoteOperationsService', () => {
  it('provides both Host ports, reads live state directly, and short-circuits pre-cancelled calls', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-session-remote-'))
    temporary.push(cwd)
    const state = await harness(cwd)
    const session = emptySession('session-live', cwd)
    state.sessions.set(String(session.id), session)

    const operations = state.ctx.get('sessionRemoteOperations') as SessionRemoteOperationsService | undefined
    expect(operations !== undefined).toBe(true)
    expect(typeof operations?.fetch).toBe('function')
    expect(operations?.path).toBe(SESSION_EXPORT_PATH)
    expect(typeof state.ctx.get('workspaceSessionRetirer')?.retireArchivedSession).toBe('function')
    await expect(operations?.list({}, new AbortController().signal))
      .resolves.toMatchObject({
        ok: true,
        value: { items: [{ sessionId: session.id, blank: true, running: false, cwd }] },
      })
    await expect(operations?.history({ sessionId: session.id }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { events: [], hasMore: false } })
    await expect(operations?.history({
      sessionId: session.id,
      maxMessages: 0,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' },
    })
    await expect(operations?.search({ query: 'prompt' }, new AbortController().signal))
      .resolves.toEqual({
        ok: true,
        value: {
          items: [{ sessionId: session.id, snippet: 'matching prompt' }],
          hasMore: false,
        },
      })

    const cancelled = new AbortController()
    cancelled.abort(new Error('caller cancelled'))
    await expect(operations?.list({}, cancelled.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })

  it('preserves text-only queue editing, steering guards, and keep-inbox cancellation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-session-remote-'))
    temporary.push(cwd)
    const state = await harness(cwd)
    const session = emptySession('session-queue', cwd)
    const pending = createUserMessage({
      content: [{ type: 'text', text: 'before' }],
      source: { kind: 'user' },
    })
    const agent = fakeAgent(session, { status: 'running', nextTurn: [pending] })
    state.sessions.set(String(session.id), session)
    state.agents.set(String(session.id), agent)
    state.roots.push(agent)
    const operations = state.ctx.sessionRemoteOperations as SessionRemoteOperationsService

    await expect(operations.updateQueue({
      sessionId: session.id,
      itemId: String(pending.id),
      action: { kind: 'edit', content: [{ type: 'text', text: 'after' }] },
    }, new AbortController().signal)).resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(agent.inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: 'after' }])

    await expect(operations.updateQueue({
      sessionId: session.id,
      itemId: String(pending.id),
      action: { kind: 'edit', content: [{ type: 'image', data: 'forbidden' }] },
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'QUEUE_EDIT_NON_TEXT' } },
    })

    await expect(operations.cancel({ sessionId: session.id }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  })

  it('routes an exact slash-command prompt through CommandRuntime and never into the model inbox', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-session-remote-'))
    temporary.push(cwd)
    const state = await harness(cwd)
    const session = emptySession('session-command', cwd)
    const agent = fakeAgent(session)
    state.sessions.set(String(session.id), session)
    state.agents.set(String(session.id), agent)
    state.roots.push(agent)
    const operations = state.ctx.sessionRemoteOperations as SessionRemoteOperationsService

    await expect(operations.prompt({
      sessionId: session.id,
      invocationId: SessionPromptInvocationId('command-ok'),
      mode: 'steer',
      content: [{ type: 'text', text: '/ok' }],
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { accepted: true, command: { kind: 'success', text: 'done' } },
    })
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.steer).not.toHaveBeenCalled()

    await expect(operations.prompt({
      sessionId: session.id,
      invocationId: SessionPromptInvocationId('command-missing'),
      mode: 'queue',
      content: [{ type: 'text', text: '/missing' }],
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown-command' },
    })
    await expect(operations.prompt({
      sessionId: session.id,
      invocationId: SessionPromptInvocationId('command-bad'),
      mode: 'queue',
      content: [{ type: 'text', text: '/bad' }],
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'command-error', message: 'not allowed' },
    })

    await expect(operations.prompt({
      sessionId: session.id,
      invocationId: SessionPromptInvocationId('ordinary-prompt'),
      mode: 'queue',
      content: [{ type: 'text', text: 'ordinary prompt' }],
      clientTimeZone: 'UTC',
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { accepted: true },
    })
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.followup.mock.calls[0]?.[0]).toMatchObject({
      content: [{ type: 'text', text: 'ordinary prompt' }],
      source: {
        kind: 'user',
        invocationId: SessionPromptInvocationId('ordinary-prompt'),
        clientTimeZone: 'UTC',
      },
    })

    await expect(operations.prompt({
      sessionId: session.id,
      invocationId: SessionPromptInvocationId(''),
      mode: 'queue',
      content: [{ type: 'text', text: 'invalid identity' }],
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid-invocation-id' },
    })

    await expect(operations.selectModel({
      sessionId: session.id,
      provider: 'provider',
      model: 'model-2',
      reasoningEffort: 'high',
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        selected: { provider: 'provider', model: 'model-2', reasoningEffort: 'high' },
      },
    })
    await expect(operations.models({ sessionId: session.id }, new AbortController().signal))
      .resolves.toMatchObject({
        ok: true,
        value: {
          current: { provider: 'provider', model: 'model-2', reasoningEffort: 'high' },
          routable: true,
        },
      })
    await expect(operations.rename({
      sessionId: session.id,
      title: '  Renamed  ',
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { title: 'Renamed', seq: 0 },
    })
  })

  it('owns created handles for safe archived retirement and rejects unowned residents', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-session-remote-'))
    temporary.push(cwd)
    const state = await harness(cwd)
    const operations = state.ctx.sessionRemoteOperations as SessionRemoteOperationsService
    const sessionId = SessionId('session-created')

    await expect(operations.create({ sessionId, cwd }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { sessionId },
    })
    expect(state.createCalls).toBe(1)
    state.archivedSessionIds = [sessionId]
    await expect(operations.retireArchivedSession(sessionId, new AbortController().signal)).resolves.toBeUndefined()
    expect(state.sessions.has(String(sessionId))).toBe(false)

    const foreignSession = emptySession('session-foreign', cwd)
    const foreignAgent = fakeAgent(foreignSession)
    state.sessions.set(String(foreignSession.id), foreignSession)
    state.agents.set(String(foreignSession.id), foreignAgent)
    state.roots.push(foreignAgent)
    state.archivedSessionIds = [foreignSession.id]
    await expect(operations.retireArchivedSession(foreignSession.id, new AbortController().signal))
      .rejects.toEqual(expect.objectContaining({
        name: WorkspaceSessionDeletionBlockedError.name,
        reason: 'resident',
      }))

    await expect(operations.create({ workspaceId: 'missing' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'workspace-not-found' } })
  })
})
