import { describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AcpModelControl } from '../src/model-control.ts'

interface RuntimeOptions {
  providers?: () => { id: string; name: string }[]
  models?: (provider: string) => Promise<{
    provider: string
    id: string
    name: string
    description?: string
  }[]>
  info?: (provider: string, model: string) => Promise<Record<string, unknown>>
  resolve?: (selection: ModelSelection) => Promise<ModelSelection>
}

function runtime(options: RuntimeOptions = {}): LlmRuntime {
  return {
    listProviders: vi.fn(options.providers ?? (() => [{ id: 'p', name: 'Provider' }])),
    listModels: vi.fn(options.models ?? (async provider => [
      { provider, id: 'reasoner', name: 'Reasoner', description: 'Thinks first.' },
      { provider, id: 'plain', name: 'Plain' },
    ])),
    resolveModelInfo: vi.fn(options.info ?? (async (provider, model) => ({
      provider,
      id: model,
      name: model,
      ...model === 'reasoner'
        ? {
          reasoning: {
            efforts: [
              { id: ReasoningEffortId('low'), name: 'Low', description: 'Short reasoning.' },
              { id: ReasoningEffortId('high'), name: 'High' },
            ],
          },
        }
        : {},
    }))),
    resolveCallConfig: vi.fn(options.resolve ?? (async selection => ({ ...selection }))),
  } as unknown as LlmRuntime
}

describe('ACP model configuration control', () => {
  it('keeps an absent route unset and exposes the mutable selection reference', async () => {
    const control = new AcpModelControl(runtime(), undefined)
    expect(control.snapshot()).toBeUndefined()
    await expect(control.options()).resolves.toEqual([])
    await expect(control.set('model', JSON.stringify(['p', 'plain']))).rejects.toThrow(/no model selection/)

    control.selection.current = { provider: 'p', model: 'plain' }
    expect(control.snapshot()).toEqual({ provider: 'p', model: 'plain' })
    control.selection.current = undefined
    expect(control.selection.current).toBeUndefined()
  })

  it('switches models and reasoning while preserving receive-order after rejections', async () => {
    const control = new AcpModelControl(runtime({
      providers: () => [{ id: 'p', name: 'Provider' }, { id: 'broken', name: 'Broken' }],
      models: async (provider) => {
        if (provider === 'broken') throw new Error('catalog unavailable')
        return [
          { provider, id: 'reasoner', name: 'Reasoner', description: 'Thinks first.' },
          { provider, id: 'plain', name: 'Plain' },
        ]
      },
    }), { provider: 'p', model: 'reasoner' })

    const initial = await control.options()
    expect(initial.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: '' })
    await expect(control.set('model', 1)).rejects.toThrow(/requires a select value/)
    await expect(control.set('model', 'missing')).rejects.toThrow(/unknown model option/)
    await expect(control.set('unknown', 'value')).rejects.toThrow(/unknown session config option/)
    await expect(control.set('reasoning_effort', 'missing')).rejects.toThrow(/unknown reasoning effort/)

    const providerDefault = await control.set('reasoning_effort', '')
    expect(providerDefault.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: '' })
    const explicit = await control.set('reasoning_effort', 'low')
    expect(explicit.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'low' })
    expect(control.snapshot()).toEqual({ provider: 'p', model: 'reasoner', reasoningEffort: 'low' })

    const switched = await control.set('model', JSON.stringify(['p', 'plain']))
    expect(switched.some(option => option.id === 'reasoning_effort')).toBe(false)
    await expect(control.set('reasoning_effort', 'low')).rejects.toThrow(/unknown reasoning effort/)
  })

  it('projects an adapter default effort without offering the provider-default sentinel', async () => {
    const llm = runtime({
      providers: () => [{ id: 'p', name: 'Provider' }],
      models: async provider => [{ provider, id: 'defaulted', name: 'Defaulted' }],
      info: async (provider, model) => ({
        provider,
        id: model,
        name: model,
        reasoning: {
          defaultEffort: ReasoningEffortId('high'),
          efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
        },
      }),
      resolve: async selection => ({ ...selection, reasoningEffort: selection.reasoningEffort ?? ReasoningEffortId('high') }),
    })
    const control = new AcpModelControl(llm, { provider: 'p', model: 'defaulted' })
    const reasoning = (await control.options()).find(option => option.id === 'reasoning_effort')
    expect(reasoning).toMatchObject({ currentValue: 'high', options: [{ value: 'high', name: 'High' }] })
    await expect(control.set('reasoning_effort', '')).rejects.toThrow(/unknown reasoning effort/)
  })

  it('keeps the last route visible after topology loss and synthesizes missing groups', async () => {
    let failResolution = false
    let catalogMode: 'present-empty' | 'absent-broken' = 'present-empty'
    const llm = runtime({
      providers: () => catalogMode === 'present-empty'
        ? [{ id: 'p', name: 'Provider' }]
        : [{ id: 'broken', name: 'Broken' }],
      models: async (provider) => {
        if (provider === 'broken') throw new Error('catalog unavailable')
        return []
      },
      info: async (provider, model) => ({ provider, id: model, name: model }),
      resolve: async (selection) => {
        if (failResolution) throw new Error('route offline')
        return { ...selection }
      },
    })
    const control = new AcpModelControl(llm, { provider: 'p', model: 'detached' })
    const discovered = await control.options()
    expect(discovered[0]).toMatchObject({
      currentValue: JSON.stringify(['p', 'detached']),
      options: [{ group: 'p', options: [{ name: 'detached' }] }],
    })

    failResolution = true
    catalogMode = 'absent-broken'
    const degraded = await control.options()
    expect(degraded[0]).toMatchObject({
      currentValue: JSON.stringify(['p', 'detached']),
      options: [{ group: 'p', name: 'p', options: [{ name: 'detached' }] }],
    })

    const neverResolved = new AcpModelControl(llm, { provider: 'p', model: 'detached' })
    await expect(neverResolved.options()).rejects.toThrow('route offline')
  })
})
