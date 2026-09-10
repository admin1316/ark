import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  apiRemoteSubagentOwnershipError,
  createApiRemoteAgentResolver,
  hasApiRemoteSubagentOwner,
  inspectApiRemoteSession,
} from '../src/agent-lookup.ts'
import { apply as applyApiRemotes } from '../src/index.ts'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

const sid = (value: string): SessionId => value as SessionId

function header(id: SessionId): SessionHeader {
  return { version: 0, id, createdAt: 1, cwd: '/proj' }
}

async function createContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return ctx
}

function provideSession(
  ctx: Context,
  meta: SessionHeader,
  inspect: () => Promise<{ meta: SessionHeader; events: SessionEvent[] }>,
): void {
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([meta]),
    inspect,
    locate: () => undefined,
  } as never)
}

function stubAgent(ctx: Context, session: Session): Agent {
  return { id: session.id, session, status: 'idle', ctx } as Agent
}

describe('API Remote Agent resolver races', () => {
  it('classifies ownership and persistence failures without attempting a resume', async () => {
    const sessionId = sid('ownership-probe')
    const parent = { id: sid('parent') } as Agent
    const agent = { id: sessionId } as Agent
    const ownerContext = {
      agents: {
        get: (): Agent => parent,
        isOwnedBy: (): boolean => true,
      },
    } as unknown as Context
    const owned = { header: { ...header(sessionId), parentSession: parent.id } }
    expect(hasApiRemoteSubagentOwner(ownerContext, owned, agent)).toBe(true)
    expect(hasApiRemoteSubagentOwner(ownerContext, { header: { ...header(sessionId), origin: 'subagent' } }, undefined)).toBe(true)
    expect(hasApiRemoteSubagentOwner(ownerContext, { header: header(sessionId) }, undefined)).toBe(false)
    expect(apiRemoteSubagentOwnershipError(sessionId)).toMatchObject({ code: 'agent-busy' })

    await expect(inspectApiRemoteSession({ get: () => undefined } as unknown as Context, sessionId))
      .rejects.toThrow('session persistence is not configured')
    const emptyPersistence = {
      get: () => ({ list: async () => [], inspect: async () => ({ meta: header(sessionId), events: [] }) }),
    } as unknown as Context
    await expect(inspectApiRemoteSession(emptyPersistence, sessionId)).rejects.toThrow('not found')
    const noCwd = {
      get: () => ({
        list: async () => [{ ...header(sessionId), cwd: undefined }],
        inspect: async () => ({ meta: header(sessionId), events: [] }),
      }),
    } as unknown as Context
    await expect(inspectApiRemoteSession(noCwd, sessionId)).rejects.toThrow('not found')
    const events = [{} as SessionEvent]
    const readable = {
      get: () => ({
        list: async () => [header(sessionId)],
        inspect: async () => ({ meta: header(sessionId), events }),
      }),
    } as unknown as Context
    const inspected = await inspectApiRemoteSession(readable, sessionId)
    expect(inspected).toEqual({ meta: header(sessionId), events })
    expect(inspected.events).not.toBe(events)
    applyApiRemotes()
  })

  it('deduplicates a cold resume while applying Host options and lookup callbacks', async () => {
    const ctx = await createContext()
    const sessionId = sid('configured-concurrent-resume')
    const meta = header(sessionId)
    let release!: () => void
    const inspectGate = new Promise<void>((resolve) => { release = resolve })
    let published: Session | undefined
    provideSession(ctx, meta, async () => {
      await inspectGate
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return { meta, events: [] }
    })
    const setup = vi.fn(async () => (_agentCtx: Context) => {})
    const agentOptions = vi.fn(() => ({}))
    const onHandle = vi.fn()
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('missing published session')
      const agent = stubAgent(ctx.extend(), published)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    })
    const resolve = createApiRemoteAgentResolver(ctx, { setup, agentOptions, onHandle })
    const first = resolve(sessionId)
    const second = resolve(sessionId)
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toMatchObject({ agent: { id: sessionId } })
    expect(secondResult).toMatchObject({ agent: { id: sessionId } })
    expect(resume).toHaveBeenCalledOnce()
    expect(setup).toHaveBeenCalledOnce()
    expect(agentOptions).toHaveBeenCalledOnce()
    expect(onHandle).toHaveBeenCalledOnce()
    await vi.waitFor(() => {
      expect(ctx.typert.lookups.get('agent')).toBeDefined()
      expect(ctx.typert.lookups.get('session')).toBeDefined()
    })
    await expect(ctx.typert.lookups.get('agent')!.resolve(sessionId)).resolves.toMatchObject({ id: sessionId })
    await expect(ctx.typert.lookups.get('session')!.resolve(sessionId)).resolves.toMatchObject({ id: sessionId })
    await ctx.fiber.dispose()
  })

  it('returns internal failures only after live and subagent fences lose', async () => {
    const ctx = await createContext()
    const sessionId = sid('ordinary-resume-failure')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => Promise.resolve({ meta, events: [] }))
    vi.spyOn(ctx.agents, 'resume').mockRejectedValue(new Error('resume broke'))
    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)
    if (!('error' in result)) throw new Error('expected an API Remote lookup error')
    expect(result.error.code).toBe('internal')
    expect(result.error.message).toContain('resume broke')
    await ctx.fiber.dispose()
  })

  it('rejects attached, inspected, and post-setup subagent ownership before resume', async () => {
    const attachedContext = await createContext()
    const attachedId = sid('attached-subagent')
    attachedContext.sessions.create(attachedId, { meta: { cwd: '/proj', origin: 'subagent' } })
    await expect(createApiRemoteAgentResolver(attachedContext, {})(attachedId)).resolves.toMatchObject({
      error: { code: 'agent-busy' },
    })
    await attachedContext.fiber.dispose()

    const inspectedContext = await createContext()
    const inspectedId = sid('inspected-subagent')
    const inspectedMeta = { ...header(inspectedId), origin: 'subagent' } as SessionHeader
    provideSession(inspectedContext, inspectedMeta, () => Promise.resolve({ meta: inspectedMeta, events: [] }))
    await expect(createApiRemoteAgentResolver(inspectedContext, {})(inspectedId)).resolves.toMatchObject({
      error: { code: 'agent-busy' },
    })
    await inspectedContext.fiber.dispose()

    const setupContext = await createContext()
    const setupId = sid('setup-subagent')
    const setupMeta = header(setupId)
    provideSession(setupContext, setupMeta, () => Promise.resolve({ meta: setupMeta, events: [] }))
    let publishedSession: Session | undefined
    vi.spyOn(setupContext.sessions, 'get').mockImplementation(id => id === setupId ? publishedSession : undefined)
    const resume = vi.spyOn(setupContext.agents, 'resume')
    await expect(createApiRemoteAgentResolver(setupContext, {
      setup: () => {
        publishedSession = { header: { ...setupMeta, origin: 'subagent' } } as Session
        return (_agentCtx: Context) => {}
      },
    })(setupId)).resolves.toMatchObject({ error: { code: 'agent-busy' } })
    expect(resume).not.toHaveBeenCalled()
    await setupContext.fiber.dispose()
  })

  it('continues when a post-setup ordinary Session has no subagent owner', async () => {
    const ctx = await createContext()
    const sessionId = sid('setup-ordinary')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => Promise.resolve({ meta, events: [] }))
    const ordinary = { id: sessionId, header: meta } as Session
    let published = false
    vi.spyOn(ctx.sessions, 'get').mockImplementation(id => id === sessionId && published ? ordinary : undefined)
    vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent: stubAgent(ctx.extend(), ordinary),
      dispose: () => Promise.resolve(),
    })
    await expect(createApiRemoteAgentResolver(ctx, {
      setup: () => {
        published = true
        return (_agentCtx: Context) => {}
      },
    })(sessionId)).resolves.toMatchObject({ agent: { id: sessionId } })
    await ctx.fiber.dispose()
  })

  it('maps an inspected session without a cwd to session-not-found', async () => {
    const ctx = await createContext()
    const sessionId = sid('missing-after-inspect')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => Promise.resolve({
      meta: { ...meta, cwd: undefined } as unknown as SessionHeader,
      events: [],
    }))

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'session-not-found', details: { sessionId } } })
    await ctx.fiber.dispose()
  })

  it('resumes through a concurrently attached ordinary Session without optional defaults', async () => {
    const ctx = await createContext()
    const sessionId = sid('ordinary-attach-race')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return Promise.resolve({ meta, events: [] })
    })
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(ctx, published), dispose: () => Promise.resolve() }
    })

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ agent: { id: sessionId } })
    expect(resume).toHaveBeenCalledWith({ resumeSessionId: sessionId })
    await ctx.fiber.dispose()
  })

  it('rejects a subagent Session published after durable inspection', async () => {
    const ctx = await createContext()
    const sessionId = sid('owned-attach-race')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => {
      ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
      return Promise.resolve({ meta, events: [] })
    })
    const resume = vi.spyOn(ctx.agents, 'resume')

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'agent-busy' } })
    expect(resume).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reclassifies failed resumes after a live or attached subagent wins publication', async () => {
    for (const winner of ['agent', 'session'] as const) {
      const ctx = await createContext()
      const sessionId = sid(`owned-${winner}-resume-race`)
      const meta = header(sessionId)
      provideSession(ctx, meta, () => Promise.resolve({ meta, events: [] }))
      vi.spyOn(ctx.agents, 'resume').mockImplementationOnce(async () => {
        const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
        if (winner === 'agent') ctx.agents.register(stubAgent(ctx, session))
        throw new Error('session id already published')
      })

      const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

      expect(result).toMatchObject({ error: { code: 'agent-busy' } })
      await ctx.fiber.dispose()
    }
  })

  it('uses the shared cold-resume policy for the Agent Host Context', async () => {
    const ctx = await createContext()
    const sessionId = sid('context-cold-resume')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return Promise.resolve({ meta, events: [] })
    })
    const agentCtx = ctx.extend()
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(agentCtx, published), dispose: () => Promise.resolve() }
    })
    const defaultProvider = ctx.typert.contexts.getHost('agent')
    createApiRemoteAgentResolver(ctx, {})
    await vi.waitFor(() => { expect(ctx.typert.contexts.getHost('agent')).not.toBe(defaultProvider) })
    const provider = ctx.typert.contexts.getHost('agent')
    if (provider === undefined) throw new Error('Agent Host Context provider was not mounted')

    await expect(provider.resolve(sessionId)).resolves.toBe(agentCtx)
    await ctx.fiber.dispose()
  })

  it('applies the subagent ownership fence to the Agent Host Context', async () => {
    const ctx = await createContext()
    const sessionId = sid('context-owned-subagent')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
    ctx.agents.register(stubAgent(ctx.extend(), session))
    const defaultProvider = ctx.typert.contexts.getHost('agent')
    createApiRemoteAgentResolver(ctx, {})
    await vi.waitFor(() => { expect(ctx.typert.contexts.getHost('agent')).not.toBe(defaultProvider) })
    const provider = ctx.typert.contexts.getHost('agent')
    if (provider === undefined) throw new Error('Agent Host Context provider was not mounted')

    const resolution = provider.resolve(sessionId)
    await expect(resolution).rejects.toBeInstanceOf(TypertLookupFailure)
    await expect(resolution).rejects.toMatchObject({ failure: { code: 'agent-busy' } })
    await ctx.fiber.dispose()
  })
})
