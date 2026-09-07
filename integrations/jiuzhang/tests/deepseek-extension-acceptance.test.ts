import assert from 'node:assert/strict'
import test from 'node:test'
import { DeepSeekAdapter, resolveAdapterOptions } from '../../../packages/llm/llm-deepseek/src/index.ts'
import { createUserMessage } from '../../../packages/llm/llm/src/index.ts'
import type { AnonymousUserId } from '../../../packages/identity/anonymous-user-id/src/index.ts'

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* consume the provider response */ }
}

function request() {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    messages: [createUserMessage({
      content: [{ type: 'text' as const, text: 'acceptance ordering' }],
      source: { kind: 'user' as const },
    })],
  }
}

test('DeepSeek extension acceptance commits only after an HTTP 2xx response', async () => {
  let accepted = 0
  const adapter = new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ baseURL: 'https://deepseek.invalid' }),
    resolveApiKey: async () => 'test-key',
    resolveUserId: () => '00000000-0000-4000-8000-000000000001' as AnonymousUserId,
    prepareExtensions: async () => ({
      fields: {},
      accept: async () => { accepted += 1 },
    }),
  })
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('{"error":{"message":"rejected"}}', { status: 500 })
    await assert.rejects(drain(adapter.stream(request())), /rejected|DeepSeek API error/)
    assert.equal(accepted, 0, 'non-2xx responses must leave the watermark unchanged for conservative replay')

    globalThis.fetch = async () => new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    await drain(adapter.stream(request()))
    assert.equal(accepted, 1, 'the request extension commits after HTTP 2xx acceptance')
  } finally {
    globalThis.fetch = originalFetch
  }
})
