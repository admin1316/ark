/** Host-owned Session archive contracts: preparation, streaming, and cancellation. */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRawArtifact } from '@deepseek-ai/dsh-session-persistence'
import type { SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import { Zip, strFromU8, unzipSync } from 'fflate'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  fetchSessionLogExport,
  sessionLogCompressionLevel,
} from '../src/session-export.ts'

const contexts: Context[] = []
const sid = (id: string): SessionId => id as SessionId

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.useRealTimers()
})

function header(id: string, parentSession?: SessionId): SessionHeader {
  return {
    version: 0,
    id: sid(id),
    createdAt: 1000,
    cwd: '/project',
    ...(parentSession === undefined ? {} : { parentSession }),
    delegationDepth: parentSession === undefined ? 0 : 1,
  }
}

function artifact(id: string, parentSession?: SessionId, content?: string): SessionRawArtifact {
  return {
    meta: header(id, parentSession),
    filename: 'session.jsonl',
    content: content
      ?? `{"type":"session","version":0,"id":"${id}","createdAt":1000}\n`
      + '{"type":"turn/start","seq":0,"time":2000,"data":{"turn":1}}\n',
  }
}

function node(id: string, ...descendants: SessionLineageNode[]): SessionLineageNode {
  return {
    session: { header: header(id, sid('session-root')), live: false, persisted: true },
    descendants,
  }
}

function storedImage(
  id: string,
  mediaType: ImageAttachmentRef['mediaType'] = 'image/png',
) {
  return {
    ref: {
      attachmentId: sid(id),
      mediaType,
      bytes: 4,
      width: 2,
      height: 2,
    } as unknown as ImageAttachmentRef,
    data: new Uint8Array([1, 2, 3, 4]),
  }
}

function imageEventLine(
  id: string,
  mediaType: ImageAttachmentRef['mediaType'] = 'image/png',
): string {
  return `{"type":"user/message","seq":1,"time":1000,"data":{"content":[{"type":"image","attachment":{"attachmentId":"${id}","mediaType":"${mediaType}","bytes":4,"width":2,"height":2}}]}}`
}

interface HarnessOptions {
  readonly query?: boolean
  readonly persistence?: boolean | 'throw' | 'unsupported'
  readonly attachments?: boolean | ((
    ref: ImageAttachmentRef,
    signal?: AbortSignal,
  ) => Promise<ReturnType<typeof storedImage>>)
  readonly sessions?: {
    get(id: SessionId): { readonly id: SessionId } | undefined
    flush(session: { readonly id: SessionId }): Promise<boolean>
  }
  readonly readRaw?: (
    id: SessionId,
    signal?: AbortSignal,
  ) => Promise<SessionRawArtifact | undefined>
  readonly traceSession?: (
    id: SessionId,
    signal?: AbortSignal,
  ) => Promise<{
    target: { header: SessionHeader; live: boolean; persisted: boolean }
    ancestors: readonly SessionLineageNode[]
    complete: boolean
    root: { header: SessionHeader; live: boolean; persisted: boolean }
    descendants: readonly SessionLineageNode[]
  }>
}

function harness(
  artifacts: Record<string, SessionRawArtifact>,
  descendants: readonly SessionLineageNode[] = [],
  options: HarnessOptions = {},
): Context {
  const ctx = new Context()
  contexts.push(ctx)
  const query = options.query ?? true
  const persistence = options.persistence ?? true
  if (query) {
    ctx.provide('sessionQuery', {
      traceSession: options.traceSession ?? (async () => ({
        target: { header: header('session-root'), live: false, persisted: true },
        ancestors: [],
        complete: true,
        root: { header: header('session-root'), live: false, persisted: true },
        descendants,
      })),
    } as never)
  }
  if (persistence) {
    ctx.provide('sessionPersistence', {
      supportsRawArtifacts: persistence !== 'unsupported',
      readRaw: options.readRaw ?? (async (id: SessionId) => {
        if (persistence === 'throw') throw new Error('/host/private/session.jsonl')
        return artifacts[id]
      }),
    } as never)
  }
  if (options.attachments !== false) {
    const readImage = typeof options.attachments === 'function'
      ? options.attachments
      : async (ref: ImageAttachmentRef) => storedImage(String(ref.attachmentId), ref.mediaType)
    ctx.provide('attachments', {
      imageLimits: {} as never,
      validateImage: async () => {},
      saveImage: async () => { throw new Error('Session export never saves media') },
      readImage,
    } as never)
  }
  if (options.sessions !== undefined) ctx.provide('sessions', options.sessions as never)
  return ctx
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://host${path}`, init)
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer())
}

describe('Session export owner and configuration', () => {
  it('validates the exact integer compression range and defaults to six', () => {
    expect(sessionLogCompressionLevel()).toBe(DEFAULT_SESSION_LOG_COMPRESSION_LEVEL)
    expect(sessionLogCompressionLevel(0)).toBe(0)
    expect(sessionLogCompressionLevel(9)).toBe(9)
    for (const value of [-1, 10, 1.5, Number.NaN]) {
      expect(() => sessionLogCompressionLevel(value)).toThrow(/integer from 0 to 9/)
    }
  })

  it('has no source or package dependency on the retiring compatibility service', async () => {
    const [index, sessionExport, manifest] = await Promise.all([
      readFile(new URL('../src/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/session-export.ts', import.meta.url), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ])
    expect(`${index}\n${sessionExport}\n${manifest}`).not.toMatch(
      /(?:dsh-host-apiproxy|\bApiProxy\b|\bapiProxy\b)/,
    )
  })
})

describe('GET and HEAD /api/session/export', () => {
  it('streams the exact root artifact with final slash-path headers', async () => {
    const root = artifact('session-root')
    const response = await fetchSessionLogExport(
      harness({ 'session-root': root }),
      request('/api/session/export?sessionId=session-root'),
      6,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toContain('dsh-session-session-root.zip')
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files)).toEqual(['session.jsonl'])
    expect(strFromU8(files['session.jsonl'] as Uint8Array)).toBe(root.content)
  })

  it('rejects the retired dot path, non-download methods, and malformed queries', async () => {
    const ctx = harness({ 'session-root': artifact('session-root') })
    await expect(fetchSessionLogExport(
      ctx,
      request('/api/session.export?sessionId=session-root'),
      6,
    )).resolves.toMatchObject({ status: 404 })
    await expect(fetchSessionLogExport(
      ctx,
      request('/api/session/export?sessionId=session-root', { method: 'POST' }),
      6,
    )).resolves.toMatchObject({ status: 404 })
    await expect(fetchSessionLogExport(
      ctx,
      request('/api/session/export?includeDescendants=true'),
      6,
    )).resolves.toMatchObject({ status: 400 })
    await expect(fetchSessionLogExport(
      ctx,
      request('/api/session/export?sessionId=session-root&includeDescendants=1'),
      6,
    )).resolves.toMatchObject({ status: 400 })
  })

  it('performs one root durability preflight for HEAD without starting a stream', async () => {
    const readRaw = vi.fn(async () => artifact('session-root'))
    const traceSession = vi.fn(async () => ({
      target: { header: header('session-root'), live: false, persisted: true },
      ancestors: [],
      complete: true,
      root: { header: header('session-root'), live: false, persisted: true },
      descendants: [node('child-never-read')],
    }))
    const response = await fetchSessionLogExport(
      harness({}, [], { readRaw, traceSession }),
      request('/api/session/export?sessionId=session-root&includeDescendants=true', { method: 'HEAD' }),
      6,
    )
    expect(response.status).toBe(200)
    expect(response.body).toBeNull()
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(readRaw).toHaveBeenCalledOnce()
    expect(traceSession).not.toHaveBeenCalled()
  })

  it('returns bodyless HEAD errors and fail-loud deployment statuses', async () => {
    const missing = await fetchSessionLogExport(
      harness({}),
      request('/api/session/export?sessionId=missing', { method: 'HEAD' }),
      6,
    )
    expect(missing.status).toBe(404)
    expect(missing.body).toBeNull()

    const unsupported = await fetchSessionLogExport(
      harness({}, [], { persistence: 'unsupported' }),
      request('/api/session/export?sessionId=session-root'),
      6,
    )
    expect(unsupported.status).toBe(501)
    expect(await unsupported.text()).toContain('does not expose per-session raw artifacts')

    const unavailable = await fetchSessionLogExport(
      harness({}, [], { query: false, persistence: false, attachments: false }),
      request('/api/session/export?sessionId=session-root'),
      6,
    )
    expect(unavailable.status).toBe(500)
    expect(await unavailable.text()).toContain('session-query')
  })
})

describe('Session archive contents and durability', () => {
  it('skips a missing live Session and covers every nested image carrier', async () => {
    const refs = [
      { id: 'nested-jpeg', mediaType: 'image/jpeg' as const },
      { id: 'message-webp', mediaType: 'image/webp' as const },
      { id: 'inserted-gif', mediaType: 'image/gif' as const },
      { id: 'chunk-png', mediaType: 'image/png' as const },
    ]
    const block = (id: string, mediaType: ImageAttachmentRef['mediaType']) => ({
      type: 'image',
      attachment: {
        attachmentId: id,
        mediaType,
        bytes: 4,
        width: 2,
        height: 2,
      },
    })
    const root = artifact('session-root', undefined, [
      JSON.stringify({ type: 'ignored', data: { content: 'not-an-array' } }),
      JSON.stringify({
        type: 'nested',
        data: {
          content: [null, [], 1, { type: 'container', content: [block(refs[0]!.id, refs[0]!.mediaType)] }],
          message: { content: [block(refs[1]!.id, refs[1]!.mediaType)] },
          inserted: [
            { content: [block(refs[2]!.id, refs[2]!.mediaType)] },
            { content: 'not-an-array' },
          ],
          chunk: { type: 'block-end', block: block(refs[3]!.id, refs[3]!.mediaType) },
        },
      }),
      JSON.stringify({ type: 'other-chunk', data: { chunk: { type: 'block-start', block: {} } } }),
      'not-json',
    ].join('\n'))
    const flush = vi.fn(async () => false)
    const response = await fetchSessionLogExport(
      harness({ 'session-root': root }, [], {
        sessions: { get: () => undefined, flush },
      }),
      request('/api/session/export?sessionId=session-root'),
      6,
    )
    const files = unzipSync(await responseBytes(response))

    expect(flush).not.toHaveBeenCalled()
    expect(Object.keys(files)).toEqual(expect.arrayContaining([
      'media/nested-jpeg.jpg',
      'media/message-webp.webp',
      'media/inserted-gif.gif',
      'media/chunk-png.png',
    ]))
  })

  it('deduplicates repeated lineage nodes before durable reads', async () => {
    const readRaw = vi.fn(async (id: SessionId) => artifact(String(id), sid('session-root')))
    const response = await fetchSessionLogExport(
      harness({}, [node('child-a'), node('child-a')], { readRaw }),
      request('/api/session/export?sessionId=session-root&includeDescendants=true'),
      6,
    )
    await response.arrayBuffer()
    expect(readRaw.mock.calls.map(([id]) => String(id))).toEqual(['session-root', 'child-a'])
  })

  it('flushes live root and descendants immediately before raw reads and deduplicates media', async () => {
    const image = imageEventLine('shared-image')
    const stored: Record<string, SessionRawArtifact> = {
      'session-root': artifact('session-root', undefined, 'stale root'),
      'child-a': artifact('child-a', sid('session-root'), 'stale child'),
    }
    const durable: Record<string, SessionRawArtifact> = {
      'session-root': artifact('session-root', undefined, `${image}\ndurable root`),
      'child-a': artifact('child-a', sid('session-root'), `${image}\ndurable child`),
    }
    const operations: string[] = []
    const readRaw = vi.fn(async (id: SessionId) => {
      operations.push(`read:${id}`)
      return stored[id]
    })
    const ctx = harness(stored, [node('child-a')], {
      readRaw,
      sessions: {
        get: id => durable[id] === undefined ? undefined : { id },
        flush: async (session) => {
          operations.push(`flush:${session.id}`)
          const next = durable[session.id]
          if (next === undefined) throw new Error('unexpected Session')
          stored[session.id] = next
          return true
        },
      },
    })
    const response = await fetchSessionLogExport(
      ctx,
      request('/api/session/export?sessionId=session-root&includeDescendants=true'),
      6,
    )
    const files = unzipSync(await responseBytes(response))
    expect(operations).toEqual([
      'flush:session-root',
      'read:session-root',
      'flush:child-a',
      'read:child-a',
    ])
    expect(strFromU8(files['session.jsonl'] as Uint8Array)).toContain('durable root')
    expect(strFromU8(files['subagents/child-a/session.jsonl'] as Uint8Array)).toContain('durable child')
    expect(files['media/shared-image.png']).toEqual(storedImage('shared-image').data)
    expect(Object.keys(files).filter(name => name.startsWith('media/'))).toEqual([
      'media/shared-image.png',
    ])
  })

  it('uses the configured compression level without changing artifact bytes', async () => {
    const root = artifact('session-root', undefined, 'compressible\n'.repeat(32 * 1024))
    const ctx = harness({ 'session-root': root })
    const stored = await fetchSessionLogExport(
      ctx,
      request('/api/session/export?sessionId=session-root'),
      0,
    )
    const compressed = await fetchSessionLogExport(
      ctx,
      request('/api/session/export?sessionId=session-root'),
      9,
    )
    const storedBytes = await responseBytes(stored)
    const compressedBytes = await responseBytes(compressed)
    expect(compressedBytes.byteLength).toBeLessThan(storedBytes.byteLength)
    expect(strFromU8(unzipSync(compressedBytes)['session.jsonl'] as Uint8Array)).toBe(root.content)
  })

  it('preserves astral characters across bounded encoder pushes', async () => {
    const root = artifact('session-root', undefined, `${'a'.repeat((1 << 16) - 1)}😀tail`)
    const response = await fetchSessionLogExport(
      harness({ 'session-root': root }),
      request('/api/session/export?sessionId=session-root'),
      6,
    )
    const files = unzipSync(await responseBytes(response))
    expect(strFromU8(files['session.jsonl'] as Uint8Array)).toBe(root.content)
  })

  it('waits for response pull capacity before reading the next media entry', async () => {
    const root = artifact('session-root', undefined, [
      imageEventLine('after-root'),
      randomBytes(512 * 1024).toString('base64'),
    ].join('\n'))
    let imageReads = 0
    const response = await fetchSessionLogExport(
      harness({ 'session-root': root }, [], {
        attachments: async (ref) => {
          imageReads += 1
          return storedImage(String(ref.attachmentId), ref.mediaType)
        },
      }),
      request('/api/session/export?sessionId=session-root'),
      6,
    )
    vi.useFakeTimers()
    await vi.runAllTimersAsync()
    expect(imageReads).toBe(0)
    vi.useRealTimers()
    const files = unzipSync(await responseBytes(response))
    expect(imageReads).toBe(1)
    expect(files['media/after-root.png']).toEqual(storedImage('after-root').data)
  })
})

describe('Session archive failure and cancellation', () => {
  it('keeps request cancellation ahead of a later attachment cleanup rejection', async () => {
    const controller = new AbortController()
    const reason = new Error('request cancelled first')
    const cleanupFailure = new Error('attachment cleanup rejected later')
    const started = Promise.withResolvers<undefined>()
    let unwound = false
    const root = artifact('session-root', undefined, imageEventLine('held-image'))
    const response = await fetchSessionLogExport(harness({ 'session-root': root }, [], {
      attachments: async (_ref, signal) => {
        if (signal === undefined) throw new Error('missing attachment signal')
        started.resolve(undefined)
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        unwound = true
        throw cleanupFailure
      },
    }), request('/api/session/export?sessionId=session-root', { signal: controller.signal }), 6)
    const body = response.arrayBuffer().then(() => undefined, (error: unknown) => error)
    await started.promise
    controller.abort(reason)
    expect(await body).toBe(reason)
    expect(unwound).toBe(true)
  })

  it('propagates a platform enqueue exception as the response failure', async () => {
    const failure = new TypeError('fixture stream controller unavailable')
    const probe = vi.spyOn(ReadableStreamDefaultController.prototype, 'enqueue').mockImplementationOnce(() => {
      throw failure
    })
    try {
      const response = await fetchSessionLogExport(harness({ 'session-root': artifact('session-root') }),
        request('/api/session/export?sessionId=session-root'), 6)
      await expect(response.arrayBuffer()).rejects.toBe(failure)
      expect(probe).toHaveBeenCalled()
    } finally {
      probe.mockRestore()
    }
  })

  it.each(['request-first', 'encoder-first'] as const)('keeps the first cause when request abort and encoder failure compete: %s', async (order) => {
    const controller = new AbortController()
    const reason = new Error('request cancellation in encoder boundary')
    const add = Reflect.get(Zip.prototype, 'add')
    let encoderFailure: Error | undefined
    const probe = vi.spyOn(Zip.prototype, 'add').mockImplementation(function (this: Zip, file) {
      const notify = this.ondata
      this.ondata = (error, data, final) => {
        if (error) encoderFailure ??= error
        notify(error, data, final)
        if (error && order === 'encoder-first') controller.abort(reason)
      }
      if (order === 'request-first') controller.abort(reason)
      try { add.call(this, file) } finally { this.ondata = notify }
    })
    try {
      const root = { ...artifact('session-root'), filename: `${'x'.repeat(65_536)}.jsonl` }
      const response = await fetchSessionLogExport(harness({ 'session-root': root }),
        request('/api/session/export?sessionId=session-root', { signal: controller.signal }), 6)
      const failure = await response.arrayBuffer().then(() => undefined, (error: unknown) => error)
      expect(encoderFailure).toBeInstanceOf(Error)
      expect(failure).toBe(order === 'request-first' ? reason : encoderFailure)
    } finally {
      probe.mockRestore()
    }
  })

  it('stops before descendant or attachment reads when the real encoder fails', async () => {
    const root = { ...artifact('session-root', undefined, imageEventLine('unused-image')), filename: `${'x'.repeat(65_536)}.jsonl` }
    const trace = vi.fn(async () => ({
      target: { header: header('session-root'), live: false, persisted: true }, ancestors: [], complete: true,
      root: { header: header('session-root'), live: false, persisted: true }, descendants: [node('child-a')],
    }))
    const readRaw = vi.fn(async (id: SessionId) => id === sid('session-root') ? root : artifact('child-a'))
    const attachments = vi.fn(async (ref: ImageAttachmentRef) => storedImage(String(ref.attachmentId)))
    const response = await fetchSessionLogExport(harness({}, [], { traceSession: trace, readRaw, attachments }),
      request('/api/session/export?sessionId=session-root&includeDescendants=true'), 6)
    await expect(response.arrayBuffer()).rejects.toThrow('filename too long')
    expect(readRaw).toHaveBeenCalledTimes(1)
    expect(trace).not.toHaveBeenCalled()
    expect(attachments).not.toHaveBeenCalled()
  })

  it('keeps the first encoder error through late callbacks and termination failure without reentrant cleanup', async () => {
    const add = Reflect.get(Zip.prototype, 'add')
    const terminate = Reflect.get(Zip.prototype, 'terminate')
    let adding = false
    let firstError: Error | undefined
    const terminationContexts: boolean[] = []
    const terminated = Promise.withResolvers<undefined>()
    const cleanupFailure = new Error('secondary termination failure')
    const addProbe = vi.spyOn(Zip.prototype, 'add').mockImplementation(function (this: Zip, file) {
      const notify = this.ondata
      this.ondata = (error, data, final) => {
        if (error) {
          firstError ??= error
          notify(error, data, final)
          // Valid callback shapes from an uncooperative dependency after its real error.
          notify(null, new Uint8Array([7]), false)
          notify(null, new Uint8Array(), true)
        } else {
          notify(error, data, final)
        }
      }
      adding = true
      try { add.call(this, file) } finally { adding = false; this.ondata = notify }
    })
    const terminateProbe = vi.spyOn(Zip.prototype, 'terminate').mockImplementation(function (this: Zip) {
      terminationContexts.push(adding)
      try { terminate.call(this) } finally { terminated.resolve(undefined) }
      throw cleanupFailure
    })
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const root = { ...artifact('session-root'), filename: `${'x'.repeat(65_536)}.jsonl` }
      const response = await fetchSessionLogExport(harness({ 'session-root': root }),
        request('/api/session/export?sessionId=session-root'), 6)
      reader = response.body!.getReader()
      const error = await reader.read().then(() => undefined, (error: unknown) => error)
      expect(firstError).toBeInstanceOf(Error)
      expect(error).toBe(firstError)
      expect((error as Error).message).toContain('filename too long')
      await terminated.promise
      expect(terminationContexts).toEqual([false])
      await expect(reader.cancel(new Error('later consumer cancellation'))).rejects.toBe(firstError)
    } finally {
      reader?.releaseLock()
      terminateProbe.mockRestore()
      addProbe.mockRestore()
    }
  })

  it('ignores empty intermediate encoder callbacks and still returns a valid archive', async () => {
    const end = Reflect.get(Zip.prototype, 'end')
    const probe = vi.spyOn(Zip.prototype, 'end').mockImplementation(function (this: Zip) {
      this.ondata(null, new Uint8Array(), false)
      end.call(this)
    })
    try {
      const root = artifact('session-root')
      const response = await fetchSessionLogExport(harness({ 'session-root': root }),
        request('/api/session/export?sessionId=session-root'), 6)
      const archive = unzipSync(new Uint8Array(await response.arrayBuffer()))
      expect(strFromU8(archive[root.filename]!)).toBe(root.content)
      expect(probe).toHaveBeenCalledTimes(1)
    } finally {
      probe.mockRestore()
    }
  })

  it('preserves request abort when it arrives at the encoder finalization boundary', async () => {
    const controller = new AbortController()
    const reason = new Error('request stopped before encoder final callback')
    const end = Reflect.get(Zip.prototype, 'end')
    const probe = vi.spyOn(Zip.prototype, 'end').mockImplementation(function (this: Zip) {
      controller.abort(reason)
      end.call(this)
    })
    try {
      const response = await fetchSessionLogExport(harness({ 'session-root': artifact('session-root') }),
        request('/api/session/export?sessionId=session-root', { signal: controller.signal }), 6)
      await expect(response.arrayBuffer()).rejects.toBe(reason)
    } finally {
      probe.mockRestore()
    }
  })

  it.each([false, true])('consumer cancellation wins over late encoder callbacks; cleanup throws=%s', async (throws) => {
    const started = Promise.withResolvers<AbortSignal>()
    const cleanupFailure = new Error('encoder termination cleanup failed')
    const lateFailure = Object.assign(new Error('late encoder callback failure'), { code: 11 as const })
    const terminate = Reflect.get(Zip.prototype, 'terminate')
    const probe = vi.spyOn(Zip.prototype, 'terminate').mockImplementation(function (this: Zip) {
      this.ondata(lateFailure, new Uint8Array(), false)
      this.ondata(null, new Uint8Array([9]), true)
      terminate.call(this)
      if (throws) throw cleanupFailure
    })
    try {
      const response = await fetchSessionLogExport(harness({}, [], {
        traceSession: async (_id, signal) => {
          if (signal === undefined) throw new Error('missing trace signal')
          started.resolve(signal)
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
          })
        },
        readRaw: async () => artifact('session-root'),
      }), request('/api/session/export?sessionId=session-root&includeDescendants=true'), 6)
      const reader = response.body!.getReader()
      const traceSignal = await started.promise
      const reason = new Error('consumer cancelled first')
      const cancelled = reader.cancel(reason)
      if (throws) await expect(cancelled).rejects.toBe(cleanupFailure)
      else await expect(cancelled).resolves.toBeUndefined()
      expect(traceSignal.aborted).toBe(true)
      expect(traceSignal.reason).toBe(reason)
      expect(probe).toHaveBeenCalledTimes(1)
      reader.releaseLock()
    } finally {
      probe.mockRestore()
    }
  })

  it('rejects the response body when the real ZIP encoder reports an invalid entry name', async () => {
    const root = { ...artifact('session-root'), filename: `${'x'.repeat(65_536)}.jsonl` }
    const response = await fetchSessionLogExport(
      harness({ 'session-root': root }),
      request('/api/session/export?sessionId=session-root'),
      6,
    )
    expect(response.status).toBe(200)
    const outcome = await response.arrayBuffer().then(
      (bytes) => {
        try {
          const entries = unzipSync(new Uint8Array(bytes))
          const restored = entries[root.filename]
          return {
            ok: true as const, bytes: bytes.byteLength,
            roundtripMatches: restored !== undefined && strFromU8(restored) === root.content,
          }
        } catch (error: unknown) {
          return { ok: true as const, bytes: bytes.byteLength, archiveError: error instanceof Error ? error.message : String(error) }
        }
      },
      (error: unknown) => ({ ok: false as const, error }),
    )
    expect(outcome).toMatchObject({ ok: false })
    if (outcome.ok) throw new Error('ZIP encoder failure was converted into a completed response')
    expect(outcome.error).toBeInstanceOf(Error)
    expect((outcome.error as Error).message).toContain('filename too long')
  })

  it('sanitizes root preparation failures and fails missing descendants mid-stream', async () => {
    const privateFailure = await fetchSessionLogExport(
      harness({}, [], { persistence: 'throw' }),
      request('/api/session/export?sessionId=session-root'),
      6,
    )
    expect(privateFailure.status).toBe(500)
    expect(await privateFailure.text()).toBe('session log export failed to prepare the stored artifact')

    const descendantFailure = await fetchSessionLogExport(
      harness({ 'session-root': artifact('session-root') }, [node('child-missing')]),
      request('/api/session/export?sessionId=session-root&includeDescendants=true'),
      6,
    )
    expect(descendantFailure.status).toBe(200)
    await expect(descendantFailure.arrayBuffer()).rejects.toThrow('has no stored log artifact')
  })

  it('fails the stream when referenced media cannot be read', async () => {
    const root = artifact('session-root', undefined, imageEventLine('missing-image'))
    const response = await fetchSessionLogExport(
      harness({ 'session-root': root }, [], {
        attachments: async () => { throw new Error('attachment bytes missing') },
      }),
      request('/api/session/export?sessionId=session-root'),
      6,
    )
    await expect(response.arrayBuffer()).rejects.toThrow('attachment bytes missing')
  })

  it('normalizes a non-Error producer failure before rejecting the response stream', async () => {
    const root = artifact('session-root', undefined, imageEventLine('string-failure'))
    const response = await fetchSessionLogExport(
      harness({ 'session-root': root }, [], {
        attachments: async () => { throw 'attachment string failure' },
      }),
      request('/api/session/export?sessionId=session-root'),
      6,
    )
    await expect(response.arrayBuffer()).rejects.toThrow('attachment string failure')
  })

  it('preserves pre-request cancellation instead of translating it to HTTP 500', async () => {
    const controller = new AbortController()
    const reason = new Error('request cancelled')
    controller.abort(reason)
    await expect(fetchSessionLogExport(
      harness({ 'session-root': artifact('session-root') }),
      request('/api/session/export?sessionId=session-root', { signal: controller.signal }),
      6,
    )).rejects.toBe(reason)
  })

  it('propagates response-reader cancellation into descendant work', async () => {
    let reportStarted!: (signal: AbortSignal) => void
    const started = new Promise<AbortSignal>((resolve) => { reportStarted = resolve })
    const response = await fetchSessionLogExport(
      harness({}, [node('child-a')], {
        readRaw: async (id, signal) => {
          if (id === sid('session-root')) return artifact('session-root')
          if (signal === undefined) throw new Error('missing descendant signal')
          reportStarted(signal)
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () =>{  reject(signal.reason as Error) }, { once: true })
          })
        },
      }),
      request('/api/session/export?sessionId=session-root&includeDescendants=true'),
      6,
    )
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing response body')
    const descendantSignal = await started
    const reason = new Error('download consumer left')
    await reader.cancel(reason)
    expect(descendantSignal.aborted).toBe(true)
    expect(descendantSignal.reason).toBe(reason)
  })

  it('normalizes consumer cancellation without a supplied Error reason', async () => {
    let reportStarted!: (signal: AbortSignal) => void
    const started = new Promise<AbortSignal>((resolve) => { reportStarted = resolve })
    const response = await fetchSessionLogExport(
      harness({}, [node('child-a')], {
        readRaw: async (id, signal) => {
          if (id === sid('session-root')) return artifact('session-root')
          if (signal === undefined) throw new Error('missing descendant signal')
          reportStarted(signal)
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () =>{  reject(signal.reason as Error) }, { once: true })
          })
        },
      }),
      request('/api/session/export?sessionId=session-root&includeDescendants=true'),
      6,
    )
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing response body')
    const descendantSignal = await started
    await reader.cancel()
    expect(descendantSignal.reason).toEqual(new Error('session log export stream cancelled'))
  })

  it('waits for held attachment work to unwind before consumer cancellation resolves', async () => {
    const root = artifact('session-root', undefined, imageEventLine('held-image'))
    let releaseAttachment!: () => void
    const attachmentHeld = new Promise<void>((resolve) => { releaseAttachment = resolve })
    let reportStarted!: (signal: AbortSignal) => void
    const started = new Promise<AbortSignal>((resolve) => { reportStarted = resolve })
    let reportAborted!: () => void
    const aborted = new Promise<void>((resolve) => { reportAborted = resolve })
    const response = await fetchSessionLogExport(
      harness({ 'session-root': root }, [], {
        attachments: async (ref, signal) => {
          if (signal === undefined) throw new Error('missing attachment signal')
          reportStarted(signal)
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              reportAborted()
              resolve()
            }, { once: true })
          })
          await attachmentHeld
          signal.throwIfAborted()
          return storedImage(String(ref.attachmentId), ref.mediaType)
        },
      }),
      request('/api/session/export?sessionId=session-root'),
      6,
    )
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing response body')
    const drain = (async (): Promise<void> => {
      while (!(await reader.read()).done) {
        // Drain until cancellation closes the consumer side.
      }
    })()
    const attachmentSignal = await started
    const reason = new Error('consumer cancellation')
    const cancellation = reader.cancel(reason)
    await aborted
    const deadline = await Promise.race([
      cancellation.then(() => 'settled' as const),
      new Promise<'deadline'>((resolve) => { setTimeout(() => { resolve('deadline') }, 10) }),
    ])
    expect(deadline).toBe('deadline')
    expect(attachmentSignal.aborted).toBe(true)
    expect(attachmentSignal.reason).toBe(reason)

    releaseAttachment()
    await expect(cancellation).resolves.toBeUndefined()
    await drain
  })

  it('propagates attachment cleanup rejection from consumer cancellation', async () => {
    const cleanupFailure = new Error('attachment cleanup failed')
    const root = artifact('session-root', undefined, imageEventLine('failing-image'))
    let reportStarted!: () => void
    const started = new Promise<void>((resolve) => { reportStarted = resolve })
    const response = await fetchSessionLogExport(
      harness({ 'session-root': root }, [], {
        attachments: async (_ref, signal) => {
          if (signal === undefined) throw new Error('missing attachment signal')
          reportStarted()
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
          throw cleanupFailure
        },
      }),
      request('/api/session/export?sessionId=session-root'),
      6,
    )
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing response body')
    const drain = (async (): Promise<void> => {
      while (!(await reader.read()).done) {
        // Drain until cancellation closes the consumer side.
      }
    })()
    await started
    await expect(reader.cancel(new Error('consumer left'))).rejects.toBe(cleanupFailure)
    await drain
  })
})
