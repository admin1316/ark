import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import * as checkpointPolicy from '../src/index.ts'

const contexts: Context[] = []

class TestPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  delete(_id: SessionId): Promise<boolean> { return Promise.reject(new Error('deletion is not used by checkpoint tests')) }

  override writeState() { return { phase: 'healthy' as const, events: 0, bytes: 0, totalEvents: 0, totalBytes: 0,
    oldestAt: null, lastSuccessAt: null, waitTimeoutMs: 30000, errorCode: null } }
  override waitForCapacity(_session: Session, signal: AbortSignal): Promise<void> {
    return signal.aborted ? Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')) : Promise.resolve()
  }

  locate(_meta: SessionHeader): undefined { return undefined }
  create(_meta: SessionHeader): Promise<void> { return Promise.resolve() }
  append(_id: SessionId, _events: readonly SessionEvent[]): Promise<void> { return Promise.resolve() }
  load(_id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return Promise.reject(new Error('not used'))
  }
  inspect(_id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return Promise.reject(new Error('not used'))
  }
  borrowSession(_id: SessionId, _signal?: AbortSignal): ReturnType<SessionPersistence['borrowSession']> {
    return Promise.reject(new Error('not used'))
  }
  readFrom(_id: SessionId, _fromSeq: number): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return Promise.reject(new Error('not used'))
  }
  list(): Promise<SessionHeader[]> { return Promise.resolve([]) }
  listSnapshots(): Promise<never[]> { return Promise.resolve([]) }
}

class RecordingAdapter extends LlmAdapter {
  constructor(private readonly order: string[]) { super() }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.order.push('adapter')
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TestPersistence)
  await ctx.plugin(checkpointPolicy)
  return ctx
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('session-checkpoint-policy request boundary', () => {
  it('awaits the live session checkpoint before constructing the downstream model stream', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('request-checkpoint'))
    session.append('turn/start', { turn: 1 })
    const gate = Promise.withResolvers<undefined>()
    const order: string[] = []
    ctx.on('session/flush', async () => {
      order.push('flush:start')
      await gate.promise
      order.push('flush:end')
    })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter(order))

    const pending = drain(ctx.llm.stream({
      provider: 'mock', model: 'mock', messages: [], sessionId: session.id,
    }))
    await Promise.resolve()
    expect(order).toEqual(['flush:start'])
    gate.resolve(undefined)
    await pending
    expect(order).toEqual(['flush:start', 'flush:end', 'adapter'])
  })

  it('delegates a request without a live session without checkpointing', async () => {
    const ctx = await setup()
    const order: string[] = []
    ctx.on('session/flush', () => { order.push('flush') })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter(order))
    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [] }))
    expect(order).toEqual(['adapter'])
  })

  it('delegates an already-detached session id without checkpointing', async () => {
    const ctx = await setup()
    const order: string[] = []
    ctx.on('session/flush', () => { order.push('flush') })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter(order))
    await drain(ctx.llm.stream({
      provider: 'mock', model: 'mock', messages: [], sessionId: SessionId('detached'),
    }))
    expect(order).toEqual(['adapter'])
  })

  it('does not dispatch the adapter when the checkpoint rejects', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('request-failure'))
    const order: string[] = []
    ctx.on('session/flush', () => Promise.reject(new Error('disk unavailable')))
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter(order))
    await expect(drain(ctx.llm.stream({
      provider: 'mock', model: 'mock', messages: [], sessionId: session.id,
    }))).rejects.toThrow('disk unavailable')
    expect(order).toEqual([])
  })
})

describe('session-checkpoint-policy tool and step boundaries', () => {
  it('awaits the checkpoint before a top-level tool body', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('tool-checkpoint'))
    const agent = { session } as Agent
    const gate = Promise.withResolvers<undefined>()
    const order: string[] = []
    ctx.on('session/flush', async () => {
      order.push('flush:start')
      await gate.promise
      order.push('flush:end')
    })
    ctx.tools.register({
      name: 'write', description: 'side effect', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => { order.push('tool'); return null },
    })

    const pending = ctx.tools.execute({
      callId: CallId('write-1'), name: 'write', arguments: {}, agent,
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    expect(order).toEqual(['flush:start'])
    gate.resolve(undefined)
    await expect(pending).resolves.toMatchObject({ isError: false })
    expect(order).toEqual(['flush:start', 'flush:end', 'tool'])
  })

  it('does not dispatch when cancellation lands during the tool checkpoint', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('tool-checkpoint-cancel'))
    const agent = { session } as Agent
    const controller = new AbortController()
    const gate = Promise.withResolvers<undefined>()
    const order: string[] = []
    ctx.on('session/flush', async () => {
      order.push('flush:start')
      await gate.promise
      order.push('flush:end')
    })
    ctx.tools.register({
      name: 'write', description: 'side effect', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => { order.push('tool'); return null },
    })

    const pending = ctx.tools.execute({
      callId: CallId('write-cancelled'), name: 'write', arguments: {}, agent,
      signal: controller.signal,
    })
    await Promise.resolve()
    expect(order).toEqual(['flush:start'])
    controller.abort('cancelled during checkpoint')
    gate.resolve(undefined)

    await expect(pending).resolves.toEqual({
      content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
      isError: true,
      error: {
        message: 'tool call aborted before dispatch',
        info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
      },
    })
    expect(order).toEqual(['flush:start', 'flush:end'])
  })

  it('turns a rejected checkpoint into an error result without running the tool body', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('tool-failure'))
    const agent = { session } as Agent
    let ran = false
    ctx.on('session/flush', () => Promise.reject(new Error('disk unavailable')))
    ctx.tools.register({
      name: 'write', description: 'side effect', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => { ran = true; return null },
    })
    const result = await ctx.tools.execute({
      callId: CallId('write-2'), name: 'write', arguments: {}, agent,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: disk unavailable' }])
    expect(ran).toBe(false)
  })

  it('reuses the outer checkpoint for a nested tool dispatch', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('nested-tool'))
    const agent = { session } as Agent
    let flushes = 0
    ctx.on('session/flush', () => { flushes += 1 })
    ctx.tools.register({
      name: 'nested', description: 'nested', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => null,
    })
    await ctx.tools.execute({
      callId: CallId('nested-1'), name: 'nested', arguments: {}, agent,
      parent: Symbol('outer') as never,
      signal: new AbortController().signal,
    })
    expect(flushes).toBe(0)
  })

  it('checkpoints during pre-step processing', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('post-step'))
    const agent = { session } as Agent
    const flushed: string[] = []
    ctx.on('session/flush', (current) => { flushed.push(current.id) })
    const signal = new AbortController().signal
    await agentEvents(ctx, agent).waterfall(
      'agent/pre-step', { messages: [], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter', messages: [] }),
    )
    expect(flushed).toEqual([session.id])
  })
})

describe('session-checkpoint-policy lifecycle', () => {
  it('removes its wrappers when the owning fiber is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(TestPersistence)
    const session = ctx.sessions.create(SessionId('disposed-policy'))
    let flushes = 0
    ctx.on('session/flush', () => { flushes += 1 })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([]))
    const fiber = await ctx.plugin(checkpointPolicy)
    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], sessionId: session.id }))
    expect(flushes).toBe(1)
    await fiber.dispose()
    await drain(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], sessionId: session.id }))
    expect(flushes).toBe(1)
  })

  it('keeps the Loader-safe namespace plugin shape', () => {
    expect('default' in checkpointPolicy).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(checkpointPolicy) as Record<string, unknown>
    expect(unwrapped).toBe(checkpointPolicy)
    expect(unwrapped.name).toBe('session-checkpoint-policy')
    expect(unwrapped.inject).toEqual(['llm', 'sessionPersistence', 'sessions', 'tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})

describe('session storage pressure checkpoints', () => {
  it('times out a producer checkpoint while keeping the original flush alive', async () => {
    const ctx = await setup()
    vi.useFakeTimers()
    const session = ctx.sessions.create(SessionId('deadline-checkpoint'))
    const healthy = ctx.sessionPersistence.writeState(session)
    vi.spyOn(ctx.sessionPersistence, 'writeState').mockReturnValue({ ...healthy, waitTimeoutMs: 20 })
    const gate = Promise.withResolvers<undefined>()
    let saved = false
    ctx.on('session/flush', async () => { await gate.promise; saved = true })
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter([]))
    const pending = expect(drain(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], sessionId: session.id })))
      .rejects.toMatchObject({ code: 'storage-stalled' })
    await vi.advanceTimersByTimeAsync(20)
    await pending
    expect(saved).toBe(false)
    gate.resolve(undefined)
    await Promise.resolve()
    expect(saved).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('blocks model dispatch immediately when saving has failed or closed', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('failed-checkpoint'))
    const healthy = ctx.sessionPersistence.writeState(session)
    const read = vi.spyOn(ctx.sessionPersistence, 'writeState')
    const order: string[] = []
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter(order))
    for (const state of [
      { ...healthy, phase: 'failed' as const, errorCode: 'storage-write-failed' as const },
      { ...healthy, phase: 'closing' as const, errorCode: null },
    ]) {
      read.mockReturnValue(state)
      await expect(drain(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], sessionId: session.id })))
        .rejects.toMatchObject({ code: state.phase === 'failed' ? 'storage-write-failed' : 'storage-closing' })
    }
    expect(order).toEqual([])
  })

  it('waits for stream capacity even when the request has no cancellation signal', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('signal-free-pressure'))
    const healthy = ctx.sessionPersistence.writeState(session)
    let pressured = false
    const gate = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.sessionPersistence, 'writeState').mockImplementation(() => pressured
      ? { ...healthy, phase: 'pressured', errorCode: null } : healthy)
    const capacity = vi.spyOn(ctx.sessionPersistence, 'waitForCapacity').mockImplementation(async () => {
      await gate.promise
      pressured = false
    })
    class CapacityAdapter extends LlmAdapter {
      async * stream(): AsyncIterable<StreamChunk> {
        pressured = true
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new CapacityAdapter())
    let finished = false
    const pending = drain(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], sessionId: session.id }))
      .then(() => { finished = true })
    await vi.waitFor(() => { expect(capacity).toHaveBeenCalledOnce() })
    expect(finished).toBe(false)
    gate.resolve(undefined)
    await pending
    expect(finished).toBe(true)
  })
})

it('waits for capacity before opening the durable checkpoint or a new model request', async () => {
  const ctx = await setup()
  const session = ctx.sessions.create(SessionId('initial-capacity'))
  const healthy = ctx.sessionPersistence.writeState(session)
  const gate = Promise.withResolvers<undefined>()
  let pressured = true
  const order: string[] = []
  vi.spyOn(ctx.sessionPersistence, 'writeState').mockImplementation(() => pressured
    ? { ...healthy, phase: 'pressured', errorCode: null } : healthy)
  vi.spyOn(ctx.sessionPersistence, 'waitForCapacity').mockImplementation(async () => {
    order.push('capacity')
    await gate.promise
    pressured = false
  })
  ctx.on('session/flush', () => { order.push('flush') })
  ctx.llm.registerAdapter(['mock'], new RecordingAdapter(order))
  const pending = drain(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], sessionId: session.id }))
  expect(order).toEqual(['capacity'])
  gate.resolve(undefined)
  await pending
  expect(order).toEqual(['capacity', 'flush', 'adapter'])
})

it('uses the tool owner cancellation fence if cancellation arrives after the checkpoint', async () => {
  const ctx = await setup()
  const session = ctx.sessions.create(SessionId('post-checkpoint-cancel'))
  const controller = new AbortController()
  let checkpointed = false
  let ran = false
  ctx.on('session/flush', () => { checkpointed = true })
  ctx.on('tools/execute', (_exec, next) => {
    expect(checkpointed).toBe(true)
    controller.abort(new Error('cancelled before dispatch'))
    return next()
  })
  ctx.tools.register({
    name: 'write', description: 'synthetic side effect', parameters: {},
    output: { schema: { type: 'null' }, render: () => [] },
    execute: async () => { ran = true; return null },
  })
  const result = await ctx.tools.execute({ callId: CallId('late-cancel'), name: 'write', arguments: {},
    agent: { session } as Agent, signal: controller.signal })
  expect(result).toMatchObject({ isError: true, error: { info: { code: TOOL_ABORTED_BEFORE_DISPATCH } } })
  expect(ran).toBe(false)
})
