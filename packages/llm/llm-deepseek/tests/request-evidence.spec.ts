import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { SessionId } from '@deepseek-ai/dsh-session'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type {} from '@deepseek-ai/dsh-plugin-package-inventory-deepseek'
import * as plugin from '../src/index.ts'
import { DeepSeekAdapter } from '../src/adapter.ts'
import type { DeepSeekAdapterOptions, ProviderRequestObservation } from '../src/adapter.ts'
import { textEvents } from './mock-server.ts'

const request: GenerateOptions = {
  provider: 'deepseek-official',
  model: 'm',
  sessionId: SessionId('trial-session'),
  maxTokens: 4096,
  messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'offline request 离线 🧭' }] })],
}
const user = '00000000-0000-4000-8000-000000000001' as AnonymousUserId
const extensionFields = { dsh_plugin_packages: { version: 1 as const, packages: [{ name: 'frozen-fixture', version: '1' }] } }
const response = () => new Response(textEvents.map(event => `data: ${event}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream' },
})
const drain = async (adapter: DeepSeekAdapter, options = request): Promise<void> => {
  for await (const _chunk of adapter.stream(options)) { /* Consume the complete stream. */ }
}
function adapter(
  recordProviderRequest?: DeepSeekAdapterOptions['recordProviderRequest'],
  baseURL = 'http://127.0.0.1:49001',
) {
  return new DeepSeekAdapter({
    options: () => plugin.resolveAdapterOptions({ baseURL }),
    resolveApiKey: () => Promise.resolve('offline-fixture-key'),
    resolveUserId: () => user,
    ...(recordProviderRequest === undefined ? {} : { recordProviderRequest }),
    prepareExtensions: () => Promise.resolve({ fields: extensionFields, accept: () => Promise.resolve() }),
  })
}
let testHome: string
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'ark-provider-evidence-'))
  vi.stubEnv('DSH_HOME', testHome)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(testHome, { recursive: true, force: true })
})

it('observes final extension-merged wire bytes and original replay request, then stamps only a registered local dispatch', async () => {
  let observed: ProviderRequestObservation | undefined
  const fetchMock = vi.fn<typeof fetch>(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  const controller = new AbortController()
  await drain(adapter((value, signal) => {
    observed = value
    expect(signal.aborted).toBe(false)
    return Promise.resolve({ status: 'registered', dispatchId: 'dispatch-1' })
  }), { ...request, signal: controller.signal })
  expect(fetchMock).toHaveBeenCalledOnce()
  const [url, init] = fetchMock.mock.calls[0]!
  const payload = init!.body
  assert(typeof payload === 'string')
  expect(observed?.requestBodyHash).toBe(createHash('sha256').update(payload).digest('hex'))
  expect(JSON.parse(payload)).toMatchObject({ ...extensionFields, max_tokens: 4096 })
  expect(observed?.request).toEqual(request)
  expect(observed?.request).not.toHaveProperty('signal')
  expect(observed).toMatchObject({
    sessionId: request.sessionId,
    endpoint: url,
    provider: request.provider,
    configuredModel: request.model,
    wireModel: request.model,
    maxTokens: 4096,
  })
  expect(url).toBe('http://127.0.0.1:49001/chat/completions')
  expect(new Headers(init!.headers).get('x-ark-cost-dispatch-id')).toBe('dispatch-1')
})

it('untracked requests preserve the unobserved request body and upstream headers exactly', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  await drain(adapter(undefined, 'https://provider.invalid'))
  await drain(adapter(() => Promise.resolve({ status: 'untracked' }), 'https://provider.invalid'))
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const [baselineUrl, baseline] = fetchMock.mock.calls[0]!
  const [url, init] = fetchMock.mock.calls[1]!
  expect(url).toBe(baselineUrl)
  expect(init!.body).toBe(baseline!.body)
  expect(init!.headers).toEqual(baseline!.headers)
  expect(new Headers(init!.headers).has('x-ark-cost-dispatch-id')).toBe(false)
  expect(new Headers(init!.headers).get('authorization')).toBe('Bearer offline-fixture-key')
})

it.each(['https://provider.invalid', 'https://127.0.0.1:49001', 'http://localhost:49001'])(
  'refuses a registered dispatch outside its authorized IPv4 HTTP guard before network I/O: %s', async (baseURL) => {
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    await expect(drain(adapter(() => Promise.resolve({ status: 'registered', dispatchId: 'dispatch-1' }), baseURL)))
      .rejects.toMatchObject({ code: 'REQUEST_EVIDENCE' })
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

it('owner refusal stops before fetch', async () => {
  const fetchMock = vi.fn(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  await expect(drain(adapter(() => Promise.reject(new Error('unregistered source'))))).rejects.toMatchObject({
    code: 'REQUEST_EVIDENCE', cause: { message: 'unregistered source' },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('cancellation after owner observation does not dispatch a registered request', async () => {
  const fetchMock = vi.fn(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  const controller = new AbortController()
  await expect(drain(adapter(() => {
    controller.abort(new Error('caller stopped'))
    return Promise.resolve({ status: 'registered', dispatchId: 'dispatch-1' })
  }), { ...request, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('cancels an outstanding owner registration without relabeling cancellation as evidence failure', async () => {
  const fetchMock = vi.fn(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  const controller = new AbortController()
  const started = Promise.withResolvers<AbortSignal>()
  const ownerRejected = vi.fn()
  const pending = drain(adapter((_value, signal) => {
    started.resolve(signal)
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        ownerRejected()
        reject(new Error('owner registration cancelled'))
      }, { once: true })
    })
  }), { ...request, signal: controller.signal })
  const assertion = expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  const ownerSignal = await started.promise
  expect(ownerSignal.aborted).toBe(false)
  expect(fetchMock).not.toHaveBeenCalled()
  controller.abort(new Error('caller stopped while registering'))
  await assertion
  expect(ownerSignal.aborted).toBe(true)
  expect(ownerRejected).toHaveBeenCalledOnce()
  expect(fetchMock).not.toHaveBeenCalled()
})

it('awaits owner acceptance before any provider fetch', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  const started = Promise.withResolvers<undefined>()
  const registration = Promise.withResolvers<{ status: 'registered'; dispatchId: string }>()
  const pending = drain(adapter(() => {
    started.resolve(undefined)
    return registration.promise
  }))
  await started.promise
  expect(fetchMock).not.toHaveBeenCalled()
  registration.resolve({ status: 'registered', dispatchId: 'accepted-after-wait' })
  await pending
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(new Headers(fetchMock.mock.calls[0]![1]!.headers).get('x-ark-cost-dispatch-id')).toBe('accepted-after-wait')
})

it('auxiliary and sessionless calls cannot enter the finite main-turn registration path', async () => {
  const observed = vi.fn(() => Promise.resolve({ status: 'untracked' as const }))
  const fetchMock = vi.fn<typeof fetch>(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  const { sessionId: _session, ...sessionless } = request
  for (const options of [{ ...request, purpose: 'compaction' as const }, sessionless]) {
    fetchMock.mockClear()
    await drain(adapter(undefined), options)
    await drain(adapter(observed), options)
    const baseline = fetchMock.mock.calls[0]![1]!
    const init = fetchMock.mock.calls[1]![1]!
    expect(init.body).toBe(baseline.body)
    expect(init.headers).toEqual(baseline.headers)
    expect(new Headers(init.headers).has('x-ark-cost-dispatch-id')).toBe(false)
  }
  expect(observed).not.toHaveBeenCalled()
})

it('reports absent max_tokens as null instead of guessing a connection default', async () => {
  let observed: ProviderRequestObservation | undefined
  const fetchMock = vi.fn<typeof fetch>(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  const { maxTokens: _cap, ...uncapped } = request
  await drain(adapter((value) => {
    observed = value
    return Promise.resolve({ status: 'untracked' })
  }), uncapped)
  expect(observed?.maxTokens).toBeNull()
  const [, init] = fetchMock.mock.calls[0]!
  const payload = init!.body
  assert(typeof payload === 'string')
  expect(JSON.parse(payload)).not.toHaveProperty('max_tokens')
})

it('assembled plugin resolves the optional owner per request and releases it after owner fiber disposal', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'offline-fixture-key')
  const fetchMock = vi.fn<typeof fetch>(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  const ctx = new Context()
  const observeProviderRequest = vi.fn(() => Promise.resolve({ status: 'registered' as const, dispatchId: 'owner-dispatch' }))
  const send = async () => {
    for await (const _chunk of ctx.llm.stream(request)) { /* Assembled provider call. */ }
  }
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
    await ctx.plugin(plugin, { baseURL: 'http://127.0.0.1:49001' })
    await send()
    const owner = await ctx.plugin((ownerCtx) => {
      ownerCtx.provide('nativeKnowledgeOwnerClient', Object.freeze({ observeProviderRequest }))
    })
    await send()
    await owner.dispose()
    await send()
    expect(ctx.get('nativeKnowledgeOwnerClient')).toBeUndefined()
    expect(observeProviderRequest).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const calls = fetchMock.mock.calls.map(([, init]) => init!)
    expect(calls.map(init => new Headers(init.headers).get('x-ark-cost-dispatch-id'))).toEqual([null, 'owner-dispatch', null])
    expect(calls[2]!.body).toBe(calls[0]!.body)
    expect(calls[2]!.headers).toEqual(calls[0]!.headers)
  } finally {
    await ctx.fiber.dispose()
  }
})
