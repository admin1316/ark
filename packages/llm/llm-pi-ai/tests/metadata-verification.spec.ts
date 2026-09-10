import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles, type PiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const provider = 'fixture-gateway'
const model = 'fixture-model'
const profile: PiAiProviderProfile = {
  api: 'openai-completions', baseURL: 'https://fixture.invalid/v1',
  models: [{ id: model, contextWindow: 4096, maxTokens: 32 }],
}

function adapter(options: {
  profile?: PiAiProviderProfile
  key?: string | null
  headers?: Record<string, string>
} = {}): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({ [provider]: { ...profile, ...options.profile } }),
    resolveApiKey: async () => options.key === null ? undefined : options.key ?? 'fixture-only-key',
    ...(options.headers === undefined ? {} : { resolveCredentialHeaders: async () => options.headers! }),
    auth: memoryAuth(),
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('non-generative exact-model verification boundaries', () => {
  it.each([404, 405])('defers HTTP %s model-detail responses to exact generation rather than declaring success', async (status) => {
    const fetch = vi.fn(async () => new Response(null, { status }))
    vi.stubGlobal('fetch', fetch)
    await expect(adapter().verifyProvider(provider, model, new AbortController().signal)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('refuses retained literal credentials when the adapter is called without the plugin registry', async () => {
    const direct = adapter({ profile: { headers: { Authorization: 'synthetic-private' } } })
    await expect(direct.verifyProvider(provider, model, new AbortController().signal)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('does not fetch unsupported protocols or routes without any credential', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(adapter({ profile: { api: 'anthropic-messages' } }).verifyProvider(provider, model, new AbortController().signal))
      .resolves.toBeUndefined()
    await expect(adapter({ key: null }).verifyProvider(provider, model, new AbortController().signal))
      .resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses declared credential headers without their resolver in both verification and streaming', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const missing = adapter({ profile: { credentialHeaders: { Authorization: 'FIXTURE_REF' } } })
    await expect(missing.verifyProvider(provider, model, new AbortController().signal)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    await expect(missing.stream({ provider, model, messages: [] })[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'AUTH'], [403, 'AUTH'], [503, 'VERIFICATION_FAILED'],
  ] as const)('keeps HTTP %s authoritative even when response cancellation fails', async (status, code) => {
    const cancel = vi.fn(() => { throw new Error('body cancellation failed') })
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetch = vi.fn(async () => new Response(body, { status }))
    vi.stubGlobal('fetch', fetch)
    await expect(adapter().verifyProvider(provider, model, new AbortController().signal)).rejects.toMatchObject({ code })
    expect(fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([false, true])('rejects an oversized Content-Length before reading, body=%s', async (hasBody) => {
    const cancel = vi.fn()
    const response = new Response(hasBody ? new ReadableStream<Uint8Array>({ cancel }) : null, {
      headers: { 'content-length': '65537' },
    })
    const fetch = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetch)
    await expect(adapter().verifyProvider(provider, model, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VERIFICATION_FAILED', message: 'provider verification metadata exceeded its byte limit' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledTimes(hasBody ? 1 : 0)
  })

  it('rejects successful HTTP without a metadata body', async () => {
    vi.stubGlobal('fetch', async () => new Response(null))
    await expect(adapter().verifyProvider(provider, model, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VERIFICATION_FAILED', message: 'provider verification returned no metadata' })
  })

  it.each([
    ['not-json', 'VERIFICATION_FAILED'],
    [JSON.stringify({ id: 'wrong-model' }), 'INVALID_MODEL_INFO'],
    [JSON.stringify({ id: model, provider: 'wrong-provider' }), 'INVALID_MODEL_INFO'],
  ])('refuses invalid or mismatched metadata %#', async (body, code) => {
    const fetch = vi.fn(async () => new Response(body))
    vi.stubGlobal('fetch', fetch)
    await expect(adapter().verifyProvider(provider, model, new AbortController().signal)).rejects.toMatchObject({ code })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('cancels a response delivered after caller cancellation without reading or challenging it', async () => {
    const owner = new AbortController()
    const cancel = vi.fn()
    const fetch = vi.fn(async () => {
      owner.abort()
      return new Response(new ReadableStream<Uint8Array>({ cancel }))
    })
    vi.stubGlobal('fetch', fetch)
    await expect(adapter().verifyProvider(provider, model, owner.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('reports only reachability when exact metadata is available without credentials', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: model })))
    vi.stubGlobal('fetch', fetch)
    await expect(adapter().verifyProvider(provider, model, new AbortController().signal)).resolves.toBe('endpoint-catalog')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['null', '[]', 'true', '"text"'])('rejects non-object metadata %s', async (body) => {
    vi.stubGlobal('fetch', async () => new Response(body))
    await expect(adapter().verifyProvider(provider, model, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VERIFICATION_FAILED', message: 'provider verification metadata was not an object' })
  })

  it('enforces the streamed byte ceiling despite a false small length and failing reader cancellation', async () => {
    const cancel = vi.fn(() => { throw new Error('reader cancellation failed') })
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65537)) }, cancel,
    })
    vi.stubGlobal('fetch', async () => new Response(body, { headers: { 'content-length': '1' } }))
    await expect(adapter().verifyProvider(provider, model, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VERIFICATION_FAILED', message: 'provider verification metadata exceeded its byte limit' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('accepts the exact metadata byte ceiling and strips custom authorization from the challenge', async () => {
    const base = JSON.stringify({ id: model, provider, padding: '' })
    const encoded = new TextEncoder().encode(JSON.stringify({ id: model, provider, padding: 'x'.repeat(65536 - Buffer.byteLength(base)) }))
    expect(encoded.byteLength).toBe(65536)
    const requests: RequestInit[] = []
    const cancel = vi.fn(() => { throw new Error('challenge cleanup failed') })
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      if (requests.length === 2) return new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 403 })
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encoded.subarray(0, 17))
        controller.enqueue(encoded.subarray(17))
        controller.close()
      } }), { headers: { 'content-length': '65536' } })
    })
    await expect(adapter({
      key: null, profile: { credentialHeaders: { Authorization: 'FIXTURE_REF' } },
      headers: { Authorization: 'fixture-only-custom' },
    }).verifyProvider(provider, model, new AbortController().signal)).resolves.toBe('metadata-auth')
    expect(requests).toHaveLength(2)
    expect(new Headers(requests[0]?.headers).get('authorization')).toBe('fixture-only-custom')
    expect(new Headers(requests[1]?.headers).get('authorization')).toBeNull()
    expect(requests.every(request => request.method === 'GET' && request.body === undefined && request.redirect === 'manual')).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('removes every explicit credential header from the challenge even when its name looks public', async () => {
    const headers: Headers[] = []
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      headers.push(new Headers(init?.headers))
      return headers.length === 1 ? new Response(JSON.stringify({ id: model })) : new Response(null, { status: 401 })
    })
    await expect(adapter({ key: null,
      profile: { headers: { 'X-Public': 'public' }, credentialHeaders: { 'X-Vendor-Proof': 'FIXTURE_REF' } },
      headers: { 'X-Vendor-Proof': 'synthetic-proof' },
    }).verifyProvider(provider, model, new AbortController().signal)).resolves.toBe('metadata-auth')
    expect(headers[0]?.get('x-vendor-proof')).toBe('synthetic-proof')
    expect(headers[1]?.get('x-vendor-proof')).toBeNull()
    expect(headers[1]?.get('x-public')).toBe('public')
  })

  it.each([
    [1, false, 'VERIFICATION_FAILED'], [1, true, 'ABORTED'],
    [2, false, 'endpoint-catalog'], [2, true, 'ABORTED'],
  ] as const)('classifies transport failure on request %s with abort=%s', async (failedRequest, abort, outcome) => {
    const owner = new AbortController()
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      if (calls === failedRequest) {
        if (abort) owner.abort(new Error('caller stopped'))
        throw new Error('fixture transport failed')
      }
      return new Response(JSON.stringify({ id: model }))
    })
    const result = adapter().verifyProvider(provider, model, owner.signal)
    if (outcome === 'endpoint-catalog') await expect(result).resolves.toBe(outcome)
    else await expect(result).rejects.toMatchObject({ code: outcome })
    expect(calls).toBe(failedRequest)
  })
})
