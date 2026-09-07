import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent, type AgentStatus } from '@deepseek-ai/dsh-agent'
import type {
  ConnectionDownloadHandler,
  ConnectionEventChannel,
  ConnectionEventFrame,
  ConnectionEventSource,
  ConnectionResponseHandler,
  HostConnectionHandle,
} from '@deepseek-ai/dsh-host-connection'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionChangeListener } from '@deepseek-ai/dsh-session-projection'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ApprovalService, { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import UserQuestionService, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it } from 'vitest'
import NativeEventsService, {
  NATIVE_EVENT_QUEUE_MAX_BYTES,
  NATIVE_EVENT_QUEUE_MAX_FRAMES,
} from '../src/index.ts'

interface CapturedConnection {
  handle: HostConnectionHandle
  readonly sources: Map<ConnectionEventChannel, ConnectionEventSource>
  response: ConnectionResponseHandler | undefined
}

function capturedConnection(): CapturedConnection {
  const sources = new Map<ConnectionEventChannel, ConnectionEventSource>()
  const captured: CapturedConnection = {
    sources,
    response: undefined,
    handle: undefined as unknown as HostConnectionHandle,
  }
  captured.handle = {
    rpc: {
      handle: () => { throw new Error('unused dedicated RPC registration') },
      intercept: () => { throw new Error('unused shared RPC registration') },
    },
    events: {
      handle(channel: ConnectionEventChannel, source: ConnectionEventSource) {
        if (sources.has(channel)) throw new Error(`duplicate ${channel} source`)
        sources.set(channel, source)
        return async () => { sources.delete(channel) }
      },
    },
    responses: {
      handle(handler: ConnectionResponseHandler) {
        if (captured.response !== undefined) throw new Error('duplicate response owner')
        captured.response = handler
        return async () => { captured.response = undefined }
      },
    },
    downloads: {
      handle(_path: string, _handler: ConnectionDownloadHandler) {
        throw new Error('unused download registration')
      },
    },
  }
  return captured
}

interface Harness {
  readonly ctx: Context
  readonly connection: CapturedConnection
  readonly fiber: { dispose(): Promise<void> }
}

interface HarnessOptions {
  readonly withApproval?: boolean
  readonly workspaceRegistry?: unknown
  readonly jobs?: unknown
  readonly tools?: unknown
  readonly sessionProjections?: unknown
}

async function harness(input: boolean | HarnessOptions = false): Promise<Harness> {
  const options = typeof input === 'boolean' ? { withApproval: input } : input
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (options.withApproval === true) await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  if (options.withApproval === true) await ctx.plugin(ApprovalService)
  const connection = capturedConnection()
  ctx.provide('connection', connection.handle)
  ctx.provide('workspaceRegistry', (options.workspaceRegistry ?? {
    list: () => [],
    get: () => undefined,
    archivedSessionIds: [],
  }) as never)
  if (options.jobs !== undefined) ctx.provide('jobs', options.jobs as never)
  if (options.tools !== undefined) ctx.provide('tools', options.tools as never)
  if (options.sessionProjections !== undefined) {
    ctx.provide('sessionProjections', options.sessionProjections as never)
  }
  const fiber = ctx.plugin(NativeEventsService)
  await fiber.await()
  return { ctx, connection, fiber }
}

/** Drive only the external projection feed; keep Native frame queues real. */
async function projectionHarness() {
  let listener: ProjectionChangeListener | undefined
  const state = await harness({
    sessionProjections: {
      onChanged(callback: ProjectionChangeListener) {
        listener = callback
        return () => { listener = undefined }
      },
    },
  })
  const publish: ProjectionChangeListener = (...args) => {
    if (listener === undefined) throw new Error('projection listener is not active')
    listener(...args)
  }
  return { ...state, publish }
}

interface LiveAgent {
  readonly session: Session
  readonly agent: Agent
  setStatus(status: AgentStatus): void
  dispose(): void
}

function attachAgent(ctx: Context, id: string, initialStatus: AgentStatus): LiveAgent {
  const session = ctx.sessions.prepare(SessionId(id))
  const detachSession = ctx.sessions.enter(session)
  let status = initialStatus
  const agentCtx = new Context()
  const agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status(): AgentStatus { return status },
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  Object.defineProperty(agentCtx, 'agent', { configurable: true, value: agent })
  const detachAgent = ctx.agents.enter(agent, undefined)
  ctx.sessions.announce(session)
  ctx.agents.announce(agent)
  return {
    session,
    agent,
    setStatus(next) {
      status = next
      ctx.emit('agent/status', { agent, status: next })
    },
    dispose() {
      detachAgent()
      detachSession()
    },
  }
}

interface OpenStream {
  readonly abort: AbortController
  readonly iterator: AsyncIterator<ConnectionEventFrame>
}

function open(connection: CapturedConnection, channel: ConnectionEventChannel): OpenStream {
  const source = connection.sources.get(channel)
  if (source === undefined) throw new Error(`missing ${channel} source`)
  const abort = new AbortController()
  return { abort, iterator: source(abort.signal)[Symbol.asyncIterator]() }
}

async function next(stream: OpenStream, type: string): Promise<ConnectionEventFrame> {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    const result = await Promise.race([
      stream.iterator.next(),
      new Promise<never>((_, reject) => {
        setTimeout(() => { reject(new Error(`timed out waiting for ${type}`)) }, 250)
      }),
    ])
    if (result.done === true) throw new Error(`stream ended before ${type}`)
    if (result.value.payload.type === type) return result.value
  }
  throw new Error(`too many frames before ${type}`)
}

async function nextSessionEvent(stream: OpenStream, eventType: string): Promise<ConnectionEventFrame> {
  for (let attempts = 0; attempts < 30; attempts += 1) {
    const frame = await next(stream, 'session/event')
    const payload = frame.payload as { event?: { type?: string } }
    if (payload.event?.type === eventType) return frame
  }
  throw new Error(`too many Session events before ${eventType}`)
}

async function close(stream: OpenStream): Promise<void> {
  stream.abort.abort()
  await stream.iterator.return?.()
}

describe('native event ownership', () => {
  it('contains no dependency or source reference to the retired proxy owner', async () => {
    const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const packageName = ['@deepseek-ai/dsh-host-', 'apiproxy'].join('')
    const contextMember = ['api', 'Proxy'].join('')
    expect(packageJson).not.toContain(packageName)
    expect(source).not.toContain(packageName)
    expect(source).not.toContain(contextMember)
  })

  it('emits complete mux and host baselines even when there are zero sessions', async () => {
    const state = await harness()
    const mux = open(state.connection, 'mux')
    const host = open(state.connection, 'host')
    try {
      const muxBegin = await next(mux, 'stream/baseline')
      const muxComplete = await next(mux, 'stream/baseline')
      expect(muxBegin.payload).toMatchObject({ channel: 'mux', phase: 'begin' })
      expect(muxComplete.payload).toMatchObject({
        channel: 'mux',
        generation: muxBegin.payload.generation,
        phase: 'complete',
        sessionIds: [],
      })

      const hostBegin = await next(host, 'stream/baseline')
      const hostComplete = await next(host, 'stream/baseline')
      expect(hostBegin.payload).toMatchObject({ channel: 'host', phase: 'begin' })
      expect(hostComplete.payload).toMatchObject({
        channel: 'host',
        generation: hostBegin.payload.generation,
        phase: 'complete',
        sessionIds: [],
      })
    } finally {
      await close(mux)
      await close(host)
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it.each(['mux', 'host'] as const)('cleans up a %s source whose signal is already aborted', async (channel) => {
    let jobListeners = 0
    let workspaceLookups = 0
    const state = await harness({
      jobs: {
        list: () => [],
        onJobsChanged: () => {
          jobListeners += 1
          return () => { jobListeners -= 1 }
        },
      },
      workspaceRegistry: {
        list: () => [],
        get: () => { workspaceLookups += 1; return undefined },
        archivedSessionIds: [],
      },
    })
    const abort = new AbortController()
    abort.abort(new Error('cancelled before event source opens'))
    const source = state.connection.sources.get(channel)!
    const iterator = source(abort.signal)[Symbol.asyncIterator]()
    let fresh: OpenStream | undefined
    try {
      await expect(iterator.next()).resolves.toMatchObject({ done: true })
      expect(jobListeners).toBe(0)
      state.ctx.emit('domain/changed', {
        domain: 'workspace', table: '', key: '', operation: 'put',
        value: { initialized: true, workspaceIds: ['late-workspace'], archivedSessionIds: [] },
      })
      expect(workspaceLookups).toBe(0)
      fresh = open(state.connection, channel)
      await next(fresh, 'stream/baseline')
      expect((await next(fresh, 'stream/baseline')).payload).toMatchObject({ phase: 'complete', channel })
    } finally {
      await iterator.return?.()
      if (fresh !== undefined) await close(fresh)
      expect(jobListeners).toBe(0)
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it.each(['circular', 'reentrant'] as const)('contains a %s projection encoding failure within its mux generation', async (shape) => {
    const state = await projectionHarness()
    const live = attachAgent(state.ctx, 'encoding-failure', 'idle')
    const mux = open(state.connection, 'mux')
    const host = open(state.connection, 'host')
    let replacement: OpenStream | undefined
    try {
      await next(mux, 'stream/baseline')
      await next(mux, 'stream/baseline')
      await next(host, 'stream/baseline')
      await next(host, 'stream/baseline')
      const waiting = mux.iterator.next()
      await Promise.resolve()
      const circular: Record<string, unknown> = {}
      circular.self = circular
      // Deliberately faulty external projection values test containment, not
      // normal JSON projection behavior or private ring-state reachability.
      const value = shape === 'circular' ? circular : {
        toJSON() {
          state.publish(live.session, 'tokenUsage', 1n, 1)
          throw new Error('later outer encoding failure')
        },
      }
      state.publish(live.session, 'tokenUsage', value, 2)
      const failure = await waiting.then(() => undefined, (error: unknown) => error)
      expect(failure).toMatchObject({
        code: 'EVENT_FRAME_ENCODING_FAILED',
        details: { maximumFrames: NATIVE_EVENT_QUEUE_MAX_FRAMES, maximumBytes: NATIVE_EVENT_QUEUE_MAX_BYTES },
      })
      expect(String(failure)).toMatch(shape === 'circular' ? /circular/i : /BigInt/i)
      expect(String(failure)).not.toContain('later outer encoding failure')
      await expect(mux.iterator.next()).resolves.toMatchObject({ done: true })

      live.setStatus('running')
      expect((await next(host, 'host/session-status')).payload).toMatchObject({ running: true })
      replacement = open(state.connection, 'mux')
      await next(replacement, 'stream/baseline')
      await next(replacement, 'stream/baseline')
      state.publish(live.session, 'tokenUsage', { total: 3 }, 3)
      expect((await next(replacement, 'session/projection')).payload).toMatchObject({ value: { total: 3 }, seq: 3 })
    } finally {
      if (replacement !== undefined) await close(replacement)
      await close(mux)
      await close(host)
      live.dispose()
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it('preserves FIFO and releases encoded-byte capacity across a full ring wrap', async () => {
    const state = await projectionHarness()
    const live = attachAgent(state.ctx, 'ring-wrap', 'idle')
    const mux = open(state.connection, 'mux')
    try {
      await next(mux, 'stream/baseline')
      await next(mux, 'stream/baseline')
      for (let index = 0; index < NATIVE_EVENT_QUEUE_MAX_FRAMES + 8; index += 1) {
        state.publish(live.session, 'tokenUsage', { total: index }, index)
        const frame = await mux.iterator.next()
        expect(frame).toMatchObject({ done: false, value: { payload: {
          type: 'session/projection', sessionId: live.session.id, value: { total: index }, seq: index,
        } } })
      }
      const content = '界'.repeat(Math.floor(NATIVE_EVENT_QUEUE_MAX_BYTES / 6))
      for (let index = 0; index < 3; index += 1) {
        state.publish(live.session, 'tokenUsage', content, index)
        const frame = await next(mux, 'session/projection')
        expect(frame.payload.value).toBe(content)
      }
    } finally {
      await close(mux)
      live.dispose()
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it('fails only an overflowing socket generation instead of dropping queued frames', async () => {
    const state = await harness()
    const mux = open(state.connection, 'mux')
    try {
      const internals = state.ctx.nativeEvents as unknown as {
        muxQueues: Set<{ push(frame: ConnectionEventFrame): void }>
      }
      const queue = [...internals.muxQueues][0]
      if (queue === undefined) throw new Error('missing mux queue')
      for (let index = 0; index < NATIVE_EVENT_QUEUE_MAX_FRAMES; index += 1) {
        queue.push({
          rpcId: `overflow-${String(index)}`,
          payload: { type: 'session/event', sessionId: 'overflow', event: { seq: index } },
        })
      }
      await expect(mux.iterator.next()).rejects.toMatchObject({
        code: 'EVENT_QUEUE_OVERFLOW',
        details: {
          maximumFrames: NATIVE_EVENT_QUEUE_MAX_FRAMES,
          maximumBytes: NATIVE_EVENT_QUEUE_MAX_BYTES,
        },
      })
    } finally {
      await close(mux)
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it('fails one generation when a single encoded frame exceeds its byte budget', async () => {
    const state = await harness()
    const mux = open(state.connection, 'mux')
    try {
      const internals = state.ctx.nativeEvents as unknown as {
        muxQueues: Set<{ push(frame: ConnectionEventFrame): void }>
      }
      const queue = [...internals.muxQueues][0]
      if (queue === undefined) throw new Error('missing mux queue')
      queue.push({
        rpcId: 'oversized',
        payload: {
          type: 'session/event',
          sessionId: 'oversized',
          event: { text: 'x'.repeat(NATIVE_EVENT_QUEUE_MAX_BYTES + 1) },
        },
      })
      let failure: unknown
      try {
        await mux.iterator.next()
      } catch (error: unknown) {
        failure = error
      }
      expect(failure).toMatchObject({
        code: 'EVENT_QUEUE_OVERFLOW',
      })
      const details = (failure as { details?: { incomingBytes?: unknown } })?.details
      expect(typeof details?.incomingBytes).toBe('number')
    } finally {
      await close(mux)
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it('replays one pending question with the same rpcId and correlates its response', async () => {
    const state = await harness()
    const live = attachAgent(state.ctx, 'question-reconnect', 'idle')
    const first = open(state.connection, 'mux')
    try {
      await next(first, 'session/subscribed')
      const asked = state.ctx.userQuestions.ask({
        agent: live.agent,
        questions: [{
          id: 'target',
          question: 'Choose one',
          options: [{ label: 'Code' }, { label: 'Docs' }],
        }],
      })
      const requested = await next(first, 'question/requested')
      await close(first)

      const second = open(state.connection, 'mux')
      await next(second, 'session/subscribed')
      const replayed = await next(second, 'question/requested')
      expect(replayed.rpcId).toBe(requested.rpcId)
      expect(state.ctx.nativeEvents.hasPendingSession(live.session.id)).toBe(true)
      const receipt = await state.connection.response?.({
        type: 'client-response',
        rpcId: replayed.rpcId,
        result: {
          ok: true,
          value: {
            sessionId: live.session.id,
            answer: { answers: [{ id: 'target', selected: ['Code'] }] },
          },
        },
      }, new AbortController().signal)
      expect(receipt).toEqual({ accepted: true })
      await expect(asked).resolves.toEqual({ answers: [{ id: 'target', selected: ['Code'] }] })
      expect((await next(second, 'question/resolved')).payload).toMatchObject({ outcome: 'answered' })
      expect(state.ctx.nativeEvents.hasPendingSession(live.session.id)).toBe(false)
      await expect(Promise.resolve(state.connection.response?.({
        type: 'client-response', rpcId: replayed.rpcId, result: { ok: true, value: {} },
      }, new AbortController().signal))).resolves.toEqual({ accepted: false, reason: 'not-pending' })
      await close(second)
    } finally {
      await close(first)
      live.dispose()
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it('re-baselines host status after disconnect while mux reconnects independently', async () => {
    const state = await harness()
    const live = attachAgent(state.ctx, 'status-reconnect', 'running')
    const firstHost = open(state.connection, 'host')
    try {
      expect((await next(firstHost, 'host/session-status')).payload).toMatchObject({ running: true })
      await close(firstHost)
      live.setStatus('idle')

      const mux = open(state.connection, 'mux')
      const host = open(state.connection, 'host')
      expect((await next(mux, 'session/subscribed')).payload).toMatchObject({
        sessionId: live.session.id,
      })
      expect((await next(host, 'host/session-status')).payload).toMatchObject({
        sessionId: live.session.id,
        running: false,
      })
      await close(mux)
      await close(host)
    } finally {
      await close(firstHost)
      live.dispose()
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it('routes an approval by stable rpcId and withdraws an aborted successor', async () => {
    const state = await harness(true)
    const live = attachAgent(state.ctx, 'approval-response', 'running')
    live.session.append('turn/start', { turn: 1 })
    const mux = open(state.connection, 'mux')
    try {
      await next(mux, 'session/subscribed')
      const asked = state.ctx.approval.request({ agent: live.agent, toolName: 'bash' })
      const requested = await next(mux, 'approval/requested')
      const payload = requested.payload as Record<string, unknown>
      expect(await state.connection.response?.({
        type: 'client-response',
        rpcId: requested.rpcId,
        result: {
          ok: true,
          value: {
            sessionId: live.session.id,
            approvalId: payload.approvalId,
            outcome: 'allowed-once',
          },
        },
      }, new AbortController().signal)).toEqual({ accepted: true })
      await expect(asked).resolves.toBe('allowed-once')
      expect((await next(mux, 'approval/resolved')).payload).toMatchObject({ outcome: 'allowed-once' })

      const cancellation = new AbortController()
      const aborted = state.ctx.approval.request({
        agent: live.agent,
        toolName: 'write',
        signal: cancellation.signal,
      })
      const successor = await next(mux, 'approval/requested')
      cancellation.abort()
      await expect(aborted).resolves.toBe('cancelled')
      expect((await next(mux, 'approval/resolved')).payload).toMatchObject({ outcome: 'cancelled' })
      await expect(Promise.resolve(state.connection.response?.({
        type: 'client-response',
        rpcId: successor.rpcId,
        result: { ok: true, value: {} },
      }, new AbortController().signal))).resolves.toEqual({ accepted: false, reason: 'not-pending' })
    } finally {
      await close(mux)
      live.dispose()
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })
})

describe('native interactive response validation', () => {
  const responseEnvelope = (rpcId: string, value: unknown) => ({
    type: 'client-response',
    rpcId,
    result: { ok: true, value },
  })

  it('rejects malformed carrier envelopes without claiming a pending interaction', async () => {
    const state = await harness()
    try {
      const respond = state.connection.response
      if (respond === undefined) throw new Error('missing response handler')
      const signal = new AbortController().signal
      const malformed: unknown[] = [
        null,
        [],
        {},
        { type: 'other', rpcId: 'x', result: { ok: true } },
        { type: 'client-response', rpcId: 1, result: { ok: true } },
        { type: 'client-response', rpcId: 'x', result: { ok: 'yes' } },
        { type: 'client-response', rpcId: 'x', result: { ok: false, error: null } },
        { type: 'client-response', rpcId: 'x', result: { ok: false, error: { code: 1, message: 'x', details: null } } },
        { type: 'client-response', rpcId: 'x', result: { ok: false, error: { code: 'x', message: 1, details: null } } },
        { type: 'client-response', rpcId: 'x', result: { ok: false, error: { code: 'x', message: 'x' } } },
      ]
      for (const value of malformed) {
        await expect(Promise.resolve(respond(value, signal)))
          .resolves.toEqual({ accepted: false, reason: 'bad-response' })
      }
      await expect(Promise.resolve(respond({
        type: 'client-response',
        rpcId: 'not-pending',
        result: { ok: true },
      }, signal))).resolves.toEqual({ accepted: false, reason: 'not-pending' })
      await expect(Promise.resolve(respond({
        type: 'client-response',
        rpcId: 'not-pending-error',
        result: { ok: false, error: { code: 'cancelled', message: 'cancelled', details: null } },
      }, signal))).resolves.toEqual({ accepted: false, reason: 'not-pending' })

      const cancelled = new AbortController()
      cancelled.abort(new Error('response cancelled'))
      expect(() => { void respond({}, cancelled.signal) }).toThrow('response cancelled')
    } finally {
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it('validates every question answer invariant before accepting custom and multi-select answers', async () => {
    const state = await harness()
    const live = attachAgent(state.ctx, 'question-validation', 'idle')
    const mux = open(state.connection, 'mux')
    try {
      await next(mux, 'session/subscribed')
      const asked = state.ctx.userQuestions.ask({
        agent: live.agent,
        questions: [{
          id: 'single',
          question: 'Choose one',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      })
      const requested = await next(mux, 'question/requested')
      const respond = state.connection.response
      if (respond === undefined) throw new Error('missing response handler')
      const signal = new AbortController().signal
      const invalidValues: unknown[] = [
        null,
        { sessionId: '', answer: { answers: [] } },
        { sessionId: live.session.id },
        { sessionId: live.session.id, answer: { answers: 'no' } },
        { sessionId: live.session.id, answer: { answers: [null] } },
        { sessionId: live.session.id, answer: { answers: [{ id: 1, selected: [] }] } },
        { sessionId: live.session.id, answer: { answers: [{ id: 'single', selected: 'A' }] } },
        { sessionId: live.session.id, answer: { answers: [{ id: 'single', selected: [1] }] } },
        { sessionId: live.session.id, answer: { answers: [{ id: 'single', selected: [], custom: 1 }] } },
        { sessionId: 'wrong-session', answer: { answers: [{ id: 'single', selected: ['A'] }] } },
        { sessionId: live.session.id, answer: { answers: [] } },
        { sessionId: live.session.id, answer: { answers: [{ id: 'other', selected: ['A'] }] } },
        { sessionId: live.session.id, answer: { answers: [{ id: 'single', selected: ['A', 'A'] }] } },
        { sessionId: live.session.id, answer: { answers: [{ id: 'single', selected: [], custom: '   ' }] } },
        { sessionId: live.session.id, answer: { answers: [{ id: 'single', selected: ['A'], custom: 'custom' }] } },
        { sessionId: live.session.id, answer: { answers: [{ id: 'single', selected: ['A', 'B'] }] } },
        { sessionId: live.session.id, answer: { answers: [{ id: 'single', selected: ['missing'] }] } },
      ]
      for (const value of invalidValues) {
        await expect(Promise.resolve(respond(responseEnvelope(requested.rpcId, value), signal)))
          .resolves.toEqual({ accepted: false, reason: 'bad-response' })
      }
      await expect(Promise.resolve(respond({
        type: 'client-response',
        rpcId: requested.rpcId,
        result: { ok: false, error: { code: 'server-error', message: 'no', details: null } },
      }, signal))).resolves.toEqual({ accepted: false, reason: 'bad-response' })

      await expect(Promise.resolve(respond(responseEnvelope(requested.rpcId, {
        sessionId: live.session.id,
        answer: { answers: [{ id: 'single', selected: [], custom: 'custom answer' }] },
      }), signal))).resolves.toEqual({ accepted: true })
      await expect(asked).resolves.toEqual({
        answers: [{ id: 'single', selected: [], custom: 'custom answer' }],
      })

      const multiple = state.ctx.userQuestions.ask({
        agent: live.agent,
        questions: [{
          id: 'multiple',
          question: 'Choose many',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      })
      const multipleRequest = await next(mux, 'question/requested')
      await expect(Promise.resolve(respond(responseEnvelope(multipleRequest.rpcId, {
        sessionId: live.session.id,
        answer: { answers: [{ id: 'multiple', selected: ['A', 'B'] }] },
      }), signal))).resolves.toEqual({ accepted: true })
      await expect(multiple).resolves.toEqual({
        answers: [{ id: 'multiple', selected: ['A', 'B'] }],
      })
    } finally {
      await close(mux)
      live.dispose()
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it('accepts only a correlated approval payload and preserves the second cancellation cutoff', async () => {
    const state = await harness(true)
    const live = attachAgent(state.ctx, 'approval-validation', 'running')
    live.session.append('turn/start', { turn: 1 })
    const mux = open(state.connection, 'mux')
    try {
      await next(mux, 'session/subscribed')
      const asked = state.ctx.approval.request({
        agent: live.agent,
        toolName: 'bash',
        callId: CallId('approval-call'),
        reason: 'needs shell',
      })
      const requested = await next(mux, 'approval/requested')
      expect(requested.payload).toMatchObject({
        callId: CallId('approval-call'),
        reason: 'needs shell',
      })
      const payload = requested.payload as unknown as { approvalId: string }
      const respond = state.connection.response
      if (respond === undefined) throw new Error('missing response handler')
      const signal = new AbortController().signal
      const invalidValues: unknown[] = [
        null,
        { sessionId: '', approvalId: payload.approvalId, outcome: 'allowed-once' },
        { sessionId: live.session.id, approvalId: '', outcome: 'allowed-once' },
        { sessionId: live.session.id, approvalId: payload.approvalId, outcome: 'allowed-session' },
        { sessionId: 'wrong', approvalId: payload.approvalId, outcome: 'allowed-once' },
        { sessionId: live.session.id, approvalId: 'wrong', outcome: 'allowed-once' },
      ]
      await expect(Promise.resolve(respond({
        type: 'client-response',
        rpcId: requested.rpcId,
        result: { ok: false, error: { code: 'cancelled', message: 'no', details: null } },
      }, signal))).resolves.toEqual({ accepted: false, reason: 'bad-response' })
      for (const value of invalidValues) {
        await expect(Promise.resolve(respond(responseEnvelope(requested.rpcId, value), signal)))
          .resolves.toEqual({ accepted: false, reason: 'bad-response' })
      }

      const cancellation = new Error('approval response cancelled')
      let checks = 0
      const secondCutoff = {
        throwIfAborted() {
          checks += 1
          if (checks === 2) throw cancellation
        },
      } as AbortSignal
      expect(() => {
        void respond(responseEnvelope(requested.rpcId, {
          sessionId: live.session.id,
          approvalId: payload.approvalId,
          outcome: 'rejected',
        }), secondCutoff)
      }).toThrow(cancellation)

      await expect(Promise.resolve(respond(responseEnvelope(requested.rpcId, {
        sessionId: live.session.id,
        approvalId: payload.approvalId,
        outcome: 'rejected',
      }), signal))).resolves.toEqual({ accepted: true })
      await expect(asked).resolves.toBe('rejected')

      const preCancelled = new AbortController()
      preCancelled.abort()
      await expect(state.ctx.approval.request({
        agent: live.agent,
        toolName: 'write',
        signal: preCancelled.signal,
      })).resolves.toBe('cancelled')
    } finally {
      await close(mux)
      live.dispose()
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it('handles defensive approval waterfall branches and converging settlement', async () => {
    const state = await harness(true)
    const live = attachAgent(state.ctx, 'approval-waterfall', 'running')
    const mux = open(state.connection, 'mux')
    const desiredCall = CallId('desired-call')
    const candidate = ApprovalRequestId('approval-candidate')
    const mismatch = ApprovalRequestId('approval-mismatch')
    const decided = ApprovalRequestId('approval-decided')
    live.session.append('approval/asked', {
      id: candidate,
      toolName: 'bash',
      callId: desiredCall,
    })
    live.session.append('approval/asked', {
      id: mismatch,
      toolName: 'bash',
      callId: CallId('other-call'),
    })
    live.session.append('approval/asked', {
      id: decided,
      toolName: 'bash',
      callId: desiredCall,
    })
    live.session.append('approval/decided', { id: decided, outcome: 'rejected' })
    live.session.append('turn/start', { turn: 1 })
    const request = {
      agent: live.agent,
      toolName: 'bash',
      callId: desiredCall,
    }
    const dispatch = (value: Omit<typeof request, 'callId'> & { callId?: CallId; signal?: AbortSignal }) => state.ctx.waterfall(
      scopeTarget(state.ctx.approval, live.agent),
      'approval/request',
      value,
      () => Promise.resolve('unavailable' as const),
    )
    try {
      await next(mux, 'session/subscribed')
      const pendingResult = dispatch(request)
      const requested = await next(mux, 'approval/requested')
      expect(requested.payload).toMatchObject({ approvalId: candidate })
      expect(state.ctx.nativeEvents.hasPendingSession(live.session.id)).toBe(true)
      const replay = open(state.connection, 'mux')
      await next(replay, 'session/subscribed')
      expect((await next(replay, 'approval/requested')).rpcId).toBe(requested.rpcId)
      await close(replay)

      await expect(dispatch(request)).resolves.toBe('unavailable')

      const cancelled = new AbortController()
      cancelled.abort()
      await expect(dispatch({ ...request, signal: cancelled.signal })).resolves.toBe('cancelled')

      const internals = state.ctx.nativeEvents as unknown as {
        pendingApprovals: Map<string, { resolve(outcome: 'allowed-once' | 'rejected' | 'cancelled'): void }>
      }
      const pending = internals.pendingApprovals.get(requested.rpcId)
      if (pending === undefined) throw new Error('missing pending approval')
      pending.resolve('allowed-once')
      pending.resolve('rejected')
      await expect(pendingResult).resolves.toBe('allowed-once')
      expect(state.ctx.nativeEvents.hasPendingSession(live.session.id)).toBe(false)

      live.session.append('approval/asked', {
        id: ApprovalRequestId('approval-disposal'),
        toolName: 'write',
      })
      const disposedResult = dispatch({ agent: live.agent, toolName: 'write' })
      await next(mux, 'approval/requested')
      await state.fiber.dispose()
      await expect(disposedResult).resolves.toBe('cancelled')
    } finally {
      await close(mux)
      live.dispose()
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it('cancels questions through both the signal listener and response envelope', async () => {
    const state = await harness()
    const live = attachAgent(state.ctx, 'question-cancellation', 'idle')
    const mux = open(state.connection, 'mux')
    const internals = state.ctx.nativeEvents as unknown as {
      askQuestion(request: {
        agent: Agent
        questions: Array<{ id: string; question: string; options?: Array<{ label: string }> }>
        signal?: AbortSignal
      }): Promise<unknown>
    }
    try {
      await next(mux, 'session/subscribed')
      const preCancelled = new AbortController()
      preCancelled.abort()
      await expect(internals.askQuestion({
        agent: live.agent,
        signal: preCancelled.signal,
        questions: [{ id: 'pre-cancelled', question: 'Already cancelled?' }],
      })).rejects.toMatchObject({ code: 'ASK_ABORTED' })

      const controller = new AbortController()
      const signalCancelled = internals.askQuestion({
        agent: live.agent,
        signal: controller.signal,
        questions: [{ id: 'signal', question: 'Abort?' }],
      })
      await next(mux, 'question/requested')
      controller.abort()
      await expect(signalCancelled).rejects.toMatchObject({ code: 'ASK_ABORTED' })
      await next(mux, 'question/resolved')

      const responseCancelled = internals.askQuestion({
        agent: live.agent,
        questions: [{ id: 'response', question: 'Cancel response?' }],
      })
      const requested = await next(mux, 'question/requested')
      const respond = state.connection.response
      if (respond === undefined) throw new Error('missing response handler')
      await expect(Promise.resolve(respond({
        type: 'client-response',
        rpcId: requested.rpcId,
        result: { ok: false, error: { code: 'cancelled', message: 'cancelled', details: null } },
      }, new AbortController().signal))).resolves.toEqual({ accepted: true })
      await expect(responseCancelled).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
      await next(mux, 'question/resolved')

      const noOptions = internals.askQuestion({
        agent: live.agent,
        questions: [{ id: 'none', question: 'No options' }],
      })
      const noOptionsRequest = await next(mux, 'question/requested')
      await expect(Promise.resolve(respond({
        type: 'client-response',
        rpcId: noOptionsRequest.rpcId,
        result: {
          ok: true,
          value: {
            sessionId: live.session.id,
            answer: { answers: [{ id: 'none', selected: [] }] },
          },
        },
      }, new AbortController().signal))).resolves.toEqual({ accepted: true })
      await expect(noOptions).resolves.toEqual({ answers: [{ id: 'none', selected: [] }] })
    } finally {
      await close(mux)
      live.dispose()
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })

  it('rejects missing/pre-cancelled questions and disposes pending work idempotently', async () => {
    const state = await harness()
    const live = attachAgent(state.ctx, 'question-disposal', 'idle')
    const mux = open(state.connection, 'mux')
    try {
      await next(mux, 'session/subscribed')
      await expect(state.ctx.userQuestions.ask({
        questions: [{ id: 'missing', question: 'Missing agent?' }],
      })).rejects.toMatchObject({ code: 'ASK_MISSING_AGENT' })

      const preCancelled = new AbortController()
      preCancelled.abort()
      await expect(state.ctx.userQuestions.ask({
        agent: live.agent,
        signal: preCancelled.signal,
        questions: [{ id: 'cancelled', question: 'Cancelled?' }],
      })).rejects.toMatchObject({ code: 'ASK_ABORTED' })

      const pendingPromise = state.ctx.userQuestions.ask({
        agent: live.agent,
        questions: [{ id: 'pending', question: 'Pending?' }],
      })
      const requested = await next(mux, 'question/requested')
      const internals = state.ctx.nativeEvents as unknown as {
        pendingQuestions: Map<string, unknown>
        claimQuestion(pending: unknown, outcome: 'answered' | 'cancelled'): void
      }
      const pending = internals.pendingQuestions.get(requested.rpcId)
      if (pending === undefined) throw new Error('missing pending question')
      await state.fiber.dispose()
      await expect(pendingPromise).rejects.toBeInstanceOf(UserQuestionError)
      internals.claimQuestion(pending, 'cancelled')
      expect(internals.pendingQuestions.size).toBe(0)
      await next(mux, 'question/resolved')
      expect((await mux.iterator.next()).done).toBe(true)
    } finally {
      await close(mux)
      live.dispose()
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })
})

describe('native mux projection coverage', () => {
  it('replays queues/jobs and projects live inbox, tool, projection, and job changes', async () => {
    let projectionChanged:
      | ((session: Session, key: string, value: unknown, seq: number) => void)
      | undefined
    let jobsChanged: ((owner: Agent | undefined) => void) | undefined
    let jobsDisposed = false
    const job = {
      id: 'job-1',
      kind: 'tool',
      label: 'Compile',
      status: 'running',
      detail: 'building',
      startedAt: 10,
      finishedAt: 20,
    }
    const minimalJob = {
      id: 'job-2',
      kind: 'maintenance',
      label: 'Index',
      status: 'queued',
      startedAt: 11,
    }
    const jobs = {
      list: (owner: Agent | undefined) => owner === undefined
        ? [minimalJob]
        : String(owner.id).startsWith('no-jobs')
          ? []
          : [job],
      onJobsChanged(callback: (owner: Agent | undefined) => void) {
        jobsChanged = callback
        return () => { jobsDisposed = true }
      },
    }
    const tools = {
      get(name: string) {
        if (name === 'good') {
          return {
            presentCall: (args: unknown) => ({ kind: 'call', args }),
            presentResult: (args: unknown, result: unknown) => ({ kind: 'result', args, result }),
          }
        }
        if (name === 'invalid-view') return { presentCall: () => 1n }
        if (name === 'invalid-result') return { presentResult: () => 1n }
        if (name === 'throwing') {
          return {
            presentCall: () => { throw new Error('call presenter failed') },
            presentResult: () => { throw new Error('result presenter failed') },
          }
        }
        return undefined
      },
    }
    const state = await harness({
      jobs,
      tools,
      sessionProjections: {
        onChanged(callback: (session: Session, key: string, value: unknown, seq: number) => void) {
          projectionChanged = callback
          return () => {}
        },
      },
    })
    const live = attachAgent(state.ctx, 'mux-coverage', 'idle')
    const noJobs = attachAgent(state.ctx, 'no-jobs-initial', 'idle')
    let createdWithoutJobs: LiveAgent | undefined
    const queued = createUserMessage({
      content: [{ type: 'text', text: 'queued' }],
      source: { kind: 'user' },
    })
    const steering = createUserMessage({
      content: [{ type: 'text', text: 'steering' }],
      source: { kind: 'user' },
    })
    const context = createUserMessage({
      content: [{ type: 'text', text: 'context' }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: 'settled',
        senderSessionId: SessionId('child'),
        settlementId: 'child:1',
      },
    })
    live.agent.inbox.append('next-turn', queued)
    live.agent.inbox.append('next-step', steering)
    live.agent.inbox.append('next-step', context)
    const mux = open(state.connection, 'mux')
    try {
      await next(mux, 'session/subscribed')
      expect((await next(mux, 'session/queue')).payload).toMatchObject({
        items: [
          { id: queued.id, placement: 'queued' },
          { id: steering.id, placement: 'steering' },
          { id: context.id, placement: 'context' },
        ],
      })
      expect((await next(mux, 'session/jobs')).payload).toMatchObject({
        jobs: [{
          id: 'job-1',
          detail: 'building',
          finishedAt: 20,
        }],
      })

      projectionChanged?.(live.session, 'tokenUsage', { total: 10 }, 7)
      expect((await next(mux, 'session/projection')).payload).toMatchObject({
        key: 'tokenUsage',
        value: { total: 10 },
        seq: 7,
      })

      live.agent.inbox.splice('next-turn', 0, 1, [])
      expect((await next(mux, 'session/queue')).payload).toMatchObject({
        items: [
          { id: steering.id, placement: 'steering' },
          { id: context.id, placement: 'context' },
        ],
      })
      state.ctx.emit('session/event', live.session, {
        type: 'agent/inbox/spliced',
        seq: live.session.seq,
        time: Date.now(),
        data: { target: 'next-turn', start: 0, inserted: [] },
      } as never)
      await next(mux, 'session/queue')

      state.ctx.emit('session/event', live.session, {
        type: 'turn/start',
        seq: live.session.seq,
        time: Date.now(),
        data: { turn: 1 },
      } as never)
      const detached = Session.create(live.session.id, undefined, live.session.header)
      state.ctx.emit('session/event', detached, {
        type: 'agent/inbox/spliced',
        seq: 0,
        time: Date.now(),
        data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [] },
      } as never)

      live.session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: CallId('good-call'),
        name: 'good',
        arguments: '{"path":"README.md"}',
      })
      expect((await nextSessionEvent(mux, 'tool/call')).payload).toMatchObject({
        event: { type: 'tool/call' },
        view: { for: 'call', view: { kind: 'call', args: { path: 'README.md' } } },
      })
      live.session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: CallId('good-call'),
          content: [{ type: 'text', text: 'done' }],
          isError: true,
        }),
        meta: { durationMs: 5 },
      }, { surfaceOp: 'append' })
      expect((await nextSessionEvent(mux, 'tool/result')).payload).toMatchObject({
        event: { type: 'tool/result' },
        view: { for: 'result', view: { kind: 'result', args: { path: 'README.md' } } },
      })

      live.session.append('tool/call', {
        turn: 1,
        step: 2,
        callId: CallId('invalid-json'),
        name: 'good',
        arguments: '{',
      })
      expect((await nextSessionEvent(mux, 'tool/call')).payload).not.toHaveProperty('view')
      live.session.append('tool/call', {
        turn: 1,
        step: 3,
        callId: CallId('invalid-view'),
        name: 'invalid-view',
        arguments: '{}',
      })
      expect((await nextSessionEvent(mux, 'tool/call')).payload).not.toHaveProperty('view')
      live.session.append('tool/call', {
        turn: 1,
        step: 4,
        callId: CallId('missing-presenter'),
        name: 'missing',
        arguments: '{}',
      })
      expect((await nextSessionEvent(mux, 'tool/call')).payload).not.toHaveProperty('view')
      live.session.append('tool/call', {
        turn: 1,
        step: 5,
        callId: CallId('throwing-call'),
        name: 'throwing',
        arguments: '{}',
      })
      expect((await nextSessionEvent(mux, 'tool/call')).payload).not.toHaveProperty('view')
      live.session.append('tool/result', {
        turn: 1,
        step: 6,
        message: createToolResultMessage({
          callId: CallId('unknown-call'),
          content: [{ type: 'text', text: 'unknown' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      expect((await nextSessionEvent(mux, 'tool/result')).payload).not.toHaveProperty('view')

      live.session.append('tool/call', {
        turn: 1,
        step: 7,
        callId: CallId('invalid-result'),
        name: 'invalid-result',
        arguments: '{}',
      })
      await nextSessionEvent(mux, 'tool/call')
      live.session.append('tool/result', {
        turn: 1,
        step: 7,
        message: createToolResultMessage({
          callId: CallId('invalid-result'),
          content: [{ type: 'text', text: 'invalid' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      expect((await nextSessionEvent(mux, 'tool/result')).payload).not.toHaveProperty('view')

      live.session.append('tool/call', {
        turn: 1,
        step: 8,
        callId: CallId('throwing-result'),
        name: 'throwing',
        arguments: '{}',
      })
      await nextSessionEvent(mux, 'tool/call')
      live.session.append('tool/result', {
        turn: 1,
        step: 8,
        message: createToolResultMessage({
          callId: CallId('throwing-result'),
          content: [{ type: 'text', text: 'throw' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      expect((await nextSessionEvent(mux, 'tool/result')).payload).not.toHaveProperty('view')
      live.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await nextSessionEvent(mux, 'turn/end')

      jobsChanged?.(live.agent)
      expect((await next(mux, 'session/jobs')).payload).toMatchObject({ sessionId: live.session.id })
      jobsChanged?.(undefined)
      expect((await next(mux, 'session/jobs')).payload).toMatchObject({ sessionId: live.session.id })

      const created = state.ctx.sessions.prepare(SessionId('mux-created'))
      const detachCreated = state.ctx.sessions.enter(created)
      state.ctx.sessions.announce(created)
      expect((await next(mux, 'session/subscribed')).payload).toMatchObject({ sessionId: created.id })
      detachCreated()
      createdWithoutJobs = attachAgent(state.ctx, 'no-jobs-created', 'idle')
      expect((await next(mux, 'session/subscribed')).payload).toMatchObject({
        sessionId: createdWithoutJobs.session.id,
      })

      const internals = state.ctx.nativeEvents as unknown as {
        muxQueues: Set<{ end(): void; push(frame: ConnectionEventFrame): void }>
        broadcast(payload: { type: 'session/projection'; sessionId: SessionId; key: string; value: unknown; seq: number }): void
      }
      const queue = [...internals.muxQueues][0]
      if (queue === undefined) throw new Error('missing mux queue')
      queue.end()
      internals.broadcast({
        type: 'session/projection',
        sessionId: live.session.id,
        key: 'after-end',
        value: null,
        seq: 8,
      })
    } finally {
      await close(mux)
      live.dispose()
      noJobs.dispose()
      createdWithoutJobs?.dispose()
      await state.fiber.dispose()
      expect(jobsDisposed).toBe(true)
      await state.ctx.fiber.dispose()
    }
  })

  it('waits on an empty mux and wakes exactly when a frame is broadcast', async () => {
    const state = await harness()
    const mux = open(state.connection, 'mux')
    try {
      expect((await next(mux, 'stream/baseline')).payload).toMatchObject({ phase: 'begin' })
      expect((await next(mux, 'stream/baseline')).payload).toMatchObject({ phase: 'complete' })
      const waiting = mux.iterator.next()
      await Promise.resolve()
      const created = state.ctx.sessions.prepare(SessionId('late'))
      const detach = state.ctx.sessions.enter(created)
      state.ctx.sessions.announce(created)
      await expect(waiting).resolves.toMatchObject({
        done: false,
        value: { payload: { type: 'session/subscribed', sessionId: created.id } },
      })
      detach()
    } finally {
      await close(mux)
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })
})

describe('native host projection coverage', () => {
  const workspace = (id: string, title: string): Workspace => ({
    id: WorkspaceId(id),
    path: `/workspace/${id}`,
    title,
    sessionIds: [],
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:01.000Z',
    setTitle: async () => {},
    attachSession: async () => {},
    insertSessionBefore: async () => {},
    detachSession: async () => {},
    status: async () => 'ok',
  })

  it('projects every Host lifecycle, workspace-domain, and forwarded-event edge', async () => {
    const first = workspace('w1', 'One')
    const second = workspace('w2', 'Two')
    const registry = new Map([[String(first.id), first], [String(second.id), second]])
    const state = await harness({
      workspaceRegistry: {
        list: () => [first],
        get: (id: string) => registry.get(id),
        archivedSessionIds: [],
      },
    })
    const running = attachAgent(state.ctx, 'host-running', 'running')
    const idle = attachAgent(state.ctx, 'host-idle', 'idle')
    const host = open(state.connection, 'host')
    const emit = state.ctx.emit.bind(state.ctx) as unknown as (name: string, ...args: unknown[]) => void
    try {
      expect((await next(host, 'host/session-status')).payload).toMatchObject({ running: true })
      expect((await next(host, 'host/session-status')).payload).toMatchObject({ running: false })

      emit('workspace/archived-sessions-changed', [running.session.id])
      expect((await next(host, 'host/archived-sessions-changed')).payload).toMatchObject({
        archivedSessionIds: [running.session.id],
      })
      emit('workspace/session-deleted', idle.session.id, [running.session.id])
      expect((await next(host, 'host/session-deleted')).payload).toMatchObject({
        sessionId: idle.session.id,
      })

      const added = Session.create(SessionId('host-added'), undefined, {
        version: 0,
        id: SessionId('host-added'),
        createdAt: 1,
        cwd: '/workspace/w1',
        parentSession: running.session.id,
        origin: 'subagent',
        agentPreset: 'standard',
      })
      added.append('turn/start', { turn: 1 })
      emit('session/created', added)
      expect((await next(host, 'host/session-added')).payload).toMatchObject({
        sessionId: added.id,
        blank: false,
        parentSessionId: running.session.id,
        origin: 'subagent',
        cwd: '/workspace/w1',
        agentPreset: 'standard',
      })
      const blank = Session.create(SessionId('host-blank'), undefined, {
        version: 0,
        id: SessionId('host-blank'),
        createdAt: 1,
      })
      emit('session/created', blank)
      expect((await next(host, 'host/session-added')).payload).toMatchObject({
        sessionId: blank.id,
        blank: true,
      })
      emit('session/disposed', added)
      expect((await next(host, 'host/session-removed')).payload).toMatchObject({ sessionId: added.id })

      emit('agent/status', { agent: idle.agent, status: 'running' })
      expect((await next(host, 'host/session-status')).payload).toMatchObject({
        sessionId: idle.agent.id,
        running: true,
      })
      emit('agent/status', { agent: idle.agent, status: 'idle' })
      expect((await next(host, 'host/session-status')).payload).toMatchObject({ running: false })
      emit('agent/error', { agent: idle.agent, error: new Error('agent failed') })
      expect((await next(host, 'host/agent-error')).payload).toMatchObject({ message: 'agent failed' })

      emit('domain/changed', {
        domain: 'other',
        table: '',
        key: '',
        operation: 'put',
        value: {},
      })
      emit('domain/changed', {
        domain: 'workspace',
        table: '',
        key: '',
        operation: 'deleted',
      })
      emit('domain/changed', {
        domain: 'workspace',
        table: '',
        key: '',
        operation: 'put',
        value: { initialized: true, workspaceIds: ['w1', 'w2'], archivedSessionIds: [] },
      })
      expect((await next(host, 'host/workspace-changed')).payload).toMatchObject({
        workspace: { workspaceId: second.id, title: 'Two' },
      })
      emit('domain/changed', {
        domain: 'workspace',
        table: '',
        key: '',
        operation: 'put',
        value: { initialized: true, workspaceIds: ['w2', 'w1'], archivedSessionIds: [] },
      })
      expect((await next(host, 'host/workspace-order-changed')).payload).toMatchObject({
        workspaceIds: ['w2', 'w1'],
      })

      emit('domain/changed', {
        domain: 'workspace',
        table: 'other',
        key: 'w1',
        operation: 'put',
        value: {},
      })
      emit('domain/changed', {
        domain: 'workspace',
        table: 'workspaces',
        key: 'unknown',
        operation: 'deleted',
      })
      emit('domain/changed', {
        domain: 'workspace',
        table: 'workspaces',
        key: 'unknown',
        operation: 'put',
        value: {},
      })
      emit('domain/changed', {
        domain: 'workspace',
        table: 'workspaces',
        key: 'w1',
        operation: 'put',
        value: {
          path: '/workspace/w1',
          title: 'One updated',
          sessionIds: [],
          createdAt: first.createdAt,
          updatedAt: '2026-08-31T00:00:02.000Z',
        },
      })
      expect((await next(host, 'host/workspace-changed')).payload).toMatchObject({
        workspace: { workspaceId: first.id, title: 'One updated' },
      })
      emit('domain/changed', {
        domain: 'workspace',
        table: 'workspaces',
        key: 'w2',
        operation: 'deleted',
      })
      expect((await next(host, 'host/workspace-removed')).payload).toMatchObject({ workspaceId: second.id })

      emit('commands/change')
      expect((await next(host, 'host/remote-event')).payload).toMatchObject({
        event: 'commands/change',
        args: [],
      })
      emit('settings/document-updated', { path: '/settings.yaml' })
      expect((await next(host, 'host/remote-event')).payload).toMatchObject({
        event: 'settings/document-updated',
        args: [{ path: '/settings.yaml' }],
      })
      expect(() => { emit('commands/change', 1n) }).toThrow(/not lossless JSON data/)

      registry.delete('w2')
      expect(() => {
        emit('domain/changed', {
          domain: 'workspace',
          table: '',
          key: '',
          operation: 'put',
          value: { initialized: true, workspaceIds: ['w1', 'w2'], archivedSessionIds: [] },
        })
      }).toThrow(/references missing workspace/)
    } finally {
      await close(host)
      running.dispose()
      idle.dispose()
      await state.fiber.dispose()
      await state.ctx.fiber.dispose()
    }
  })
})
