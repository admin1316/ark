import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentHandle,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { UnknownPresetError, PresetMountError } from '@deepseek-ai/dsh-agent-presets'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ReasoningEffortId,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  SessionPromptInvocationId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { SessionPersistenceNotFoundError, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { SessionObservationReader } from '../../../session-query/session-query/src/observation.ts'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { installModelSelectionProjection } from '@deepseek-ai/dsh-agent-default-model/session-selection'
import SessionRemoteOperationsService from '../src/index.ts'

const contexts: Context[] = []
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

function header(id: string, cwd: string, overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: 0,
    id: SessionId(id),
    createdAt: 10,
    cwd,
    ...overrides,
  }
}

function emptySession(id: string, cwd: string, overrides: Partial<SessionHeader> = {}): Session {
  return Session.create(SessionId(id), undefined, header(id, cwd, overrides))
}

interface TestAgent {
  readonly id: SessionId
  readonly session: Session
  readonly ctx: Context
  readonly options: { provider: string; model: string }
  status: 'idle' | 'running'
  readonly inbox: {
    readonly nextTurn: UserMessage[]
    readonly nextStep: UserMessage[]
    readonly hasPending: boolean
    replace(id: string, message: UserMessage): boolean
    remove(id: string): UserMessage | undefined
  }
  readonly cancel: ReturnType<typeof vi.fn>
  readonly steer: ReturnType<typeof vi.fn>
  readonly followup: ReturnType<typeof vi.fn>
  readonly send: ReturnType<typeof vi.fn>
  runMaintenance<Value>(operation: (signal: AbortSignal) => Promise<Value>): Promise<Value>
  whenIdle(): Promise<void>
}

function fakeAgent(session: Session, options: {
  status?: 'idle' | 'running'
  nextTurn?: UserMessage[]
  nextStep?: UserMessage[]
} = {}): TestAgent {
  const nextTurn = options.nextTurn ?? []
  const nextStep = options.nextStep ?? []
  const ctx = new Context()
  const agent: TestAgent = {
    id: session.id,
    session,
    ctx,
    options: { provider: 'provider', model: 'model' },
    status: options.status ?? 'idle',
    inbox: {
      nextTurn,
      nextStep,
      get hasPending() { return nextTurn.length > 0 || nextStep.length > 0 },
      replace(id, message) {
        const turn = nextTurn.findIndex(candidate => candidate.id === id)
        if (turn >= 0) {
          nextTurn[turn] = message
          return true
        }
        const step = nextStep.findIndex(candidate => candidate.id === id)
        if (step < 0) return false
        nextStep[step] = message
        return true
      },
      remove(id) {
        const turn = nextTurn.findIndex(candidate => candidate.id === id)
        if (turn >= 0) return nextTurn.splice(turn, 1)[0]
        const step = nextStep.findIndex(candidate => candidate.id === id)
        return step < 0 ? undefined : nextStep.splice(step, 1)[0]
      },
    },
    cancel: vi.fn(),
    steer: vi.fn((message: UserMessage) => {
      session.append('agent/inbox/spliced', { target: 'next-step', start: nextStep.length, inserted: [message] })
      nextStep.push(message)
    }),
    followup: vi.fn((message: UserMessage) => {
      session.append('agent/inbox/spliced', { target: 'next-turn', start: nextTurn.length, inserted: [message] })
      nextTurn.push(message)
    }),
    send: vi.fn(),
    runMaintenance: operation => operation(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  Object.defineProperty(ctx, 'agent', { configurable: true, value: agent })
  return agent
}

interface ProjectionRegistration {
  readonly key: string
  init(header?: SessionHeader): unknown
  apply(state: unknown, event: SessionEvent): unknown
  readonly wire: { view(state: unknown): unknown }
}

interface CoverageHarness {
  readonly ctx: Context
  readonly service: SessionRemoteOperationsService
  readonly cwd: string
  readonly sessions: Map<string, Session>
  readonly agents: Map<string, TestAgent>
  readonly roots: TestAgent[]
  readonly workspaces: Map<string, Workspace>
  readonly persistenceHeaders: SessionHeader[]
  readonly persistenceEvents: Map<string, SessionEvent[]>
  readonly projectionRegistrations: Map<string, ProjectionRegistration>
  readonly create: Mock<(input: CreateAgentOptions) => Promise<AgentHandle>>
  readonly resume: Mock<(input: ResumeAgentOptions) => Promise<AgentHandle>>
  readonly flush: Mock<() => Promise<boolean>>
  readonly assertAdmission: Mock<() => void>
  readonly searchSessions: Mock<(...args: unknown[]) => Promise<{ items: unknown[]; nextCursor?: string }>>
  readonly traceSession: Mock<(...args: unknown[]) => Promise<unknown>>
  readonly persistenceList: Mock<() => Promise<SessionHeader[]>>
  readonly persistenceInspect: Mock<(id: SessionId) => Promise<{ meta: SessionHeader; events: SessionEvent[] }>>
  readonly projectionSnapshot: Mock<(...args: unknown[]) => unknown>
  readonly projectionRestore: Mock<(...args: unknown[]) => unknown>
  readonly projectionCache: Mock<(...args: unknown[]) => unknown>
  readonly listModels: Mock<(provider: string) => Promise<Array<{ id: string; name: string; description?: string }>>>
  readonly listProviders: Mock<() => Array<{ id: string; name: string }>>
  readonly resolveModelInfo: Mock<(...args: unknown[]) => Promise<unknown>>
  readonly resolveCallConfig: Mock<(...args: unknown[]) => Promise<unknown>>
  readonly saveSelection: Mock<(...args: unknown[]) => Promise<void>>
  readonly saveImages: Mock<(...args: unknown[]) => Promise<unknown[]>>
  readonly readImage: Mock<(...args: unknown[]) => Promise<unknown>>
  readonly commandExecute: Mock<(...args: unknown[]) => Promise<unknown>>
  readonly titleRename: Mock<(session: Session, title: string) => { title: string; eventSeq: number }>
  readonly presetResolve: Mock<(id: string | undefined) => Promise<{ id: string }>>
  readonly presetMount: Mock<(...args: unknown[]) => Promise<void>>
  readonly standingKeyFor: Mock<(...args: unknown[]) => Promise<unknown>>
  readonly jobsList: Mock<(...args: unknown[]) => unknown[]>
  readonly toolGet: Mock<(...args: unknown[]) => unknown>
  readonly download: {
    path?: string
    handler?: (request: Request, signal: AbortSignal) => Promise<Response>
    authority?: string
  }
  archivedSessionIds: SessionId[]
  providers: Array<{ id: string; name: string }>
  models: Record<string, Array<{ id: string; name: string; description?: string }>>
  createError?: unknown
  resumeError?: unknown
  flushError?: unknown
  saveSelectionError?: unknown
  attachmentError?: unknown
  disposeError?: unknown
  admissionError?: unknown
  ownedBySubagent: boolean
}

interface HarnessOptions {
  readonly omit?: readonly string[]
  readonly config?: { cwd?: string; coldBlankProbeMaxBytes?: number; sessionExportCompressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }
}

async function harness(options: HarnessOptions = {}): Promise<CoverageHarness> {
  const cwd = options.config?.cwd ?? await mkdtemp(join(tmpdir(), 'dsh-session-coverage-'))
  if (options.config?.cwd === undefined) temporary.push(cwd)
  const omitted = new Set(options.omit ?? [])
  const ctx = new Context()
  contexts.push(ctx)
  const sessions = new Map<string, Session>()
  const agents = new Map<string, TestAgent>()
  const roots: TestAgent[] = []
  const workspaces = new Map<string, Workspace>()
  const persistenceHeaders: SessionHeader[] = []
  const persistenceEvents = new Map<string, SessionEvent[]>()
  const projectionRegistrations = new Map<string, ProjectionRegistration>()
  const download: CoverageHarness['download'] = {}

  const state = {
    archivedSessionIds: [] as SessionId[],
    providers: [{ id: 'provider', name: 'Provider' }],
    models: { provider: [{ id: 'model', name: 'Model' }] } as CoverageHarness['models'],
    createError: undefined as unknown,
    resumeError: undefined as unknown,
    flushError: undefined as unknown,
    saveSelectionError: undefined as unknown,
    attachmentError: undefined as unknown,
    disposeError: undefined as unknown,
    admissionError: undefined as unknown,
    ownedBySubagent: false,
  }

  const assertAdmission = vi.fn<() => void>(() => {
    if (state.admissionError !== undefined) throw state.admissionError
  })
  const flush = vi.fn<() => Promise<boolean>>(async () => {
    if (state.flushError !== undefined) throw state.flushError
    return true
  })

  const publish = async (
    session: Session,
    setup: AgentSetup | undefined,
  ): Promise<AgentHandle> => {
    const agent = fakeAgent(session)
    const prepared = await setup?.(agent.ctx)
    prepared?.commit()
    sessions.set(String(session.id), session)
    agents.set(String(session.id), agent)
    roots.push(agent)
    return {
      agent: agent as unknown as Agent,
      dispose: vi.fn(async () => {
        if (state.disposeError !== undefined) throw state.disposeError
        sessions.delete(String(session.id))
        agents.delete(String(session.id))
        const index = roots.indexOf(agent)
        if (index >= 0) roots.splice(index, 1)
      }),
    }
  }

  const create = vi.fn<(input: CreateAgentOptions) => Promise<AgentHandle>>(async (input) => {
    if (state.createError !== undefined) throw state.createError
    const meta = input.meta
    const session = Session.create(input.sessionId, input.seed, header(String(input.sessionId), meta?.cwd ?? cwd, {
      ...meta?.parentSession === undefined ? {} : { parentSession: meta.parentSession },
      ...meta?.seedLength === undefined ? {} : { seedLength: meta.seedLength },
      ...meta?.origin === undefined ? {} : { origin: meta.origin },
      ...meta?.delegationDepth === undefined ? {} : { delegationDepth: meta.delegationDepth },
      ...meta?.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset },
    }))
    return publish(session, input.setup)
  })

  const resume = vi.fn<(input: ResumeAgentOptions) => Promise<AgentHandle>>(async (input) => {
    if (state.resumeError !== undefined) throw state.resumeError
    const meta = persistenceHeaders.find(candidate => candidate.id === input.resumeSessionId)
    if (meta === undefined) throw new Error(`missing persisted session ${input.resumeSessionId}`)
    const session = Session.create(
      input.resumeSessionId,
      persistenceEvents.get(String(input.resumeSessionId)) ?? [],
      meta,
    )
    return publish(session, input.setup)
  })

  const searchSessions = vi.fn<(...args: unknown[]) => Promise<{ items: unknown[]; nextCursor?: string }>>(
    async () => ({ items: [] }),
  )
  const traceSession = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (id: unknown) => {
    const sessionId = id as SessionId
    const meta = persistenceHeaders.find(candidate => candidate.id === sessionId) ?? header(String(sessionId), cwd)
    return {
      target: { header: meta, live: sessions.has(String(sessionId)), persisted: true },
      ancestors: [],
      complete: true,
      root: { header: meta, live: sessions.has(String(sessionId)), persisted: true },
      descendants: [],
    }
  })
  const listModels = vi.fn<(provider: string) => Promise<Array<{ id: string; name: string; description?: string }>>>(
    async provider => state.models[provider] ?? [],
  )
  const listProviders = vi.fn<() => Array<{ id: string; name: string }>>(() => state.providers)
  const resolveModelInfo = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    inputModalities: ['text', 'image'],
    reasoning: undefined,
  }))
  const resolveCallConfig = vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async selection => selection,
  )
  const saveSelection = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {
    if (state.saveSelectionError !== undefined) throw state.saveSelectionError
  })
  const saveImages = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async (input: unknown) => {
    const inputs = input as Array<{ mediaType: string; data: Uint8Array; name?: string }>
    if (state.attachmentError !== undefined) throw state.attachmentError
    return inputs.map((input, index) => ({
      attachmentId: `attachment-${String(index)}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    }))
  })
  const readImage = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (input: unknown) => {
    const ref = input as { attachmentId: string }
    if (state.attachmentError !== undefined) throw state.attachmentError
    return { ref, data: new Uint8Array([1, 2, 3]) }
  })
  const commandExecute = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined)
  const titleRename = vi.fn<(session: Session, title: string) => { title: string; eventSeq: number }>((session, title) => ({
    title: title.trim(),
    eventSeq: session.seq,
  }))
  const presetResolve = vi.fn<(id: string | undefined) => Promise<{ id: string }>>(
    async id => ({ id: id ?? 'standard' }),
  )
  const presetMount = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined)
  const standingKeyFor = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ kind: 'standing' }))
  const jobsList = vi.fn<(...args: unknown[]) => unknown[]>(() => [])
  const toolGet = vi.fn<(...args: unknown[]) => unknown>(() => undefined)
  const persistenceList = vi.fn<() => Promise<SessionHeader[]>>(async () => [...persistenceHeaders])
  const persistenceInspect = vi.fn<(id: SessionId) => Promise<{ meta: SessionHeader; events: SessionEvent[] }>>(
    async (id) => {
      const meta = persistenceHeaders.find(candidate => candidate.id === id)
      if (meta === undefined) throw new Error(`missing persisted session ${id}`)
      return { meta, events: persistenceEvents.get(String(id)) ?? [] }
    },
  )
  const projectionSnapshot = vi.fn<(...args: unknown[]) => unknown>(() => ({ asOfSeq: 0, values: {} }))
  const projectionRestore = vi.fn<(...args: unknown[]) => unknown>(
    () => ({ snapshot: { asOfSeq: 0, values: {} } }),
  )
  const projectionCache = vi.fn<(...args: unknown[]) => unknown>(() => ({ asOfSeq: 0, values: {} }))

  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'provider', model: 'model' }),
    saveSelection,
  } as never)
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4096,
      maxImagePixels: 1024,
      maxImageDimension: 1024,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    saveImages,
    readImage,
  } as never)
  ctx.provide('llm', {
    listProviders,
    listModels,
    resolveModelInfo,
    resolveCallConfig,
  } as never)
  ctx.provide('sessions', {
    get: (id: SessionId) => sessions.get(String(id)),
    list: () => [...sessions.values()],
    flush,
  } as never)
  ctx.provide('agents', {
    get: (id: SessionId) => agents.get(String(id)),
    list: () => [...agents.values()],
    roots: () => [...roots],
    isOwnedBy: () => state.ownedBySubagent,
    create,
    resume,
  } as never)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => workspaces.get(String(id)),
    list: () => [...workspaces.values()],
    sessionAdmissionRevision: () => 1,
    assertSessionAdmission: assertAdmission,
    get archivedSessionIds() { return state.archivedSessionIds },
  } as never)

  if (!omitted.has('sessionPersistence')) {
    ctx.provide('sessionPersistence', {
      supportsRawArtifacts: true,
      ensureMaterialized: async () => {},
      list: persistenceList,
      inspect: persistenceInspect,
      locate: (header: SessionHeader) => ({ path: join(cwd, `${header.id}.jsonl`) }),
      readRaw: async () => undefined,
    } as never)
  }
  if (!omitted.has('sessionQuery')) {
    const observations = new SessionObservationReader(ctx)
    // A sibling provider matches Loader topology; root.provide would make
    // undeclared direct reads succeed through the ancestor fiber store.
    await ctx.plugin((queryCtx: Context) => {
      queryCtx.provide('sessionQuery', {
        searchSessions, traceSession, observeSession: observations.read.bind(observations),
        listSessions: async (signal?: AbortSignal) => {
          signal?.throwIfAborted()
          const persisted = await persistenceList()
          return [...new Map([...persisted, ...[...sessions.values()].map(session => session.header)]
            .map(header => [header.id, { header }])).values()]
        },
      } as never)
    })
  }
  if (!omitted.has('sessionTitle')) ctx.provide('sessionTitle', { rename: titleRename } as never)
  if (!omitted.has('commands')) ctx.provide('commands', { execute: commandExecute } as never)
  if (!omitted.has('agentPresets')) {
    ctx.provide('agentPresets', {
      resolve: presetResolve,
      mount: presetMount,
      standingKeyFor,
    } as never)
  }
  if (!omitted.has('sessionProjections')) {
    await ctx.plugin((projectionCtx: Context) => {
      projectionCtx.provide('sessionProjections', {
        register(registration: ProjectionRegistration) {
          projectionRegistrations.set(registration.key, registration)
          return () => { projectionRegistrations.delete(registration.key) }
        },
        snapshot: projectionSnapshot,
        cachedSnapshot: projectionSnapshot,
        stateOf: (session: Session, key: string) => {
          const definition = projectionRegistrations.get(key)
          if (definition === undefined) return undefined
          let value = definition.init(session.header)
          for (const event of session.events) value = definition.apply(value, event)
          return value
        },
        restore: projectionRestore,
      } as never)
    })
  }
  if (!omitted.has('sessionProjectionCache')) {
    ctx.provide('sessionProjectionCache', { cachedSnapshot: projectionCache } as never)
  }
  if (!omitted.has('tools')) ctx.provide('tools', { get: toolGet } as never)
  if (!omitted.has('jobs')) ctx.provide('jobs', { list: jobsList } as never)
  if (!omitted.has('connection')) {
    ctx.provide('connection', {
      downloads: {
        handle(path: string, handler: (request: Request, signal: AbortSignal) => Promise<Response>, config: { authority: string }) {
          download.path = path
          download.handler = handler
          download.authority = config.authority
          return async () => {
            delete download.path
            delete download.handler
            delete download.authority
          }
        },
      },
    } as never)
  }

  if (!omitted.has('sessionProjections')) {
    await ctx.plugin(Object.assign((projectionCtx: Context) => {
      installModelSelectionProjection(projectionCtx)
    }, { inject: ['sessionProjections'] }))
  }
  await ctx.plugin(SessionRemoteOperationsService, options.config ?? {})
  const consumer: { service?: SessionRemoteOperationsService } = {}
  await ctx.plugin(Object.assign((consumerCtx: Context) => {
    consumer.service = consumerCtx.sessionRemoteOperations as SessionRemoteOperationsService
  }, { inject: ['sessionRemoteOperations'] }))
  const { service } = consumer
  if (service === undefined) throw new Error('session Remote consumer did not activate')
  return Object.assign(state, {
    ctx,
    service,
    cwd,
    sessions,
    agents,
    roots,
    workspaces,
    persistenceHeaders,
    persistenceEvents,
    projectionRegistrations,
    create,
    resume,
    flush,
    assertAdmission,
    searchSessions,
    traceSession,
    persistenceList,
    persistenceInspect,
    projectionSnapshot,
    projectionRestore,
    projectionCache,
    listModels,
    listProviders,
    resolveModelInfo,
    resolveCallConfig,
    saveSelection,
    saveImages,
    readImage,
    commandExecute,
    titleRename,
    presetResolve,
    presetMount,
    standingKeyFor,
    jobsList,
    toolGet,
    download,
  })
}

function attach(state: CoverageHarness, session: Session, options?: Parameters<typeof fakeAgent>[1]): TestAgent {
  const agent = fakeAgent(session, options)
  state.sessions.set(String(session.id), session)
  state.agents.set(String(session.id), agent)
  state.roots.push(agent)
  return agent
}

function workspace(id: string, path: string): Workspace & { attachSession: ReturnType<typeof vi.fn> } {
  const attachSession = vi.fn(async () => undefined)
  return {
    id: WorkspaceId(id),
    path,
    title: id,
    sessionIds: [],
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    setTitle: async () => {},
    attachSession,
    insertSessionBefore: async () => {},
    detachSession: async () => {},
    status: async () => 'ok',
  }
}

function cancelledSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  return controller.signal
}

describe('Session Remote construction and projection ownership', () => {
  it('rejects a relative default cwd and registers both projection owners', async () => {
    await expect(harness({ config: { cwd: 'relative' } })).rejects.toThrow(/cwd must be absolute/)

    const state = await harness()
    expect(state.download).toMatchObject({
      path: '/api/session/export',
      authority: 'loopback',
    })
    const metadata = state.projectionRegistrations.get('sessionListMetadata')
    const limits = state.projectionRegistrations.get('imageLimits')
    if (metadata === undefined || limits === undefined) throw new Error('missing projection registration')
    const initial = metadata.init()
    expect(initial).toEqual({ blank: true, lastPromptAt: null })
    const unchanged = metadata.apply(initial, {
      type: 'assistant/message',
      seq: 0,
      time: 1,
      data: { message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } } },
      surfaceOp: 'append',
    } as never)
    expect(unchanged).toBe(initial)
    const started = metadata.apply(initial, {
      type: 'turn/start',
      seq: 0,
      time: 2,
      data: { turn: 1 },
    } as never)
    expect(started).toEqual({ blank: false, lastPromptAt: null })
    const prompted = metadata.apply(started, {
      type: 'user/message',
      seq: 1,
      time: 3,
      data: {
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    } as never)
    expect(prompted).toEqual({ blank: false, lastPromptAt: 3 })
    expect(metadata.wire.view(prompted)).toBe(prompted)
    expect(limits.init()).toBeNull()
    const applyLimits = limits.apply.bind(limits)
    expect(applyLimits(null, {
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1 },
    } as never)).toBeNull()
    expect(limits.wire.view(null)).toEqual(state.ctx.attachments.imageLimits)
  })

  it('owns the loopback download registration, signal replacement, and handle cleanup', async () => {
    const state = await harness()
    const request = new Request('http://host/api/session/export?sessionId=missing')
    await expect(state.service.fetch(request)).resolves.toMatchObject({ status: 404 })
    await expect(state.service.fetch(request, new AbortController().signal)).resolves.toMatchObject({ status: 404 })
    if (state.download.handler === undefined) throw new Error('missing download handler')
    await expect(state.download.handler(request, new AbortController().signal))
      .resolves.toMatchObject({ status: 404 })

    const created = await state.service.create({
      sessionId: SessionId('cleanup-a'),
      cwd: state.cwd,
    }, new AbortController().signal)
    expect(created).toMatchObject({ ok: true })
    const agent = state.agents.get('cleanup-a')
    if (agent === undefined) throw new Error('missing created agent')
    state.ctx.emit('agent/disposed', { agent: fakeAgent(agent.session) as unknown as Agent })
    state.ctx.emit('agent/disposed', { agent: agent as unknown as Agent })

    await state.ctx.fiber.dispose()
    expect(state.download.handler).toBeUndefined()
  })
})

describe('Session Remote listing and search', () => {
  it('keeps unrelated operations mounted and fails explicitly when the optional query provider is absent', async () => {
    const state = await harness({ omit: ['sessionQuery'] })
    const session = emptySession('visible-without-query', state.cwd)
    attach(state, session)
    await expect(state.service.list({}, new AbortController().signal)).resolves.toEqual({
      ok: false, error: {
        code: 'internal',
        message: 'session listing is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
        details: {},
      },
    })
    const renamed = await state.service.rename({ sessionId: session.id, title: 'still available' }, new AbortController().signal)
    expect(renamed).toMatchObject({ ok: true })
  })

  it('reports a missing model projection explicitly through the injected consumer', async () => {
    const state = await harness({ omit: ['sessionProjections'] })
    const session = emptySession('missing-model-projection', state.cwd)
    attach(state, session)
    await expect(state.service.prompt({
      sessionId: session.id, invocationId: SessionPromptInvocationId('missing-projection'),
      mode: 'queue', content: [{ type: 'text', text: 'hello' }],
    }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'prompt-unavailable',
        details: { reason: 'Error: ordinary prompt receipt projection is unavailable' },
      } })
  })

  it('merges attached and cold cached rows without inspecting large or unknown logs', async () => {
    const state = await harness()
    const live = emptySession('live', state.cwd, {
      parentSession: SessionId('parent'),
      origin: 'subagent',
      agentPreset: 'standard',
    })
    live.append('turn/start', { turn: 1 })
    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'latest' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const liveAgent = attach(state, live, { status: 'running' })
    expect(liveAgent.status).toBe('running')

    const cold = header('cold', state.cwd, { createdAt: 20 })
    const failed = header('failed', state.cwd, { createdAt: 30 })
    const raced = header('raced', state.cwd, { createdAt: 40 })
    const { cwd: _missingCwd, ...withoutCwd } = header('no-cwd', state.cwd)
    state.persistenceHeaders.push(
      live.header,
      withoutCwd,
      cold,
      failed,
      raced,
    )
    state.projectionSnapshot.mockReturnValue({ asOfSeq: 2, values: {
      attached: true, agentPreset: 'standard', sessionListMetadata: { blank: false, lastPromptAt: 99 },
    } })
    state.projectionCache.mockImplementation(input => ({ asOfSeq: 0, values: {
      cached: true, ...(input === cold ? { sessionListMetadata: { blank: false, lastPromptAt: 80 } } : {}),
    } }))

    const result = await state.service.list({}, new AbortController().signal)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: live.id,
        running: true,
        blank: false,
        parentSessionId: SessionId('parent'),
        origin: 'subagent',
        cwd: state.cwd,
        agentPreset: 'standard',
        projections: { asOfSeq: 2, values: { attached: true, agentPreset: 'standard', sessionListMetadata: { blank: false, lastPromptAt: 99 } } },
      }),
      expect.objectContaining({
        sessionId: cold.id,
        blank: false,
        updatedAt: 80,
        projections: { asOfSeq: 0, values: { cached: true, sessionListMetadata: { blank: false, lastPromptAt: 80 } } },
      }),
      expect.objectContaining({
        sessionId: failed.id,
        blank: false,
        projections: { asOfSeq: 0, values: { cached: true } },
      }),
      expect.objectContaining({ sessionId: raced.id }),
    ]))
    expect(state.persistenceInspect).not.toHaveBeenCalled()
    expect(state.resume).not.toHaveBeenCalled()
    expect(result.value.items.map(item => item.updatedAt))
      .toEqual([...result.value.items.map(item => item.updatedAt)].sort((a, b) => b - a))

    await expect(state.service.list({}, cancelledSignal())).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    state.persistenceList.mockRejectedValueOnce('list failed')
    await expect(state.service.list({}, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
  })

  it('probes only physically small unknown cold files and releases each observation', async () => {
    const state = await harness({ config: { coldBlankProbeMaxBytes: 8 } })
    const rows = ['small', 'large', 'known', 'missing', 'failed'].map(id => header(id, state.cwd))
    state.persistenceHeaders.push(...rows)
    for (const row of rows.filter(row => row.id !== 'missing')) {
      await writeFile(join(state.cwd, `${row.id}.jsonl`), row.id === 'large' ? 'x'.repeat(9) : 'x'.repeat(8))
    }
    state.projectionCache.mockImplementation(input => input === rows[2]
      ? { asOfSeq: 10, values: { sessionListMetadata: { blank: false, lastPromptAt: 123 }, agentPreset: 'changed' } }
      : undefined)
    const released = vi.fn()
    const observe = vi.spyOn(state.ctx.sessionQuery, 'observeSession').mockImplementation(async (id) => {
      if (id === 'failed') throw new Error('bad artifact')
      const row = rows.find(row => row.id === id)
      if (row === undefined) throw new Error('unexpected probe')
      const observation: SessionObservation = {
        source: 'prepared', header: row, events: [], cursor: -1,
        projections: { asOfSeq: -1, values: { sessionListMetadata: { blank: true, lastPromptAt: null } } },
        retain: () => observation, [Symbol.dispose]: released,
      }
      return observation
    })
    const result = await state.service.list({}, new AbortController().signal)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'small', blank: true }),
      expect.objectContaining({ sessionId: 'large', blank: false }),
      expect.objectContaining({ sessionId: 'missing', blank: false }),
      expect.objectContaining({ sessionId: 'failed', blank: false }),
      expect.objectContaining({ sessionId: 'known', blank: false, updatedAt: 123, agentPreset: 'changed' }),
    ]))
    expect(observe.mock.calls.map(call => call[0]).sort()).toEqual(['failed', 'small'])
    expect(released).toHaveBeenCalledOnce()
    expect(state.persistenceInspect).not.toHaveBeenCalled()
    expect(state.resume).not.toHaveBeenCalled()
    observe.mockClear()
    await state.service.search({ query: 'anything' }, new AbortController().signal)
    expect(observe).not.toHaveBeenCalled()
  })

  it('can disable cold probing and rejects blank queue edits without changing the pending message', async () => {
    const state = await harness({ config: { coldBlankProbeMaxBytes: 0 } })
    const row = header('disabled-probe', state.cwd)
    state.persistenceHeaders.push(row)
    await writeFile(join(state.cwd, `${row.id}.jsonl`), '')
    const observe = vi.spyOn(state.ctx.sessionQuery, 'observeSession')
    await expect(state.service.list({}, new AbortController().signal)).resolves.toMatchObject({ ok: true })
    expect(observe).not.toHaveBeenCalled()
    const session = emptySession('blank-edit', state.cwd)
    const queued = createUserMessage({ content: [{ type: 'text', text: 'keep me' }], source: { kind: 'user' } })
    const agent = attach(state, session, { nextTurn: [queued] })
    for (const content of [[], [{ type: 'text', text: ' \n\t' }]]) {
      await expect(state.service.updateQueue({ sessionId: session.id, itemId: String(queued.id),
        action: { kind: 'edit', content } }, new AbortController().signal))
        .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } })
      expect(agent.inbox.nextTurn).toEqual([queued])
    }
  })

  it('validates queries, retries provider limits, restarts stale cursors, and filters malformed hits', async () => {
    const state = await harness()
    const visible = emptySession('visible', state.cwd)
    attach(state, visible)
    const hiddenHeader = header('hidden', state.cwd)
    const hit = (id: string, overrides: Record<string, unknown> = {}) => ({
      header: id === 'visible' ? visible.header : hiddenHeader,
      bestMatch: {
        sessionId: SessionId(id),
        surface: 'current',
        type: 'user/message',
        snippet: '😀'.repeat(300),
        ...overrides,
      },
    })

    for (const query of ['', ' '.repeat(3), 'x'.repeat(501), 'nul\0query']) {
      await expect(state.service.search({ query }, new AbortController().signal))
        .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } })
    }
    await expect(state.service.search({ query: 'x' }, cancelledSignal()))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })

    state.searchSessions
      .mockRejectedValueOnce(new SessionQueryError('limit', 'SESSION_QUERY_INVALID_LIMIT'))
      .mockResolvedValueOnce({
        items: [
          hit('hidden'),
          hit('visible', { sessionId: SessionId('other') }),
          hit('visible', { surface: 'historical' }),
          hit('visible', { type: 'tool/result' }),
          hit('visible'),
          hit('visible'),
        ],
        nextCursor: 'cursor-1',
      })
      .mockRejectedValueOnce(new SessionQueryError('stale', 'SESSION_QUERY_STALE_CURSOR'))
      .mockResolvedValueOnce({ items: [hit('visible')] })

    const result = await state.service.search({ query: ' prompt ' }, new AbortController().signal)
    expect(result).toMatchObject({
      ok: true,
      value: { items: [{ sessionId: visible.id }], hasMore: false },
    })
    if (!result.ok) throw new Error('search failed')
    expect(Array.from(result.value.items[0]!.snippet)).toHaveLength(240)
    expect(state.searchSessions.mock.calls[1]?.[0]).toMatchObject({ limit: 10 })
  })

  it('fails closed for missing providers, malformed pages, repeated cursors, and aborts', async () => {
    const missing = await harness({ omit: ['sessionQuery'] })
    attach(missing, emptySession('visible', missing.cwd))
    await expect(missing.service.search({ query: 'x' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'internal' } })

    const empty = await harness()
    await expect(empty.service.search({ query: 'x' }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { items: [], hasMore: false } })

    const malformed = await harness()
    const session = emptySession('visible', malformed.cwd)
    attach(malformed, session)
    const page = {
      header: session.header,
      bestMatch: {
        sessionId: session.id,
        surface: 'current',
        type: 'user/message',
        snippet: 'x',
      },
    }
    malformed.searchSessions.mockResolvedValueOnce({
      items: Array.from({ length: 21 }, () => page),
    })
    await expect(malformed.service.search({ query: 'x' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'internal' } })

    malformed.searchSessions
      .mockReset()
      .mockResolvedValue({ items: [], nextCursor: 'same' })
    await expect(malformed.service.search({ query: 'x' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'internal' } })

    malformed.searchSessions.mockReset().mockRejectedValue(
      new SessionQueryError('aborted', 'SESSION_QUERY_ABORTED'),
    )
    await expect(malformed.service.search({ query: 'x' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('handles missing optional summary projections and corpus cancellation', async () => {
    const plain = await harness({ omit: ['sessionProjections', 'sessionProjectionCache'] })
    const noCwd = Session.create(SessionId('summary-no-cwd'), undefined, {
      version: 0,
      id: SessionId('summary-no-cwd'),
      createdAt: 10,
    })
    attach(plain, noCwd)
    const cold = header('summary-cold', plain.cwd)
    const raced = header('summary-raced', plain.cwd)
    plain.persistenceHeaders.push(cold, raced)
    plain.persistenceEvents.set('summary-cold', [])
    const plainList = await plain.service.list({}, new AbortController().signal)
    if (!plainList.ok) throw new Error('plain listing failed')
    expect(new Set(plainList.value.items.map(item => item.sessionId)))
      .toEqual(new Set([noCwd.id, cold.id, raced.id]))

    const interrupted = await harness()
    const interruptedHeader = header('inspection-aborted', interrupted.cwd)
    interrupted.persistenceHeaders.push(interruptedHeader)
    const controller = new AbortController()
    interrupted.persistenceList.mockImplementationOnce(async () => {
      controller.abort(new Error('corpus cancelled'))
      throw new Error('cold inspection failed')
    })
    await expect(interrupted.service.list({}, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })

  it('bounds provider calls and reports a twenty-one hit page as having more', async () => {
    const limited = await harness()
    const session = emptySession('search-limit', limited.cwd)
    attach(limited, session)
    let cursor = 0
    limited.searchSessions.mockImplementation(async () => ({
      items: [],
      nextCursor: `cursor-${String(cursor++)}`,
    }))
    await expect(limited.service.search({ query: 'x' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(limited.searchSessions).toHaveBeenCalledTimes(100)

    const paged = await harness()
    const sessions = Array.from({ length: 22 }, (_, index) => {
      const item = emptySession(`search-${String(index)}`, paged.cwd)
      attach(paged, item)
      return item
    })
    const hit = (session: Session) => ({
      header: session.header,
      bestMatch: {
        sessionId: session.id,
        surface: 'current',
        type: 'assistant/message',
        snippet: String(session.id),
      },
    })
    paged.searchSessions
      .mockResolvedValueOnce({ items: sessions.slice(0, 20).map(hit), nextCursor: 'next' })
      .mockResolvedValueOnce({ items: sessions.slice(20).map(hit) })
    const result = await paged.service.search({ query: 'x' }, new AbortController().signal)
    expect(result).toMatchObject({
      ok: true,
      value: { hasMore: true },
    })
    if (!result.ok) throw new Error('paged search failed')
    expect(result.value.items).toHaveLength(20)
  })
})

describe('Session Remote creation, composition, and cold resume', () => {
  it('validates creation identity, cwd, workspace, and cancellation before side effects', async () => {
    const state = await harness()
    await expect(state.service.create({}, cancelledSignal()))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    await expect(state.service.create({
      workspaceId: 'w1',
      cwd: state.cwd,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' },
    })
    await expect(state.service.create({
      workspaceId: 'missing',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'workspace-not-found' },
    })
    await expect(state.service.create({
      cwd: 'relative',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' },
    })

    const created = await state.service.create({}, new AbortController().signal)
    if (!created.ok) throw new Error('generated creation failed')
    expect(String(created.value.sessionId)).toMatch(/^session-/)
    expect(created.value.agentPreset).toBe('standard')
  })

  it('attaches workspace sessions once and preserves attach failures', async () => {
    const state = await harness()
    const owned = workspace('w1', state.cwd)
    state.workspaces.set(String(owned.id), owned)
    const first = await state.service.create({
      sessionId: SessionId('workspace-created'),
      workspaceId: String(owned.id),
    }, new AbortController().signal)
    expect(first).toMatchObject({ ok: true })
    expect(owned.attachSession).toHaveBeenCalledWith(SessionId('workspace-created'))

    Object.defineProperty(owned, 'sessionIds', { configurable: true, value: [SessionId('workspace-created')] })
    await state.service.create({
      sessionId: SessionId('workspace-created'),
      workspaceId: String(owned.id),
    }, new AbortController().signal)
    expect(owned.attachSession).toHaveBeenCalledOnce()

    const failing = workspace('w2', state.cwd)
    failing.attachSession.mockRejectedValueOnce(new Error('attach failed'))
    state.workspaces.set(String(failing.id), failing)
    await expect(state.service.create({
      sessionId: SessionId('workspace-failed'),
      workspaceId: String(failing.id),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'workspace-attach-failed' },
    })
  })

  it('resumes a matching persisted identity and rejects cwd and preset adoption', async () => {
    const state = await harness()
    const persisted = header('persisted', state.cwd, { agentPreset: 'standard' })
    state.persistenceHeaders.push(persisted)
    state.persistenceEvents.set('persisted', [])
    await expect(state.service.create({
      sessionId: persisted.id,
      cwd: state.cwd,
      agentPreset: 'standard',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { sessionId: persisted.id, agentPreset: 'standard' },
    })
    expect(state.resume).toHaveBeenCalledOnce()

    await expect(state.service.create({
      sessionId: persisted.id,
      cwd: join(state.cwd, 'other'),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-conflict' },
    })
    await expect(state.service.create({
      sessionId: persisted.id,
      cwd: state.cwd,
      agentPreset: 'code',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-preset-conflict', details: { existingPreset: 'standard' } },
    })

    const unownedPreset = header('no-preset', state.cwd)
    state.persistenceHeaders.push(unownedPreset)
    state.persistenceEvents.set('no-preset', [])
    await expect(state.service.create({
      sessionId: unownedPreset.id,
      cwd: state.cwd,
      agentPreset: 'code',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'agent-preset-conflict',
        details: { requestedPreset: 'code' },
      },
    })
  })

  it('translates preset, subagent, admission, cancellation, and internal creation failures', async () => {
    const state = await harness()
    state.presetResolve.mockRejectedValueOnce(new UnknownPresetError('missing', ['standard']))
    await expect(state.service.create({
      sessionId: SessionId('unknown-preset'),
      cwd: state.cwd,
      agentPreset: 'missing',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-preset-not-found' },
    })

    state.presetMount.mockRejectedValueOnce(new PresetMountError('broken', 'invalid composition'))
    await expect(state.service.create({
      sessionId: SessionId('invalid-preset'),
      cwd: state.cwd,
      agentPreset: 'broken',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-preset-invalid' },
    })

    const subagent = emptySession('subagent', state.cwd, { origin: 'subagent' })
    attach(state, subagent)
    await expect(state.service.create({
      sessionId: subagent.id,
      cwd: state.cwd,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-busy' },
    })

    state.admissionError = new Error('archive race')
    await expect(state.service.create({
      sessionId: SessionId('admission-race'),
      cwd: state.cwd,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    state.admissionError = undefined

    state.createError = 'plain create failure'
    await expect(state.service.create({
      sessionId: SessionId('internal-create'),
      cwd: state.cwd,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
  })

  it('reuses an in-flight identity and keeps publication admission checks around setup commit', async () => {
    const state = await harness({ omit: ['agentPresets'] })
    const internals = state.service as unknown as {
      composeAgent(presetId: string | undefined): Promise<{ setup: AgentSetup }>
      withSessionAdmission(
        setup: AgentSetup | undefined,
        checks: Array<{ sessionId: SessionId; revision: number }>,
      ): AgentSetup
    }
    const composition = await internals.composeAgent(undefined)
    await expect(Promise.resolve().then(() => composition.setup(new Context())))
      .rejects.toThrow(/no scoped agent/)

    const commit = vi.fn()
    const setup = internals.withSessionAdmission(
      () => ({ commit }),
      [{ sessionId: SessionId('checked'), revision: 1 }],
    )
    const agent = fakeAgent(emptySession('checked', state.cwd))
    const prepared = await setup(agent.ctx)
    prepared?.commit()
    expect(commit).toHaveBeenCalledOnce()
    expect(state.assertAdmission).toHaveBeenCalledTimes(2)

    const deferred = Promise.withResolvers<AgentHandle>()
    state.create.mockImplementationOnce(() => deferred.promise)
    const first = state.service.create({
      sessionId: SessionId('concurrent'),
      cwd: state.cwd,
    }, new AbortController().signal)
    const second = state.service.create({
      sessionId: SessionId('concurrent'),
      cwd: state.cwd,
    }, new AbortController().signal)
    const session = emptySession('concurrent', state.cwd)
    const live = fakeAgent(session)
    state.sessions.set('concurrent', session)
    state.agents.set('concurrent', live)
    state.roots.push(live)
    deferred.resolve({
      agent: live as unknown as Agent,
      dispose: async () => {},
    })
    await expect(first).resolves.toMatchObject({ ok: true })
    await expect(second).resolves.toMatchObject({ ok: true })
    expect(state.create).toHaveBeenCalledOnce()
  })

  it('covers ordinary no-preset setup and every cold ownership race', async () => {
    const noPreset = await harness({ omit: ['agentPresets'] })
    await expect(noPreset.service.create({
      sessionId: SessionId('no-preset-create'),
      cwd: noPreset.cwd,
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { sessionId: SessionId('no-preset-create') },
    })
    const presetInternals = (await harness()).service as unknown as {
      composeAgent(presetId: string | undefined): Promise<{ setup: AgentSetup }>
    }
    const presetComposition = await presetInternals.composeAgent('standard')
    await expect(Promise.resolve().then(() => presetComposition.setup(new Context())))
      .rejects.toThrow(/no scoped agent/)

    const inspectedWithoutCwd = await harness()
    const listed = header('inspected-no-cwd', inspectedWithoutCwd.cwd)
    inspectedWithoutCwd.persistenceHeaders.push(listed)
    const { cwd: _listedCwd, ...listedWithoutCwd } = listed
    inspectedWithoutCwd.persistenceInspect.mockResolvedValueOnce({
      meta: listedWithoutCwd,
      events: [],
    })
    await expect(inspectedWithoutCwd.service.models({
      sessionId: listed.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-not-found' },
    })

    const liveChild = await harness()
    const child = emptySession('live-child', liveChild.cwd, { origin: 'subagent' })
    attach(liveChild, child)
    await expect(liveChild.service.models({
      sessionId: child.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-busy' },
    })

    const attachedChild = await harness()
    const attached = emptySession('attached-child', attachedChild.cwd, { origin: 'subagent' })
    attachedChild.sessions.set(String(attached.id), attached)
    await expect(attachedChild.service.models({
      sessionId: attached.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-busy' },
    })

    const ordinary = await harness()
    const ordinaryHeader = header('ordinary-resume', ordinary.cwd)
    ordinary.persistenceHeaders.push(ordinaryHeader)
    ordinary.persistenceEvents.set('ordinary-resume', [])
    const first = ordinary.service.models({
      sessionId: ordinaryHeader.id,
    }, new AbortController().signal)
    const second = ordinary.service.models({
      sessionId: ordinaryHeader.id,
    }, new AbortController().signal)
    await expect(first).resolves.toMatchObject({ ok: true })
    await expect(second).resolves.toMatchObject({ ok: true })
    expect(ordinary.resume).toHaveBeenCalledOnce()

    const postResumeChild = await harness()
    const postResumeHeader = header('post-resume-child', postResumeChild.cwd)
    postResumeChild.persistenceHeaders.push(postResumeHeader)
    postResumeChild.persistenceEvents.set('post-resume-child', [])
    postResumeChild.resume.mockImplementationOnce(async () => {
      const session = emptySession('post-resume-child', postResumeChild.cwd, { origin: 'subagent' })
      const agent = fakeAgent(session)
      return { agent: agent as unknown as Agent, dispose: async () => {} }
    })
    await expect(postResumeChild.service.models({
      sessionId: postResumeHeader.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-busy' },
    })

    const racedChild = await harness()
    const racedHeader = header('raced-child', racedChild.cwd)
    racedChild.persistenceHeaders.push(racedHeader)
    racedChild.persistenceEvents.set('raced-child', [])
    racedChild.createError = undefined
    racedChild.resume.mockImplementationOnce(async () => {
      const session = emptySession('raced-child', racedChild.cwd, { origin: 'subagent' })
      attach(racedChild, session)
      throw new Error('raced child')
    })
    await expect(racedChild.service.models({
      sessionId: racedHeader.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-busy' },
    })
  })

  it('fences stored/raced subagents, stored cwd drift, and post-create cancellation', async () => {
    const storedChild = await harness()
    const childHeader = header('stored-child', storedChild.cwd, { origin: 'subagent' })
    storedChild.persistenceHeaders.push(childHeader)
    storedChild.persistenceEvents.set('stored-child', [])
    await expect(storedChild.service.create({
      sessionId: childHeader.id,
      cwd: storedChild.cwd,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-busy' },
    })

    const cwdConflict = await harness()
    const conflictHeader = header('stored-conflict', join(cwdConflict.cwd, 'old'))
    cwdConflict.persistenceHeaders.push(conflictHeader)
    cwdConflict.persistenceEvents.set('stored-conflict', [])
    await expect(cwdConflict.service.create({
      sessionId: conflictHeader.id,
      cwd: cwdConflict.cwd,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-conflict' },
    })

    const racedOrdinary = await harness()
    racedOrdinary.create.mockImplementationOnce(async () => {
      const session = emptySession('raced-ordinary', racedOrdinary.cwd)
      attach(racedOrdinary, session)
      throw new Error('create raced')
    })
    await expect(racedOrdinary.service.create({
      sessionId: SessionId('raced-ordinary'),
      cwd: racedOrdinary.cwd,
    }, new AbortController().signal)).resolves.toMatchObject({ ok: true })

    const racedAttachedChild = await harness()
    racedAttachedChild.create.mockImplementationOnce(async () => {
      const session = emptySession('raced-attached-child', racedAttachedChild.cwd, { origin: 'subagent' })
      racedAttachedChild.sessions.set(String(session.id), session)
      throw new Error('attached child raced')
    })
    await expect(racedAttachedChild.service.create({
      sessionId: SessionId('raced-attached-child'),
      cwd: racedAttachedChild.cwd,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-busy' },
    })

    const postChild = await harness()
    postChild.create.mockImplementationOnce(async () => {
      const session = emptySession('post-child', postChild.cwd, { origin: 'subagent' })
      const agent = fakeAgent(session)
      return { agent: agent as unknown as Agent, dispose: async () => {} }
    })
    await expect(postChild.service.create({
      sessionId: SessionId('post-child'),
      cwd: postChild.cwd,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-busy' },
    })

    const missingCwd = await harness()
    const noCwd = Session.create(SessionId('no-existing-cwd'), undefined, {
      version: 0,
      id: SessionId('no-existing-cwd'),
      createdAt: 10,
    })
    attach(missingCwd, noCwd)
    await expect(missingCwd.service.create({
      sessionId: noCwd.id,
      cwd: missingCwd.cwd,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { requestedCwd: missingCwd.cwd } },
    })

    const abortedAfter = await harness()
    const afterController = new AbortController()
    abortedAfter.create.mockImplementationOnce(async () => {
      afterController.abort(new Error('after create'))
      const session = emptySession('aborted-after', abortedAfter.cwd)
      const agent = fakeAgent(session)
      return { agent: agent as unknown as Agent, dispose: async () => {} }
    })
    await expect(abortedAfter.service.create({
      sessionId: SessionId('aborted-after'),
      cwd: abortedAfter.cwd,
    }, afterController.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    const abortedCatch = await harness()
    const catchController = new AbortController()
    abortedCatch.create.mockImplementationOnce(async () => {
      catchController.abort(new Error('during create'))
      throw new Error('create stopped')
    })
    await expect(abortedCatch.service.create({
      sessionId: SessionId('aborted-catch'),
      cwd: abortedCatch.cwd,
    }, catchController.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })
})

describe('Session Remote history and projections', () => {
  it('validates pagination and serves tool views, source groups, and projection cuts', async () => {
    const state = await harness()
    const session = emptySession('history', state.cwd)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('history-call'),
      name: 'presented',
      arguments: '{"path":"a"}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('history-call'),
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }),
      meta: { durationMs: 1 },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'answer' }],
        source: { provider: 'provider', model: 'model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    attach(state, session)
    state.projectionSnapshot.mockReturnValue({ asOfSeq: 7, values: { usage: 3 } })
    state.toolGet.mockImplementation((...args: unknown[]) => {
      if (args[0] !== 'presented') return undefined
      return {
        presentCall: (input: unknown) => ({ args: input }),
        presentResult: (input: unknown, result: unknown) => ({ args: input, result }),
      }
    })

    for (const request of [
      { sessionId: session.id, beforeSeq: -1 },
      { sessionId: session.id, beforeSeq: 1.5 },
      { sessionId: session.id, maxMessages: 0 },
      { sessionId: session.id, maxMessages: 1.5 },
      { sessionId: session.id, maxMessages: 2_049 },
    ]) {
      await expect(state.service.history(request, new AbortController().signal))
        .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } })
    }
    await expect(state.service.history({ sessionId: session.id }, cancelledSignal()))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })

    const first = await state.service.history({
      sessionId: session.id,
      maxMessages: 1,
    }, new AbortController().signal)
    expect(first).toMatchObject({
      ok: true,
      value: {
        hasMore: true,
        projections: { asOfSeq: 7, values: { usage: 3 } },
      },
    })
    if (!first.ok) throw new Error('history failed')
    const complete = await state.service.history({
      sessionId: session.id,
      maxMessages: 10,
    }, new AbortController().signal)
    if (!complete.ok) throw new Error('complete history failed')
    expect(complete.value.events.some(entry => entry.view !== undefined)).toBe(true)

    const older = await state.service.history({
      sessionId: session.id,
      beforeSeq: session.seq,
      maxMessages: 10,
    }, new AbortController().signal)
    expect(older).toMatchObject({ ok: true, value: { hasMore: false } })
    if (!older.ok) throw new Error('older history failed')
    expect(older.value).not.toHaveProperty('projections')
  })

  it('pages an attached immutable snapshot without iterating or copying the complete log', async () => {
    const state = await harness()
    const session = emptySession('shared-history-snapshot', state.cwd)
    for (let index = 0; index < 3_000; index++) session.append('turn/start', { turn: index + 1 })
    attach(state, session)
    const snapshot = session.events
    const observed = new Proxy(snapshot, {
      get(target, key, receiver): unknown {
        if (key === Symbol.iterator) throw new Error('history must not copy the complete log')
        return Reflect.get(target, key, receiver)
      },
    })
    vi.spyOn(session, 'events', 'get').mockReturnValue(observed)
    const newest = await state.service.history({ sessionId: session.id }, new AbortController().signal)
    if (!newest.ok) throw new Error(newest.error.message)
    const cursor = newest.value.events[0]?.event.seq
    if (cursor === undefined) throw new Error('expected an older-page cursor')
    expect(cursor).toBeGreaterThan(0)
    const older = await state.service.history({ sessionId: session.id, beforeSeq: cursor }, new AbortController().signal)
    if (!older.ok) throw new Error(older.error.message)
    expect(older.value.events.at(-1)?.event.seq).toBe(cursor - 1)
    expect(snapshot).toHaveLength(3_000)
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('captures events and projections together after asynchronous presentation scope resolution', async () => {
    const state = await harness()
    const session = emptySession('history-observation-cut', state.cwd)
    session.append('turn/start', { turn: 1 })
    state.sessions.set(String(session.id), session)
    const before = session.events
    state.standingKeyFor.mockImplementation(async () => {
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      return undefined
    })
    state.projectionSnapshot.mockImplementation(() => ({ asOfSeq: session.seq - 1, values: {} }))
    const result = await state.service.history({ sessionId: session.id }, new AbortController().signal)
    if (!result.ok) throw new Error(result.error.message)
    expect(state.standingKeyFor).toHaveBeenCalledOnce()
    expect(before).toHaveLength(1)
    expect(result.value.events.map(entry => entry.event.seq)).toEqual([0, 1])
    expect(result.value.projections?.asOfSeq).toBe(result.value.events.at(-1)?.event.seq)
  })

  it('bounds history by event count and encoded bytes while its implicit cursor always advances', async () => {
    const state = await harness()
    const session = emptySession('bounded-history', state.cwd)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    for (let index = 0; index < 2_500; index += 1) {
      session.append('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index, text: `chunk-${String(index)}` },
      })
    }
    attach(state, session)

    const newest = await state.service.history({
      sessionId: session.id,
      maxMessages: 2_048,
    }, new AbortController().signal)
    if (!newest.ok) throw new Error('bounded history failed')
    expect(newest.value.events).toHaveLength(2_048)
    expect(newest.value.hasMore).toBe(true)
    const cursor = newest.value.events[0]?.event.seq
    expect(cursor).toBeTypeOf('number')
    if (cursor === undefined) throw new Error('bounded history returned no pagination cursor')
    expect(newest.value.events.at(-1)?.event.seq).toBe(session.seq - 1)

    const older = await state.service.history({
      sessionId: session.id,
      beforeSeq: cursor,
      maxMessages: 2_048,
    }, new AbortController().signal)
    if (!older.ok) throw new Error('older bounded history failed')
    expect(older.value.events.at(-1)?.event.seq).toBe(cursor - 1)
    expect(older.value.events[0]?.event.seq).toBeLessThan(cursor)
    expect(older.value.hasMore).toBe(false)

    const byteBounded = emptySession('byte-bounded-history', state.cwd)
    byteBounded.append('turn/start', { turn: 1 })
    byteBounded.append('step/start', { turn: 1, step: 1 })
    for (let index = 0; index < 20; index += 1) {
      byteBounded.append('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index, text: `${String(index)}:${'界'.repeat(40_000)}` },
      })
    }
    attach(state, byteBounded)
    const bytes = await state.service.history({
      sessionId: byteBounded.id,
      maxMessages: 2_048,
    }, new AbortController().signal)
    if (!bytes.ok) throw new Error('byte-bounded history failed')
    expect(Buffer.byteLength(JSON.stringify(bytes.value.events), 'utf8')).toBeLessThanOrEqual(1_048_576)
    expect(Buffer.byteLength(JSON.stringify(bytes.value), 'utf8')).toBeLessThanOrEqual(1_048_576)
    expect(bytes.value.events.length).toBeGreaterThan(0)
    expect(bytes.value.events.length).toBeLessThan(22)
    expect(bytes.value.hasMore).toBe(true)
  })

  it('enforces the final response byte bound when hasMore:false uses one more encoded byte', async () => {
    const state = await harness()
    const build = (id: string, text: string): Session => {
      const session = emptySession(id, state.cwd)
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'tail' } })
      attach(state, session)
      return session
    }
    const probe = build('wire-budget-probe', '')
    const baseline = await state.service.history({
      sessionId: probe.id, beforeSeq: probe.seq, maxMessages: 10,
    }, new AbortController().signal)
    if (!baseline.ok) throw new Error('small history probe failed')
    expect(baseline.value.hasMore).toBe(false)
    expect(baseline.value.events).toHaveLength(4)
    const baseBytes = Buffer.byteLength(JSON.stringify(baseline.value), 'utf8')
    const boundary = build('wire-budget-boundary', 'x'.repeat(1_048_576 - baseBytes + 1))

    const result = await state.service.history({
      sessionId: boundary.id, beforeSeq: boundary.seq, maxMessages: 10,
    }, new AbortController().signal)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('over-budget history was accepted')
    expect(result.error.code).toBe('internal')
    expect(result.error.message).toContain('history page exceeded the encoded byte budget')
    expect(boundary.seq).toBe(4)
  })

  it('rejects a faulty presenter that inflates metadata during retained-window reprojection', async () => {
    const state = await harness()
    const session = emptySession('inflating-history-presenter', state.cwd)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    for (const callId of ['first', 'second']) session.append('tool/call', {
      turn: 1, step: 1, callId: CallId(callId), name: 'faulty-presenter', arguments: JSON.stringify({ callId }),
    })
    attach(state, session)
    const calls: string[] = []
    state.toolGet.mockReturnValue({
      presentCall(input: { callId: string }) {
        calls.push(input.callId)
        return { title: calls.length <= 2 ? 'small preview' : 'x'.repeat(1_100_000) }
      },
    })
    // Fault injection is confined to the external presenter. The real page
    // selection, reprojection, serialization and byte guard all execute.
    const result = await state.service.history({
      sessionId: session.id, beforeSeq: session.seq, maxMessages: 10,
    }, new AbortController().signal)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('over-budget presenter metadata was accepted')
    expect(result.error.code).toBe('internal')
    expect(result.error.message).toContain('history presentation metadata exceeded the encoded page budget')
    expect(calls).toEqual(['second', 'first', 'first', 'second'])
    expect(session.seq).toBe(4)
  })

  it('returns one oversized newest event so history pagination cannot livelock', async () => {
    const state = await harness()
    const session = emptySession('oversized-history', state.cwd)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(1_100_000) },
    })
    attach(state, session)

    const oversized = await state.service.history({
      sessionId: session.id,
      maxMessages: 2_048,
    }, new AbortController().signal)
    if (!oversized.ok) throw new Error('oversized history failed')
    expect(oversized.value.events).toHaveLength(1)
    expect(oversized.value.events[0]?.event.seq).toBe(session.seq - 1)
    expect(Buffer.byteLength(JSON.stringify(oversized.value.events), 'utf8')).toBeGreaterThan(1_048_576)
    expect(oversized.value.hasMore).toBe(true)

    const cursor = oversized.value.events[0]!.event.seq
    const older = await state.service.history({
      sessionId: session.id,
      beforeSeq: cursor,
      maxMessages: 2_048,
    }, new AbortController().signal)
    if (!older.ok) throw new Error('older oversized history failed')
    expect(older.value.events.at(-1)?.event.seq).toBe(cursor - 1)
    expect(older.value.hasMore).toBe(false)

    const empty = await state.service.history({
      sessionId: session.id,
      beforeSeq: 0,
      maxMessages: 2_048,
    }, new AbortController().signal)
    expect(empty).toEqual({ ok: true, value: { events: [], hasMore: false } })

    state.projectionSnapshot.mockReturnValue({
      asOfSeq: session.seq - 1,
      values: { oversized: 'x'.repeat(1_100_000) },
    })
    await expect(state.service.history({
      sessionId: session.id,
      maxMessages: 2_048,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
  })

  it('serves detached history and fails soft on presenter/projection errors', async () => {
    const state = await harness()
    const cold = emptySession('cold-history', state.cwd)
    cold.append('turn/start', { turn: 1 })
    cold.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('bad-json'),
      name: 'throwing',
      arguments: '{',
    })
    cold.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('missing-call'),
        content: [{ type: 'text', text: 'missing' }],
        isError: true,
      }),
    }, { surfaceOp: 'append' })
    cold.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    state.persistenceHeaders.push(cold.header)
    state.persistenceEvents.set('cold-history', [...cold.events])
    state.standingKeyFor.mockRejectedValueOnce(new Error('standing key unavailable'))
    state.projectionRestore.mockImplementationOnce(() => { throw new Error('projection failed') })
    state.toolGet.mockReturnValue({
      presentCall: () => { throw new Error('presenter failed') },
      presentResult: () => ({ invalid: 1n }),
    })

    await expect(state.service.history({
      sessionId: cold.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { hasMore: false },
    })

    const noPersistence = await harness({ omit: ['sessionPersistence'] })
    await expect(noPersistence.service.history({
      sessionId: SessionId('missing'),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    await expect(state.service.history({
      sessionId: SessionId('missing'),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-not-found' },
    })
  })

  it('rejects non-JSON event carriers and covers every projection snapshot guard', async () => {
    const state = await harness()
    const session = emptySession('projection-guards', state.cwd)
    const agent = attach(state, session)
    const internals = state.service as unknown as {
      projectionsFor(source: { kind: 'attached'; session: Session }): unknown
    }
    for (const snapshot of [
      undefined,
      null,
      1,
      {},
      { asOfSeq: 1.5, values: {} },
      { asOfSeq: 1, values: null },
      { asOfSeq: 1, values: [] },
      { asOfSeq: 1, values: { invalid: 1n } },
    ]) {
      state.projectionSnapshot.mockReturnValueOnce(snapshot)
      expect(internals.projectionsFor({ kind: 'attached', session })).toBeUndefined()
    }
    state.projectionSnapshot.mockReturnValueOnce({ asOfSeq: 1, values: { valid: true } })
    expect(internals.projectionsFor({ kind: 'attached', session })).toEqual({
      asOfSeq: 1,
      values: { valid: true },
    })
    state.projectionSnapshot.mockImplementationOnce(() => { throw new Error('snapshot failed') })
    expect(internals.projectionsFor({ kind: 'attached', session })).toBeUndefined()

    const invalidData = header('invalid-data', state.cwd)
    state.persistenceHeaders.push(invalidData)
    state.persistenceEvents.set('invalid-data', [{
      type: 'custom/invalid',
      seq: 0,
      time: 1,
      data: { invalid: 1n },
    } as never])
    await expect(state.service.history({
      sessionId: invalidData.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })

    const invalidSurface = header('invalid-surface', state.cwd)
    state.persistenceHeaders.push(invalidSurface)
    state.persistenceEvents.set('invalid-surface', [{
      type: 'custom/surface',
      seq: 0,
      time: 1,
      data: {},
      surfaceOp: { invalid: 1n },
    } as never])
    await expect(state.service.history({
      sessionId: invalidSurface.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })

    state.agents.delete(String(agent.id))
  })

  it('preserves grouped/ignorable event fields and handles absent tools and optional metadata', async () => {
    const state = await harness({ omit: ['tools', 'sessionProjections'] })
    const fullCold = header('history-optional', state.cwd)
    const { cwd: _coldCwd, ...cold } = fullCold
    state.persistenceHeaders.push({ ...cold, cwd: state.cwd })
    const call = {
      type: 'tool/call',
      seq: 0,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        callId: CallId('optional-call'),
        name: 'missing',
        arguments: '{}',
      },
      sourceEventSeqs: [0],
      ignorable: true,
    } as unknown as SessionEvent
    const result = {
      type: 'tool/result',
      seq: 1,
      time: 2,
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: CallId('optional-call'),
          content: [{ type: 'text', text: 'result' }],
          isError: false,
        }),
      },
      surfaceOp: 'append',
    } as unknown as SessionEvent
    const user = {
      type: 'user/message',
      seq: 2,
      time: 3,
      data: createUserMessage({
        content: [{ type: 'text', text: 'grouped' }],
        source: { kind: 'user' },
      }),
      surfaceOp: 'append',
      sourceEventSeqs: [0, 1],
    } as unknown as SessionEvent
    state.persistenceEvents.set('history-optional', [call, result, user])
    const history = await state.service.history({
      sessionId: SessionId('history-optional'),
      maxMessages: 1,
    }, new AbortController().signal)
    if (!history.ok) throw new Error('optional history failed')
    expect(history.value.events.some(entry =>
      entry.event.ignorable === true
      && entry.event.sourceEventSeqs?.[0] === 0)).toBe(true)
  })

  it('omits call/result views when the mounted tool has no presenter', async () => {
    const state = await harness()
    state.toolGet.mockReturnValue({
      presentResult: (_args: unknown, result: unknown) => ({ result }),
    })
    const cold = header('history-no-presenter', state.cwd)
    state.persistenceHeaders.push(cold)
    state.persistenceEvents.set('history-no-presenter', [
      {
        type: 'tool/call',
        seq: 0,
        time: 1,
        data: {
          turn: 1,
          step: 1,
          callId: CallId('no-presenter'),
          name: 'missing',
          arguments: '{}',
        },
      },
      {
        type: 'tool/result',
        seq: 1,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId: CallId('no-presenter'),
            content: [{ type: 'text', text: 'result' }],
            isError: false,
          }),
        },
        surfaceOp: 'append',
      },
    ] as SessionEvent[])
    const result = await state.service.history({
      sessionId: cold.id,
    }, new AbortController().signal)
    if (!result.ok) throw new Error('history failed')
    expect(result.value.events[0]?.view).toBeUndefined()
    expect(result.value.events[1]?.view).toEqual(expect.objectContaining({
      for: 'result',
    }))
    state.toolGet.mockReturnValue({})
    const omitted = await state.service.history({
      sessionId: cold.id,
    }, new AbortController().signal)
    if (!omitted.ok) throw new Error('history without presenter failed')
    expect(omitted.value.events[1]?.view).toBeUndefined()
  })

  it('returns cancellation when a cold history read loses its signal race', async () => {
    const state = await harness()
    const cold = header('history-cancelled', state.cwd)
    state.persistenceHeaders.push(cold)
    const controller = new AbortController()
    state.persistenceInspect.mockImplementationOnce(async () => {
      controller.abort(new Error('history cancelled'))
      throw new Error('inspect stopped')
    })
    await expect(state.service.history({
      sessionId: cold.id,
    }, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })
})

describe('Session Remote model catalog, selection, and titles', () => {
  it('projects provider/model reasoning metadata and records provider failures', async () => {
    const state = await harness()
    const session = emptySession('models', state.cwd)
    attach(state, session)
    state.providers = [
      { id: 'provider', name: 'Provider' },
      { id: 'empty', name: 'Empty' },
      { id: 'broken', name: 'Broken' },
      { id: 'string-broken', name: 'String broken' },
    ]
    state.models.provider = [
      { id: 'model', name: 'Model', description: 'Primary model' },
      { id: 'plain', name: 'Plain' },
    ]
    state.models.empty = []
    state.listModels.mockImplementation(async (provider: string) => {
      if (provider === 'broken') throw new Error('catalog failure')
      if (provider === 'string-broken') throw 'string catalog failure'
      return state.models[provider] ?? []
    })
    state.resolveModelInfo.mockImplementation(async (...args: unknown[]) => {
      if (args[1] !== 'model') return { inputModalities: ['text'], reasoning: undefined }
      return {
        inputModalities: ['text', 'image'],
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High', description: 'Deep reasoning' },
          ],
          defaultEffort: 'high',
        },
      }
    })

    const result = await state.service.models({ sessionId: session.id }, new AbortController().signal)
    expect(result).toMatchObject({
      ok: true,
      value: {
        current: { provider: 'provider', model: 'model' },
        routable: true,
        groups: [{
          id: 'provider',
          models: [
            {
              id: 'model',
              description: 'Primary model',
              reasoning: {
                defaultEffort: 'high',
                efforts: [
                  { id: 'low' },
                  { id: 'high', description: 'Deep reasoning' },
                ],
              },
            },
            { id: 'plain' },
          ],
        }],
        failures: [
          { id: 'broken', message: 'catalog failure' },
          { id: 'string-broken', message: 'string catalog failure' },
        ],
      },
    })

    state.providers = [{ id: 'other', name: 'Other' }]
    state.models.other = []
    await expect(state.service.models({ sessionId: session.id }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { routable: false } })
    await expect(state.service.models({ sessionId: session.id }, cancelledSignal()))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('restores logged selection, switches reasoning, tolerates save failure, and serializes image admission', async () => {
    const state = await harness()
    const session = emptySession('selection', state.cwd)
    session.append('request/header', {
      header: {
        config: { provider: 'provider', model: 'logged', reasoningEffort: ReasoningEffortId('low') },
      },
      reason: 'initial',
    })
    attach(state, session)
    await expect(state.service.models({ sessionId: session.id }, new AbortController().signal))
      .resolves.toMatchObject({
        ok: true,
        value: { current: { provider: 'provider', model: 'logged', reasoningEffort: 'low' } },
      })

    state.resolveCallConfig.mockResolvedValueOnce({
      provider: 'provider',
      model: 'selected',
      reasoningEffort: 'high',
    })
    state.saveSelectionError = new Error('settings unavailable')
    await expect(state.service.selectModel({
      sessionId: session.id,
      provider: 'provider',
      model: 'selected',
      reasoningEffort: 'high',
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { selected: { provider: 'provider', model: 'selected', reasoningEffort: 'high' } },
    })
    await expect(state.service.models({ sessionId: session.id }, new AbortController().signal))
      .resolves.toMatchObject({
        ok: true,
        value: { current: { provider: 'provider', model: 'selected', reasoningEffort: 'high' } },
      })

    state.resolveCallConfig.mockResolvedValueOnce({ provider: 'provider', model: 'plain' })
    state.saveSelectionError = undefined
    await expect(state.service.selectModel({
      sessionId: session.id,
      provider: 'provider',
      model: 'plain',
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { selected: { provider: 'provider', model: 'plain' } },
    })

    state.resolveCallConfig.mockRejectedValueOnce(new Error('unknown route'))
    await expect(state.service.selectModel({
      sessionId: session.id,
      provider: 'missing',
      model: 'missing',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'model-unavailable' },
    })
    state.resolveCallConfig.mockRejectedValueOnce('string route failure')
    await expect(state.service.selectModel({
      sessionId: session.id,
      provider: 'missing',
      model: 'missing',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { message: 'string route failure' },
    })
    await expect(state.service.selectModel({
      sessionId: session.id,
      provider: 'provider',
      model: 'model',
    }, cancelledSignal())).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('translates absent, invalid, internal, and cancelled title operations', async () => {
    const absent = await harness({ omit: ['sessionTitle'] })
    const absentSession = emptySession('rename-absent', absent.cwd)
    attach(absent, absentSession)
    await expect(absent.service.rename({
      sessionId: absentSession.id,
      title: 'Title',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })

    const state = await harness()
    const session = emptySession('rename', state.cwd)
    attach(state, session)
    await expect(state.service.rename({
      sessionId: session.id,
      title: '  Renamed  ',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { title: 'Renamed' },
    })
    state.titleRename.mockImplementationOnce(() => { throw new SessionTitleInvalidError('blank') })
    await expect(state.service.rename({
      sessionId: session.id,
      title: '',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'title-invalid' },
    })
    state.titleRename.mockImplementationOnce(() => { throw 'rename string failure' })
    await expect(state.service.rename({
      sessionId: session.id,
      title: 'x',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    await expect(state.service.rename({
      sessionId: session.id,
      title: 'x',
    }, cancelledSignal())).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('returns stable lookup failures for admission, missing, subagent, raced, and failed resumes', async () => {
    const state = await harness()
    const internals = state.service as unknown as {
      agentFor(sessionId: SessionId): Promise<{ ok: boolean; value?: Agent; error?: unknown }>
    }
    state.admissionError = 'admission string failure'
    await expect(internals.agentFor(SessionId('admission'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-busy' },
    })
    state.admissionError = new Error('admission error failure')
    await expect(internals.agentFor(SessionId('admission-error'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-busy', message: 'admission error failure', details: { reason: 'admission error failure' } },
    })
    state.admissionError = undefined

    await expect(internals.agentFor(SessionId('missing'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-not-found' },
    })
    const childHeader = header('cold-child', state.cwd, { origin: 'subagent' })
    state.persistenceHeaders.push(childHeader)
    state.persistenceEvents.set('cold-child', [])
    await expect(internals.agentFor(childHeader.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-busy' },
    })

    const ordinary = header('resume-failure', state.cwd)
    state.persistenceHeaders.push(ordinary)
    state.persistenceEvents.set('resume-failure', [])
    state.resumeError = new Error('resume failed')
    await expect(internals.agentFor(ordinary.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })

    const racedHeader = header('resume-raced', state.cwd)
    state.persistenceHeaders.push(racedHeader)
    state.persistenceEvents.set('resume-raced', [])
    state.resume.mockImplementationOnce(async () => {
      const session = emptySession('resume-raced', state.cwd)
      const agent = attach(state, session)
      throw new Error(`raced with ${agent.id}`)
    })
    await expect(internals.agentFor(racedHeader.id)).resolves.toMatchObject({
      ok: true,
      value: { id: racedHeader.id },
    })
  })

  it('covers logged/default reasoning omissions and cancellation after catalog, selection, or title work', async () => {
    const state = await harness()
    const session = emptySession('model-optional', state.cwd)
    session.append('request/header', {
      header: { config: { provider: 'provider', model: 'model' } },
      reason: 'initial',
    })
    attach(state, session)
    state.resolveModelInfo.mockResolvedValueOnce({
      inputModalities: ['text'],
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }],
        defaultEffort: undefined,
      },
    })
    await expect(state.service.models({
      sessionId: session.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        current: { provider: 'provider', model: 'model' },
        groups: [{
          models: [{
            reasoning: { efforts: [{ id: 'low', name: 'Low' }] },
          }],
        }],
      },
    })

    await expect(state.service.models({
      sessionId: SessionId('missing'),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-not-found' },
    })
    await expect(state.service.selectModel({
      sessionId: SessionId('missing'),
      provider: 'provider',
      model: 'model',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-not-found' },
    })
    await expect(state.service.rename({
      sessionId: SessionId('missing'),
      title: 'x',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-not-found' },
    })

    const catalogController = new AbortController()
    state.listModels.mockImplementationOnce(async () => {
      catalogController.abort(new Error('catalog cancelled'))
      throw new Error('catalog stopped')
    })
    await expect(state.service.models({
      sessionId: session.id,
    }, catalogController.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    const selectionController = new AbortController()
    state.resolveCallConfig.mockImplementationOnce(async () => {
      selectionController.abort(new Error('selection cancelled'))
      throw new Error('selection stopped')
    })
    await expect(state.service.selectModel({
      sessionId: session.id,
      provider: 'provider',
      model: 'model',
    }, selectionController.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    const titleController = new AbortController()
    state.titleRename.mockImplementationOnce(() => {
      titleController.abort(new Error('title cancelled'))
      throw new Error('title stopped')
    })
    await expect(state.service.rename({
      sessionId: session.id,
      title: 'x',
    }, titleController.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    state.listProviders.mockImplementationOnce(() => { throw new Error('provider roster failed') })
    const rosterFailure = await state.service.models({
      sessionId: session.id,
    }, new AbortController().signal)
    if (rosterFailure.ok) throw new Error('provider roster unexpectedly succeeded')
    expect(rosterFailure.error.code).toBe('internal')
    expect(rosterFailure.error.message).toContain('provider roster failed')
  })

  it('clears a rejected image-admission tail before the next operation', async () => {
    const state = await harness()
    const session = emptySession('image-chain', state.cwd)
    const agent = attach(state, session)
    const internals = state.service as unknown as {
      serializeAdmission<Value>(agent: Agent, operation: () => Promise<Value>): Promise<Value>
    }
    await expect(internals.serializeAdmission(
      agent as unknown as Agent,
      () => Promise.reject(new Error('first failed')),
    )).rejects.toThrow('first failed')
    await expect(internals.serializeAdmission(
      agent as unknown as Agent,
      () => Promise.resolve('second'),
    )).resolves.toBe('second')
  })
})

describe('Session Remote fork ownership', () => {
  function completedSession(id: string, cwd: string, overrides: Partial<SessionHeader> = {}): Session {
    const session = emptySession(id, cwd, overrides)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'fork me' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return session
  }

  async function historyRevision(state: CoverageHarness, source: Session): Promise<string> {
    const page = await state.service.history({ sessionId: source.id, view: 'raw' }, new AbortController().signal)
    if (!page.ok || page.value.sourceRevision === undefined) throw new Error('missing bound history')
    return page.value.sourceRevision
  }

  it.each(['replace', 'truncate', 'delete'] as const)('rejects a bound fork after source %s without creating a child', async (change) => {
    const state = await harness()
    const source = completedSession('bound-fork-source', state.cwd)
    attach(state, source)
    const sourceRevision = await historyRevision(state, source)
    if (change === 'delete') {
      state.sessions.delete(String(source.id))
      Reflect.set(state.ctx.sessionPersistence, 'borrowSession', async () => { throw new SessionPersistenceNotFoundError(source.id) })
    } else state.sessions.set(String(source.id), Session.create(source.id,
      change === 'truncate' ? source.events.slice(0, 1) : source.events, source.header))
    const result = await state.service.fork({ sessionId: source.id, sourceRevision, atSeq: 1 }, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'history-stale-source' } })
    expect(state.create).not.toHaveBeenCalled()
    expect(state.flush).not.toHaveBeenCalled()
  })

  it('keeps a bound fork seed and preset at the displayed cut across later appends', async () => {
    const state = await harness()
    const source = completedSession('bound-fork-append', state.cwd, { agentPreset: 'standard' })
    attach(state, source)
    const expectedSeed = source.events
    const sourceRevision = await historyRevision(state, source)
    source.append('agent-preset/selected', { agentPreset: 'future-preset' })
    state.presetMount.mockImplementationOnce(async () => {
      source.append('turn/start', { turn: 2 })
      await Promise.resolve()
    })
    const result = await state.service.fork({ sessionId: source.id, sourceRevision, atSeq: 1 }, new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(state.create.mock.calls[0]?.[0].seed).toEqual(expectedSeed)
    expect(state.create.mock.calls[0]?.[0].meta?.agentPreset).toBe('standard')
    await expect(state.service.fork({ sessionId: source.id, sourceRevision, atSeq: 3 }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } })
  })

  it.each(['setup-await', 'publication-commit'] as const)('rejects replacement at %s before publishing or flushing the fork', async (stage) => {
    const state = await harness()
    const source = completedSession('bound-fork-race', state.cwd, { agentPreset: 'standard' })
    attach(state, source)
    const sourceRevision = await historyRevision(state, source)
    const replace = () => { state.sessions.set(String(source.id), Session.create(source.id, source.events, source.header)) }
    if (stage === 'setup-await') state.presetMount.mockImplementationOnce(async () => { await Promise.resolve(); replace() })
    else {
      let calls = 0
      state.assertAdmission.mockImplementation(() => { if (++calls === 2) replace() })
    }
    const result = await state.service.fork({ sessionId: source.id, sourceRevision }, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'history-stale-source' } })
    expect(state.sessions.size).toBe(1)
    expect(state.flush).not.toHaveBeenCalled()
  })

  it('does not use a later turn end to make an unfinished bound cut forkable', async () => {
    const state = await harness()
    const source = emptySession('bound-fork-open', state.cwd)
    source.append('turn/start', { turn: 1 })
    attach(state, source)
    const sourceRevision = await historyRevision(state, source)
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(state.service.fork({ sessionId: source.id, sourceRevision, atSeq: 0 }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'fork-unavailable' } })
    expect(state.create).not.toHaveBeenCalled()
  })

  it.each(['unchanged', 'durable-replaced', 'live-at-commit'] as const)('retains a cold fork lease and rechecks its source (%s)', async (change) => {
    const state = await harness()
    const source = completedSession('bound-fork-cold', state.cwd, { agentPreset: 'standard' })
    let revision = 'cold-fork-v1'
    let pins = 0
    Reflect.set(state.ctx.sessionPersistence, 'borrowSession', async () => {
      pins++
      return { source: 'prepared', inspection: { meta: source.header, events: source.events },
        revision: SessionPersistenceRevision(revision), preparedSession: source,
        [Symbol.dispose]: () => { pins-- } }
    })
    const sourceRevision = await historyRevision(state, source)
    expect(pins).toBe(0)
    state.presetMount.mockImplementationOnce(async () => {
      expect(pins).toBe(1)
      await Promise.resolve()
      if (change === 'durable-replaced') revision = 'cold-fork-v2'
    })
    if (change === 'live-at-commit') {
      let calls = 0
      state.assertAdmission.mockImplementation(() => { if (++calls === 2) state.sessions.set(String(source.id), source) })
    }
    const result = await state.service.fork({ sessionId: source.id, sourceRevision }, new AbortController().signal)
    expect(pins).toBe(0)
    if (change !== 'unchanged') {
      expect(result).toMatchObject({ ok: false, error: { code: 'history-stale-source' } })
      expect(state.sessions.size).toBe(change === 'live-at-commit' ? 1 : 0)
      expect(state.flush).not.toHaveBeenCalled()
    } else {
      expect(result.ok).toBe(true)
      expect(state.create.mock.calls[0]?.[0].seed).toEqual(source.events)
    }
  })

  it('forks the last completed prefix and attaches the inherited workspace', async () => {
    const state = await harness()
    const source = completedSession('fork-source', state.cwd, { agentPreset: 'standard' })
    attach(state, source)
    const owner = workspace('fork-workspace', state.cwd)
    Object.defineProperty(owner, 'sessionIds', { configurable: true, value: [source.id] })
    state.workspaces.set(String(owner.id), owner)

    const result = await state.service.fork({
      sessionId: source.id,
    }, new AbortController().signal)
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(String(result.value.sessionId)).toMatch(/^session-/)
    const createOptions = state.create.mock.calls[0]?.[0]
    expect(createOptions?.seed).toEqual(source.events)
    expect(createOptions?.meta).toEqual(expect.objectContaining({
      cwd: state.cwd,
      parentSession: source.id,
      seedLength: source.events.length,
      agentPreset: 'standard',
    }))
    expect(state.flush).toHaveBeenCalled()
    expect(owner.attachSession).toHaveBeenCalledWith(result.value.sessionId)
  })

  it('validates fork anchors and distinguishes missing, unfinished, and admission failures', async () => {
    const state = await harness()
    const open = emptySession('fork-open', state.cwd)
    open.append('turn/start', { turn: 1 })
    attach(state, open)
    await expect(state.service.fork({ sessionId: open.id }, cancelledSignal()))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    for (const atSeq of [-1, 1.5]) {
      await expect(state.service.fork({
        sessionId: open.id,
        atSeq,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid-argument' },
      })
    }
    await expect(state.service.fork({ sessionId: open.id }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'fork-unavailable' } })
    const unfinished = await state.service.fork({
      sessionId: open.id,
      atSeq: 0,
    }, new AbortController().signal)
    if (unfinished.ok) throw new Error('unfinished fork unexpectedly succeeded')
    expect(unfinished.error.code).toBe('fork-unavailable')
    expect(unfinished.error.message).toContain('has not completed')
    await expect(state.service.fork({
      sessionId: SessionId('missing'),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-not-found' },
    })

    state.admissionError = 'fork admission string'
    await expect(state.service.fork({
      sessionId: open.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'fork-unavailable', message: 'fork admission string' },
    })
  })

  it('uses anchored and fallback boundaries and reports create, flush, disposal, and attach failures', async () => {
    const state = await harness()
    const source = completedSession('fork-errors', state.cwd)
    source.append('turn/start', { turn: 2 })
    source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'open second' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    attach(state, source)

    const anchored = await state.service.fork({
      sessionId: source.id,
      atSeq: 1,
    }, new AbortController().signal)
    if (!anchored.ok) throw new Error(JSON.stringify(anchored.error))
    expect(anchored).toMatchObject({ ok: true })
    await expect(state.service.fork({
      sessionId: source.id,
      atSeq: source.seq + 10,
    }, new AbortController().signal)).resolves.toMatchObject({ ok: true })

    state.createError = new Error('fork create failed')
    await expect(state.service.fork({
      sessionId: source.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    state.createError = undefined
    state.flushError = new Error('fork flush failed')
    state.disposeError = new Error('fork dispose failed')
    await expect(state.service.fork({
      sessionId: source.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    state.flushError = undefined
    state.disposeError = undefined

    const owner = workspace('fork-failing-workspace', state.cwd)
    Object.defineProperty(owner, 'sessionIds', { configurable: true, value: [source.id] })
    owner.attachSession.mockRejectedValueOnce(new Error('workspace attach failed'))
    state.workspaces.set(String(owner.id), owner)
    await expect(state.service.fork({
      sessionId: source.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'workspace-attach-failed' },
    })
  })

  it('resolves subagent workspaces through ancestors and fails without session-query', async () => {
    const absent = await harness({ omit: ['sessionQuery'] })
    const source = completedSession('subagent-source', absent.cwd, { origin: 'subagent' })
    const internals = absent.service as unknown as {
      forkWorkspace(
        source: { id: SessionId; header: SessionHeader; events: SessionEvent[] },
        signal: AbortSignal,
      ): Promise<Workspace | undefined>
    }
    await expect(internals.forkWorkspace({
      id: source.id,
      header: source.header,
      events: [...source.events],
    }, new AbortController().signal)).rejects.toThrow(/without session-query/)

    const state = await harness()
    const ancestor = header('ancestor', state.cwd)
    const owner = workspace('ancestor-workspace', state.cwd)
    Object.defineProperty(owner, 'sessionIds', { configurable: true, value: [ancestor.id] })
    state.workspaces.set(String(owner.id), owner)
    state.traceSession.mockResolvedValueOnce({
      target: { header: source.header, live: false, persisted: true },
      ancestors: [{ header: ancestor, live: false, persisted: true }],
      complete: true,
      root: { header: ancestor, live: false, persisted: true },
      descendants: [],
    })
    const resolved = await (state.service as unknown as typeof internals).forkWorkspace({
      id: source.id,
      header: source.header,
      events: [...source.events],
    }, new AbortController().signal)
    expect(resolved).toBe(owner)

    state.traceSession.mockResolvedValueOnce({
      target: { header: source.header, live: false, persisted: true },
      ancestors: [],
      complete: true,
      root: { header: source.header, live: false, persisted: true },
      descendants: [],
    })
    await expect((state.service as unknown as typeof internals).forkWorkspace({
      id: source.id,
      header: source.header,
      events: [...source.events],
    }, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('covers empty sources, inter-turn cuts, omitted metadata, and fork cancellation/error paths', async () => {
    const empty = await harness()
    const emptySource = emptySession('fork-empty', empty.cwd)
    attach(empty, emptySource)
    await expect(empty.service.fork({
      sessionId: emptySource.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'fork-unavailable' },
    })

    const marker = await harness()
    const marked = completedSession('fork-marker', marker.cwd)
    marked.append('session/title', { title: 'Marker', messageSeqs: [], source: { kind: 'user' } })
    marked.append('turn/start', { turn: 2 })
    attach(marker, marked)
    const markedFork = await marker.service.fork({
      sessionId: marked.id,
      atSeq: 1,
    }, new AbortController().signal)
    expect(markedFork).toMatchObject({ ok: true })
    const markedOptions = marker.create.mock.calls[0]?.[0]
    expect(markedOptions?.seed).toEqual(marked.events.slice(0, 4))
    expect(markedOptions?.meta?.seedLength).toBe(4)

    const optional = await harness({ omit: ['agentPresets'] })
    const noMetadata = Session.create(SessionId('fork-no-metadata'), undefined, {
      version: 0,
      id: SessionId('fork-no-metadata'),
      createdAt: 1,
    })
    noMetadata.append('turn/start', { turn: 1 })
    noMetadata.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    attach(optional, noMetadata)
    await expect(optional.service.fork({
      sessionId: noMetadata.id,
    }, new AbortController().signal)).resolves.toMatchObject({ ok: true })
    expect(optional.create).toHaveBeenCalledWith(expect.objectContaining({
      meta: {
        parentSession: noMetadata.id,
        seedLength: 2,
      },
    }))

    const sourceFailure = await harness({ omit: ['sessionPersistence'] })
    await expect(sourceFailure.service.fork({
      sessionId: SessionId('missing'),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })

    const sourceCancelled = await harness()
    const cancelledHeader = header('fork-source-cancelled', sourceCancelled.cwd)
    sourceCancelled.persistenceHeaders.push(cancelledHeader)
    const sourceController = new AbortController()
    sourceCancelled.persistenceInspect.mockImplementationOnce(async () => {
      sourceController.abort(new Error('source cancelled'))
      throw new Error('source read stopped')
    })
    await expect(sourceCancelled.service.fork({
      sessionId: cancelledHeader.id,
    }, sourceController.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    const workspaceFailure = await harness({ omit: ['sessionQuery'] })
    const child = completedSession('fork-workspace-failure', workspaceFailure.cwd, { origin: 'subagent' })
    attach(workspaceFailure, child)
    await expect(workspaceFailure.service.fork({
      sessionId: child.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })

    const workspaceCancelled = await harness()
    const cancelledChild = completedSession('fork-workspace-cancelled', workspaceCancelled.cwd, {
      origin: 'subagent',
    })
    attach(workspaceCancelled, cancelledChild)
    const workspaceController = new AbortController()
    workspaceCancelled.traceSession.mockImplementationOnce(async () => {
      workspaceController.abort(new Error('workspace cancelled'))
      throw new Error('trace stopped')
    })
    await expect(workspaceCancelled.service.fork({
      sessionId: cancelledChild.id,
    }, workspaceController.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    const createCancelled = await harness()
    const createSource = completedSession('fork-create-cancelled', createCancelled.cwd)
    attach(createCancelled, createSource)
    const createController = new AbortController()
    createCancelled.create.mockImplementationOnce(async () => {
      createController.abort(new Error('fork create cancelled'))
      throw new Error('create stopped')
    })
    await expect(createCancelled.service.fork({
      sessionId: createSource.id,
    }, createController.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    const admission = await harness()
    const admissionSource = completedSession('fork-admission-error', admission.cwd)
    attach(admission, admissionSource)
    admission.admissionError = new Error('fork admission error')
    await expect(admission.service.fork({
      sessionId: admissionSource.id,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'fork-unavailable', message: 'fork admission error' },
    })
  })

  it('iterates unmatched subagent ancestors before returning no workspace', async () => {
    const state = await harness()
    const source = completedSession('fork-unmatched-ancestor', state.cwd, { origin: 'subagent' })
    state.traceSession.mockResolvedValueOnce({
      target: { header: source.header, live: false, persisted: true },
      ancestors: [{ header: header('unmatched', state.cwd), live: false, persisted: true }],
      complete: true,
      root: { header: source.header, live: false, persisted: true },
      descendants: [],
    })
    const result = await (state.service as unknown as {
      forkWorkspace(
        source: { id: SessionId; header: SessionHeader; events: SessionEvent[] },
        signal: AbortSignal,
      ): Promise<Workspace | undefined>
    }).forkWorkspace({
      id: source.id,
      header: source.header,
      events: [...source.events],
    }, new AbortController().signal)
    expect(result).toBeUndefined()
  })

  it('keeps a fork result when releasing its source observations fails', async () => {
    const state = await harness()
    const warn = vi.spyOn(state.ctx.logger, 'warn').mockImplementation(() => undefined)
    const source = completedSession('fork-release-failure', state.cwd, { agentPreset: 'standard' })
    let failing = false
    Reflect.set(state.ctx.sessionPersistence, 'borrowSession', async () => ({
      source: 'prepared',
      inspection: { meta: source.header, events: source.events },
      revision: SessionPersistenceRevision('fork-release-v1'),
      preparedSession: source,
      [Symbol.dispose]: () => {
        if (failing) throw new Error('synthetic release failure')
      },
    }))
    const sourceRevision = await historyRevision(state, source)
    failing = true
    const result = await state.service.fork({ sessionId: source.id, sourceRevision }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true })
    expect(state.create).toHaveBeenCalledOnce()
    expect(state.flush).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('failed to release a fork source observation')
  })
})

describe('Session Remote prompt, attachment, queue, and cancellation', () => {
  const prompt = (sessionId: SessionId, overrides: Record<string, unknown> = {}) => ({
    sessionId,
    invocationId: SessionPromptInvocationId('invocation'),
    mode: 'queue' as const,
    content: [{ type: 'text' as const, text: 'hello' }],
    ...overrides,
  })

  it('validates prompt identity/time zone and routes commands without entering the model inbox', async () => {
    const state = await harness()
    const session = emptySession('prompt-command', state.cwd)
    const agent = attach(state, session)
    await expect(state.service.prompt(prompt(session.id), cancelledSignal()))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    await expect(state.service.prompt(prompt(session.id, {
      invocationId: SessionPromptInvocationId(''),
    }), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid-invocation-id' },
    })
    for (const clientTimeZone of ['', ' UTC', 'UTC ', 'Invalid', 'Area/Definitely-Invalid']) {
      await expect(state.service.prompt(prompt(session.id, {
        clientTimeZone,
      }), new AbortController().signal)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid-time-zone' },
      })
    }

    state.commandExecute.mockResolvedValueOnce(undefined)
    await expect(state.service.prompt(prompt(session.id, {
      content: [{ type: 'text', text: '/missing' }],
    }), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown-command' },
    })
    state.commandExecute.mockResolvedValueOnce({
      commandId: 'bad',
      result: { kind: 'error', text: 'not allowed' },
    })
    await expect(state.service.prompt(prompt(session.id, {
      content: [{ type: 'text', text: '/bad' }],
    }), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'command-error' },
    })
    state.commandExecute.mockResolvedValueOnce({
      commandId: 'ok',
      result: { kind: 'success', text: undefined },
    })
    await expect(state.service.prompt(prompt(session.id, {
      content: [{ type: 'text', text: '/ok' }],
    }), new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { accepted: true, command: { kind: 'success' } },
    })
    state.commandExecute.mockResolvedValueOnce({
      commandId: 'ok-text',
      result: { kind: 'success', text: 'done' },
    })
    await expect(state.service.prompt(prompt(session.id, {
      content: [{ type: 'text', text: '/ok text' }],
    }), new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { accepted: true, command: { kind: 'success', text: 'done' } },
    })
    state.commandExecute.mockRejectedValueOnce(new Error('command exploded'))
    await expect(state.service.prompt(prompt(session.id, {
      content: [{ type: 'text', text: '/explode' }],
    }), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'command-error', message: 'command exploded' },
    })
    state.commandExecute.mockRejectedValueOnce('command string failure')
    await expect(state.service.prompt(prompt(session.id, {
      content: [{ type: 'text', text: '/explode' }],
    }), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { message: 'command string failure' },
    })
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('delivers queued and steering text with canonical time zones and lifecycle revalidation', async () => {
    const state = await harness()
    const session = emptySession('prompt-text', state.cwd)
    const agent = attach(state, session)
    await expect(state.service.prompt(prompt(session.id, {
      clientTimeZone: 'America/New_York',
    }), new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { accepted: true },
    })
    const queuedMessage: unknown = agent.followup.mock.calls[0]?.[0]
    expect(queuedMessage).toMatchObject({
      source: {
        kind: 'user',
        invocationId: SessionPromptInvocationId('invocation'),
        clientTimeZone: 'America/New_York',
      },
    })

    await expect(state.service.prompt(prompt(session.id, {
      invocationId: SessionPromptInvocationId('steer'),
      mode: 'steer',
      clientTimeZone: 'UTC',
    }), new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { accepted: true },
    })
    const steeredMessage: unknown = agent.steer.mock.calls[0]?.[0]
    expect(steeredMessage).toMatchObject({
      source: { kind: 'user', invocationId: SessionPromptInvocationId('steer'), clientTimeZone: 'UTC' },
    })

    state.providers = []
    await expect(state.service.prompt(prompt(session.id, { invocationId: SessionPromptInvocationId('fresh-invocation') }), new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'model-unavailable' } })
    state.providers = [{ id: 'provider', name: 'Provider' }]

    state.admissionError = new Error('lifecycle changed')
    await expect(state.service.prompt(prompt(session.id, { invocationId: SessionPromptInvocationId('fresh-invocation') }), new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'agent-busy' } })
    state.admissionError = undefined
    agent.followup.mockImplementationOnce(() => { throw 'followup rejected' })
    await expect(state.service.prompt(prompt(session.id, { invocationId: SessionPromptInvocationId('fresh-invocation') }), new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'agent-busy' } })
  })

  it('admits ordered images for every model modality and translates attachment failures', async () => {
    const state = await harness()
    const session = emptySession('prompt-image', state.cwd)
    const agent = attach(state, session)
    const imagePrompt = prompt(session.id, {
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', data: 'AQID', mediaType: 'image/png', name: 'image.png' },
        { type: 'text', text: 'after' },
      ],
    })
    // Ark 定制：text-only 路由同样放行上传，能否识别由模型决定。
    state.resolveModelInfo.mockResolvedValueOnce({ inputModalities: ['text'] })
    await expect(state.service.prompt(imagePrompt, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    const imageMessage: unknown = agent.followup.mock.calls[0]?.[0]
    expect(imageMessage).toMatchObject({
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', attachment: { attachmentId: 'attachment-0' } },
        { type: 'text', text: 'after' },
      ],
    })

    state.resolveModelInfo.mockResolvedValue({ inputModalities: ['text', 'image'] })
    state.attachmentError = new AttachmentError('bad image', 'INVALID_IMAGE_BASE64')
    await expect(state.service.prompt({ ...imagePrompt, invocationId: SessionPromptInvocationId('fresh-image') }, new AbortController().signal))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'attachment-error', details: { reason: 'INVALID_IMAGE_BASE64' } },
      })
    state.attachmentError = 'storage string failure'
    await expect(state.service.prompt({ ...imagePrompt, invocationId: SessionPromptInvocationId('fresh-image') }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'agent-busy' } })
  })

  it('deduplicates image-only retries before decoding but admits a new invocation with the same image', async () => {
    const state = await harness()
    const session = emptySession('image-only-retry', state.cwd)
    const agent = attach(state, session)
    const request = prompt(session.id, { content: [{ type: 'image', data: 'AQID', mediaType: 'image/png' }] })
    expect(await Promise.all([
      state.service.prompt(request, new AbortController().signal),
      state.service.prompt(request, new AbortController().signal),
    ])).toEqual([{ ok: true, value: { accepted: true } }, { ok: true, value: { accepted: true } }])
    expect(state.saveImages).toHaveBeenCalledOnce()
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(await state.service.prompt({ ...request, invocationId: SessionPromptInvocationId('new-image-send') },
      new AbortController().signal)).toMatchObject({ ok: true })
    expect(state.saveImages).toHaveBeenCalledTimes(2)
    expect(agent.followup).toHaveBeenCalledTimes(2)
    expect(await state.service.prompt({ ...request, content: [{ type: 'image', data: 'BAUG', mediaType: 'image/png' }] },
      new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'invocation-conflict' } })
    expect(state.saveImages).toHaveBeenCalledTimes(2)
  })

  it('authorizes every durable image carrier and rejects missing or failed reads', async () => {
    const state = await harness()
    const ref = (id: string) => ({
      attachmentId: id,
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    })
    const carriers: SessionEvent[] = [
      {
        type: 'carrier/direct',
        seq: 0,
        time: 1,
        data: { content: [null, [], 1, { type: 'image', attachment: ref('direct') }] },
      },
      {
        type: 'carrier/wrapped',
        seq: 1,
        time: 2,
        data: { message: { content: [{ type: 'image', attachment: ref('wrapped') }] } },
      },
      {
        type: 'carrier/inserted',
        seq: 2,
        time: 3,
        data: { inserted: [{ content: [{ type: 'image', attachment: ref('inserted') }] }] },
      },
      {
        type: 'carrier/nested',
        seq: 3,
        time: 4,
        data: {
          content: [{
            type: 'tool-result',
            content: [{ type: 'image', attachment: ref('nested') }],
          }],
        },
      },
      {
        type: 'assistant/chunk',
        seq: 4,
        time: 5,
        data: {
          chunk: { type: 'block-end', block: { type: 'image', attachment: ref('chunk') } },
        },
      },
      {
        type: 'assistant/chunk',
        seq: 5,
        time: 6,
        data: { chunk: { type: 'block-start' } },
      },
    ] as never
    const persisted = header('attachment-session', state.cwd)
    state.persistenceHeaders.push(persisted)
    state.persistenceEvents.set('attachment-session', carriers)

    for (const attachmentId of ['direct', 'wrapped', 'inserted', 'nested', 'chunk']) {
      await expect(state.service.attachment({
        sessionId: persisted.id,
        attachmentId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: true,
        value: { attachment: { attachmentId }, data: 'AQID' },
      })
    }
    await expect(state.service.attachment({
      sessionId: persisted.id,
      attachmentId: 'missing',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'ATTACHMENT_NOT_REFERENCED' } },
    })
    await expect(state.service.attachment({
      sessionId: persisted.id,
      attachmentId: 'direct',
    }, cancelledSignal())).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    await expect(state.service.attachment({
      sessionId: SessionId('missing-session'),
      attachmentId: 'direct',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-not-found' },
    })

    state.attachmentError = new AttachmentError('missing bytes', 'ATTACHMENT_NOT_FOUND')
    await expect(state.service.attachment({
      sessionId: persisted.id,
      attachmentId: 'direct',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'attachment-error' },
    })
    state.attachmentError = 'storage failed'
    await expect(state.service.attachment({
      sessionId: persisted.id,
      attachmentId: 'direct',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
  })

  it('covers every queue action and generic cancellation fence', async () => {
    const state = await harness()
    const session = emptySession('queue-coverage', state.cwd)
    const queued = createUserMessage({
      content: [{ type: 'text', text: 'queued' }],
      source: { kind: 'user' },
    })
    const step = createUserMessage({
      content: [{ type: 'text', text: 'step' }],
      source: { kind: 'user' },
    })
    const agent = attach(state, session, {
      status: 'running',
      nextTurn: [queued],
      nextStep: [step],
    })
    await expect(state.service.updateQueue({
      sessionId: session.id,
      itemId: String(queued.id),
      action: { kind: 'remove' },
    }, cancelledSignal())).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    for (const content of [
      [null],
      [[]],
      [1],
      [{ type: 'image', data: 'x' }],
      [{ type: 'text', text: 1 }],
    ] as never[]) {
      await expect(state.service.updateQueue({
        sessionId: session.id,
        itemId: String(queued.id),
        action: { kind: 'edit', content },
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false,
        error: { code: 'attachment-error' },
      })
    }
    await expect(state.service.updateQueue({
      sessionId: SessionId('missing'),
      itemId: 'missing',
      action: { kind: 'remove' },
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'queue-item-not-found' },
    })
    await expect(state.service.updateQueue({
      sessionId: session.id,
      itemId: 'missing',
      action: { kind: 'remove' },
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'queue-item-not-found' },
    })
    await expect(state.service.updateQueue({
      sessionId: session.id,
      itemId: String(step.id),
      action: { kind: 'steer' },
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'steer-unavailable' },
    })
    agent.status = 'idle'
    await expect(state.service.updateQueue({
      sessionId: session.id,
      itemId: String(queued.id),
      action: { kind: 'steer' },
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'steer-unavailable' },
    })
    agent.status = 'running'
    await expect(state.service.updateQueue({
      sessionId: session.id,
      itemId: String(queued.id),
      action: { kind: 'edit', content: [{ type: 'text', text: 'edited' }] },
    }, new AbortController().signal)).resolves.toEqual({ ok: true, value: { accepted: true } })
    await expect(state.service.updateQueue({
      sessionId: session.id,
      itemId: String(queued.id),
      action: { kind: 'steer' },
    }, new AbortController().signal)).resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(agent.steer).toHaveBeenCalled()
    await expect(state.service.updateQueue({
      sessionId: session.id,
      itemId: String(step.id),
      action: { kind: 'remove' },
    }, new AbortController().signal)).resolves.toEqual({ ok: true, value: { accepted: true } })

    await expect(state.service.cancel({ sessionId: session.id }, cancelledSignal()))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    await expect(state.service.cancel({
      sessionId: SessionId('missing'),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-not-found' },
    })
    await expect(state.service.cancel({ sessionId: session.id }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })

    const child = emptySession('queue-child', state.cwd, { origin: 'subagent' })
    const childAgent = attach(state, child)
    // A continuable child's queue is its own inbox: a live Agent without the
    // pending item rejects as queue-item-not-found, not with the ownership
    // fence. Cold children keep the fence via the shared resolver elsewhere.
    await expect(state.service.updateQueue({
      sessionId: child.id,
      itemId: 'missing',
      action: { kind: 'remove' },
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'queue-item-not-found' },
    })
    await expect(state.service.cancel({ sessionId: child.id }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'agent-busy' } })
    expect(childAgent.cancel).not.toHaveBeenCalled()
  })

  it('covers canonical-time-zone, missing-command, lifecycle-race, and cancellation fallbacks', async () => {
    const noCommands = await harness({ omit: ['commands'] })
    const noCommandsSession = emptySession('no-commands', noCommands.cwd)
    attach(noCommands, noCommandsSession)
    await expect(noCommands.service.prompt(prompt(noCommandsSession.id, {
      content: [{ type: 'text', text: '/missing' }],
    }), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown-command' },
    })

    const state = await harness()
    const session = emptySession('prompt-fallbacks', state.cwd)
    const agent = attach(state, session)
    const OriginalDateTimeFormat = Intl.DateTimeFormat
    Object.defineProperty(Intl, 'DateTimeFormat', {
      configurable: true,
      value: function invalidCanonicalTimeZone() {
        return { resolvedOptions: () => ({ timeZone: 'GMT' }) }
      },
    })
    try {
      await expect(state.service.prompt(prompt(session.id, {
        clientTimeZone: 'America/New_York',
      }), new AbortController().signal)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid-time-zone' },
      })
    } finally {
      Object.defineProperty(Intl, 'DateTimeFormat', {
        configurable: true,
        value: OriginalDateTimeFormat,
      })
    }

    state.commandExecute.mockResolvedValueOnce(undefined)
    vi.spyOn(String.prototype, 'split').mockReturnValueOnce([])
    const fallback = await state.service.prompt(prompt(session.id, {
      content: [{ type: 'text', text: '/fallback' }],
    }), new AbortController().signal)
    if (fallback.ok) throw new Error('fallback command unexpectedly succeeded')
    expect(fallback.error.code).toBe('unknown-command')
    expect(fallback.error.message).toContain('/fallback')

    const commandController = new AbortController()
    state.commandExecute.mockImplementationOnce(async () => {
      commandController.abort(new Error('command cancelled'))
      throw new Error('command stopped')
    })
    await expect(state.service.prompt(prompt(session.id, {
      content: [{ type: 'text', text: '/cancel' }],
    }), commandController.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    state.assertAdmission
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { state.agents.delete(String(session.id)) })
    await expect(state.service.prompt(prompt(session.id), new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'agent-busy' } })
    state.agents.set(String(session.id), agent)

    const promptController = new AbortController()
    agent.followup.mockImplementationOnce(() => {
      promptController.abort(new Error('prompt cancelled'))
      throw new Error('followup stopped')
    })
    await expect(state.service.prompt(prompt(session.id), promptController.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })

    const imageController = new AbortController()
    state.saveImages.mockImplementationOnce(async () => {
      imageController.abort(new Error('image admission cancelled'))
      throw new Error('image stopped')
    })
    await expect(state.service.prompt(prompt(session.id, {
      content: [{ type: 'image', data: 'AQID', mediaType: 'image/png' }],
    }), imageController.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })

  it('returns cancellation when attachment reading loses its signal race', async () => {
    const state = await harness()
    const persisted = header('attachment-cancelled', state.cwd)
    state.persistenceHeaders.push(persisted)
    state.persistenceEvents.set('attachment-cancelled', [{
      type: 'carrier',
      seq: 0,
      time: 1,
      data: {
        content: [{
          type: 'image',
          attachment: {
            attachmentId: 'cancelled',
            mediaType: 'image/png',
            bytes: 3,
            width: 1,
            height: 1,
          },
        }],
      },
    } as never])
    const controller = new AbortController()
    state.readImage.mockImplementationOnce(async () => {
      controller.abort(new Error('attachment cancelled'))
      throw new Error('read stopped')
    })
    await expect(state.service.attachment({
      sessionId: persisted.id,
      attachmentId: 'cancelled',
    }, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })
})

describe('Session Remote archived retirement', () => {
  it('returns for absent residents and rejects cancellation or unowned live Agents', async () => {
    const state = await harness()
    await expect(state.service.retireArchivedSession(SessionId('missing'), new AbortController().signal))
      .resolves.toBeUndefined()
    await expect(state.service.retireArchivedSession(SessionId('missing'), cancelledSignal()))
      .rejects.toThrow('cancelled')

    const foreign = emptySession('foreign', state.cwd)
    attach(state, foreign)
    state.archivedSessionIds = [foreign.id]
    await expect(state.service.retireArchivedSession(foreign.id, new AbortController().signal))
      .rejects.toMatchObject({ reason: 'resident' })
  })

  it('rechecks every safety predicate inside the maintenance boundary', async () => {
    const scenarios = [
      'handle-replaced',
      'handle-agent-changed',
      'agent-replaced',
      'session-replaced',
      'not-root',
      'not-archived',
      'running',
      'pending-inbox',
      'open-turn',
      'owned-job',
    ] as const
    for (const scenario of scenarios) {
      const state = await harness()
      const id = SessionId(`retire-${scenario}`)
      const created = await state.service.create({
        sessionId: id,
        cwd: state.cwd,
      }, new AbortController().signal)
      if (!created.ok) throw new Error(`failed to create ${scenario}`)
      state.archivedSessionIds = [id]
      const agent = state.agents.get(String(id))
      if (agent === undefined) throw new Error('missing owned Agent')
      const internals = state.service as unknown as {
        handles: Map<SessionId, AgentHandle>
      }
      const handle = internals.handles.get(id)
      if (handle === undefined) throw new Error('missing owned handle')
      agent.runMaintenance = async (operation) => {
        switch (scenario) {
          case 'handle-replaced':
            internals.handles.set(id, {
              agent: agent as unknown as Agent,
              dispose: async () => {},
            })
            break
          case 'handle-agent-changed':
            Object.defineProperty(handle, 'agent', {
              configurable: true,
              value: fakeAgent(agent.session),
            })
            break
          case 'agent-replaced':
            state.agents.set(String(id), fakeAgent(agent.session))
            break
          case 'session-replaced':
            state.sessions.set(String(id), emptySession(String(id), state.cwd))
            break
          case 'not-root':
            state.roots.splice(state.roots.indexOf(agent), 1)
            break
          case 'not-archived':
            state.archivedSessionIds = []
            break
          case 'running':
            agent.status = 'running'
            break
          case 'pending-inbox':
            agent.inbox.nextTurn.push(createUserMessage({
              content: [{ type: 'text', text: 'pending' }],
              source: { kind: 'user' },
            }))
            break
          case 'open-turn':
            agent.session.append('turn/start', { turn: 1 })
            break
          case 'owned-job':
            state.jobsList.mockReturnValue([{
              id: 'job',
              kind: 'tool',
              label: 'job',
              status: 'running',
              startedAt: 1,
              ownerSession: id,
            }])
            break
        }
        return operation(new AbortController().signal)
      }
      await expect(state.service.retireArchivedSession(id, new AbortController().signal))
        .rejects.toMatchObject({ reason: 'resident' })
    }
  })

  it('propagates maintenance cancellation and awaits safe or failed disposal in finally', async () => {
    const cancelled = await harness()
    const cancelledId = SessionId('retire-maintenance-cancelled')
    await cancelled.service.create({
      sessionId: cancelledId,
      cwd: cancelled.cwd,
    }, new AbortController().signal)
    cancelled.archivedSessionIds = [cancelledId]
    const cancelledAgent = cancelled.agents.get(String(cancelledId))
    if (cancelledAgent === undefined) throw new Error('missing Agent')
    const maintenanceAbort = new AbortController()
    maintenanceAbort.abort(new Error('maintenance stopped'))
    cancelledAgent.runMaintenance = operation => operation(maintenanceAbort.signal)
    await expect(cancelled.service.retireArchivedSession(
      cancelledId,
      new AbortController().signal,
    )).rejects.toThrow('maintenance stopped')

    const safe = await harness()
    const safeId = SessionId('retire-safe')
    await safe.service.create({ sessionId: safeId, cwd: safe.cwd }, new AbortController().signal)
    safe.archivedSessionIds = [safeId]
    const safeAgent = safe.agents.get(String(safeId))
    if (safeAgent === undefined) throw new Error('missing safe Agent')
    safeAgent.session.append('turn/start', { turn: 1 })
    safeAgent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(safe.service.retireArchivedSession(safeId, new AbortController().signal))
      .resolves.toBeUndefined()
    expect(safe.agents.has(String(safeId))).toBe(false)

    const failed = await harness()
    const failedId = SessionId('retire-dispose-failed')
    await failed.service.create({ sessionId: failedId, cwd: failed.cwd }, new AbortController().signal)
    failed.archivedSessionIds = [failedId]
    failed.disposeError = new Error('dispose failed')
    await expect(failed.service.retireArchivedSession(failedId, new AbortController().signal))
      .rejects.toThrow('dispose failed')
  })
})

describe('Session Remote admission, history source, and delivery contracts', () => {
  const requestFor = (
    sessionId: SessionId,
    invocationId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    sessionId,
    invocationId: SessionPromptInvocationId(invocationId),
    mode: 'queue' as const,
    content: [{ type: 'text' as const, text: 'hello' }],
    ...overrides,
  })

  it('rejects a cold blank probe budget that is not a non-negative safe integer', async () => {
    for (const coldBlankProbeMaxBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(harness({ config: { coldBlankProbeMaxBytes } }))
        .rejects.toThrow(new RangeError('coldBlankProbeMaxBytes must be a non-negative safe integer'))
    }
  })

  it('reports a non-Error admission refusal across the model route', async () => {
    const state = await harness()
    const session = emptySession('models-admission-refusal', state.cwd)
    attach(state, session)
    state.admissionError = 'workspace admission revoked'
    await expect(state.service.models({ sessionId: session.id }, new AbortController().signal))
      .resolves.toEqual({
        ok: false,
        error: {
          code: 'agent-busy',
          message: 'workspace admission revoked',
          details: { reason: 'workspace admission revoked' },
        },
      })
  })

  it('fails a semantic history read whose source cannot be observed', async () => {
    const state = await harness()
    const missing = SessionId('semantic-missing')
    Reflect.set(state.ctx.sessionPersistence, 'borrowSession', async () => {
      throw new SessionPersistenceNotFoundError(missing)
    })
    await expect(state.service.history({ sessionId: missing, view: 'semantic' }, new AbortController().signal))
      .resolves.toEqual({
        ok: false,
        error: {
          code: 'internal',
          message: 'semantic history unavailable: SessionQueryError: session "semantic-missing" not found',
          details: {},
        },
      })
  })

  it('returns cancellation for a semantic history source aborted while it was read', async () => {
    const state = await harness()
    const controller = new AbortController()
    Reflect.set(state.ctx.sessionPersistence, 'borrowSession', async () => {
      controller.abort(new Error('caller cancelled the semantic read'))
      throw new Error('borrow interrupted')
    })
    await expect(state.service.history({
      sessionId: SessionId('semantic-aborted'),
      view: 'semantic',
    }, controller.signal)).resolves.toEqual({
      ok: false,
      error: { code: 'cancelled', message: 'session Remote invocation was cancelled', details: {} },
    })
  })

  it('confirms durability before reporting an ordinary prompt accepted', async () => {
    const state = await harness()
    const session = emptySession('prompt-durability-owner', state.cwd)
    const agent = attach(state, session)
    state.flush.mockResolvedValueOnce(false)
    const request = requestFor(session.id, 'durability')
    await expect(state.service.prompt(request, new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: {
        code: 'prompt-durability-unconfirmed',
        message: 'prompt was accepted but its durable acknowledgement is not confirmed',
        details: {
          accepted: true,
          invocationId: SessionPromptInvocationId('durability'),
          reason: 'Error: ordinary prompt has no durability owner',
        },
      },
    })
    await expect(state.service.prompt(request, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(agent.followup).toHaveBeenCalledOnce()
  })

  it('rejects a prompt for a live session owned by subagent routing', async () => {
    // Omitting the projection owner proves admission returns at the ownership
    // fence: without it the receipt lookup would report prompt-unavailable.
    const state = await harness({ omit: ['sessionProjections'] })
    const session = emptySession('prompt-subagent-owned', state.cwd, {
      origin: 'subagent',
      parentSession: SessionId('parent-of-child'),
    })
    const agent = attach(state, session)
    await expect(state.service.prompt(requestFor(session.id, 'invocation'), new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: {
        code: 'agent-busy',
        message: 'session "prompt-subagent-owned" is owned by subagent routing',
        details: { reason: 'use subagent delivery for this child session' },
      },
    })
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('fails a cold prompt when no persistence owner is mounted', async () => {
    const state = await harness({ omit: ['sessionPersistence'] })
    const sessionId = SessionId('prompt-cold-without-persistence')
    await expect(state.service.prompt(requestFor(sessionId, 'invocation'), new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: `resume failed for session "${sessionId}": Error: session persistence is not configured`,
        details: {},
      },
    })
    expect(state.resume).not.toHaveBeenCalled()
  })

  it('requires a persistence owner before admitting a live ordinary prompt', async () => {
    const state = await harness({ omit: ['sessionPersistence'] })
    const session = emptySession('prompt-live-without-persistence', state.cwd)
    const agent = attach(state, session)
    await expect(state.service.prompt(requestFor(session.id, 'invocation'), new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: {
        code: 'prompt-unavailable',
        message: 'ordinary prompts require a persistence owner',
        details: {},
      },
    })
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('rechecks a session that became live while its cold log was verified', async () => {
    const state = await harness()
    // The persistence owner returns the pre-race snapshot while the live log
    // already recorded this invocation under a different digest.
    const prepared = emptySession('prompt-live-race', state.cwd)
    const session = emptySession('prompt-live-race', state.cwd)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'accepted before this delivery' }],
      source: {
        kind: 'user',
        invocationId: SessionPromptInvocationId('invocation'),
        promptDigest: 'v1:already-accepted',
      },
    }), { surfaceOp: 'append' })
    let live: TestAgent | undefined
    Reflect.set(state.ctx.sessionPersistence, 'borrowSession', async () => {
      live = attach(state, session)
      return {
        source: 'prepared',
        inspection: { meta: prepared.header, events: prepared.events },
        revision: SessionPersistenceRevision('prompt-live-race-v1'),
        preparedSession: prepared,
        [Symbol.dispose]: () => {},
      }
    })
    await expect(state.service.prompt(requestFor(session.id, 'invocation'), new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: {
        code: 'invocation-conflict',
        message: 'invocationId was already accepted with different or unverifiable input',
        details: {},
      },
    })
    expect(state.resume).not.toHaveBeenCalled()
    expect(live?.followup).not.toHaveBeenCalled()
  })

  it('rejects a prompt whose cold source resolved live outside the registry', async () => {
    const state = await harness()
    const session = emptySession('prompt-live-outside-registry', state.cwd)
    Reflect.set(state.ctx.sessionPersistence, 'borrowSession', async () => ({
      source: 'live',
      inspection: { meta: session.header, events: session.events },
      [Symbol.dispose]: () => {},
    }))
    await expect(state.service.prompt(requestFor(session.id, 'invocation'), new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: {
        code: 'agent-busy',
        message: 'session lifecycle changed while verifying prompt admission',
        details: {},
      },
    })
    expect(state.resume).not.toHaveBeenCalled()
  })

  it('prefers caller cancellation over a failed cold prompt admission', async () => {
    const state = await harness()
    const controller = new AbortController()
    Reflect.set(state.ctx.sessionPersistence, 'borrowSession', async () => {
      controller.abort(new Error('caller cancelled admission'))
      throw new Error('borrow interrupted')
    })
    await expect(state.service.prompt(requestFor(SessionId('prompt-admission-aborted'), 'invocation'), controller.signal))
      .resolves.toEqual({
        ok: false,
        error: { code: 'cancelled', message: 'session Remote invocation was cancelled', details: {} },
      })
  })

  it('rejects prompt content without non-whitespace text or an attachment', async () => {
    const state = await harness()
    const session = emptySession('prompt-blank-content', state.cwd)
    const agent = attach(state, session)
    await expect(state.service.prompt(requestFor(session.id, 'invocation', {
      content: [{ type: 'text', text: '  \n\t ' }],
    }), new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: {
        code: 'bad-request',
        message: 'prompt content must include non-whitespace text or an attachment',
        details: {},
      },
    })
    expect(agent.followup).not.toHaveBeenCalled()
    expect(state.flush).not.toHaveBeenCalled()
  })

  it('retains acceptance when a reentrant observer throws after the splice committed', async () => {
    const state = await harness()
    const session = emptySession('prompt-reentrant-observer', state.cwd)
    const agent = attach(state, session)
    agent.followup.mockImplementationOnce((message: UserMessage) => {
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
      throw new Error('reentrant observer rejected the committed splice')
    })
    const request = requestFor(session.id, 'reentrant')
    await expect(state.service.prompt(request, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    await expect(state.service.prompt(request, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(agent.followup).toHaveBeenCalledOnce()
  })

  it('rejects a delivery the session log never recorded', async () => {
    const state = await harness()
    const session = emptySession('prompt-unrecorded-delivery', state.cwd)
    const agent = attach(state, session)
    agent.followup.mockImplementationOnce(() => undefined)
    await expect(state.service.prompt(requestFor(session.id, 'invocation'), new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: {
        code: 'agent-busy',
        message: 'prompt rejected',
        details: { reason: 'Error: inbox did not record prompt acceptance' },
      },
    })
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(state.flush).not.toHaveBeenCalled()
  })
})
