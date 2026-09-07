import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  CallId,
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop, {
  AgentQuiescenceTimeoutError,
  type AgentTurnBudgetExhaustedReason,
  type AgentTurnBudgetLimits,
} from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const TEST_BUDGET: AgentTurnBudgetLimits = {
  maxElapsedMs: 10_000,
  maxSteps: 10,
  maxModelAttempts: 10,
  maxToolCalls: 10,
  cancellationGraceMs: 100,
}

class InfiniteToolAdapter extends LlmAdapter {
  requests = 0

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    const index = this.requests
    const id = CallId(`loop-${index}`)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: 'echo', argumentsDelta: '{}' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'echo', arguments: '{}' } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

class InfiniteFailureAdapter extends LlmAdapter {
  requests = 0

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'still unavailable', code: 'SERVER' } },
    }
  }
}

class UncooperativeAdapter extends LlmAdapter {
  requests = 0

  constructor(
    private readonly release: Promise<void>,
    private readonly waiting: () => void,
  ) {
    super()
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    yield { type: 'block-start', index: 0, blockType: 'text' }
    this.waiting()
    await this.release
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(
  adapter: LlmAdapter,
  turnBudget: Partial<AgentTurnBudgetLimits> = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [], turnBudget: { ...TEST_BUDGET, ...turnBudget } })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: Agent): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'run' }],
    source: { kind: 'user' },
  }))
}

function turnReason(agent: Agent): TurnEndReason | undefined {
  return agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason
}

function expectFiniteElapsed(reason: TurnEndReason | undefined): void {
  expect(reason?.kind).toBe('budget-exhausted')
  expect(Number.isFinite((reason as AgentTurnBudgetExhaustedReason).usage.elapsedMs)).toBe(true)
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition did not become true')
}

let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
})

describe('authoritative finite turn budget', () => {
  it.each<keyof AgentTurnBudgetLimits>([
    'maxElapsedMs', 'maxSteps', 'maxModelAttempts', 'maxToolCalls', 'cancellationGraceMs',
  ])('rejects invalid %s at the public programmatic constructor boundary', async (key) => {
    for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const ctx = new Context()
      try {
        expect(() => new AgentLoop(ctx, { agents: [], turnBudget: { [key]: value } }))
          .toThrow(`turnBudget.${key} must be a positive safe integer`)
      } finally {
        await ctx.fiber.dispose()
      }
    }
  })

  it('enforces elapsed budget after a clock jump before model dispatch and clears pending next-step input', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    const adapter = new MockAdapter([textResponse('must not run')])
    context = await harness(adapter, { maxElapsedMs: 100 })
    const agent = context.agentLoop.create(SessionId('budget-clock-jump'), { provider: 'mock', model: 'mock' })
    context.on('agent/pre-step', async (_payload, next) => {
      agent.inject(createUserMessage({ content: [{ type: 'text', text: 'queued for the exhausted turn' }], source: { kind: 'user' } }))
      vi.setSystemTime(new Date(1_000))
      return next()
    })
    send(agent)
    await agent.whenIdle()
    expect(adapter.requests).toEqual([])
    expect(agent.inbox.nextStep).toEqual([])
    expect(agent.session.events.filter(event => event.type === 'step/start')).toEqual([])
    expect(turnReason(agent)).toEqual({
      kind: 'budget-exhausted', dimension: 'elapsed-ms', limit: 100, observed: 1_000,
      usage: { elapsedMs: 1_000, steps: 0, modelAttempts: 0, toolCalls: 0 },
    })
  })

  it('terminates an infinite tool loop at the step boundary with exact accounting', async () => {
    const adapter = new InfiniteToolAdapter()
    context = await harness(adapter, { maxSteps: 3 })
    context.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    const agent = context.agentLoop.create(SessionId('budget-tool-loop'), { provider: 'mock', model: 'mock' })

    send(agent)
    await agent.whenIdle()

    expect(adapter.requests).toBe(3)
    expect(agent.session.events.filter(event => event.type === 'tool/call')).toHaveLength(3)
    const reason = turnReason(agent)
    expect(reason).toMatchObject({
      kind: 'budget-exhausted',
      dimension: 'steps',
      limit: 3,
      observed: 4,
      usage: { steps: 3, modelAttempts: 3, toolCalls: 3 },
    })
    expectFiniteElapsed(reason)
  })

  it('bounds a permanent request-recovery loop by total model attempts', async () => {
    const adapter = new InfiniteFailureAdapter()
    context = await harness(adapter, { maxModelAttempts: 3 })
    context.on('agent/request-error', () => Promise.resolve({ kind: 'retry' }))
    const agent = context.agentLoop.create(SessionId('budget-retry-loop'), { provider: 'mock', model: 'mock' })

    send(agent)
    await agent.whenIdle()

    expect(adapter.requests).toBe(3)
    const reason = turnReason(agent)
    expect(reason).toMatchObject({
      kind: 'budget-exhausted',
      dimension: 'model-attempts',
      limit: 3,
      observed: 4,
      usage: { steps: 1, modelAttempts: 3, toolCalls: 0 },
    })
    expectFiniteElapsed(reason)
  })

  it('refuses a tool batch before dispatch when it exceeds the turn call budget', async () => {
    const calls = [0, 1, 2].flatMap((index): StreamChunk[] => {
      const id = CallId(`batch-${index}`)
      return [
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id, name: 'echo', argumentsDelta: '{}' },
        { type: 'block-end', index, block: { type: 'tool-call', id, name: 'echo', arguments: '{}' } },
      ]
    })
    context = await harness(new MockAdapter([[...calls, { type: 'finish', reason: { kind: 'tool-calls' } }]]), {
      maxToolCalls: 2,
    })
    let executions = 0
    context.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo',
      parameters: {},
      async execute() { executions++; return [{ type: 'text', text: 'unexpected' }] },
    }))
    const agent = context.agentLoop.create(SessionId('budget-tool-count'), { provider: 'mock', model: 'mock' })

    send(agent)
    await agent.whenIdle()

    expect(executions).toBe(0)
    expect(agent.session.events.some(event => event.type === 'tool/call')).toBe(false)
    const reason = turnReason(agent)
    expect(reason).toMatchObject({
      kind: 'budget-exhausted',
      dimension: 'tool-calls',
      limit: 2,
      observed: 3,
      usage: { steps: 1, modelAttempts: 1, toolCalls: 0 },
    })
    expectFiniteElapsed(reason)
  })

  it('uses a fake clock to report an uncooperative pre-step without claiming idle', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    context = await harness(new MockAdapter([textResponse('unused')]), {
      maxElapsedMs: 1_000,
      cancellationGraceMs: 100,
    })
    context.on('agent/pre-step', async (_payload, next) => {
      entered.resolve(undefined)
      await gate.promise
      return next()
    })
    const agent = context.agentLoop.create(SessionId('budget-elapsed'), { provider: 'mock', model: 'mock' })
    const residuals: unknown[] = []
    context.on('agent/quiescence-timeout', ({ residual }) => { residuals.push(residual) })

    send(agent)
    await entered.promise
    const bounded = agent.whenIdle().then(
      () => undefined,
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(1_099)
    expect(agent.status).toBe('running')
    expect(residuals).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(await bounded).toMatchObject({
      code: 'AGENT_OPERATION_UNRESPONSIVE',
      residual: {
        abortKind: 'budget-exhausted',
        graceMs: 100,
        operations: [{ stage: 'pre-step', count: 1 }],
      },
    })
    expect(agent.status).toBe('running')

    gate.resolve(undefined)
    await waitUntil(() => agent.status === 'idle')
    await agent.whenIdle()
    expect(turnReason(agent)).toEqual({
      kind: 'budget-exhausted',
      dimension: 'elapsed-ms',
      limit: 1_000,
      observed: 1_000,
      usage: { elapsedMs: 1_000, steps: 0, modelAttempts: 0, toolCalls: 0 },
    })
  })
})

describe('bounded cancellation and teardown outcomes', () => {
  it('refuses a second maintenance job while the first still owns the agent', async () => {
    context = await harness(new MockAdapter([]))
    const agent = context.agentLoop.create(SessionId('overlapping-maintenance'), { provider: 'mock', model: 'mock' })
    const released = Promise.withResolvers<undefined>()
    const first = agent.runMaintenance(async () => { await released.promise; return 'first completed' })
    const second = vi.fn(async () => 'must not execute')
    try {
      expect(() => agent.runMaintenance(second)).toThrow('already has active work')
      expect(second).not.toHaveBeenCalled()
    } finally {
      released.resolve(undefined)
      await expect(first).resolves.toBe('first completed')
    }
    expect(agent.status).toBe('idle')
  })

  it('retains an unresponsive agent across same-stack reentrant factory-handle disposal', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    context = await harness(new MockAdapter([textResponse('must not run')]))
    const id = SessionId('reentrant-factory-dispose')
    const handle = await context.agentLoop.createAgent(context, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
    let reentrant: Promise<unknown> | undefined
    context.on('agent/pre-step', async ({ signal }, next) => {
      signal.addEventListener('abort', () => {
        reentrant = handle.dispose().then(() => undefined, (error: unknown) => error)
      }, { once: true })
      started.resolve(undefined)
      await released.promise
      return next()
    })
    send(handle.agent)
    await started.promise
    try {
      const outer = handle.dispose().then(() => undefined, (error: unknown) => error)
      expect(reentrant).toBeDefined()
      await vi.advanceTimersByTimeAsync(TEST_BUDGET.cancellationGraceMs)
      expect(await outer).toBeInstanceOf(AgentQuiescenceTimeoutError)
      expect(await reentrant).toBeInstanceOf(AgentQuiescenceTimeoutError)
      expect(context.agents.get(id)).toBe(handle.agent)
      expect(context.sessions.get(id)).toBe(handle.agent.session)
      expect(handle.agent.status).toBe('running')
    } finally {
      released.resolve(undefined)
      await waitUntil(() => handle.agent.status === 'idle')
      await handle.dispose()
    }
    expect(context.agents.get(id)).toBeUndefined()
    expect(context.sessions.get(id)).toBeUndefined()
  })

  it('refuses maintenance on a disposed handle before invoking its job', async () => {
    context = await harness(new MockAdapter([]))
    const id = SessionId('maintenance-after-disposal')
    const handle = await context.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
    await handle.dispose()
    const job = vi.fn(async () => 'must not execute')
    expect(() => handle.agent.runMaintenance(job)).toThrow('lifecycle is disposing')
    expect(job).not.toHaveBeenCalled()
    expect(context.agents.get(id)).toBeUndefined()
    expect(context.sessions.get(id)).toBeUndefined()
  })

  it('does not replace an explicit cancellation with a later elapsed deadline while cleanup is outstanding', async () => {
    vi.useFakeTimers()
    const released = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    const adapter = new UncooperativeAdapter(released.promise, () => { started.resolve(undefined) })
    context = await harness(adapter)
    const residuals: unknown[] = []
    context.on('agent/quiescence-timeout', ({ residual }) => { residuals.push(residual) })
    const agent = context.agentLoop.create(SessionId('cancel-before-elapsed-deadline'), { provider: 'mock', model: 'mock' })
    send(agent)
    await started.promise
    const bounded = agent.whenIdle().then(() => undefined, (error: unknown) => error)
    try {
      agent.cancel({ kind: 'user' })
      await vi.advanceTimersByTimeAsync(TEST_BUDGET.maxElapsedMs + 1)
      expect(await bounded).toBeInstanceOf(AgentQuiescenceTimeoutError)
      expect(residuals).toHaveLength(1)
      expect(residuals[0]).toMatchObject({ abortKind: 'user' })
      expect(agent.status).toBe('running')
      expect(adapter.requests).toBe(1)
    } finally {
      released.resolve(undefined)
      await waitUntil(() => agent.status === 'idle')
      await agent.whenIdle()
    }
    expect(turnReason(agent)).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it('lets a cooperative provider cancel and reach true idle within the grace', async () => {
    vi.useFakeTimers()
    const adapter = new MockAdapter(['hang'])
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('cooperative-cancel'), { provider: 'mock', model: 'mock' })

    send(agent)
    await waitUntil(() => adapter.requests.length === 1)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    expect(turnReason(agent)).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    expect(agent.status).toBe('idle')
  })

  it('reports an uncooperative provider while retaining ownership until it settles', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<undefined>()
    const waiting = Promise.withResolvers<undefined>()
    const adapter = new UncooperativeAdapter(gate.promise, () => { waiting.resolve(undefined) })
    context = await harness(adapter)
    const id = SessionId('uncooperative-provider')
    const agent = context.agentLoop.create(id, { provider: 'mock', model: 'mock' })

    send(agent)
    await waiting.promise
    const bounded = agent.whenIdle().then(
      () => undefined,
      (error: unknown) => error,
    )
    agent.cancel({ kind: 'user' })
    await vi.advanceTimersByTimeAsync(100)

    expect(await bounded).toBeInstanceOf(AgentQuiescenceTimeoutError)
    expect(agent.status).toBe('running')
    expect(context.agents.get(id)).toBe(agent)
    expect(context.sessions.get(id)).toBe(agent.session)

    gate.resolve(undefined)
    await waitUntil(() => agent.status === 'idle')
    await agent.whenIdle()
    expect(turnReason(agent)).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it('reports an uncooperative system-prompt waterfall at its exact boundary', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    context = await harness(new MockAdapter([textResponse('unused')]))
    context.on('system-prompt/assemble', async (_assembly, _assembleContext, next) => {
      entered.resolve(undefined)
      await gate.promise
      return next()
    })
    const agent = context.agentLoop.create(SessionId('uncooperative-prompt'), { provider: 'mock', model: 'mock' })

    send(agent)
    await entered.promise
    const bounded = agent.whenIdle().then(
      () => undefined,
      (error: unknown) => error,
    )
    agent.cancel({ kind: 'user' })
    await vi.advanceTimersByTimeAsync(100)

    expect(await bounded).toMatchObject({
      residual: { operations: [{ stage: 'system-prompt', count: 1 }] },
    })
    expect(agent.status).toBe('running')

    gate.resolve(undefined)
    await waitUntil(() => agent.status === 'idle')
    expect(turnReason(agent)).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it('reports an uncooperative tool body and does not detach it', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    context = await harness(new MockAdapter([toolCallResponse('slow-call', 'slow', {})]))
    context.tools.register(defineContentToolFixture({
      name: 'slow',
      description: 'ignores cancellation until released by the test',
      parameters: {},
      async execute() {
        entered.resolve(undefined)
        await gate.promise
        return [{ type: 'text', text: 'settled' }]
      },
    }))
    const id = SessionId('uncooperative-tool')
    const agent = context.agentLoop.create(id, { provider: 'mock', model: 'mock' })

    send(agent)
    await entered.promise
    const bounded = agent.whenIdle().then(
      () => undefined,
      (error: unknown) => error,
    )
    agent.cancel({ kind: 'user' })
    await vi.advanceTimersByTimeAsync(100)

    expect(await bounded).toMatchObject({
      residual: { operations: [{ stage: 'tool-body', count: 1 }] },
    })
    expect(agent.status).toBe('running')
    expect(context.agents.get(id)).toBe(agent)

    gate.resolve(undefined)
    await waitUntil(() => agent.status === 'idle')
    expect(turnReason(agent)).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it('refuses lifecycle detachment while pre-step code is live, then permits a retry', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    context = await harness(new MockAdapter([textResponse('unused')]))
    context.on('agent/pre-step', async (_payload, next) => {
      entered.resolve(undefined)
      await gate.promise
      return next()
    })
    const id = SessionId('uncooperative-dispose')
    const handle = await context.agents.create({
      sessionId: id,
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent)
    await entered.promise
    const firstDisposal = handle.dispose().then(
      () => undefined,
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(100)

    expect(await firstDisposal).toBeInstanceOf(AgentQuiescenceTimeoutError)
    expect(context.agents.get(id)).toBe(handle.agent)
    expect(context.sessions.get(id)).toBe(handle.agent.session)

    gate.resolve(undefined)
    await waitUntil(() => handle.agent.status === 'idle')
    await handle.dispose()
    expect(context.agents.get(id)).toBeUndefined()
    expect(context.sessions.get(id)).toBeUndefined()
  })
})

it('normalizes a provider EOF without finish to STREAM_CLOSED', async () => {
  context = await harness(new MockAdapter([[]]))
  const agent = context.agentLoop.create(SessionId('missing-finish'), { provider: 'mock', model: 'mock' })

  send(agent)
  await agent.whenIdle()

  expect(turnReason(agent)).toEqual({
    kind: 'error',
    error: { message: 'model stream closed without a terminal finish chunk', code: 'STREAM_CLOSED' },
  })
})
