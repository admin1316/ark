import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SettingsController from '../src/index.ts'

describe('openAgentPresetDirectory failure surfaces', () => {
  it('stringifies a non-Error opener failure into the internal failure', async () => {
    const ctx = new Context()
    ctx.provide('agentPresets', {
      resolve: (id: string) => Promise.resolve({ id, trust: 'user', path: '/presets/' + id + '/agent.cordis.yml' }),
    } as never)
    const controller = new SettingsController(ctx, { nativeOpen: true }, {
      openPath: () => Promise.reject('spawn exploded'),
    })
    await expect(controller.openAgentPresetDirectory('mine', new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'internal', message: 'path open failed: spawn exploded' } })
  })

  it('reports an Error opener failure message into the internal failure', async () => {
    const ctx = new Context()
    ctx.provide('agentPresets', {
      resolve: (id: string) => Promise.resolve({ id, trust: 'user', path: '/presets/' + id + '/agent.cordis.yml' }),
    } as never)
    const controller = new SettingsController(ctx, { nativeOpen: true }, {
      openPath: () => Promise.reject(new Error('spawn missing')),
    })
    await expect(controller.openAgentPresetDirectory('mine', new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'internal', message: 'path open failed: spawn missing' } })
  })
})
