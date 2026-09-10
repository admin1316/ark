import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type PromptRequest } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AcpSession, type CreateAcpSessionOptions, type ResumeAcpSessionOptions } from '../src/session.ts'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

function sessionOptions(sessionId: string): CreateAcpSessionOptions {
  return {
    sessionId: SessionId(sessionId),
    cwd: process.cwd(),
    mcpServers: [],
    agentOptions: { provider: 'mock', model: 'mock' },
    fallbackSelection: { provider: 'mock', model: 'mock' },
    signal: new AbortController().signal,
    notify: () => Promise.resolve(),
  }
}

describe('ACP session failure boundaries', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
    vi.restoreAllMocks()
  })

  it('fails fresh and resumed composition before publication when no LLM exists', async () => {
    const withoutLlm = { get: () => undefined } as unknown as Context
    await expect(AcpSession.create(withoutLlm, sessionOptions('no-llm-create')))
      .rejects.toThrow(/requires an LLM service/)

    const agent = { session: { requestHeader: () => undefined } } as unknown as Agent
    const resumeContext = {
      get: () => undefined,
      agents: {
        resume: async (options: { setup: (ctx: Context) => Promise<void> }) => {
          await options.setup({ agent } as unknown as Context)
          throw new Error('setup unexpectedly returned')
        },
      },
    } as unknown as Context
    const options: ResumeAcpSessionOptions = { ...sessionOptions('no-llm-resume') }
    await expect(AcpSession.resume(resumeContext, options)).rejects.toThrow(/requires an LLM service/)
  })

  it('clears the prompt slot when Agent followup throws synchronously', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('recovered')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    vi.spyOn(agent, 'followup').mockImplementationOnce(() => { throw new Error('followup failed') })

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'first' }] }))
      .rejects.toThrow(/prompt was not queued: followup failed/)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'second' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('rejects after asynchronous admission if the Agent disappears', async () => {
    harness = await makeBridgeHarness({ imageCapable: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    harness.attachments!.beforeValidate = async () => {
      entered.resolve(undefined)
      await release.promise
    }

    const prompt = harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })
    await entered.promise
    await harness.loopFiber.dispose()
    release.resolve(undefined)
    await expect(prompt).rejects.toThrow(/agent was disposed outside the bridge/)
  })

  it('settles cancellation requested while image admission is pending', async () => {
    harness = await makeBridgeHarness({ imageCapable: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    harness.attachments!.beforeValidate = async () => {
      entered.resolve(undefined)
      await release.promise
    }

    const prompt = harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })
    await entered.promise
    await harness.client.cancel({ sessionId })
    release.resolve(undefined)
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('runs a prompt without a model-control snapshot when Agent options own the route', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('option-routed')] })
    const record = await AcpSession.create(harness.ctx, {
      ...sessionOptions('option-routed'),
      fallbackSelection: undefined,
    })
    harness.ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (agent === record.agent) record.onInboxClaimed(message, turn)
    })
    harness.ctx.on('session/event', (session, event) => {
      if (session === record.agent.session) record.onSessionEvent(session, event)
    })

    await expect(record.prompt({
      sessionId: record.agent.session.id,
      prompt: [{ type: 'text', text: 'run' }],
    }, false)).resolves.toEqual({ stopReason: 'end_turn' })
    await record.close('test complete')
  })

  it('publishes topology changes but suppresses a discovery finishing during close', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const first = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    harness.ctx.emit('llm/adapters-updated')
    await vi.waitFor(() => {
      expect(harness!.updates.some(update => update.sessionUpdate === 'config_option_update')).toBe(true)
    })
    await harness.client.closeSession({ sessionId: first.sessionId })

    const second = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const gate = Promise.withResolvers<{ provider: string; model: string }>()
    const resolve = vi.spyOn(harness.ctx.llm, 'resolveCallConfig').mockReturnValueOnce(gate.promise)
    const before = harness.updates.length
    harness.ctx.emit('llm/adapters-updated')
    await vi.waitFor(() => { expect(resolve).toHaveBeenCalledOnce() })
    const closing = harness.client.closeSession({ sessionId: second.sessionId })
    gate.resolve({ provider: 'mock', model: 'mock' })
    await closing
    expect(harness.updates).toHaveLength(before)
  })

  it('shares concurrent close and rejects new work while teardown is pending', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const idle = Promise.withResolvers<undefined>()
    const whenIdle = vi.spyOn(agent, 'whenIdle').mockReturnValue(idle.promise)

    const first = harness.client.closeSession({ sessionId })
    await vi.waitFor(() => { expect(whenIdle).toHaveBeenCalledOnce() })
    const second = harness.client.closeSession({ sessionId })
    harness.ctx.emit('llm/adapters-updated')
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'too late' }] }))
      .rejects.toThrow(/session is closing/)
    idle.resolve(undefined)
    await expect(Promise.all([first, second])).resolves.toEqual([{}, {}])
  })

  it('contains all update-delivery failures and rejects the owning prompt after quiescence', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const notify = vi.fn().mockRejectedValue(new Error('transport unavailable'))
    const record = await AcpSession.create(harness.ctx, {
      ...sessionOptions('direct-output'),
      notify,
    })
    harness.ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (agent === record.agent) record.onInboxClaimed(message, turn)
    })
    harness.ctx.on('session/event', (session, event) => {
      if (session === record.agent.session) record.onSessionEvent(session, event)
    })

    const request: PromptRequest = {
      sessionId: record.agent.session.id,
      prompt: [{ type: 'text', text: 'run' }],
    }
    const prompt = record.prompt(request, false)
    await vi.waitFor(() => { expect(record.agent.status).toBe('running') })
    const turn = record.agent.session.events.findLast(event => event.type === 'turn/start')?.data.turn
    if (turn === undefined) throw new Error('expected an active turn')

    record.onSessionEvent(record.agent.session, {
      type: 'assistant/message',
      seq: 100,
      time: 1,
      data: {
        turn,
        step: 1,
        message: {
          id: 'assistant-direct',
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
      },
      surfaceOp: 'append',
    } as SessionEvent<'assistant/message'>)
    await record.drainUpdates()

    record.onSessionEvent(record.agent.session, {
      type: 'tool/call',
      seq: 101,
      time: 2,
      data: { turn, step: 1, callId: 'call', name: 'tool', arguments: '{}' },
    } as SessionEvent<'tool/call'>)
    await record.drainUpdates()

    record.onSessionEvent(record.agent.session, {
      type: 'tool/result',
      seq: 102,
      time: 3,
      data: {
        turn,
        step: 1,
        message: {
          id: 'result-direct',
          role: 'user',
          source: { kind: 'tool', callId: 'call' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call',
            content: [{ type: 'text', text: 'result' }],
          }],
        },
      },
      surfaceOp: 'append',
    } as SessionEvent<'tool/result'>)
    await record.drainUpdates()

    record.agent.cancel({ kind: 'hook', reason: 'finish fault injection' })
    await expect(prompt).rejects.toThrow(/assistant output delivery failed: transport unavailable/)
    const callsDuringPrompt = notify.mock.calls.length

    record.onSessionEvent(record.agent.session, {
      type: 'tool/call',
      seq: 103,
      time: 4,
      data: { turn: turn + 1, step: 1, callId: 'idle-call', name: 'tool', arguments: '{}' },
    } as SessionEvent<'tool/call'>)
    await record.drainUpdates()
    record.onSessionEvent(record.agent.session, {
      type: 'tool/result',
      seq: 104,
      time: 5,
      data: {
        turn: turn + 1,
        step: 1,
        message: {
          id: 'idle-result',
          role: 'user',
          source: { kind: 'tool', callId: 'idle-call' },
          content: [{
            type: 'tool-result',
            toolCallId: 'idle-call',
            content: [{ type: 'text', text: 'idle result' }],
          }],
        },
      },
      surfaceOp: 'append',
    } as SessionEvent<'tool/result'>)
    await record.drainUpdates()
    expect(notify.mock.calls.length).toBeGreaterThanOrEqual(callsDuringPrompt + 2)
    await record.close('test complete')
  })
})
