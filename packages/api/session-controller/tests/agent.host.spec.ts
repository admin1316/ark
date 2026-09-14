import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionNotFound,
  ApiSessionPresetConflict,
  ApiSessionSubagentOwnership,
  inspectApiSession,
} from '../src/agent.ts'
import { installModelSelectionProjection } from '@deepseek-ai/dsh-agent-default-model/session-selection'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<{ ctx: Context; agents: ApiSessionAgentController }> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.sessionProjections.register(agentPresetProjectionDefinition)
  installModelSelectionProjection(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  return { ctx, agents: new ApiSessionAgentController(ctx) }
}

function header(id: string, cwd: string | null = '/workspace'): SessionHeader {
  return {
    version: 0,
    id: SessionId(id),
    createdAt: 1,
    ...(cwd === null ? {} : { cwd }),
  }
}

function providePersistence(ctx: Context, persistence: Record<string, unknown>): () => void {
  return ctx.provide('sessionPersistence', testSessionPersistence(ctx, persistence) as never)
}

function agent(ctx: Context, meta: SessionHeader): Agent {
  const session = ctx.sessions.create(meta.id, { meta })
  return { id: meta.id, session, status: 'idle', ctx } as Agent
}

function unpublishedAgent(ctx: Context, meta: SessionHeader): Agent {
  return {
    id: meta.id,
    session: { id: meta.id, header: meta, events: [] },
    status: 'idle',
    ctx,
  } as unknown as Agent
}

describe('ApiSession identity failures', () => {
  it('describes cwd conflicts with and without a recorded cwd', () => {
    expect(new ApiSessionCwdConflict(SessionId('missing-cwd'), '/wanted', undefined).message)
      .toContain('records no cwd')
    expect(new ApiSessionCwdConflict(SessionId('wrong-cwd'), '/wanted', '/existing').message)
      .toContain('belongs to "/existing"')
  })

  it('describes preset conflicts with and without a recorded preset', () => {
    const unrecorded = new ApiSessionPresetConflict(SessionId('unrecorded-preset'), 'standard', undefined)
    expect(unrecorded.message).toContain(
      'session "unrecorded-preset" records no agent preset and cannot be adopted under "standard"',
    )
    expect(unrecorded.sessionId).toBe(SessionId('unrecorded-preset'))
    expect(unrecorded.requestedPreset).toBe('standard')
    expect(unrecorded.existingPreset).toBeUndefined()

    const mismatched = new ApiSessionPresetConflict(SessionId('mismatched-preset'), 'standard', 'minimal')
    expect(mismatched.message).toContain(
      'session "mismatched-preset" runs agent preset "minimal", not "standard"',
    )
    expect(mismatched.existingPreset).toBe('minimal')
  })

  it('maps absent and cwd-less point observations to not found', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    await expect(inspectApiSession(ctx, SessionId('missing')))
      .rejects.toBeInstanceOf(ApiSessionNotFound)

    const inspect = vi.fn(() => Promise.resolve(undefined))
    const disposeMissing = providePersistence(ctx, {
      list: () => Promise.resolve([]),
      inspect,
    })
    await expect(inspectApiSession(ctx, SessionId('missing'))).rejects.toBeInstanceOf(ApiSessionNotFound)
    expect(inspect).toHaveBeenCalledOnce()
    disposeMissing()

    const listed = header('cwd-less-catalog', null)
    const disposeListed = providePersistence(ctx, {
      list: () => Promise.resolve([listed]),
      inspect: () => Promise.resolve({ meta: listed, events: [] }),
    })
    await expect(inspectApiSession(ctx, listed.id)).rejects.toBeInstanceOf(ApiSessionNotFound)
    disposeListed()

    const catalog = header('cwd-less-inspect')
    const inspected = header('cwd-less-inspect', null)
    providePersistence(ctx, {
      list: () => Promise.resolve([catalog]),
      inspect: () => Promise.resolve({ meta: inspected, events: [] }),
    })
    await expect(inspectApiSession(ctx, catalog.id)).rejects.toBeInstanceOf(ApiSessionNotFound)
  })

  it('forwards an explicit inspection signal', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    const meta = header('signalled-inspection')
    const inspect = vi.fn(() => Promise.resolve({ meta, events: [] }))
    providePersistence(ctx, { inspect })
    const signal = new AbortController().signal

    await expect(inspectApiSession(ctx, meta.id, signal)).resolves.toEqual({ meta, events: [] })
    expect(inspect).toHaveBeenCalledWith(meta.id, signal)
  })
})

describe('ApiSession Agent lookup and recovery', () => {
  it('resumes directly from a retained observation and rejects an invalid observed header', async () => {
    const { ctx, agents } = await harness()
    const meta = header('observed-resume')
    const resumed = unpublishedAgent(ctx, meta)
    const resume = vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent: resumed,
      dispose: () => Promise.resolve(),
    })
    const observed = {
      source: 'prepared',
      header: meta,
      events: [],
      cursor: -1,
      projections: { asOfSeq: -1, values: {} },
      retain: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    } as unknown as SessionObservation

    await expect(agents.resolveObservedAgent(observed)).resolves.toEqual({ agent: resumed })
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: meta.id }))

    const invalid = {
      ...observed,
      header: header('observed-without-cwd', null),
    } as SessionObservation
    await expect(agents.resolveObservedAgent(invalid)).resolves.toMatchObject({
      error: { code: 'session-not-found' },
    })
  })

  it('projects live Agent contexts and maps missing cold identities through Typert lookup failures', async () => {
    const { ctx } = await harness()
    const live = agent(ctx, header('live'))
    ctx.agents.register(live)
    providePersistence(ctx, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    })
    const host = ctx.typert.contexts.getHost('agent')
    if (host === undefined) throw new Error('Agent Context resolver was not registered')

    await expect(host.resolve(live.id)).resolves.toBe(live.ctx)
    await expect(host.resolve(SessionId('missing'))).rejects.toBeInstanceOf(TypertLookupFailure)
  })

  it('returns raced ordinary Agents and ownership failures after resume throws', async () => {
    const ordinary = await harness()
    const ordinaryMeta = header('ordinary-race')
    providePersistence(ordinary.ctx, {
      list: () => Promise.resolve([ordinaryMeta]),
      inspect: () => Promise.resolve({ meta: ordinaryMeta, events: [] }),
    })
    const winner = agent(ordinary.ctx, ordinaryMeta)
    vi.spyOn(ordinary.ctx.agents, 'resume').mockImplementation(async () => {
      ordinary.ctx.agents.register(winner)
      throw new Error('raced publication')
    })
    await expect(ordinary.agents.resolveAgent(ordinaryMeta.id)).resolves.toEqual({ agent: winner })

    const child = await harness()
    const childMeta = header('child-race')
    providePersistence(child.ctx, {
      list: () => Promise.resolve([childMeta]),
      inspect: () => Promise.resolve({ meta: childMeta, events: [] }),
    })
    vi.spyOn(child.ctx.agents, 'resume').mockImplementation(async () => {
      child.ctx.sessions.create(childMeta.id, {
        meta: { ...childMeta, parentSession: SessionId('parent'), origin: 'subagent' },
      })
      throw new Error('raced child publication')
    })
    await expect(child.agents.resolveAgent(childMeta.id)).resolves.toMatchObject({
      error: { code: 'agent-busy' },
    })
  })

  it('reports not-found and ordinary resume failures without fabricating an Agent', async () => {
    const missing = await harness()
    providePersistence(missing.ctx, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    })
    await expect(missing.agents.resolveAgent(SessionId('missing'))).resolves.toMatchObject({
      error: { code: 'session-not-found' },
    })

    const failed = await harness()
    const meta = header('failed')
    providePersistence(failed.ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
    })
    vi.spyOn(failed.ctx.agents, 'resume').mockRejectedValue(new Error('factory unavailable'))
    await expect(failed.agents.resolveAgent(meta.id)).resolves.toMatchObject({
      error: { code: 'internal', message: expect.stringContaining('factory unavailable') as string },
    })
  })

  it('fences an identity already attached to subagent routing before resuming', async () => {
    const { ctx, agents } = await harness()
    const meta = { ...header('attached-subagent-lookup'), origin: 'subagent' as const }
    ctx.sessions.create(meta.id, { meta })
    const resume = vi.spyOn(ctx.agents, 'resume')

    await expect(agents.resolveAgent(meta.id)).resolves.toMatchObject({ error: { code: 'agent-busy' } })
    expect(resume).not.toHaveBeenCalled()
  })

  it('requires projected observations before activation', async () => {
    const { agents } = await harness()
    const meta = header('unprojected-observation')
    const observed = {
      source: 'prepared',
      header: meta,
      events: [],
      cursor: -1,
      retain: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    } as unknown as SessionObservation

    expect(() => agents.presetForObservation(observed)).toThrow(
      'Agent activation requires a projected Session observation',
    )
  })
})

describe('ApiSession model selection', () => {
  it('requires the model-selection projection', async () => {
    const { ctx, agents } = await harness()
    const live = agent(ctx, header('missing-model-projection'))
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)

    expect(() => agents.selectionFor(live)).toThrow('required modelSelection projection')
  })

  it('reads a reasoning-free request and consumes only the exact pending selection', async () => {
    const { ctx, agents } = await harness()
    const logged = agent(ctx, header('logged-model'))
    logged.session.append('request/header', {
      header: { config: { provider: 'logged-provider', model: 'logged-model' } },
      reason: 'initial',
    })
    expect(agents.selectionFor(logged).current).toEqual({
      provider: 'logged-provider',
      model: 'logged-model',
    })

    const pending = agent(ctx, header('pending-model'))
    const selection = agents.selectionFor(pending)
    pending.session.append('model/selection', {
      provider: 'selected-provider',
      model: 'selected-model',
      reasoningEffort: 'high',
    })
    expect(selection.current).toMatchObject({
      provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'high',
    })
    for (const [provider, model, reasoningEffort] of [
      ['other-provider', 'selected-model', 'high'],
      ['selected-provider', 'other-model', 'high'],
      ['selected-provider', 'selected-model', 'low'],
    ] as const) {
      pending.session.append('request/header', {
        header: { config: { provider, model, reasoningEffort: reasoningEffort as never } }, reason: 'initial',
      })
      expect(selection.current).toMatchObject({ provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'high' })
    }
    pending.session.append('request/header', {
      header: { config: { provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'high' as never },
        adapterDefaults: { reasoningEffort: true } }, reason: 'initial',
    })
    expect(ctx.sessionProjections.stateOf(pending.session, 'modelSelection')?.pending).toBeNull()
    expect(selection.current).toEqual({ provider: 'selected-provider', model: 'selected-model' })

  })

  it('installs the shared selection and mounts the resolved preset during composition', async () => {
    const { ctx, agents } = await harness()
    await ctx.plugin(SystemPrompt, { persona: '' })
    const mount = vi.fn(() => Promise.resolve())
    ctx.provide('agentPresets', {
      resolve: (id?: string) => Promise.resolve({ id: id ?? 'standard' }),
      mount,
    } as never)

    const composition = await agents.composeAgent('review')
    expect(composition.agentPreset).toBe('review')

    // The factory hands setup the Agent's exact scope, carrying the agent association.
    const session = ctx.sessions.create(SessionId('composed-setup'))
    const holder = { id: session.id, session, status: 'idle', ctx }
    const agentCtx = ctx.extend({ agent: holder })
    holder.ctx = agentCtx
    const scoped = holder as Agent

    await composition.setup(agentCtx)
    expect(mount).toHaveBeenCalledWith(agentCtx, 'review')

    // What setup installed is what prompt assembly and request routing read.
    expect((await ctx.systemPrompt.assemble()).variables)
      .toMatchObject({ provider: 'fixture', model: 'fixture-model' })
    const signal = new AbortController().signal
    await expect(agentEvents(ctx, scoped).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve({ provider: 'seed', model: 'seed' }),
    )).resolves.toMatchObject({ provider: 'fixture', model: 'fixture-model' })
  })

  it('serializes image admission per Agent and survives a rejected operation', async () => {
    const { ctx, agents } = await harness()
    const first = agent(ctx, header('admission-first'))
    const second = agent(ctx, header('admission-second'))
    const order: string[] = []
    const releaseFirst = Promise.withResolvers<undefined>()

    const admitted = agents.serializeImageAdmission(first, async () => {
      order.push('first:start')
      await releaseFirst.promise
      order.push('first:end')
      return 'first'
    })
    const queued = agents.serializeImageAdmission(first, async () => {
      order.push('queued')
      return 'queued'
    })
    const independent = agents.serializeImageAdmission(second, async () => {
      order.push('independent')
      return 'independent'
    })

    // A second Agent is never blocked by the first Agent's in-flight admission.
    await expect(independent).resolves.toBe('independent')
    expect(order).toEqual(['first:start', 'independent'])

    releaseFirst.resolve(undefined)
    await expect(admitted).resolves.toBe('first')
    await expect(queued).resolves.toBe('queued')
    expect(order).toEqual(['first:start', 'independent', 'first:end', 'queued'])

    // A rejected admission releases the chain instead of poisoning it.
    const failure = new Error('admission rejected')
    await expect(agents.serializeImageAdmission(first, () => Promise.reject(failure))).rejects.toBe(failure)
    await expect(agents.serializeImageAdmission(first, () => Promise.resolve('after-failure')))
      .resolves.toBe('after-failure')
  })
})

describe('ApiSession create or adoption', () => {
  it('shares one in-flight creation between concurrent callers', async () => {
    const { ctx, agents } = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-concurrent-'))
    const meta = header('concurrent-create', cwd)
    const created = unpublishedAgent(ctx, meta)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const create = vi.spyOn(ctx.agents, 'create').mockImplementation(async () => {
      await gate
      return { agent: created, dispose: () => Promise.resolve() }
    })

    const first = agents.ensureSession(meta.id, cwd, false)
    const second = agents.ensureSession(meta.id, cwd, false)
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([created, created])
    expect(create).toHaveBeenCalledOnce()
  })

  it('accepts a raced ordinary creation and rejects a raced attached child', async () => {
    const ordinary = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-create-'))
    const ordinaryMeta = header('create-race', cwd)
    const winner = agent(ordinary.ctx, ordinaryMeta)
    vi.spyOn(ordinary.ctx.agents, 'create').mockImplementation(async () => {
      ordinary.ctx.agents.register(winner)
      throw new Error('raced creation')
    })
    await expect(ordinary.agents.ensureSession(ordinaryMeta.id, cwd, false))
      .resolves.toBe(winner)

    const child = await harness()
    const childCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-child-'))
    const childId = SessionId('create-child-race')
    vi.spyOn(child.ctx.agents, 'create').mockImplementation(async () => {
      child.ctx.sessions.create(childId, {
        meta: { cwd: childCwd, parentSession: SessionId('parent'), origin: 'subagent' },
      })
      throw new Error('raced child creation')
    })
    await expect(child.agents.ensureSession(childId, childCwd, false))
      .rejects.toBeInstanceOf(ApiSessionSubagentOwnership)
  })

  it('validates ownership and cwd on the Agent returned by creation', async () => {
    const child = await harness()
    const childCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-returned-child-'))
    const childMeta = {
      ...header('returned-child', childCwd),
      parentSession: SessionId('parent'),
      origin: 'subagent' as const,
    }
    const childAgent = unpublishedAgent(child.ctx, childMeta)
    vi.spyOn(child.ctx.agents, 'create').mockResolvedValue({
      agent: childAgent,
      dispose: () => Promise.resolve(),
    })
    await expect(child.agents.ensureSession(childMeta.id, childCwd, false))
      .rejects.toBeInstanceOf(ApiSessionSubagentOwnership)

    const wrong = await harness()
    const requestedCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-wrong-cwd-'))
    const wrongAgent = unpublishedAgent(wrong.ctx, header('wrong-returned-cwd', '/other'))
    vi.spyOn(wrong.ctx.agents, 'create').mockResolvedValue({
      agent: wrongAgent,
      dispose: () => Promise.resolve(),
    })
    await expect(wrong.agents.ensureSession(wrongAgent.id, requestedCwd, false))
      .rejects.toBeInstanceOf(ApiSessionCwdConflict)
  })

  it('resumes a matching persisted identity and preserves its selected preset', async () => {
    const { ctx, agents } = await harness()
    const meta = { ...header('stored'), agentPreset: 'minimal' }
    const events = [{
      type: 'agent-preset/selected',
      seq: 0,
      time: 1,
      data: { agentPreset: 'minimal' },
    }] as SessionEvent[]
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events }),
    })
    ctx.provide('agentPresets', {
      resolve: (id?: string) => Promise.resolve({ id: id ?? 'minimal' }),
      mount: () => Promise.resolve(),
    } as never)
    const resumed = {
      id: meta.id,
      session: { id: meta.id, header: meta, events },
      status: 'idle',
      ctx,
    } as unknown as Agent
    const resume = vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent: resumed,
      dispose: () => Promise.resolve(),
    })

    await expect(agents.ensureSession(meta.id, '/workspace', true, 'minimal')).resolves.toBe(resumed)
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: meta.id }))
  })

  it('rejects an ownership race before resume and a persisted cwd conflict', async () => {
    const child = await harness()
    const childMeta = header('resume-child-race')
    providePersistence(child.ctx, {
      list: () => Promise.resolve([childMeta]),
      inspect: () => Promise.resolve({ meta: childMeta, events: [] }),
    })
    child.ctx.provide('agentPresets', {
      resolve: () => {
        child.ctx.sessions.create(childMeta.id, {
          meta: { ...childMeta, parentSession: SessionId('parent'), origin: 'subagent' },
        })
        return Promise.resolve({ id: 'standard' })
      },
      mount: () => Promise.resolve(),
    } as never)
    await expect(child.agents.resolveAgent(childMeta.id)).resolves.toMatchObject({
      error: { code: 'agent-busy' },
    })

    const conflict = await harness()
    const stored = header('stored-cwd-conflict', '/stored')
    providePersistence(conflict.ctx, {
      list: () => Promise.resolve([stored]),
      inspect: () => Promise.resolve({ meta: stored, events: [] }),
    })
    await expect(conflict.agents.ensureSession(stored.id, '/requested', true))
      .rejects.toBeInstanceOf(ApiSessionCwdConflict)
  })

  it('surfaces directory creation failure and rejects setup without a scoped Agent', async () => {
    const { agents } = await harness()
    const parent = mkdtempSync(join(tmpdir(), 'dsh-session-controller-file-'))
    const file = join(parent, 'file')
    writeFileSync(file, 'not a directory')
    await expect(agents.ensureSession(SessionId('mkdir-failure'), join(file, 'child'), false))
      .rejects.toThrow('failed to ensure project directory')

    const composition = await agents.composeAgent(undefined)
    expect(() => composition.setup(new Context())).toThrow('Agent setup has no scoped Agent')
  })

  it('reuses a live Agent for an attached identity without factory work', async () => {
    const { ctx, agents } = await harness()
    const meta = header('live-reuse')
    const live = agent(ctx, meta)
    ctx.agents.register(live)
    const create = vi.spyOn(ctx.agents, 'create')
    const resume = vi.spyOn(ctx.agents, 'resume')

    await expect(agents.ensureSession(meta.id, '/workspace', false)).resolves.toBe(live)
    expect(create).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('rejects a creation that raced a live subagent Agent with the ownership fence', async () => {
    const { ctx, agents } = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-raced-child-'))
    const childMeta = { ...header('raced-live-child', cwd), origin: 'subagent' as const }
    vi.spyOn(ctx.agents, 'create').mockImplementation(async () => {
      const session = ctx.sessions.create(childMeta.id, { meta: childMeta })
      ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
      throw new Error('raced live child creation')
    })

    // The factory failed, but the identity already belongs to subagent routing:
    // the caller must see the stable ownership fence, never the raw error.
    await expect(agents.ensureSession(childMeta.id, cwd, false))
      .rejects.toBeInstanceOf(ApiSessionSubagentOwnership)
  })

  it('refuses to create over an identity already attached to subagent routing', async () => {
    const { ctx, agents } = await harness()
    const childMeta = { ...header('attached-child-create'), origin: 'subagent' as const }
    ctx.sessions.create(childMeta.id, { meta: childMeta })
    const create = vi.spyOn(ctx.agents, 'create')
    const resume = vi.spyOn(ctx.agents, 'resume')

    await expect(agents.ensureSession(childMeta.id, '/workspace', false))
      .rejects.toBeInstanceOf(ApiSessionSubagentOwnership)
    expect(create).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('refuses to adopt a persisted subagent identity during creation', async () => {
    const { ctx, agents } = await harness()
    const childMeta = { ...header('stored-child-create'), origin: 'subagent' as const }
    providePersistence(ctx, {
      list: () => Promise.resolve([childMeta]),
      inspect: () => Promise.resolve({ meta: childMeta, events: [] }),
    })
    const create = vi.spyOn(ctx.agents, 'create')

    await expect(agents.ensureSession(childMeta.id, '/workspace', true))
      .rejects.toBeInstanceOf(ApiSessionSubagentOwnership)
    expect(create).not.toHaveBeenCalled()
  })

  it('creates a fresh Session when no identity is persisted and records the resolved preset', async () => {
    const { ctx, agents } = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-fresh-'))
    const freshId = SessionId('fresh-create')
    ctx.provide('agentPresets', {
      resolve: (id?: string) => Promise.resolve({ id: id ?? 'standard' }),
      mount: () => Promise.resolve(),
    } as never)
    providePersistence(ctx, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    })
    vi.spyOn(ctx.agents, 'create').mockImplementation(async (options: CreateAgentOptions) => {
      const session = ctx.sessions.create(options.sessionId, options.meta === undefined ? {} : { meta: options.meta })
      return { agent: { id: session.id, session, status: 'idle', ctx } as Agent, dispose: () => Promise.resolve() }
    })

    const created = await agents.ensureSession(freshId, cwd, true, 'review')
    expect(created.id).toBe(freshId)
    expect(ctx.sessions.get(freshId)?.header).toMatchObject({ cwd, agentPreset: 'review' })
  })

  it('refuses to adopt a live preset-less Session under a requested preset', async () => {
    const { ctx, agents } = await harness()
    const meta = header('preset-less-live')
    const live = agent(ctx, meta)
    ctx.agents.register(live)
    const create = vi.spyOn(ctx.agents, 'create')
    const resume = vi.spyOn(ctx.agents, 'resume')

    const failure = agents.ensureSession(meta.id, '/workspace', false, 'standard')
    const error = await failure.then(() => undefined, (caught: unknown) => caught)
    if (!(error instanceof ApiSessionPresetConflict)) {
      throw new Error(`expected ApiSessionPresetConflict, got ${String(error)}`)
    }
    expect(error.sessionId).toBe(meta.id)
    expect(error.requestedPreset).toBe('standard')
    // A projection state of null means "no recorded preset", reported as undefined.
    expect(error.existingPreset).toBeUndefined()
    expect(error.message).toContain('records no agent preset')
    expect(create).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })
})
