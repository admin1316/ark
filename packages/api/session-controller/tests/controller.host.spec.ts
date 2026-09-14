import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import SessionController from '../src/index.ts'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SESSION_CONTROLLER_REMOTE_EVENTS } from '../src/remote-events.ts'
import type { SessionSummary } from '../src/types.ts'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const defaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

describe('SessionController facade', () => {
  it('does not require the Tools service', () => {
    expect(SessionController.inject).not.toContain('tools')
  })

  it('owns Host service methods and publishes Agent lifecycle projections', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('controller-session')
    const header: SessionHeader = {
      version: 0,
      id: sessionId,
      createdAt: 1,
      cwd: '/workspace',
    }
    const events: SessionEvent[] = []
    const inspect = vi.fn(() => Promise.resolve({ meta: header, events }))
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect,
    }) as never)
    const controller = createSessionTestController(ctx, defaults)
    const status = vi.fn()
    const failure = vi.fn()
    const activity = vi.fn()
    ctx.on('api-session/status', status)
    ctx.on('api-session/error', failure)
    ctx.on('api-session/activity', activity)

    await expect(controller.inspect(sessionId)).resolves.toEqual({ meta: header, events })
    expect(inspect).toHaveBeenCalledOnce()

    const session = ctx.sessions.create(sessionId, { meta: header })
    const agent = {
      id: sessionId,
      session,
      status: 'idle',
      ctx,
    } as Agent
    ctx.agents.register(agent)


    await expect(controller.resolveAgent(sessionId)).resolves.toEqual({ agent })
    await expect(controller.inspect(sessionId)).resolves.toEqual({ meta: header, events })
    expect(inspect).toHaveBeenCalledOnce()
    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('agent/error', { agent, turn: 1, step: 0, error: new Error('fixture failure') })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(status).toHaveBeenCalledWith(sessionId, true)
    expect(failure).toHaveBeenCalledWith(sessionId, expect.stringContaining('fixture failure'))
    expect(activity).toHaveBeenCalledWith(sessionId, expect.any(Number))
    session.append('request/header', {
      header: { config: { provider: 'fixture', model: 'fixture-model' } },
      reason: 'initial',
    })
    const unowned = ctx.sessions.create(SessionId('controller-unowned'), {
      meta: { cwd: '/workspace' },
    })
    unowned.append('request/header', {
      header: { config: { provider: 'fixture', model: 'other-model' } },
      reason: 'initial',
    })

    const abort = new AbortController()
    const iterator = controller.follow({
      address: { kind: 'session', sessionId },
    }, abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', cursor: 1 },
    })
    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it.each(['success', 'domain-error', 'throw'] as const)(
    'promotes a prepared follow observation in the background: %s',
    async (outcome) => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      const sessionId = SessionId(`background-${outcome}`)
      const header: SessionHeader = {
        version: 0, id: sessionId, createdAt: 1, cwd: '/workspace',
      }
      ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
        list: () => Promise.resolve([header]),
        inspect: () => Promise.resolve({ meta: header, events: [] }),
      }) as never)
      const controller = createSessionTestController(ctx, defaults)
      const agents = (controller as unknown as { agents: ApiSessionAgentController }).agents
      const apiError = vi.fn()
      ctx.on('api-session/error', apiError)
      const logError = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
      const live = { id: sessionId, session: { id: sessionId }, ctx, status: 'idle' } as unknown as Agent
      const resolve = vi.spyOn(agents, 'resolveObservedAgent')
      if (outcome === 'success') resolve.mockResolvedValue({ agent: live })
      else if (outcome === 'domain-error') {
        resolve.mockResolvedValue({
          error: { code: 'internal', message: 'activation unavailable', details: {} },
        })
      } else {
        resolve.mockRejectedValue(new Error('activation crashed'))
      }
      const abort = new AbortController()
      const iterator = controller.follow({
        address: { kind: 'session', sessionId },
      }, abort.signal)[Symbol.asyncIterator]()

      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot' } })
      const waiting = iterator.next()
      await vi.waitFor(() => { expect(resolve).toHaveBeenCalledOnce() })
      if (outcome === 'domain-error') {
        await vi.waitFor(() => {
          expect(apiError).toHaveBeenCalledWith(sessionId, 'activation unavailable')
        })
      } else if (outcome === 'throw') {
        await vi.waitFor(() => {
          expect(logError).toHaveBeenCalledWith(expect.stringContaining('activation crashed'))
        })
      } else {
        expect(apiError).not.toHaveBeenCalled()
      }
      abort.abort()
      await expect(waiting).resolves.toMatchObject({ done: true })
      await ctx.fiber.dispose()
    },
  )

  it('waits for an admitted background promotion during teardown', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('background-disposal')
    const header: SessionHeader = {
      version: 0, id: sessionId, createdAt: 1, cwd: '/workspace',
    }
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.resolve({ meta: header, events: [] }),
    }) as never)
    const controller = createSessionTestController(ctx, defaults)
    const agents = (controller as unknown as { agents: ApiSessionAgentController }).agents
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(agents, 'resolveObservedAgent').mockImplementation(async () => {
      started.resolve(undefined)
      await release.promise
      return {
        agent: { id: sessionId, session: { id: sessionId }, ctx, status: 'idle' } as unknown as Agent,
      }
    })
    const iterator = controller.follow({
      address: { kind: 'session', sessionId },
    }, new AbortController().signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot' } })
    const waiting = iterator.next()
    await started.promise
    let disposed = false
    const disposal = ctx.fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(undefined)
    await disposal
    await expect(waiting).resolves.toMatchObject({ done: true })
  })
})

describe('Session Controller remote event surface', () => {
  it('emits every declared controller remote event for its host trigger', async () => {
    // The declaration is the transport forwarding allowlist; pin its contents.
    expect([...SESSION_CONTROLLER_REMOTE_EVENTS].sort()).toEqual([
      'api-session/activity',
      'api-session/added',
      'api-session/error',
      'api-session/removed',
      'api-session/status',
    ])

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    createSessionTestController(ctx, defaults)
    const emitted = new Set<string>()
    const record = (name: string) => () => { emitted.add(name) }
    const disposers = [
      ctx.on('api-session/added', record('api-session/added')),
      ctx.on('api-session/removed', record('api-session/removed')),
      ctx.on('api-session/status', record('api-session/status')),
      ctx.on('api-session/error', record('api-session/error')),
      ctx.on('api-session/activity', record('api-session/activity')),
    ]

    const session = ctx.sessions.create(SessionId('surface-session'), { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'idle', ctx } as Agent
    ctx.agents.register(agent)
    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('agent/error', { agent, turn: 1, step: 0, error: new Error('surface failure') })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const prepared = ctx.sessions.prepare(SessionId('surface-removed'), { meta: { cwd: '/workspace' } })
    const detach = ctx.sessions.enter(prepared)
    ctx.sessions.announce(prepared)
    detach()

    expect([...emitted].sort()).toEqual([...SESSION_CONTROLLER_REMOTE_EVENTS].sort())
    for (const dispose of disposers) dispose()
    await ctx.fiber.dispose()
  })
})

describe('api-session/added summaries', () => {
  it('forwards the Session origin on the added summary', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    createSessionTestController(ctx, defaults)
    const added = vi.fn()
    ctx.on('api-session/added', added)

    const session = ctx.sessions.create(SessionId('origin-summary'), {
      meta: { cwd: '/workspace', origin: 'subagent' },
    })

    expect(added).toHaveBeenCalledOnce()
    expect(added).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id,
      origin: 'subagent',
      cwd: '/workspace',
    }))
    await ctx.fiber.dispose()
  })

  it('omits and logs cached projections that fail to summarize', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    createSessionTestController(ctx, defaults)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    let summary: SessionSummary | undefined
    ctx.on('api-session/added', (received) => { summary = received })
    vi.spyOn(ctx.sessionProjections, 'cachedSnapshot').mockImplementation(() => {
      throw new Error('projection cache offline')
    })

    const session = ctx.sessions.create(SessionId('degraded-summary'))

    expect(summary).toBeDefined()
    expect(summary).toMatchObject({ sessionId: session.id, blank: true, running: false })
    expect(summary).not.toHaveProperty('projections')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('degraded-summary'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('projection cache offline'))
    await ctx.fiber.dispose()
  })
})
