import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { settingsNamespace } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

const namespace = settingsNamespace('native-settings')
const schema = z.object({ label: z.string().default('initial'), apiKey: z.string().role('secret') })
const contexts: Context[] = []

async function boot() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings, { doc: { [namespace]: { apiKey: 'fixture-secret' } } })
  ctx.settings.register(namespace, schema)
  return ctx.settings
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('native settings Remote', () => {
  it.each(['dict', 'array', 'object', 'tuple'] as const)('refuses malformed %s defaults and overridden base without echoing secrets', async (kind) => {
    for (const layer of ['default', 'base']) {
      const ctx = new Context()
      contexts.push(ctx)
      const secret = z.string().role('secret')
      const container = kind === 'dict' ? z.dict(secret) : kind === 'array' ? z.array(secret)
        : kind === 'object' ? z.object({ token: secret }) : z.tuple([secret])
      const valid = kind === 'dict' || kind === 'object' ? {} : ['synthetic-user-secret']
      await ctx.plugin(MemorySettings, { doc: { [namespace]: { tokens: valid } } })
      if (layer === 'default') Reflect.set(container.meta, 'default', 'synthetic-malformed-default-secret')
      const schema: z<object> = z.object({ tokens: container })
      ctx.settings.register(namespace, schema, layer === 'base' ? { base: { tokens: 'synthetic-overridden-base-secret' } } : {})
      expect(ctx.settings.get(namespace)).toHaveProperty('tokens')
      expect(() => ctx.settings.remoteDescribe()).toThrow('settings cannot safely redact a malformed secret-bearing container')
    }
  })

  it('removes secrets from union branches and both field and parent schema defaults', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemorySettings)
    const credentials = z.object({ token: z.string().role('secret').default('field-default-secret'), label: z.string() })
    const union = z.union([credentials, z.object({ label: z.string() })])
      .default({ token: 'parent-default-secret', label: 'parent-default-label' })
    ctx.settings.register(namespace, z.object({ provider: union }), {
      base: { provider: { token: 'composition-secret', label: 'visible' } },
    })
    const description = ctx.settings.remoteDescribe()
    const encoded = JSON.stringify(description)
    for (const secret of ['field-default-secret', 'parent-default-secret', 'composition-secret']) {
      expect(encoded).not.toContain(secret)
    }
    expect(description.namespaces[0]?.value).toEqual({ provider: { label: 'visible' } })
    expect(description.namespaces[0]?.secrets).toEqual([{ path: ['provider', 'token'], set: true }])
  })

  it('rejects unsupported secret transforms without revealing their values', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemorySettings)
    ctx.settings.register(namespace, z.object({
      value: z.transform(z.string().role('secret'), value => value),
    }), { base: { value: 'transform-secret' } })
    expect(() => ctx.settings.remoteDescribe()).toThrow('cannot safely redact')
  })

  it('registers all five methods on the storage owner and redacts each read and write', async () => {
    const settings = await boot()
    expect(remoteMethods(settings).map(method => method.exportName).sort()).toEqual([
      'describe', 'mutate', 'openDocument', 'replace', 'update',
    ])
    const description = settings.remoteDescribe()
    expect(description).toMatchObject({ writable: true, hasDocument: false })
    expect(JSON.stringify(description)).not.toContain('fixture-secret')
    expect(description.namespaces[0]?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    const merged = await settings.remoteUpdate(namespace, { label: 'merged' }, 0)
    expect(merged.value).toEqual({ label: 'merged' })
    const mutated = await settings.remoteMutate(namespace, [{ op: 'unset', path: ['label'] }], merged.revision)
    expect(mutated.value).toEqual({ label: 'initial' })
    expect(settings.get(namespace)).toMatchObject({ apiKey: 'fixture-secret' })
    const replaced = await settings.remoteReplace(namespace, { label: 'replacement' }, mutated.revision)
    expect(replaced.value).toEqual({ label: 'replacement' })
    expect(settings.get(namespace)).not.toHaveProperty('apiKey')
  })

  it('returns detached projections and never includes schema validation secrets in a rejection', async () => {
    const settings = await boot()
    const view = settings.remoteDescribe().namespaces[0]!
    Reflect.set(view.value as object, 'label', 'changed-by-client')
    expect(settings.get(namespace)).toMatchObject({ label: 'initial' })
    await expect(settings.remoteUpdate(namespace, { label: { password: 'do-not-echo' } })).rejects.toMatchObject({
      failure: { code: 'settings-rejected', message: `settings write for "${namespace}" was rejected` },
    })
    expect(settings.get(namespace)).toMatchObject({ label: 'initial' })
  })

  it('rejects stale writes and reserves protected namespaces for their domain transaction', async () => {
    const settings = await boot()
    await settings.remoteUpdate(namespace, { label: 'first' }, 0)
    await expect(settings.remoteUpdate(namespace, { label: 'stale' }, 0)).rejects.toMatchObject({
      failure: { code: 'settings-conflict', details: { ns: namespace, expected: 0, actual: 1 } },
    })
    settings.setRemoteProtectedNamespaces([namespace])
    for (const write of [
      () => settings.remoteUpdate(namespace, { label: 'denied' }),
      () => settings.remoteReplace(namespace, { label: 'denied' }),
      () => settings.remoteMutate(namespace, [{ op: 'set', path: ['label'], value: 'denied' }]),
    ]) await expect(write()).rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
    await settings.update(namespace, { label: 'domain-owned' })
    settings.setRemoteProtectedNamespaces([])
    await settings.remoteUpdate(namespace, { label: 'public-again' })
    expect(settings.get(namespace)).toMatchObject({ label: 'public-again' })
  })

  it('fails closed for unknown namespaces, malformed revisions and read-only providers', async () => {
    const settings = await boot()
    for (const ns of ['', 'INVALID', 'unknown']) {
      await expect(settings.remoteUpdate(ns, {})).rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
    }
    for (const revision of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(settings.remoteUpdate(namespace, {}, revision)).rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
    }
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemorySettings, { writable: false })
    ctx.settings.register(namespace, schema)
    expect(ctx.settings.remoteDescribe().writable).toBe(false)
    await expect(ctx.settings.remoteUpdate(namespace, {})).rejects.toMatchObject({ failure: { code: 'settings-rejected' } })
  })
})

class DocumentSettings extends MemorySettings {
  path: string | undefined = '/isolated/settings.yaml'
  prepare = vi.fn(async () => this.path)
  open = vi.fn(async (_path: string, _signal: AbortSignal) => {})
  override get documentPath() { return this.path }
  override prepareDocument() { return this.prepare() }
  protected override openDocumentInNativeEditor(path: string, signal: AbortSignal) { return this.open(path, signal) }
}

async function documentProvider() {
  const ctx = new Context()
  contexts.push(ctx)
  const provider = new DocumentSettings(ctx)
  return provider
}

describe('native settings document handoff', () => {
  it('prepares and opens only the current absolute provider path', async () => {
    const settings = await documentProvider()
    const signal = new AbortController().signal
    await expect(settings.remoteOpenDocument(signal)).resolves.toEqual({ opened: true })
    expect(settings.open).toHaveBeenCalledExactlyOnceWith('/isolated/settings.yaml', signal)
    for (const path of [undefined, 'relative/settings.yaml']) {
      settings.path = path
      expect(settings.remoteDescribe().hasDocument).toBe(false)
      await expect(settings.remoteOpenDocument(signal)).rejects.toMatchObject({ failure: { code: 'internal' } })
    }
  })

  it('refuses cancellation before preparation, after preparation, and after handoff', async () => {
    for (const phase of ['before', 'prepare', 'open']) {
      const settings = await documentProvider()
      const abort = new AbortController()
      if (phase === 'before') abort.abort()
      if (phase === 'prepare') settings.prepare.mockImplementation(async () => { abort.abort(); return settings.path })
      if (phase === 'open') settings.open.mockImplementation(async () => { abort.abort() })
      await expect(settings.remoteOpenDocument(abort.signal)).rejects.toMatchObject({ failure: { code: 'cancelled' } })
      if (phase !== 'open') expect(settings.open).not.toHaveBeenCalled()
    }
  })

  it('rejects changed ownership and contains preparation and native command diagnostics', async () => {
    const settings = await documentProvider()
    const signal = new AbortController().signal
    settings.prepare.mockResolvedValue('/other/settings.yaml')
    await expect(settings.remoteOpenDocument(signal)).rejects.toMatchObject({ failure: { code: 'internal' } })
    settings.prepare.mockImplementation(async () => { settings.path = '/changed/settings.yaml'; return '/isolated/settings.yaml' })
    await expect(settings.remoteOpenDocument(signal)).rejects.toMatchObject({ failure: { code: 'internal' } })
    expect(settings.open).not.toHaveBeenCalled()
    settings.prepare.mockRejectedValue(new Error('private preparation diagnostic'))
    await expect(settings.remoteOpenDocument(signal)).rejects.toMatchObject({ failure: { message: 'settings document preparation failed' } })
    settings.prepare.mockImplementation(async () => settings.path)
    settings.open.mockRejectedValue(new Error('private command diagnostic'))
    await expect(settings.remoteOpenDocument(signal)).rejects.toMatchObject({ failure: { message: 'settings document open failed' } })
  })
})
