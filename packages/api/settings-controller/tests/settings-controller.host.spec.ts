import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  InvalidPresetIdError,
  PresetExistsError,
  UnknownPresetError,
} from '@deepseek-ai/dsh-agent-presets'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsDescriptor, SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { TypertLookupFailure, TypertRemoteFailure, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SettingsController from '../src/index.ts'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'

const NS = settingsNamespace('ui-test')

const Profile = z.object({
  preference: z.union(['light', 'dark']).default('light'),
  apiKey: z.string().role('secret'),
})

/** A provider that reports a local document, for the `hasDocument` fact. */
class DocumentSettings extends MemorySettings {
  readonly openEditor = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())

  protected override openDocumentInNativeEditor(path: string, signal: AbortSignal): Promise<void> {
    return this.openEditor(path, signal)
  }

  override get documentPath(): string | undefined {
    return '/deployment/settings.yaml'
  }
}

/** A provider whose read forgets the namespace its write just committed. */
class VanishingSettings extends MemorySettings {
  override describe(): SettingsDescriptor[] {
    return []
  }
}

/**
 * A provider whose descriptor omits the secret-slot list. `secrets` is optional
 * on the descriptor, so a foreign provider may leave it out even under
 * `redactSecrets`, and the view still has to declare an empty list.
 */
class SlotlessSettings extends MemorySettings {
  override describe(): SettingsDescriptor[] {
    return [{
      ns: NS,
      schema: Profile.toJSON(),
      value: { preference: 'light' },
      applies: 'live',
      revision: 0,
    } as unknown as SettingsDescriptor]
  }
}

/** A provider that refuses every write the way a read-only backing store would. */
class RefusingSettings extends MemorySettings {
  override mutate(ns: SettingsNamespace): Promise<void> {
    return Promise.reject(new Error(`settings "${ns}" is read-only in this deployment`))
  }
}

/** A provider that refuses with a bare string, the way some storage clients do. */
class LiteralRefusingSettings extends MemorySettings {
  override async mutate(): Promise<void> {
    throw 'the document is locked'
  }
}

async function boot(
  provider: typeof MemorySettings = MemorySettings,
  options: { doc?: Record<string, unknown>; base?: { preference: 'light' | 'dark' } } = {},
): Promise<{ controller: SettingsController; ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(provider, options.doc === undefined ? {} : { doc: options.doc })
  ctx.settings.register(NS, Profile, options.base === undefined ? {} : { base: options.base })
  await ctx.plugin(SettingsController)
  return { controller: ctx.settingsController, ctx }
}

describe('the settings Remote namespace a configuration page calls', () => {
  it('publishes the settings namespace from its own service key', async () => {
    const { controller } = await boot()
    expect(controller.typertRemote.serviceKey).toBe('settingsController')
    expect(controller.typertRemote.namespace).toBe('settings')
    expect(remoteMethods(controller)).toEqual([
      { method: 'canOpenAgentPresetDirectory', invocation: { kind: 'direct' } },
      { method: 'openSettingsDocument', invocation: { kind: 'direct' } },
      { method: 'openAgentPresetDirectory', invocation: { kind: 'direct' } },
    ])
  })

  it('reports the actionable configuration error while no settings provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SettingsController)
    const calls: Array<() => unknown> = [
      () => ctx.settingsController.openSettingsDocument(new AbortController().signal),
    ]
    for (const call of calls) {
      const failure = await Promise.resolve().then(call).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(TypertRemoteFailure)
      expect((failure as TypertRemoteFailure).failure).toEqual({
        code: 'internal',
        message: 'settings service is absent: this deployment does not mount a settings provider (e.g. @deepseek-ai/dsh-settings-file) in its composition',
        details: {},
      })
    }
  })

  it('disposes desktop actions without disposing the canonical settings owner', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    ctx.settings.register(NS, Profile)
    const fiber = ctx.plugin(SettingsController)
    await fiber.await()
    const settings = ctx.settings
    expect(remoteMethods(settings).map(method => method.exportName)).toContain('describe')
    await fiber.dispose()
    expect(ctx.get('settingsController')).toBeUndefined()
    expect(ctx.settings.typertRemote.serviceKey).toBe(settings.typertRemote.serviceKey)
    expect(ctx.settings.remoteDescribe().namespaces).toHaveLength(1)
  })

  it('describes every namespace redacted, with the deployment facts around them', async () => {
    const { ctx } = await boot(DocumentSettings, { doc: { 'ui-test': { apiKey: 'sk-stored' } } })
    const value = ctx.settings.remoteDescribe()
    expect(value).toMatchObject({ writable: true, hasDocument: true })
    const [view] = value.namespaces
    expect(view?.ns).toBe('ui-test')
    // The secret never rides; its slot reports only that one is stored.
    expect(JSON.stringify(value)).not.toContain('sk-stored')
    expect(view?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    // Redaction removes the field rather than replacing it, so the layer that
    // stored a secret comes back empty instead of carrying a placeholder.
    expect(view?.user).toEqual({})
  })

  it('reports a read-only provider and omits the layers it has none of', async () => {
    const { ctx } = await boot(class extends MemorySettings {
      override get writable(): boolean {
        return false
      }
    })
    const value = ctx.settings.remoteDescribe()
    expect(value).toMatchObject({ writable: false, hasDocument: false })
    const [view] = value.namespaces
    // No composition base was declared and no user section is stored, so
    // neither optional layer appears at all.
    expect(view && 'base' in view).toBe(false)
    expect(view && 'user' in view).toBe(false)
  })

  it('declares an empty slot list when the provider names no secrets', async () => {
    const { ctx } = await boot(SlotlessSettings)
    const [view] = ctx.settings.remoteDescribe().namespaces
    expect(view?.secrets).toEqual([])
  })

  it('carries the composition base layer when the registrant declared one', async () => {
    const { ctx } = await boot(MemorySettings, { base: { preference: 'dark' } })
    const [view] = ctx.settings.remoteDescribe().namespaces
    expect(view?.base).toEqual({ preference: 'dark' })
  })

  it('applies path-addressed edits and answers with the namespace it just wrote', async () => {
    const { ctx } = await boot()
    const view = await ctx.settings.remoteMutate('ui-test', [{ op: 'set', path: ['preference'], value: 'dark' }], undefined)
    expect(view).toMatchObject({ ns: 'ui-test', user: { preference: 'dark' } })
    expect(view.revision).toBeGreaterThan(0)
  })

  it('supports merge updates and wholesale replacement on the Remote namespace', async () => {
    const { ctx } = await boot(MemorySettings, {
      doc: { 'ui-test': { preference: 'dark', apiKey: 'sk-stored' } },
    })
    const updated = await ctx.settings.remoteUpdate('ui-test', { preference: 'light' }, undefined)
    expect(updated.user).toEqual({ preference: 'light' })
    expect(updated.secrets).toEqual([{ path: ['apiKey'], set: true }])

    const replaced = await ctx.settings.remoteReplace('ui-test', {}, updated.revision)
    expect(replaced.value).toEqual({ preference: 'light' })
    expect(replaced.user).toEqual({})
    expect(replaced.secrets).toEqual([{ path: ['apiKey'], set: false }])
  })

  it('refuses a stale write as settings-conflict carrying both revisions', async () => {
    const { ctx } = await boot()
    const held = ctx.settings.remoteDescribe().namespaces[0]!.revision
    await ctx.settings.remoteMutate('ui-test', [{ op: 'set', path: ['preference'], value: 'dark' }], held)
    const failure = await ctx.settings
      .remoteMutate('ui-test', [{ op: 'set', path: ['preference'], value: 'light' }], held)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TypertLookupFailure)
    const { code, details } = (failure as TypertLookupFailure)
    expect(code).toBe('settings-conflict')
    expect(details).toMatchObject({ ns: 'ui-test', expected: held })
  })

  it('answers a malformed namespace exactly as an unregistered one', async () => {
    const { ctx } = await boot()
    for (const ns of ['Not A Namespace', 'unregistered']) {
      const failure = await ctx.settings.remoteMutate(ns, [{ op: 'unset', path: ['preference'] }], undefined)
        .catch((error: unknown) => error)
      expect((failure as TypertLookupFailure)).toMatchObject({
        code: 'settings-rejected',
        details: { ns },
      })
    }
  })

  it('reports an empty namespace as settings-rejected', async () => {
    const { ctx } = await boot()
    for (const call of [
      () => ctx.settings.remoteUpdate('', {}, undefined),
      () => ctx.settings.remoteReplace('', {}, undefined),
      () => ctx.settings.remoteMutate('', [], undefined),
    ]) {
      const failure = await call().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(TypertLookupFailure)
      expect((failure as TypertLookupFailure)).toMatchObject({ code: 'settings-rejected' })
    }
  })

  it('reports a refused write as settings-rejected without exposing the seam message', async () => {
    const { ctx } = await boot(RefusingSettings)
    const failure = await ctx.settings.remoteMutate('ui-test', [{ op: 'unset', path: ['preference'] }], undefined)
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ failure: {
      code: 'settings-rejected', message: 'settings write for "ui-test" was rejected',
    } })
  })

  it('sanitizes a refusal that is not an Error', async () => {
    const { ctx } = await boot(LiteralRefusingSettings)
    const failure = await ctx.settings.remoteMutate('ui-test', [{ op: 'unset', path: ['preference'] }], undefined)
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ failure: { message: 'settings write for "ui-test" was rejected' } })
  })

  it('reports a namespace disposed between the write and its read-back', async () => {
    const { ctx } = await boot(VanishingSettings)
    const failure = await ctx.settings.remoteMutate('ui-test', [{ op: 'set', path: ['preference'], value: 'dark' }], undefined)
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ failure: { code: 'internal', message: 'settings write did not complete' } })
  })

  it('prepares and opens the provider-owned settings document', async () => {
    const ctx = new Context()
    await ctx.plugin(DocumentSettings)
    const prepare = vi.spyOn(ctx.settings, 'prepareDocument').mockResolvedValue('/deployment/settings.yaml')
    const openTextFile = (ctx.settings as DocumentSettings).openEditor
    const controller = new SettingsController(ctx)
    const signal = new AbortController().signal

    await expect(controller.openSettingsDocument(signal)).resolves.toEqual({ opened: true })
    expect(prepare).toHaveBeenCalledOnce()
    expect(openTextFile).toHaveBeenCalledWith('/deployment/settings.yaml', signal)
  })

  it('rejects a prepared path outside the provider-owned document', async () => {
    const ctx = new Context()
    await ctx.plugin(DocumentSettings)
    vi.spyOn(ctx.settings, 'prepareDocument').mockResolvedValue('/unowned/other.yaml')
    const openEditor = (ctx.settings as DocumentSettings).openEditor
    const controller = new SettingsController(ctx)
    await expect(controller.openSettingsDocument(new AbortController().signal))
      .rejects.toMatchObject({ failure: {
        code: 'internal', message: 'settings provider did not prepare its owned local document',
      } })
    expect(openEditor).not.toHaveBeenCalled()
  })

  it('preserves settings-document absence, failure, and cancellation', async () => {
    const absent = await boot()
    const missingDocument = absent.controller.openSettingsDocument(new AbortController().signal)
    await expect(missingDocument).rejects.toMatchObject({ code: 'internal' })
    await expect(missingDocument).rejects.toMatchObject({ failure: { message: 'settings provider has no local document to open' } })

    const failed = await boot(DocumentSettings)
    vi.spyOn(failed.ctx.settings, 'prepareDocument').mockRejectedValue(new Error('read failed'))
    const failedRead = failed.controller.openSettingsDocument(new AbortController().signal)
    await expect(failedRead).rejects.toMatchObject({ code: 'internal' })
    await expect(failedRead).rejects.toMatchObject({ failure: { message: 'settings document preparation failed' } })

    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled'))
    const prepare = vi.spyOn(failed.ctx.settings, 'prepareDocument')
    prepare.mockClear()
    await expect(failed.controller.openSettingsDocument(cancelled.signal))
      .rejects.toMatchObject({ code: 'cancelled' })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('does not open a settings document cancelled during preparation', async () => {
    const ctx = new Context()
    await ctx.plugin(DocumentSettings)
    const prepared = Promise.withResolvers<string | undefined>()
    vi.spyOn(ctx.settings, 'prepareDocument').mockReturnValue(prepared.promise)
    const openTextFile = (ctx.settings as DocumentSettings).openEditor
    const controller = new SettingsController(ctx)
    const abort = new AbortController()

    const opening = controller.openSettingsDocument(abort.signal)
    abort.abort(new Error('cancelled'))
    prepared.resolve('/deployment/settings.yaml')

    await expect(opening).rejects.toMatchObject({ code: 'cancelled' })
    expect(openTextFile).not.toHaveBeenCalled()
  })

  it('maps native settings-document opener failures', async () => {
    const ctx = new Context()
    await ctx.plugin(DocumentSettings)
    vi.spyOn(ctx.settings, 'prepareDocument').mockResolvedValue('/deployment/settings.yaml')
    ;(ctx.settings as DocumentSettings).openEditor.mockRejectedValue(new Error('no default editor'))
    const controller = new SettingsController(ctx)

    await expect(controller.openSettingsDocument(new AbortController().signal))
      .rejects.toMatchObject({
        failure: { code: 'internal', message: 'settings document open failed' },
      })
  })

  it('classifies cancellation while preparing or opening the settings document', async () => {
    const preparing = new Context()
    await preparing.plugin(DocumentSettings)
    const prepareAbort = new AbortController()
    vi.spyOn(preparing.settings, 'prepareDocument').mockImplementation(async () => {
      prepareAbort.abort(new Error('cancelled'))
      throw new Error('preparation stopped')
    })
    const preparingController = new SettingsController(preparing)
    await expect(preparingController.openSettingsDocument(prepareAbort.signal))
      .rejects.toMatchObject({ code: 'cancelled' })

    const opening = new Context()
    await opening.plugin(DocumentSettings)
    vi.spyOn(opening.settings, 'prepareDocument').mockResolvedValue('/deployment/settings.yaml')
    const openAbort = new AbortController()
    ;(opening.settings as DocumentSettings).openEditor.mockImplementation(async () => {
      openAbort.abort(new Error('cancelled'))
      throw new Error('opening stopped')
    })
    const openingController = new SettingsController(opening)
    await expect(openingController.openSettingsDocument(openAbort.signal))
      .rejects.toMatchObject({ code: 'cancelled' })
  })

  it('opens a user Agent preset directory or returns its path without a native opener', async () => {
    const ctx = new Context()
    ctx.provide('agentPresets', {
      resolve: (id: string) => Promise.resolve({
        id, trust: 'user', path: `/presets/${id}/agent.cordis.yml`,
      }),
    } as never)
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const openable = new SettingsController(ctx, { nativeOpen: true }, { openPath })
    expect(openable.canOpenAgentPresetDirectory()).toBe(true)
    const signal = new AbortController().signal
    await expect(openable.openAgentPresetDirectory('mine', signal))
      .resolves.toEqual({ opened: true })
    expect(openPath).toHaveBeenCalledWith('/presets/mine', signal)

    const headless = new Context()
    headless.provide('agentPresets', {
      resolve: (id: string) => Promise.resolve({
        id, trust: 'user', path: `/presets/${id}/agent.cordis.yml`,
      }),
    } as never)
    const reveal = new SettingsController(headless, { nativeOpen: false })
    expect(reveal.canOpenAgentPresetDirectory()).toBe(false)
    await expect(reveal.openAgentPresetDirectory('mine', new AbortController().signal))
      .resolves.toEqual({ opened: false, path: '/presets/mine' })
  })

  it('covers native-open detection defaults and explicit overrides', () => {
    const fromInjectedOpener = new SettingsController(new Context(), {}, {
      openPath: () => Promise.resolve(),
    })
    expect((fromInjectedOpener as unknown as { canOpenPath: () => boolean }).canOpenPath()).toBe(true)

    const detected = new SettingsController(new Context())
    expect(typeof (detected as unknown as { canOpenPath: () => boolean }).canOpenPath()).toBe('boolean')

    const override = vi.fn(() => false)
    const overridden = new SettingsController(new Context(), {}, { canOpenPath: override })
    expect((overridden as unknown as { canOpenPath: () => boolean }).canOpenPath()).toBe(false)
    expect(override).toHaveBeenCalledOnce()
  })

  it('refuses a shipped Agent preset and a missing preset provider', async () => {
    const ctx = new Context()
    ctx.provide('agentPresets', {
      resolve: (id: string) => Promise.resolve({
        id, trust: 'system', path: `/presets/${id}/agent.cordis.yml`,
      }),
    } as never)
    const controller = new SettingsController(ctx)
    await expect(controller.openAgentPresetDirectory('standard', new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'agent-preset-read-only' } })

    const missing = new SettingsController(new Context())
    await expect(missing.openAgentPresetDirectory('mine', new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'agent-preset-not-found' } })
  })

  it('rejects an empty Agent preset id before resolving a provider', async () => {
    const resolve = vi.fn()
    const ctx = new Context()
    ctx.provide('agentPresets', { resolve } as never)
    const controller = new SettingsController(ctx)

    await expect(controller.openAgentPresetDirectory('', new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'bad-request' } })
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each([
    [new UnknownPresetError('missing', ['standard']), 'agent-preset-not-found'],
    [new InvalidPresetIdError('../bad'), 'agent-preset-invalid'],
    [new PresetExistsError('taken'), 'agent-preset-invalid'],
    [new TypertRemoteFailure({ code: 'cancelled', message: 'cancelled', details: {} }), 'cancelled'],
    ['unexpected preset failure', 'internal'],
  ] as const)('maps Agent preset resolution failure %#', async (error, code) => {
    const ctx = new Context()
    ctx.provide('agentPresets', { resolve: async () => { throw error } } as never)
    const controller = new SettingsController(ctx)

    await expect(controller.openAgentPresetDirectory('mine', new AbortController().signal))
      .rejects.toMatchObject({ failure: { code } })
  })

  it('classifies cancellation and non-Error failures from the preset opener', async () => {
    const ctx = new Context()
    ctx.provide('agentPresets', {
      resolve: (id: string) => Promise.resolve({
        id, trust: 'user', path: `/presets/${id}/agent.cordis.yml`,
      }),
    } as never)
    const abort = new AbortController()
    const openPath = vi.fn()
      .mockImplementationOnce(async () => {
        abort.abort(new Error('cancelled'))
        throw new Error('opening stopped')
      })
      .mockRejectedValueOnce('desktop unavailable')
    const controller = new SettingsController(ctx, { nativeOpen: true }, { openPath })

    await expect(controller.openAgentPresetDirectory('first', abort.signal))
      .rejects.toMatchObject({ failure: { code: 'cancelled' } })
    await expect(controller.openAgentPresetDirectory('second', new AbortController().signal))
      .rejects.toMatchObject({
        failure: { code: 'internal', message: 'path open failed: desktop unavailable' },
      })
  })
})
