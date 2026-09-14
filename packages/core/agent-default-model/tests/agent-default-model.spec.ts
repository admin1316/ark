/** Default Agent model settings layered over a real settings provider. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig, { AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE } from '../src/index.ts'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { sessionModelSelection } from '../src/session-selection.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(): Promise<{
  ctx: Context
  settingsFiber: Context['fiber']
  defaultModel: AgentDefaultModelConfig
}> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  await ctx.plugin(AgentDefaultModelConfig, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  return { ctx, settingsFiber, defaultModel: ctx.agentDefaultModel }
}

describe('AgentDefaultModelConfig', () => {
  it('resolves the user layer over the composition entry', async () => {
    const bench = await boot()
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })

    await bench.defaultModel.saveSelection({
      provider: 'acme-gateway', model: 'acme-large', reasoningEffort: ReasoningEffortId('high'),
    })
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'acme-gateway', model: 'acme-large', reasoningEffort: 'high',
    })
    await bench.ctx.fiber.dispose()
  })

  it('clears a stored effort when the saved selection has none', async () => {
    const bench = await boot()
    await bench.defaultModel.saveSelection({
      provider: 'acme-gateway', model: 'acme-large', reasoningEffort: ReasoningEffortId('high'),
    })
    await bench.defaultModel.saveSelection({ provider: 'acme-gateway', model: 'acme-plain' })
    expect(bench.defaultModel.currentSelection()).toEqual({ provider: 'acme-gateway', model: 'acme-plain' })
    await bench.ctx.fiber.dispose()
  })

  it('layers a hand-written partial section over the entry', async () => {
    const bench = await boot()
    await bench.settingsFiber.ctx.settings.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
      model: 'deepseek-reasoner',
    })
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-reasoner',
    })
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot()
    await bench.defaultModel.saveSelection({ provider: 'acme-gateway', model: 'acme-large' })
    expect(bench.defaultModel.currentSelection().provider).toBe('acme-gateway')
    await bench.settingsFiber.dispose()
    expect(bench.defaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    await bench.ctx.fiber.dispose()
  })

  it('keeps the composition entry when no settings provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
    await ctx.agentDefaultModel.saveSelection({ provider: 'other', model: 'other' })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'p', model: 'm' })
    await ctx.fiber.dispose()
  })
})


describe('transport-independent Session model intent', () => {
  it('normalizes absent reasoning effort in persisted and wire projections without accepting empty effort', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'default', model: 'default-model' })
    const session = ctx.sessions.create(SessionId('schema-test'))
    const restore = (pending: unknown) => ctx.sessionProjections.restore({
      modelSelection: { ver: 2, seq: -1, val: { lastUsed: null, pending } },
    }, [], 0, session.header)
    for (const pending of [
      { provider: 'p', model: 'm' },
      { provider: 'p', model: 'm', reasoningEffort: undefined },
    ]) {
      expect(restore(pending).checkpoint.modelSelection?.val).toEqual({
        lastUsed: null, pending: { provider: 'p', model: 'm' },
      })
      const view = restore(pending).snapshot.values.modelSelection
      expect(view).toEqual({ lastUsed: null, next: { provider: 'p', model: 'm' } })
      expect(view).not.toHaveProperty('next.reasoningEffort')
    }
    expect(() => restore({ provider: 'p', model: 'm', reasoningEffort: '' })).toThrow()
    expect(restore({ provider: 'p', model: 'm', reasoningEffort: 'high' }).checkpoint.modelSelection?.val).toEqual({ lastUsed: null, pending: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
    await ctx.fiber.dispose()
  })

  it('registers and restores pending intent without any Session controller, then consumes only its matching request', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'default', model: 'default-model' })
    const original = ctx.sessions.create(SessionId('saved-selection'), { meta: { cwd: '/fixture' } })
    original.append('request/header', {
      header: { config: { provider: 'old', model: 'old-model' } }, reason: 'initial',
    })
    original.append('model/selection', { provider: 'chosen', model: 'chosen-model', reasoningEffort: 'high' })
    const restored = ctx.sessions.prepare(SessionId('restored-selection'), {
      meta: { cwd: '/fixture' }, seed: [...original.events],
    })
    const agentCtx = ctx.extend({})
    const agent = { id: restored.id, session: restored, ctx: agentCtx } as Agent
    const selection = sessionModelSelection(ctx, agent)
    expect(sessionModelSelection(ctx, agent)).toBe(selection)
    expect(selection.current).toEqual({ provider: 'chosen', model: 'chosen-model', reasoningEffort: 'high' })
    expect(ctx.sessionProjections.snapshot(restored).values.modelSelection?.next).toEqual(selection.current)
    restored.append('request/header', {
      header: { config: { provider: 'old', model: 'old-model' } }, reason: 'initial',
    })
    expect(selection.current.provider).toBe('chosen')
    restored.append('request/header', {
      header: { config: { provider: 'chosen', model: 'chosen-model', reasoningEffort: ReasoningEffortId('high') },
        adapterDefaults: { reasoningEffort: true } }, reason: 'initial',
    })
    expect(ctx.sessionProjections.stateOf(restored, 'modelSelection')?.pending).toBeNull()
    // Adapter-default effort is logged use, not a persistent explicit override.
    expect(selection.current).toEqual({ provider: 'chosen', model: 'chosen-model' })
    await ctx.fiber.dispose()
  })
})
