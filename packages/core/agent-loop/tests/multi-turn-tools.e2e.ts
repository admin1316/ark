import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'

/**
 * With-key proof of the multi-turn tool chain on the real provider: one user
 * turn must drive three sequential tool calls (lookup → store → lookup) with
 * each step's result feeding the next, and the final answer must repeat the
 * last stored value. The mock suites pin the scheduling; this key-gated test
 * establishes that a real model follows the tool loop across multiple calls
 * in one turn (the product spine — agent-loop currently has only the
 * request-cache keyed e2e).
 */

// Terse enough to keep the chain on rails: literal tool use, no invented values.
const SYSTEM = 'You are a terse automated tool-chain test assistant. '
  + 'Always follow instructions literally and exactly. Use the lookup tool for '
  + 'every key you need, and the store tool for every value you are asked to save. '
  + 'Never invent a value the tools have not returned. After the final lookup, '
  + 'answer with a single short sentence repeating the stored value verbatim. '
  + 'No explanations, no markdown, no follow-up questions.'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function loopHarness(): Promise<Context> {
  const created = new Context()
  await created.plugin(LlmRuntime)
  await created.plugin(SessionStore)
  await created.plugin(SystemPrompt, { persona: SYSTEM })
  await created.plugin(ToolRuntime)
  await created.plugin(AgentRegistry)
  await created.plugin(AgentLoop, { agents: [] })
  await created.plugin(LlmDeepSeek)
  created.tools.register(defineContentToolFixture({
    name: 'lookup',
    description: 'Look up the stored value for a key.',
    parameters: { key: { type: 'string', description: 'The key to look up.' } },
    async execute(args) {
      return [{ type: 'text', text: `value(${String(args.key)}) = azure-falcon-42` }]
    },
  }))
  created.tools.register(defineContentToolFixture({
    name: 'store',
    description: 'Store a value under a key.',
    parameters: {
      key: { type: 'string', description: 'The key to store under.' },
      value: { type: 'string', description: 'The value to store.' },
    },
    async execute(args) {
      return [{ type: 'text', text: `stored(${String(args.key)}) = ${String(args.value)}` }]
    },
  }))
  return created
}

function waitForIdle(context: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = context.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('multi-turn tool chain (real API)', () => {
  it('drives three sequential tool calls in one turn and reports the stored value', async () => {
    ctx = await loopHarness()
    const agent = ctx.agentLoop.create(SessionId('multi-turn-tools-e2e'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'Look up "deploy-color", store the returned value under "current-color", then look up "current-color" and tell me its value.',
      }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    // The tool chain: at least three tool-call steps in this one turn.
    const toolCalls = [...agent.session.events]
      .filter(e => e.type === 'tool/call' || e.type === 'assistant/message')
      .filter(e => e.type === 'tool/call')
    expect(toolCalls.length).toBeGreaterThanOrEqual(3)

    // World-verification: the second lookup's value made it to the final answer.
    const finalText = agent.session.deriveMessages().at(-1)!.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(finalText).toContain('azure-falcon-42')
  }, 180_000)
})
