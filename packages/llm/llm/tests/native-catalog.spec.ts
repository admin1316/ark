import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '../src/index.ts'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '../src/index.ts'

class CatalogAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<LlmModelInfo[]> {
    if (provider === 'unavailable') throw new Error('private-key-must-not-escape')
    if (provider === 'empty') return Promise.resolve([])
    return Promise.resolve([{ provider, id: 'model', name: 'Display model', description: 'Model description' }])
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: 'resolved', defaultMaxTokens: 4096,
      reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low', description: 'Fast' }], defaultEffort: ReasoningEffortId('low') },
    })
  }
  async* stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('catalog reads must not invoke a model') }
}

it('joins dormant and active-only providers without exposing configuration values', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  try {
    ctx.llm.registerAdapter(['active', 'extra'], new CatalogAdapter())
    ctx.llm.registerConfigurableProviders([
      { provider: 'active', displayName: 'Configured', settingsNs: 'profiles', settingsPath: ['active'], declared: true },
      { provider: 'dormant', displayName: 'Dormant', settingsNs: 'profiles', settingsPath: ['dormant'] },
    ])
    expect(ctx.llm.remoteProviders()).toEqual({ providers: [
      { provider: 'active', displayName: 'Configured', settingsNs: 'profiles', settingsPath: ['active'], declared: true, active: true },
      { provider: 'dormant', displayName: 'Dormant', settingsNs: 'profiles', settingsPath: ['dormant'], active: false },
      { provider: 'extra', displayName: 'extra', settingsNs: '', settingsPath: [], active: true },
    ] })
    const rows = ctx.llm.remoteProviders()
    Reflect.set(rows.providers[0]!.settingsPath, '0', 'changed')
    expect(ctx.llm.listConfigurableProviders()[0]!.settingsPath).toEqual(['active'])
  } finally { await ctx.fiber.dispose() }
})

it('isolates provider catalog failure and projects exact model reasoning metadata', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  try {
    ctx.llm.registerAdapter(['active', 'unavailable', 'empty'], new CatalogAdapter())
    const catalog = await ctx.llm.remoteModels()
    expect(catalog).toEqual({
      groups: [{ id: 'active', name: 'active', models: [{
        id: 'model', name: 'Display model', description: 'Model description', defaultMaxTokens: 4096,
        reasoning: { efforts: [{ id: 'low', name: 'Low', description: 'Fast' }], defaultEffort: 'low' },
      }] }],
      failures: [{ id: 'unavailable', name: 'unavailable', message: 'provider model catalog unavailable' }],
    })
    expect(JSON.stringify(catalog)).not.toContain('private-key')
  } finally { await ctx.fiber.dispose() }
})

it('uses the Native discovery envelope, preserves cancellation and never echoes a one-shot key', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  try {
    const cancel = new AbortController()
    let calls = 0
    ctx.llm.registerModelDiscovery('profiles', (request) => {
      calls++
      if (request.provider === 'cancel') cancel.abort()
      if (request.provider === 'failure') throw new Error(request.apiKey)
      return Promise.resolve([{ id: 'native', name: 'Native model' }])
    })
    await expect(ctx.llm.remoteDiscoverModels({ settingsNs: 'profiles', provider: 'okay', baseURL: 'https://fixture.invalid', apiKey: 'fixture-key' },
      new AbortController().signal)).resolves.toEqual({ models: [{ id: 'native', name: 'Native model' }] })
    await expect(ctx.llm.remoteDiscoverModels({ settingsNs: 'profiles', provider: 'failure', baseURL: 'https://fixture.invalid', apiKey: 'fixture-key' },
      new AbortController().signal)).rejects.toMatchObject({ failure: { message: 'provider model discovery failed' } })
    await expect(ctx.llm.remoteDiscoverModels({ settingsNs: 'profiles', provider: 'cancel' }, cancel.signal))
      .rejects.toMatchObject({ failure: { code: 'cancelled' } })
    await expect(ctx.llm.remoteDiscoverModels({ settingsNs: 'profiles', provider: 'cancel' }, AbortSignal.abort()))
      .rejects.toMatchObject({ failure: { code: 'cancelled' } })
    expect(calls).toBe(3)
  } finally { await ctx.fiber.dispose() }
})

it('preserves absent model metadata and absent reasoning defaults in the Native catalog', async () => {
  class SparseCatalog extends LlmAdapter {
    override listModels(provider: string): Promise<LlmModelInfo[]> {
      return Promise.resolve(['bare', 'reasoning'].map(id => ({ provider, id, name: id })))
    }
    override resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
      return Promise.resolve({ provider, id, name: id, ...id === 'bare' ? {} : {
        reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] },
      } })
    }
    async* stream(): AsyncIterable<StreamChunk> { throw new Error('catalog reads must not invoke a model') }
  }
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  try {
    ctx.llm.registerAdapter(['sparse'], new SparseCatalog())
    expect(await ctx.llm.remoteModels()).toEqual({ groups: [{ id: 'sparse', name: 'sparse', models: [
      { id: 'bare', name: 'bare' },
      { id: 'reasoning', name: 'reasoning', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
    ] }], failures: [] })
  } finally { await ctx.fiber.dispose() }
})

it.each([undefined, ''])('refuses a one-shot discovery credential without its exact endpoint: %s', async (baseURL) => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  let calls = 0
  try {
    ctx.llm.registerModelDiscovery('profiles', () => { calls++; return Promise.resolve([]) })
    await expect(ctx.llm.discoverModels('profiles', { provider: 'openai', apiKey: 'synthetic-key',
      ...baseURL === undefined ? {} : { baseURL },
    })).rejects.toMatchObject({ code: 'INVALID_DISCOVERY' })
    expect(calls).toBe(0)
  } finally { await ctx.fiber.dispose() }
})

it.each([0, -1, 1.5, 1e100, Number.MAX_SAFE_INTEGER + 1])('refuses invalid discovered capacity %s at the Host response boundary', async (capacity) => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  try {
    ctx.llm.registerModelDiscovery('profiles', () => Promise.resolve([{ id: 'model', contextWindow: capacity }]))
    await expect(ctx.llm.remoteDiscoverModels({ settingsNs: 'profiles', provider: 'fixture' }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'model-discovery-failed' } })
  } finally { await ctx.fiber.dispose() }
})
