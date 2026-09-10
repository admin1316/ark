import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsScope } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

const ns = settingsNamespace('settlement-test')
const schema = z.object({ value: z.number().default(0) })
const contexts: Context[] = []

async function boot() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings)
  let scope: SettingsScope<{ value: number }> | undefined
  const owner = ctx.plugin({
    inject: ['settings'],
    apply(child: Context) { scope = child.settings.register(ns, schema) },
  })
  await owner
  if (scope === undefined) throw new Error('namespace did not register')
  return { ctx, owner, scope }
}

afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

it('binds the exact revision before document notification and waits for activation', async () => {
  const { ctx, scope } = await boot()
  const applied = Promise.withResolvers<undefined>()
  scope.watch(() => applied.promise)
  let settlement: Promise<boolean> | undefined
  let settled = false
  ctx.on('settings/document-updated', (namespace, revision) => {
    expect(ctx.settings.get(namespace)).toEqual({ value: 1 })
    settlement = ctx.settings.settle(namespace, revision)
    void settlement.then(() => { settled = true })
  })
  await scope.update({ value: 1 })
  await Promise.resolve()
  expect(settled).toBe(false)
  applied.resolve(undefined)
  await expect(settlement).resolves.toBe(true)
})

it('distinguishes a durable commit from an owner callback rejection', async () => {
  const { ctx, scope } = await boot()
  scope.watch(() => { throw new Error('activation refused') })
  await scope.update({ value: 1 })
  await expect(ctx.settings.settle(ns, 1)).resolves.toBe(false)
  expect(ctx.settings.get(ns)).toEqual({ value: 1 })
  await expect(ctx.settings.settle(ns, 0)).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
})

it('does not claim an exact revision activated after a later write supersedes it', async () => {
  const { ctx, scope } = await boot()
  const applied = Promise.withResolvers<undefined>()
  scope.watch(() => applied.promise)
  await scope.update({ value: 1 })
  const first = ctx.settings.settle(ns, 1)
  const failure = expect(first).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
  await scope.update({ value: 2 })
  applied.resolve(undefined)
  await failure
  await expect(ctx.settings.settle(ns, 2)).resolves.toBe(true)
})

it('settles a raw override equal to the inherited value without rerunning callbacks', async () => {
  const { ctx, scope } = await boot()
  const callback = vi.fn()
  scope.watch(callback)
  await scope.update({ value: 0 })
  await expect(ctx.settings.settle(ns, 1)).resolves.toBe(true)
  expect(callback).not.toHaveBeenCalled()
})

it('keeps the namespace reserved while an old owner drains and rejects new watchers', async () => {
  const { ctx, owner, scope } = await boot()
  const started = Promise.withResolvers<undefined>()
  const finished = Promise.withResolvers<undefined>()
  scope.watch(async () => { started.resolve(undefined); await finished.promise })
  await scope.update({ value: 1 })
  await started.promise
  const settlement = ctx.settings.settle(ns, 1)
  const failure = expect(settlement).rejects.toThrow('disposed')
  const disposal = owner.dispose()
  await vi.waitFor(() => { expect(() => scope.watch(() => {})).toThrow('disposed') })
  expect(() => ctx.settings.register(ns, schema)).toThrow('already registered')
  finished.resolve(undefined)
  await disposal
  await failure
  const replacement = ctx.settings.register(ns, schema)
  expect(replacement.get()).toEqual({ value: 1 })
  await expect(scope.update({ value: 9 })).rejects.toThrow('disposed')
  await expect(scope.replace({ value: 9 })).rejects.toThrow('disposed')
  expect(replacement.get()).toEqual({ value: 1 })
})

it('lets a watcher unload its own plugin without awaiting itself', async () => {
  const { ctx, owner, scope } = await boot()
  const finished = Promise.withResolvers<undefined>()
  scope.watch(async () => { await owner.dispose(); finished.resolve(undefined) })
  await scope.update({ value: 1 })
  await finished.promise
  expect(ctx.settings.get(ns)).toBeUndefined()
})

it('drains an unsubscribed but still running watcher before releasing its namespace', async () => {
  const { ctx, owner, scope } = await boot()
  const started = Promise.withResolvers<undefined>()
  const finished = Promise.withResolvers<undefined>()
  const unsubscribe = scope.watch(async () => { started.resolve(undefined); await finished.promise })
  await scope.update({ value: 1 })
  await started.promise
  unsubscribe()
  let stopped = false
  const disposal = owner.dispose().then(() => { stopped = true })
  await Promise.resolve()
  expect(stopped).toBe(false)
  expect(() => ctx.settings.register(ns, schema)).toThrow('already registered')
  finished.resolve(undefined)
  await disposal
  expect(ctx.settings.get(ns)).toBeUndefined()
})

it('blocks replacement after the old owner exceeds its deadline, until its work actually stops', async () => {
  class TimedSettings extends MemorySettings {
    protected override get registrationQuiescenceTimeoutMs() { return 10 }
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TimedSettings)
  const started = Promise.withResolvers<undefined>()
  const finished = Promise.withResolvers<undefined>()
  const owner = ctx.plugin({
    inject: ['settings'],
    apply(child: Context) {
      child.settings.register(ns, schema).watch(async () => { started.resolve(undefined); await finished.promise })
    },
  })
  await owner
  await ctx.settings.update(ns, { value: 1 })
  await started.promise
  const disposal = owner.dispose()
  await vi.waitFor(() => {
    expect(() => ctx.settings.register(ns, schema)).toThrow('replacement remains blocked')
  })
  finished.resolve(undefined)
  await disposal
  await vi.waitFor(() => { expect(ctx.settings.get(ns)).toBeUndefined() })
  expect(ctx.settings.register(ns, schema).get()).toEqual({ value: 1 })
})

it('previews secret positions and rejects new unsafe writes before storage', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings, { doc: { [ns]: { value: 0 } } })
  const redact = vi.fn((value: unknown) => ({ value: {}, secrets: [{ path: ['value'], set: value !== undefined }] }))
  ctx.settings.register(ns, schema, {
    validateWrite(value) { if (value.value < 1) throw new Error('unsafe new value') }, redact,
  })
  expect(ctx.settings.previewMutation(ns, [{ op: 'set', path: ['value'], value: 1 }])).toEqual({
    secrets: [{ path: ['value'], set: true }],
  })
  expect(ctx.settings.get(ns)).toEqual({ value: 0 })
  expect(() => ctx.settings.previewMutation(ns, [{ op: 'set', path: ['value'], value: 0 }])).toThrow('unsafe')
  await expect(ctx.settings.update(ns, { value: 0 })).rejects.toThrow('unsafe')
  expect(ctx.settings.remoteDescribe().namespaces[0]).toMatchObject({ value: {}, user: {} })
})

it('preserves prototype-shaped keys as own JSON data through merge and path edits', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings)
  ctx.settings.register(ns, z.dict(z.any()))
  const input = { ['__proto__']: { polluted: true }, constructor: { value: 1 } }
  await ctx.settings.update(ns, input)
  const user = ctx.settings.describe()[0]!.user
  expect(user).toEqual(input)
  expect(Object.getPrototypeOf(user)).toBe(Object.prototype)
  expect(Object.prototype).not.toHaveProperty('polluted')
  await ctx.settings.mutate(ns, [{ op: 'set', path: ['__proto__', 'nested'], value: 2 }])
  expect(ctx.settings.describe()[0]!.user).toEqual(JSON.parse('{"__proto__":{"polluted":true,"nested":2},"constructor":{"value":1}}'))
})
