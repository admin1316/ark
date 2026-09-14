
import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup(script: Parameters<typeof MockAdapter>[0]) {
  const adapter = new MockAdapter(script)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root })
  cleanups.push(async () => {
    await persistenceFiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

const testSignal = new AbortController().signal
const message = (text: string) => [{ type: 'text' as const, text }]

async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  const { vi } = await import('vitest')
  await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5000 })
}

it('probe: live duplicate receipt through a manually resumed child session', async () => {
  const { ctx, parent, adapter } = await setup([textResponse('first'), textResponse('again')])
  const started = await ctx.subagents.startContinuable({
    provider: 'spawn', label: 'child task',
    request: { prompt: message('child task'), parent },
    signal: testSignal,
  })
  await waitNoActivation(ctx, started.childId)

  const invocationId = randomUUID()
  const source = { kind: 'subagent-prompt' as const, form: 'relay' as const, senderSessionId: parent.id, invocationId }
  const content = message('retry work')
  const first = await ctx.subagents.followupReceipt(parent, started.childId, content, { source, invocationId, signal: testSignal })
  console.log('FIRST RECEIPT:', JSON.stringify(first))
  await waitNoActivation(ctx, started.childId)

  const handle = await ctx.agents.resume({
    resumeSessionId: started.childId,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  console.log('LIVE SESSION PRESENT:', ctx.sessions.get(started.childId) !== undefined)
  const liveFlush = await ctx.sessions.flush(handle.agent.session)
  console.log('LIVE FLUSH RESULT:', liveFlush)

  const receipt = await ctx.subagents.followupReceipt(parent, started.childId, content, { source, invocationId, signal: testSignal })
  console.log('DUPLICATE RECEIPT:', JSON.stringify(receipt))
  expect(receipt).toEqual({ messageId: first.messageId, durable: true, duplicate: true })
  await handle.dispose()

  const saved = await ctx.sessionPersistence.load(started.childId)
  const prompts = saved.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'subagent-prompt')
  console.log('PROMPT EVENT COUNT:', prompts.length, 'CHILD MODEL CALLS:', adapter.requests.length)
  expect(prompts).toHaveLength(1)
})
