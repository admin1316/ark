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
 * With-key proof that a real-model turn survives cancel + resume: cancel
 * returns the agent to idle without wedging the driver, and a follow-up over
 * the same session completes a tool chain whose value reaches the final
 * answer. The mock suites pin the landing windows; this key-gated test
 * establishes the real-provider round trip (cancel during an in-flight
 * request, resume on the same session log).
 */

// Same terse persona as the multi-turn e2e so the model stays on rails.
const SYSTEM = 'You are a terse automated test assistant. '
  + 'Always follow instructions literally and exactly. Use the lookup tool for every key you need. '
  + 'Never invent a value the tool has not returned. Answer with one short sentence. '
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

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('cancel and resume over the real provider', () => {
  it('returns to idle after an in-flight cancel and completes a resumed tool turn', async () => {
    ctx = await loopHarness()
    const agent = ctx.agentLoop.create(SessionId('cancel-resume-e2e'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    // Start a turn that must call the tool, then cancel while it is in flight.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Look up "deploy-color" with the lookup tool and tell me its value.' }],
      source: { kind: 'user' },
    }))
    agent.cancel({ kind: 'user' })

    // Cancel must settle to idle — the driver is not wedged.
    await waitForIdle(ctx, agent)

    // Resume on the same session: the follow-up completes the tool turn.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Please look up "deploy-color" now and tell me its value.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    const finalText = agent.session.deriveMessages().at(-1)!.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(finalText).toContain('azure-falcon-42')
  }, 180_000)
})
