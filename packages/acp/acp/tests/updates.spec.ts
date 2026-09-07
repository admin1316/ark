import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { assistantUpdates, toolCallUpdate, toolResultUpdate } from '../src/updates.ts'

function assistantEvent(
  content: unknown[],
  usage?: { inputTokens: number; outputTokens: number },
): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: 1,
    time: 1,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant',
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
      ...usage === undefined ? {} : { usage },
    },
    surfaceOp: 'append',
  } as SessionEvent<'assistant/message'>
}

function fixture(options: { contextWindow?: number; totalTokens?: number } = {}): {
  ctx: Context
  session: Session
} {
  const meter = options.totalTokens === undefined
    ? undefined
    : { measure: vi.fn(() => ({ totalTokens: options.totalTokens })) }
  const ctx = {
    get: (name: string) => name === 'tokenMeter' ? meter : undefined,
    logger: { warn: vi.fn() },
  } as unknown as Context
  const session = {
    requestContext: () => options.contextWindow === undefined
      ? undefined
      : { contextWindow: options.contextWindow },
  } as unknown as Session
  return { ctx, session }
}

describe('ACP committed update projection', () => {
  it('emits non-empty thought, message, and measured usage in block order', async () => {
    const { ctx, session } = fixture({ contextWindow: 128, totalTokens: 17 })
    const updates = await assistantUpdates(ctx, session, assistantEvent([
      { type: 'reasoning', text: '' },
      { type: 'reasoning', text: 'inspect' },
      { type: 'text', text: '' },
      { type: 'text', text: 'answer' },
    ], { inputTokens: 10, outputTokens: 7 }))

    expect(updates).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'inspect' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
      { sessionUpdate: 'usage_update', used: 17, size: 128 },
    ])
  })

  it('omits usage until both context capacity and a token meter exist', async () => {
    const event = assistantEvent([], { inputTokens: 1, outputTokens: 1 })
    const noSize = fixture({ totalTokens: 2 })
    await expect(assistantUpdates(noSize.ctx, noSize.session, event)).resolves.toEqual([])
    const noMeter = fixture({ contextWindow: 100 })
    await expect(assistantUpdates(noMeter.ctx, noMeter.session, event)).resolves.toEqual([])
    const noUsage = fixture({ contextWindow: 100, totalTokens: 2 })
    await expect(assistantUpdates(noUsage.ctx, noUsage.session, assistantEvent([]))).resolves.toEqual([])
  })

  it('preserves malformed tool arguments and marks failed results', async () => {
    expect(toolCallUpdate({
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: { turn: 1, step: 1, callId: 'call', name: 'broken', arguments: '{' },
    } as SessionEvent<'tool/call'>)).toMatchObject({ rawInput: '{' })

    const { ctx } = fixture()
    const update = await toolResultUpdate(ctx, {
      type: 'tool/result',
      seq: 2,
      time: 2,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'result',
          role: 'user',
          source: { kind: 'tool', callId: 'call' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call',
            isError: true,
            content: [
              { type: 'reasoning', text: 'private' },
              { type: 'text', text: 'failed visibly' },
            ],
          }],
        },
      },
      surfaceOp: 'append',
    } as SessionEvent<'tool/result'>)
    expect(update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'failed visibly' } }],
    })
  })
})
