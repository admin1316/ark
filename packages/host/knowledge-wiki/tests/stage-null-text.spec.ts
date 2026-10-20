import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { createOwnedStageExecutor } from '../src/owned-stage-executor.ts'

describe('owned provider empty text', () => {
  it('returns an empty text response without inventing content', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    class EmptyAdapter extends LlmAdapter {
      override stream() { return (async function* () {})() }
    }
    ctx.llm.registerAdapter(['fixture'], new EmptyAdapter())
    const executor = createOwnedStageExecutor({ llm: ctx.llm, web: () => undefined, attachments: () => undefined })
    try {
      await expect(executor.execute({ kind:'llm-complete',provider:'fixture',model:'fixture',prompt:'source',operation:'analysis',timeoutMs:1000 }, new AbortController().signal)).resolves.toEqual({ text:'' })
    } finally { await ctx.fiber.dispose() }
  })
})
