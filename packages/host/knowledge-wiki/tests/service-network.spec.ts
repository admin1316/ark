import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
  responses: [] as Array<{ status: number; headers?: Record<string, string>; body?: Buffer | string; error?: unknown }>,
  requestOptions: [] as RequestOptions[],
}))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('node:http', async importOriginal => ({
  ...await importOriginal<typeof import('node:http')>(),
  request: mocks.request,
}))
vi.mock('node:https', async importOriginal => ({
  ...await importOriginal<typeof import('node:https')>(),
  request: mocks.request,
}))

import KnowledgeWikiService, { isBlockedNetworkAddress, readResponseBounded, requestPinned } from '../src/index.ts'

interface NetworkSurface {
  snapshots: { dispose(): void }
  ingestUrl(request: { url: string }): Promise<{ written: string[]; warnings: string[] }>
  ingestQueueCancel(): Promise<object>
  ingestSourceWithContext(
    request: { path: string },
    context: object,
    signal: AbortSignal,
  ): Promise<{ written: string[]; warnings: string[] }>
}

let root: string
let ctx: Context
let service: NetworkSurface

async function expectUrlError(url: string, message: string): Promise<void> {
  const result = await service.ingestUrl({ url }) as {
    written: string[]
    warnings: string[]
    status?: string
    errorCode?: string
  }
  expect(result).toMatchObject({ written: [], status: 'error' })
  expect(result.warnings[0]).toContain(message)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.responses.length = 0
  mocks.requestOptions.length = 0
  mocks.request.mockImplementation((
    _url: URL,
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ): ClientRequest => {
    mocks.requestOptions.push(options)
    const request = new EventEmitter() as ClientRequest
    request.end = (() => {
      queueMicrotask(() => {
        const next = mocks.responses.shift()
        if (next === undefined) {
          request.emit('error', new Error('missing mocked response'))
          return
        }
        if (next.error !== undefined) {
          request.emit('error', next.error)
          return
        }
        const response = Readable.from(next.body === undefined ? [] : [next.body]) as IncomingMessage
        Object.assign(response, { statusCode: next.status, headers: next.headers ?? {} })
        onResponse(response)
      })
      return request
    }) as ClientRequest['end']
    return request
  })
  root = mkdtempSync(join(tmpdir(), 'wiki-service-network-'))
  mkdirSync(join(root, 'wiki'), { recursive: true })
  ctx = new Context()
  service = new KnowledgeWikiService(ctx, {
    wikiRoot: join(root, 'wiki'), mainRoot: root,
    credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
  }) as unknown as NetworkSurface
})

afterEach(async () => {
  service.snapshots.dispose()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('public URL security and clipping', () => {
  it('rejects an unsupported DNS address family before creating a request', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '1.1.1.1', family: 0 }])
    await expectUrlError('https://invalid-family.example/a', 'no supported public address')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it.each(['deadline', 'owner-cancel'] as const)('releases a pending request on %s through the public ingest owner', async (kind) => {
    const started = Promise.withResolvers<undefined>()
    let requestSignal: AbortSignal | undefined
    mocks.request.mockImplementationOnce((_url: URL, options: RequestOptions): ClientRequest => {
      const request = new EventEmitter() as ClientRequest
      const signal = options.signal
      if (signal === undefined) throw new Error('expected request cancellation signal')
      requestSignal = signal
      signal.addEventListener('abort', () => { request.emit('error', signal.reason) }, { once: true })
      request.end = (() => { started.resolve(undefined); return request }) as ClientRequest['end']
      return request
    })
    if (kind === 'deadline') vi.useFakeTimers()
    const pending = service.ingestUrl({ url: 'https://1.1.1.1/held' })
    try {
      await started.promise
      expect(requestSignal?.aborted).toBe(false)
      if (kind === 'deadline') await vi.advanceTimersByTimeAsync(15_000)
      else await service.ingestQueueCancel()
      const result = await pending
      expect(requestSignal?.aborted).toBe(true)
      expect(result.written).toEqual([])
      expect(result.warnings.join('\n')).toContain(kind === 'deadline' ? 'timed out after 15 seconds' : 'ingest cancelled')
      expect(mocks.request).toHaveBeenCalledOnce()
      expect(mocks.lookup).not.toHaveBeenCalled()
      if (kind === 'deadline') expect(vi.getTimerCount()).toBe(0)
    } finally {
      await service.ingestQueueCancel()
      await pending
      if (kind === 'deadline') vi.useRealTimers()
    }
  })

  it.each([
    ['not a url', 'Invalid URL'],
    ['ftp://example.test/a', 'only http and https'],
    ['https://user:pass@example.test/a', 'credentials'],
    ['https://example.test:8443/a', 'non-default URL ports'],
    ['http://example.test:443/a', 'non-default URL ports'],
    ['http://localhost/a', 'local network'],
    ['https://host.local/a', 'local network'],
    ['http://127.0.0.1/a', 'private or non-routable'],
  ])('rejects unsafe URL %s', async (url, message) => {
    await expectUrlError(url, message)
  })

  it('rejects empty and private DNS answers', async () => {
    mocks.lookup.mockResolvedValueOnce([]).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
    await expectUrlError('https://empty.example/a', 'private or non-routable')
    await expectUrlError('https://private.example/a', 'private or non-routable')
  })

  it('clips a public response and keeps redirect ownership on every hop', async () => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
    mocks.responses.push(
      { status: 302, headers: { location: '/final' } },
      { status: 200, body: '<title>Public</title><p>Body</p>' },
    )
    const ingest = vi.spyOn(service, 'ingestSourceWithContext').mockResolvedValue({
      written: ['wiki/_candidates/clip.md'], warnings: [],
    })

    const result = await service.ingestUrl({ url: 'https://example.test/start' })
    expect(result.written).toEqual(['wiki/_candidates/clip.md'])
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(mocks.lookup).toHaveBeenCalledTimes(2)
    const pinned = vi.fn()
    mocks.requestOptions[0]!.lookup!('example.test', {}, pinned)
    expect(pinned).toHaveBeenCalledWith(null, '1.1.1.1', 4)
    const rel = ingest.mock.calls[0]?.[0].path
    expect(rel).toMatch(/^raw\/sources\/clips\/example-test-/u)
    expect(existsSync(join(root, rel!))).toBe(true)
  })

  it('accepts explicit default ports', async () => {
    mocks.responses.push({ status: 200, body: 'ok' }, { status: 200, body: 'ok' })
    vi.spyOn(service, 'ingestSourceWithContext').mockResolvedValue({ written: [], warnings: [] })
    expect((await service.ingestUrl({ url: 'http://1.1.1.1:80/a' })).warnings).toEqual([])
    expect((await service.ingestUrl({ url: 'https://1.1.1.1:443/a' })).warnings).toEqual([])
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })

  it('reports redirect, HTTP, and declared/actual body limits', async () => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
    mocks.responses.push(
      { status: 302 },
      { status: 503, body: 'error' },
      { status: 200, headers: { 'content-length': String(5 * 1024 * 1024 + 1) }, body: 'small' },
      { status: 200, body: Buffer.alloc(5 * 1024 * 1024 + 1) },
    )

    await expectUrlError('https://example.test/no-location', 'has no location')
    await expectUrlError('https://example.test/error', 'fetch failed (503)')
    await expectUrlError('https://example.test/declared', 'exceeds 5 MiB')
    await expectUrlError('https://example.test/actual', 'exceeds 5 MiB')
    expect(mocks.request).toHaveBeenCalledTimes(4)
  })

  it('caps redirect chains at six hops', async () => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
    for (let index = 0; index < 6; index += 1) {
      mocks.responses.push({ status: 302, headers: { location: '/again' } })
    }
    await expectUrlError('https://example.test/start', 'too many redirects')
  })

  it('stringifies primitive fetch failures', async () => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
    mocks.responses.push({ status: 0, error: 'primitive fetch failure' })
    await expectUrlError('https://example.test/fail', 'primitive fetch failure')
  })
})

describe('exported transport and byte-boundary helpers', () => {
  it('supplies the pinned all-address lookup result while retaining HTTPS authority', async () => {
    const address = { address: '2606:4700:4700::1111', family: 6 as const }
    const url = new URL('https://public.example.test/document')
    const abort = new AbortController()
    mocks.responses.push({ status: 200 })
    const response = await requestPinned(url, address, abort.signal, 'fixture-only-ca')
    try {
      const options = mocks.requestOptions[0]
      expect(options).toMatchObject({ signal: abort.signal, servername: url.hostname, ca: 'fixture-only-ca', headers: { Host: url.host } })
      if (options?.lookup === undefined) throw new Error('expected pinned lookup')
      const callback = vi.fn()
      options.lookup(url.hostname, { all: true }, callback)
      expect(callback).toHaveBeenCalledExactlyOnceWith(null, [address])
      expect(mocks.lookup).not.toHaveBeenCalled()
    } finally {
      response.destroy()
    }
  })

  it('counts non-Buffer chunks in bytes and refuses the first over-limit chunk', async () => {
    const response = Readable.from([new Uint8Array([1, 2]), '界']) as IncomingMessage
    await expect(readResponseBounded(response, 5, new AbortController().signal))
      .resolves.toEqual(Buffer.concat([Buffer.from([1, 2]), Buffer.from('界')]))
    const oversized = Readable.from([Buffer.from('界')]) as IncomingMessage
    await expect(readResponseBounded(oversized, 2, new AbortController().signal)).rejects.toThrow('exceeds 5 MiB')
    expect(oversized.destroyed).toBe(true)
  })

  it('preserves cancellation when a response produces its next chunk', async () => {
    const abort = new AbortController()
    const reason = new Error('cancelled response read')
    abort.abort(reason)
    const response = Readable.from([Buffer.from('must not return')]) as IncomingMessage
    await expect(readResponseBounded(response, 1024, abort.signal)).rejects.toBe(reason)
    expect(response.destroyed).toBe(true)
  })
})

describe('blocked network classifier edges', () => {
  it.each(['2001:4860:4860::8888%en0', '[2001:4860:4860::8888%en0]'])('rejects a scoped IPv6 address %s', (address) => {
    expect(isBlockedNetworkAddress(address)).toBe(true)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.lookup).not.toHaveBeenCalled()
  })

  it.each([
    '0.0.0.0', '100.64.0.1', '100.127.255.255', '172.31.255.255',
    '192.0.0.9', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.9',
    '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '[::]', '::1', '100::1', 'fe80::1', 'fec0::1', 'fc00::1', 'fdff::1',
    'ff02::1', '2001:db8::1', '3fff::1', '2001:2::1', '2001:10::1',
    '2001:20::1', '2002::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '64:ff9b::127.0.0.1', '64:ff9b:1::1',
  ])('blocks %s', (address) => {
    expect(isBlockedNetworkAddress(address)).toBe(true)
  })

  it.each([
    '1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.0.1',
    '172.32.0.1', '198.20.0.1', '64:ff9b::8.8.8.8',
    '2001:4860:4860::8888', '2606:4700:4700::1111',
  ])(
    'allows %s',
    (address) => {
      expect(isBlockedNetworkAddress(address)).toBe(false)
    },
  )

  it('allows a non-IP token at the pure classifier boundary', () => {
    expect(isBlockedNetworkAddress('public.example')).toBe(false)
  })
})
