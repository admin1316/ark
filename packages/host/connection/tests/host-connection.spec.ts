/** Host connection registers the /api prefix route bridging to the API gateway. */
import { randomBytes } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  API_PATH, apply, HOST_EVENTS_PATH, inject, MUX_EVENTS_PATH, RESPOND_PATH,
  HostConnectionService,
  type ConnectionClientRequest, type ConnectionResponseReceipt,
} from '../src/index.ts'
import { DEFAULT_MAX_REQUEST_BODY_BYTES } from '../src/http-bridge.ts'
import { WebSocketDownlinks } from '../src/websocket-downlink.ts'
import { fetchSessionLogExport } from '../../session-remote-operations/src/session-export.ts'

/** Structural webServer fake recording both route registries. */
function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

/** Bodyless GET carrying the given headers (enough for the trust fence + bridge). */
function fakeRequest(headers: Record<string, string>, url = `${API_PATH}/session.list`): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers })
  return request
}

/** JSON POST carrying a complete client-request envelope. */
function fakePost(headers: Record<string, string>, url: string, body: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } })
  return request
}

/** Raw POST for malformed-body and media-type boundary cases. */
function fakeRawPost(headers: Record<string, string>, url: string, body: string): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers })
  return request
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: unknown } } {
  const state: { status?: number; body?: unknown } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number) { state.status = value; return this },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      else if (value !== undefined) throw new TypeError('fake response only accepts string or Uint8Array bodies')
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

async function mounted(config?: { trustedHosts?: string[] }): Promise<{
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return { routes, upgrades, dispose: () => fiber.dispose() }
}

/**
 * Read the Connection service mounted by the fixture's `apply`. The host
 * aggregate also compiles `packages/client/connection`'s Context augmentation
 * (its `.host.spec.ts` files import that src), whose structurally different
 * `ctx.connection` surface wins the ambient declaration merge; pin the runtime
 * identity `apply` provides instead of casting through the shadowed type.
 * @param ctx - context whose `apply` mounted the host service.
 * @returns the mounted host Connection service.
 */
function hostConnection(ctx: Context): HostConnectionService {
  const service: unknown = ctx.get('connection')
  if (!(service instanceof HostConnectionService)) {
    throw new Error('fixture context did not mount the host Connection service')
  }
  return service
}

async function connectionFixture() {
  const ctx = new Context()
  ctx.provide('webServer', fakeHttpServer([], []) as WebServer)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const connection = hostConnection(ctx)
  return { fiber, connection, fetch: connection.createSharedFetchHandler('/api') }
}

describe('connection request cancellation boundaries', () => {
  it('does not deliver a pre-aborted response to its handler', async () => {
    const { fiber, connection, fetch } = await connectionFixture()
    const handler = vi.fn(async (): Promise<ConnectionResponseReceipt> => ({ accepted: true }))
    const remove = connection.responses.handle(handler)
    const owner = new AbortController()
    owner.abort(new Error('cancelled before response dispatch'))
    try {
      const response = await fetch.fetch(new Request('http://127.0.0.1/api/respond', {
        method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        body: '{}', signal: owner.signal,
      }))
      expect(response.status).toBe(500)
      expect(await response.text()).toContain('cancelled before response dispatch')
      expect(handler).not.toHaveBeenCalled()
    } finally {
      await remove()
      await fiber.dispose()
    }
  })

  it('propagates request cancellation while a response handler is pending and ignores its late success', async () => {
    const { fiber, connection, fetch } = await connectionFixture()
    const started = Promise.withResolvers<AbortSignal>()
    const released = Promise.withResolvers<undefined>()
    let aborts = 0
    const remove = connection.responses.handle(async (_body, signal) => {
      signal.addEventListener('abort', () => { aborts += 1 }, { once: true })
      started.resolve(signal)
      await released.promise
      return { accepted: true }
    })
    const owner = new AbortController()
    const reason = new Error('request cancelled during response dispatch')
    const pending = fetch.fetch(new Request('http://127.0.0.1/api/respond', {
      method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: '{}', signal: owner.signal,
    }))
    try {
      const signal = await started.promise
      owner.abort(reason)
      expect(signal.aborted).toBe(true)
      expect(signal.reason).toBe(reason)
      released.resolve(undefined)
      const response = await pending
      expect(response.status).toBe(500)
      expect(await response.text()).toContain(reason.message)
      expect(aborts).toBe(1)
    } finally {
      released.resolve(undefined)
      await remove()
      await fiber.dispose()
    }
  })

  it('settles a pre-aborted bodyless download without inventing a body to cancel', async () => {
    const { fiber, connection, fetch } = await connectionFixture()
    const owner = new AbortController()
    owner.abort(new Error('already cancelled'))
    const remove = connection.downloads.handle('/api/files/cancelled-bodyless', async () => new Response(null, { status: 204 }), {
      authority: 'loopback',
    })
    try {
      const response = await fetch.fetch(new Request('http://127.0.0.1/api/files/cancelled-bodyless', {
        headers: { host: '127.0.0.1' }, signal: owner.signal,
      }))
      expect(response.status).toBe(499)
      expect(await response.text()).toBe('request cancelled')
      await remove()
    } finally {
      await remove()
      await fiber.dispose()
    }
  })

  it('contains a native error Response on HEAD without completing its lifetime twice', async () => {
    const { fiber, connection, fetch } = await connectionFixture()
    let aborted = 0
    const remove = connection.downloads.handle('/api/files/native-error-response', async (_request, signal) => {
      signal.addEventListener('abort', () => { aborted += 1 }, { once: true })
      return Response.error()
    }, { authority: 'loopback' })
    try {
      const response = await fetch.fetch(new Request('http://127.0.0.1/api/files/native-error-response', {
        method: 'HEAD', headers: { host: '127.0.0.1' },
      }))
      expect(response.status).toBe(500)
      expect(await response.text()).toContain('handler failure:')
      expect(aborted).toBe(1)
      await remove()
      expect(aborted).toBe(1)
    } finally {
      await remove()
      await fiber.dispose()
    }
  })

  it('keeps one terminal outcome when producer error and request abort race in the same task', async () => {
    const { fiber, connection, fetch } = await connectionFixture()
    const reading = Promise.withResolvers<undefined>()
    let producer!: ReadableStreamDefaultController<Uint8Array>
    let aborts = 0
    const cancel = vi.fn()
    const owner = new AbortController()
    const producerFailure = new Error('producer failed before abort reaction')
    const requestReason = new Error('request left before read rejection reaction')
    const remove = connection.downloads.handle('/api/files/error-abort-race', async (_request, signal) => {
      signal.addEventListener('abort', () => { aborts += 1 }, { once: true })
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { producer = controller },
        pull() { reading.resolve(undefined) },
        cancel,
      }))
    }, { authority: 'loopback' })
    try {
      const response = await fetch.fetch(new Request('http://127.0.0.1/api/files/error-abort-race', {
        headers: { host: '127.0.0.1' }, signal: owner.signal,
      }))
      const bodyFailure = expect(response.text()).rejects.toBe(requestReason)
      await reading.promise
      producer.error(producerFailure)
      owner.abort(requestReason)
      const disposal = remove()
      expect(remove()).toBe(disposal)
      await Promise.all([bodyFailure, expect(disposal).rejects.toBe(producerFailure)])
      expect(aborts).toBe(1)
      // Native stream error already terminated the producer; cancelling its
      // reader rejects with that error without invoking the producer again.
      expect(cancel).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
    }
  })

  it.each([undefined, null, 'producer cancellation failed'])('retains a non-Error cancellation failure %s until concurrent owner disposal settles', async (failure) => {
    const { fiber, connection, fetch } = await connectionFixture()
    const cancelling = Promise.withResolvers<undefined>()
    const cancelled = Promise.withResolvers<undefined>()
    const owner = new AbortController()
    const reason = new Error('download caller left')
    let cancellations = 0
    const remove = connection.downloads.handle('/api/files/cancel-failure', async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancellations += 1
        cancelling.resolve(undefined)
        return cancelled.promise
      },
    })), { authority: 'loopback' })
    try {
      const response = await fetch.fetch(new Request('http://127.0.0.1/api/files/cancel-failure', {
        headers: { host: '127.0.0.1' }, signal: owner.signal,
      }))
      const bodyFailure = expect(response.text()).rejects.toBe(reason)
      owner.abort(reason)
      const disposal = remove()
      expect(remove()).toBe(disposal)
      const disposalFailure = expect(disposal).rejects.toBe(failure)
      await cancelling.promise
      cancelled.reject(failure)
      await Promise.all([bodyFailure, disposalFailure])
      expect(cancellations).toBe(1)
      const missing = await fetch.fetch(new Request('http://127.0.0.1/api/files/cancel-failure', { headers: { host: '127.0.0.1' } }))
      expect(missing.status).toBe(404)
    } finally {
      cancelled.reject(failure)
      await fiber.dispose()
    }
  })
})

describe('connection node half', () => {
  it('reserves enough default carrier capacity for the 200 MiB image batch', () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(300 * 1024 * 1024)
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBeGreaterThan(Math.ceil(200 * 1024 * 1024 * 4 / 3) + 1024 * 1024)
  })

  it('fails loud when the carrier cap cannot hold the configured image batch', () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('attachments', {
      imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
    } as AttachmentStore)
    expect(() => { apply(ctx, { maxRequestBodyBytes: 1024 }) })
      .toThrow(/must be at least .* aggregate image limit/)
    expect(routes).toHaveLength(0)
  })

  it('fails the load on a trustedHosts entry that is not a bare authority', async () => {
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.internal/path'] })
    await expect(fiber).rejects.toThrow(/not a bare host\[:port\] authority/)
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('registers one HTTP route plus one upgrade route per downlink and removes all three with the fiber', async () => {
    const { routes, upgrades, dispose } = await mounted()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })
    expect(upgrades.map(route => route.path)).toEqual([MUX_EVENTS_PATH, HOST_EVENTS_PATH])
    await dispose()
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('requires WebSocket upgrade for network GETs to either event path', async () => {
    const { routes, dispose } = await mounted()
    for (const path of [MUX_EVENTS_PATH, HOST_EVENTS_PATH]) {
      const { response, state } = fakeResponse()
      await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, path), response)
      expect(state.status).toBe(426)
      expect(state.body).toBe('upgrade required')
    }
    await dispose()
  })

  it('rejects an untrusted WebSocket upgrade before protocol negotiation', async () => {
    const { upgrades, dispose } = await mounted()
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await upgrades[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }, MUX_EVENTS_PATH), socket, Buffer.alloc(0))
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    await dispose()
  })

  it('refuses an untrusted Host on any /api path before the bridge runs', async () => {
    const { routes, dispose } = await mounted()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }), response)
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
    await dispose()
  })

  it('pins privileged methods to loopback even for a declared trusted authority', async () => {
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    // The privileged set: native dialogs plus the whole settings/credential
    // configuration plane, reads included, plus the one method that makes the
    // host fetch a caller-chosen URL. The same declared authority reaches
    // ordinary reads (carrier-level 404 from the empty strict router proves the fence
    // passed), but each privileged method stays loopback-only and 403s.
    for (const method of [
      'host/pickDirectory', 'host/openPath',
      'settings/describe', 'settings/openDocument', 'settings/update', 'settings/replace', 'settings/mutate',
      'credentials/describe', 'credentials/set', 'credentials/unset',
      'llm/discoverModels',
      'agentPreset/read', 'agentPreset/copy', 'agentPreset/openDocument', 'agentPreset/remove',
    ]) {
      const denied = fakeResponse()
      await routes[0]!.handler(
        fakeRequest({ host: 'harness.example' }, `${API_PATH}/${method}`),
        denied.response,
      )
      expect(denied.state.status).toBe(403)
      expect(denied.state.body).toBe('forbidden')
    }
    const read = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: 'harness.example' }), read.response)
    expect(read.state.status).not.toBe(403)
    await dispose()
  })

  it('passes loopback and declared-authority requests through to the bridge', async () => {
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example:3080', '192.168.1.5'] })
    // Loopback, no browser markers (curl shape): the fence passes; the carrier
    // answers 404 for a GET unary path — proof the bridge ran.
    const loopback = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }), loopback.response)
    expect(loopback.state.status).toBe(404)
    // An all-interfaces composition derives port-less LAN IP literals, which
    // pass markerless curl on any port.
    const lan = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '192.168.1.5:3080' }), lan.response)
    expect(lan.state.status).toBe(404)
    // Declared public authority, same-origin browser shape.
    const declared = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example:3080', origin: 'http://harness.example:3080', 'sec-fetch-site': 'same-origin',
    }), declared.response)
    expect(declared.state.status).toBe(404)
    await dispose()
  })

  it('provides a disposable dedicated RPC channel without a legacy fallback', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })

    const connection = hostConnection(ctx)
    const calls: unknown[] = []
    const remove = connection.rpc.handle('/rpc', async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { accepted: true } }
    }, { authority: 'trusted-host' })
    const route = routes.find(candidate => candidate.path === '/rpc')
    expect(route).toBeDefined()

    const request: ConnectionClientRequest = {
      type: 'client-request',
      rpcId: 'rpc-dedicated',
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }
    const result = fakeResponse()
    await route!.handler(fakePost({ host: '127.0.0.1:3080' }, '/rpc/goals/create', request), result.response)
    expect(result.state.status).toBe(200)
    expect(JSON.parse(String(result.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-dedicated',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    expect(() => connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }), {
      authority: 'trusted-host',
    })).toThrow(/duplicate route/)
    await remove()
    expect(routes.map(candidate => candidate.path)).toEqual([API_PATH])
    await fiber.dispose()
    expect(routes).toHaveLength(0)
  })

  it('scopes event producers and aborts active iterators when their owner is removed', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    let sourceSignal: AbortSignal | undefined
    const remove = connection.events.handle('mux', async function * (signal) {
      sourceSignal = signal
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })
    expect(() => connection.events.handle('mux', async function * () {}))
      .toThrow('mux event source is already registered')

    const reader = connection.openEventStream('mux', new AbortController().signal)[Symbol.asyncIterator]()
    const pending = reader.next()
    await vi.waitFor(() => { expect(sourceSignal).toBeDefined() })
    await remove()
    expect(sourceSignal?.aborted).toBe(true)
    await expect(pending).resolves.toMatchObject({ done: true })

    const missing = connection.openEventStream('mux', new AbortController().signal)[Symbol.asyncIterator]()
    await expect(missing.next()).rejects.toThrow('no mux event source is registered')
    await fiber.dispose()
  })

  it('dispatches claimed /api endpoints before the fail-closed fallback and withdraws the claim', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = hostConnection(ctx)
    const calls: unknown[] = []
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async (endpoint, payload) => {
        calls.push({ endpoint, payload })
        return { ok: true, value: { accepted: true } }
      },
      { authority: 'trusted-host' },
    )
    expect(() => connection.rpc.intercept(
      '/api',
      () => true,
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host' },
    )).toThrow('already has an interceptor')
    expect(() => connection.rpc.intercept(
      '/rpc' as '/api',
      () => true,
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host' },
    )).toThrow('invalid shared RPC channel')
    const route = routes.find(candidate => candidate.path === API_PATH)!
    const request: ConnectionClientRequest = {
      type: 'client-request',
      rpcId: 'rpc-shared',
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }

    const claimed = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/api/goals/create', request), claimed.response)
    expect(JSON.parse(String(claimed.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-shared',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/api/goals/create', request), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(calls).toHaveLength(1)

    const unclaimed = fakeResponse()
    await route.handler(fakeRequest({ host: '127.0.0.1:3080' }, '/api/session.list'), unclaimed.response)
    expect(unclaimed.state.status).toBe(404)

    await remove()
    const withdrawn = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/api/goals/create', request), withdrawn.response)
    expect(withdrawn.state.status).toBe(404)
    expect(calls).toHaveLength(1)

    const removeLoopback = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async () => ({ ok: true, value: null }),
      { authority: 'loopback' },
    )
    const loopbackOnly = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/api/goals/create', request), loopbackOnly.response)
    expect(loopbackOnly.state.status).toBe(403)
    await removeLoopback()
    await fiber.dispose()
  })

  it('applies the configured trust fence and JSON envelope checks to generic channels', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = hostConnection(ctx)
    const remove = connection.rpc.handle('/rpc', async (endpoint) => {
      if (endpoint === 'fail') throw new Error('handler broke')
      return { ok: true, value: null }
    }, {
      authority: 'trusted-host',
    })
    const route = routes.find(candidate => candidate.path === '/rpc')!

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/rpc/goals/create', {}), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })

    const methodMismatch = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/rpc/goals/create', {
      type: 'client-request', rpcId: 'rpc-bad', method: 'other', payload: {},
    }), methodMismatch.response)
    expect(JSON.parse(String(methodMismatch.state.body))).toMatchObject({
      rpcId: 'rpc-bad',
      result: { ok: false, error: { code: 'bad-request' } },
    })

    for (const [request, status] of [
      [fakeRequest({ host: 'harness.example' }, '/rpc/goals/create'), 404],
      [fakePost({ host: 'harness.example' }, '/outside/goals/create', {}), 404],
      [fakePost({ host: 'harness.example' }, '/rpc/goals//create', {}), 404],
      [fakeRawPost({ host: 'harness.example' }, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ host: 'harness.example', 'content-type': 'text/plain' }, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ host: 'harness.example', 'content-type': 'application/json; charset=utf-8' }, '/rpc/goals/create', '{'), 400],
    ] as const) {
      const response = fakeResponse()
      await route.handler(request, response.response)
      expect(response.state.status).toBe(status)
    }

    for (const [body, rpcId] of [
      [{ rpcId: 'retained-id' }, 'retained-id'],
      [{ rpcId: 42 }, 'invalid-request'],
      [null, 'invalid-request'],
    ] as const) {
      const response = fakeResponse()
      await route.handler(fakePost({ host: 'harness.example' }, '/rpc/goals/create', body), response.response)
      expect(JSON.parse(String(response.state.body))).toMatchObject({
        rpcId,
        result: { ok: false, error: { code: 'bad-request' } },
      })
    }

    const failed = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/rpc/fail', {
      type: 'client-request', rpcId: 'rpc-fail', method: 'fail', payload: {},
    }), failed.response)
    expect(failed.state).toMatchObject({ status: 500, body: 'handler failure: Error: handler broke' })

    expect(() => connection.rpc.handle('/api', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })).toThrow('invalid or reserved RPC channel')
    expect(() => connection.rpc.handle('api3', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })).toThrow('invalid or reserved RPC channel')

    const removeLoopback = connection.rpc.handle('/loopback', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })
    const loopbackRoute = routes.find(candidate => candidate.path === '/loopback')!
    const publicResponse = fakeResponse()
    await loopbackRoute.handler(fakePost({ host: 'harness.example' }, '/loopback/read', {
      type: 'client-request', rpcId: 'rpc-public', method: 'read', payload: {},
    }), publicResponse.response)
    expect(publicResponse.state.status).toBe(403)
    await removeLoopback()
    await remove()
    await fiber.dispose()
  })

  it('reserves the exact response carrier outside the shared RPC interceptor', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = hostConnection(ctx)
    const gatewayCalls: unknown[] = []
    const removeGateway = connection.rpc.intercept(
      '/api',
      () => true,
      async (endpoint, payload) => {
        gatewayCalls.push({ endpoint, payload })
        return { ok: true, value: null }
      },
      { authority: 'trusted-host' },
    )
    const responses: unknown[] = []
    const removeResponses = connection.responses.handle(async (message, signal) => {
      signal.throwIfAborted()
      responses.push(message)
      return { accepted: true }
    })
    expect(() => connection.responses.handle(async () => ({ accepted: true })))
      .toThrow('/api/respond handler is already registered')

    const route = routes.find(candidate => candidate.path === API_PATH)!
    const body = { type: 'client-response', rpcId: 'answer-1', result: { ok: true, value: {} } }
    const forbidden = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, RESPOND_PATH, body), forbidden.response)
    expect(forbidden.state.status).toBe(403)
    expect(responses).toEqual([])
    const accepted = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, RESPOND_PATH, body), accepted.response)
    expect(JSON.parse(String(accepted.state.body))).toEqual({ accepted: true })
    expect(responses).toEqual([body])
    expect(gatewayCalls).toEqual([])

    for (const [request, status] of [
      [fakeRequest({ host: '127.0.0.1:3080' }, RESPOND_PATH), 404],
      [fakeRawPost({ host: '127.0.0.1:3080' }, RESPOND_PATH, '{}'), 415],
      [fakeRawPost({ host: '127.0.0.1:3080', 'content-type': 'application/json' }, RESPOND_PATH, '{'), 400],
    ] as const) {
      const response = fakeResponse()
      await route.handler(request, response.response)
      expect(response.state.status).toBe(status)
    }

    await removeResponses()
    const withdrawn = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, RESPOND_PATH, body), withdrawn.response)
    expect(withdrawn.state.status).toBe(404)
    expect(gatewayCalls).toEqual([])
    await removeGateway()
    await fiber.dispose()
  })

  it('aborts an active response owner when its registration is disposed', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    let handlerSignal: AbortSignal | undefined
    const remove = connection.responses.handle(async (_message, signal) => {
      handlerSignal = signal
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      signal.throwIfAborted()
      return { accepted: true }
    })
    const route = routes.find(candidate => candidate.path === API_PATH)!
    const response = fakeResponse()
    const pending = route.handler(fakePost({ host: '127.0.0.1:3080' }, RESPOND_PATH, {
      type: 'client-response', rpcId: 'active', result: { ok: true, value: {} },
    }), response.response)
    await vi.waitFor(() => { expect(handlerSignal).toBeDefined() })
    await remove()
    await pending
    expect(handlerSignal?.aborted).toBe(true)
    expect(response.state.status).toBe(500)
    await fiber.dispose()
  })

  it('mounts an exact loopback download without exposing it to the shared RPC interceptor', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = hostConnection(ctx)
    const gatewayCalls: string[] = []
    const removeGateway = connection.rpc.intercept(
      '/api',
      () => true,
      async (endpoint) => {
        gatewayCalls.push(endpoint)
        return { ok: true, value: null }
      },
      { authority: 'trusted-host' },
    )
    const seen: string[] = []
    let downloadSignal: AbortSignal | undefined
    const path = '/api/session/export'
    const removeDownload = connection.downloads.handle(path, async (request, signal) => {
      downloadSignal = signal
      signal.throwIfAborted()
      seen.push(new URL(request.url).pathname)
      return new Response('archive', { status: 200 })
    }, { authority: 'loopback' })
    expect(() => connection.downloads.handle(path, async () => new Response(), {
      authority: 'loopback',
    })).toThrow('already registered')
    expect(() => connection.downloads.handle('/outside/export', async () => new Response(), {
      authority: 'loopback',
    })).toThrow('invalid or reserved download path')

    const route = routes.find(candidate => candidate.path === API_PATH)!
    const loopback = fakeResponse()
    await route.handler(fakeRequest({ host: '127.0.0.1:3080' }, path), loopback.response)
    expect(loopback.state).toMatchObject({ status: 200, body: 'archive' })
    expect(seen).toEqual([path])
    expect(gatewayCalls).toEqual([])
    expect(downloadSignal?.aborted).toBe(true)

    const remote = fakeResponse()
    await route.handler(fakeRequest({ host: 'harness.example' }, path), remote.response)
    expect(remote.state.status).toBe(403)
    expect(seen).toEqual([path])

    await removeDownload()
    const withdrawn = fakeResponse()
    await route.handler(fakeRequest({ host: '127.0.0.1:3080' }, path), withdrawn.response)
    expect(withdrawn.state.status).toBe(404)
    await removeGateway()
    await fiber.dispose()
  })

  it('keeps a delayed download active through the real Connection bridge until body EOF', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    let handlerSignal: AbortSignal | undefined
    let abortEvents = 0
    const observedDuringPull: boolean[] = []
    let pull = 0
    const remove = connection.downloads.handle('/api/session/export', async (_request, signal) => {
      handlerSignal = signal
      signal.addEventListener('abort', () => { abortEvents += 1 })
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
          observedDuringPull.push(signal.aborted)
          pull += 1
          controller.enqueue(new TextEncoder().encode(pull === 1 ? 'delayed-' : 'archive'))
          if (pull === 2) controller.close()
        },
      }))
    }, { authority: 'loopback' })

    const result = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({ host: '127.0.0.1:3080' }, '/api/session/export'),
      result.response,
    )
    expect(result.state).toMatchObject({ status: 200, body: 'delayed-archive' })
    expect(observedDuringPull).toEqual([false, false])
    expect(handlerSignal?.aborted).toBe(true)
    expect(abortEvents).toBe(1)

    await remove()
    expect(abortEvents).toBe(1)
    await fiber.dispose()
  })

  it('streams a delayed large real Session ZIP through Connection to valid EOF', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    const mediaData = new Uint8Array(randomBytes(192 * 1024))
    const imageLine = '{"type":"user/message","seq":1,"time":1000,"data":{"content":[{"type":"image","attachment":{"attachmentId":"large-image","mediaType":"image/png","bytes":196608,"width":1,"height":1}}]}}'
    const rootContent = `${imageLine}\n${randomBytes(384 * 1024).toString('base64')}`
    const root = {
      meta: { version: 0, id: 'session-root', createdAt: 1000, cwd: '/project', delegationDepth: 0 },
      filename: 'session.jsonl',
      content: rootContent,
    }
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('sessionQuery', { traceSession: async () => { throw new Error('descendants disabled') } } as never)
    ctx.provide('sessionPersistence', {
      supportsRawArtifacts: true,
      readRaw: async () => root,
    } as never)
    let releaseAttachment!: () => void
    const attachmentHeld = new Promise<void>((resolve) => { releaseAttachment = resolve })
    let reportAttachment!: (signal: AbortSignal) => void
    const attachmentStarted = new Promise<AbortSignal>((resolve) => { reportAttachment = resolve })
    ctx.provide('attachments', {
      imageLimits: { maxMessageImageBytes: mediaData.byteLength },
      readImage: async (ref: unknown, signal?: AbortSignal) => {
        if (signal === undefined) throw new Error('missing attachment signal')
        reportAttachment(signal)
        await attachmentHeld
        signal.throwIfAborted()
        return { ref, data: mediaData }
      },
    } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    const service = hostConnection(ctx) as unknown as Pick<HostConnectionService, 'createSharedFetchHandler'> & {
      downloadHandlers: Map<string, { active: Set<unknown> }>
    }
    let handlerSignal: AbortSignal | undefined
    const remove = connection.downloads.handle('/api/session/export', (request, signal) => {
      handlerSignal = signal
      return fetchSessionLogExport(ctx, new Request(request, { signal }), 0)
    }, { authority: 'loopback' })
    const registration = service.downloadHandlers.get('/api/session/export')
    if (registration === undefined) throw new Error('missing Session export registration')
    const response = await service.createSharedFetchHandler('/api').fetch(new Request(
      'http://127.0.0.1/api/session/export?sessionId=session-root',
      { headers: { host: '127.0.0.1' } },
    ))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    const bodyResult = response.arrayBuffer().then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const attachmentSignal = await attachmentStarted
    expect(attachmentSignal.aborted).toBe(false)
    expect(handlerSignal?.aborted).toBe(false)
    expect(registration.active.size).toBe(1)

    releaseAttachment()
    const result = await bodyResult
    if (!result.ok) throw result.error
    const files = unzipSync(new Uint8Array(result.value))
    expect(strFromU8(files['session.jsonl'] as Uint8Array)).toBe(rootContent)
    expect(files['media/large-image.png']).toEqual(mediaData)
    expect(handlerSignal?.aborted).toBe(true)
    expect(registration.active.size).toBe(0)
    await remove()
    await fiber.dispose()
  })

  it('preserves download metadata and promptly releases finite, bodyless, HEAD, and JSON responses', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    const fetch = hostConnection(ctx).createSharedFetchHandler('/api')

    let finiteSignal: AbortSignal | undefined
    let finiteAbortEvents = 0
    const removeFinite = connection.downloads.handle('/api/files/finite', async (_request, signal) => {
      finiteSignal = signal
      signal.addEventListener('abort', () => { finiteAbortEvents += 1 })
      return new Response('archive', {
        status: 206,
        statusText: 'Partial Archive',
        headers: { 'content-type': 'application/zip', 'x-download': 'finite' },
      })
    }, { authority: 'loopback' })
    const finite = await fetch.fetch(new Request('http://127.0.0.1/api/files/finite', {
      headers: { host: '127.0.0.1' },
    }))
    expect(finite.status).toBe(206)
    expect(finite.statusText).toBe('Partial Archive')
    expect(finite.headers.get('content-type')).toBe('application/zip')
    expect(finite.headers.get('x-download')).toBe('finite')
    expect(finiteSignal?.aborted).toBe(false)
    await expect(finite.text()).resolves.toBe('archive')
    expect(finiteSignal?.aborted).toBe(true)
    expect(finiteAbortEvents).toBe(1)
    await removeFinite()
    expect(finiteAbortEvents).toBe(1)

    let bodylessSignal: AbortSignal | undefined
    const removeBodyless = connection.downloads.handle('/api/files/bodyless', async (_request, signal) => {
      bodylessSignal = signal
      return new Response(null, { status: 204, headers: { 'x-download': 'bodyless' } })
    }, { authority: 'loopback' })
    const bodyless = await fetch.fetch(new Request('http://127.0.0.1/api/files/bodyless', {
      headers: { host: '127.0.0.1' },
    }))
    expect(bodyless.status).toBe(204)
    expect(bodyless.headers.get('x-download')).toBe('bodyless')
    expect(bodyless.body).toBeNull()
    expect(bodylessSignal?.aborted).toBe(true)
    await removeBodyless()

    let headSignal: AbortSignal | undefined
    let headCancelReason: unknown
    const removeHead = connection.downloads.handle('/api/files/head', async (_request, signal) => {
      headSignal = signal
      return new Response(new ReadableStream<Uint8Array>({
        cancel(reason) {
          headCancelReason = reason
        },
      }), {
        status: 202,
        statusText: 'Archive Ready',
        headers: { 'x-download': 'head' },
      })
    }, { authority: 'loopback' })
    const head = await fetch.fetch(new Request('http://127.0.0.1/api/files/head', {
      method: 'HEAD',
      headers: { host: '127.0.0.1' },
    }))
    expect(head.status).toBe(202)
    expect(head.statusText).toBe('Archive Ready')
    expect(head.headers.get('x-download')).toBe('head')
    expect(head.body).toBeNull()
    expect(headSignal?.aborted).toBe(true)
    await vi.waitFor(() => { expect(headCancelReason).toBeDefined() })
    await removeHead()

    let responseSignal: AbortSignal | undefined
    const removeResponse = connection.responses.handle(async (_body, signal) => {
      responseSignal = signal
      return { accepted: true }
    })
    const response = await fetch.fetch(new Request('http://127.0.0.1/api/respond', {
      method: 'POST',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId: 'short', result: { ok: true, value: {} } }),
    }))
    expect(response.status).toBe(200)
    expect(responseSignal?.aborted).toBe(true)
    await expect(response.json()).resolves.toEqual({ accepted: true })
    await removeResponse()
    await fiber.dispose()
  })

  it('releases delayed download lifetimes on consumer cancellation and body error', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    const fetch = hostConnection(ctx).createSharedFetchHandler('/api')

    const consumerReason = new Error('consumer cancelled')
    let consumerSignal: AbortSignal | undefined
    let consumerCancelReason: unknown
    let consumerAbortEvents = 0
    const removeConsumer = connection.downloads.handle('/api/files/consumer-cancel', async (_request, signal) => {
      consumerSignal = signal
      signal.addEventListener('abort', () => { consumerAbortEvents += 1 })
      return new Response(new ReadableStream<Uint8Array>({
        cancel(reason) {
          consumerCancelReason = reason
        },
      }))
    }, { authority: 'loopback' })
    const consumerResponse = await fetch.fetch(new Request('http://127.0.0.1/api/files/consumer-cancel', {
      headers: { host: '127.0.0.1' },
    }))
    const consumerReader = consumerResponse.body?.getReader()
    if (consumerReader === undefined) throw new Error('missing consumer response body')
    await consumerReader.cancel(consumerReason)
    expect(consumerSignal?.aborted).toBe(true)
    expect(consumerSignal?.reason).toBe(consumerReason)
    expect(consumerCancelReason).toBe(consumerReason)
    expect(consumerAbortEvents).toBe(1)
    await removeConsumer()
    expect(consumerAbortEvents).toBe(1)

    const bodyError = new Error('archive producer failed')
    let errorSignal: AbortSignal | undefined
    let errorController!: ReadableStreamDefaultController<Uint8Array>
    let errorAbortEvents = 0
    let markErrorPull!: () => void
    const errorPull = new Promise<void>((resolve) => { markErrorPull = resolve })
    const removeError = connection.downloads.handle('/api/files/body-error', async (_request, signal) => {
      errorSignal = signal
      signal.addEventListener('abort', () => { errorAbortEvents += 1 })
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          errorController = controller
        },
        pull() {
          markErrorPull()
        },
      }))
    }, { authority: 'loopback' })
    const errorResponse = await fetch.fetch(new Request('http://127.0.0.1/api/files/body-error', {
      headers: { host: '127.0.0.1' },
    }))
    const errorBody = errorResponse.text()
    await errorPull
    errorController.error(bodyError)
    await expect(errorBody).rejects.toBe(bodyError)
    expect(errorSignal?.aborted).toBe(true)
    expect(errorSignal?.reason).toBe(bodyError)
    expect(errorAbortEvents).toBe(1)
    await removeError()
    expect(errorAbortEvents).toBe(1)
    await fiber.dispose()
  })

  it('aborts an in-flight body on request cancellation or download-owner disposal', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    const fetch = hostConnection(ctx).createSharedFetchHandler('/api')

    const requestAbort = new AbortController()
    const requestReason = new Error('request disconnected')
    let requestSignal: AbortSignal | undefined
    let requestCancelReason: unknown
    let requestAbortEvents = 0
    let markRequestPull!: () => void
    const requestPull = new Promise<void>((resolve) => { markRequestPull = resolve })
    const removeRequest = connection.downloads.handle('/api/files/request-abort', async (_request, signal) => {
      requestSignal = signal
      signal.addEventListener('abort', () => { requestAbortEvents += 1 })
      return new Response(new ReadableStream<Uint8Array>({
        pull() {
          markRequestPull()
        },
        cancel(reason) {
          requestCancelReason = reason
        },
      }))
    }, { authority: 'loopback' })
    const requestResponse = await fetch.fetch(new Request('http://127.0.0.1/api/files/request-abort', {
      headers: { host: '127.0.0.1' },
      signal: requestAbort.signal,
    }))
    expect(requestSignal?.aborted).toBe(false)
    const requestBody = requestResponse.text()
    await requestPull
    requestAbort.abort(requestReason)
    await expect(requestBody).rejects.toBe(requestReason)
    expect(requestSignal?.aborted).toBe(true)
    expect(requestSignal?.reason).toBe(requestReason)
    await vi.waitFor(() => { expect(requestCancelReason).toBe(requestReason) })
    expect(requestAbortEvents).toBe(1)
    await removeRequest()
    expect(requestAbortEvents).toBe(1)

    let ownerSignal: AbortSignal | undefined
    let ownerCancelReason: unknown
    let ownerAbortEvents = 0
    let markOwnerPull!: () => void
    const ownerPull = new Promise<void>((resolve) => { markOwnerPull = resolve })
    const removeOwner = connection.downloads.handle('/api/files/owner-removal', async (_request, signal) => {
      ownerSignal = signal
      signal.addEventListener('abort', () => { ownerAbortEvents += 1 })
      return new Response(new ReadableStream<Uint8Array>({
        pull() {
          markOwnerPull()
        },
        cancel(reason) {
          ownerCancelReason = reason
          return Promise.reject(new Error('source cancellation raced with disposal'))
        },
      }))
    }, { authority: 'loopback' })
    const ownerResponse = await fetch.fetch(new Request('http://127.0.0.1/api/files/owner-removal', {
      headers: { host: '127.0.0.1' },
    }))
    expect(ownerSignal?.aborted).toBe(false)
    const ownerBody = ownerResponse.text().then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await ownerPull
    await expect(removeOwner()).rejects.toThrow('source cancellation raced with disposal')
    expect(ownerSignal?.aborted).toBe(true)
    expect(ownerSignal?.reason).toBeInstanceOf(Error)
    expect((ownerSignal?.reason as Error).message).toContain('was disposed')
    const ownerResult = await ownerBody
    const ownerReason: unknown = ownerSignal?.reason
    expect(ownerResult).toEqual({ ok: false, error: ownerReason })
    await vi.waitFor(() => { expect(ownerCancelReason).toBe(ownerSignal?.reason) })
    expect(ownerAbortEvents).toBe(1)
    expect((await fetch.fetch(new Request('http://127.0.0.1/api/files/owner-removal', {
      headers: { host: '127.0.0.1' },
    }))).status).toBe(404)
    await fiber.dispose()
  })

  it('keeps owner disposal pending until a held body cancellation becomes quiescent', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    const fetch = hostConnection(ctx).createSharedFetchHandler('/api')
    const internals = hostConnection(ctx) as unknown as {
      downloadHandlers: Map<string, { active: Set<unknown> }>
    }

    let releaseCancel!: () => void
    const heldCancel = new Promise<void>((resolve) => { releaseCancel = resolve })
    let markCancelStarted!: () => void
    const cancelStarted = new Promise<void>((resolve) => { markCancelStarted = resolve })
    let markPullStarted!: () => void
    const pullStarted = new Promise<void>((resolve) => { markPullStarted = resolve })
    let handlerSignal: AbortSignal | undefined
    let cancelCalls = 0
    const path = '/api/files/held-cancel'
    const remove = connection.downloads.handle(path, async (_request, signal) => {
      handlerSignal = signal
      return new Response(new ReadableStream<Uint8Array>({
        pull() {
          markPullStarted()
        },
        cancel() {
          cancelCalls += 1
          markCancelStarted()
          return heldCancel
        },
      }))
    }, { authority: 'loopback' })
    const registration = internals.downloadHandlers.get(path)
    if (registration === undefined) throw new Error('missing download registration')
    const response = await fetch.fetch(new Request(`http://127.0.0.1${path}`, {
      headers: { host: '127.0.0.1' },
    }))
    const bodyResult = response.text().then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await pullStarted
    expect(registration.active.size).toBe(1)

    let disposalSettled = false
    const firstDisposal = remove().then(() => { disposalSettled = true })
    const secondDisposal = remove()
    await cancelStarted
    await Promise.resolve()
    expect(disposalSettled).toBe(false)
    expect(registration.active.size).toBe(1)
    expect(cancelCalls).toBe(1)
    expect(handlerSignal?.aborted).toBe(true)

    releaseCancel()
    await Promise.all([firstDisposal, secondDisposal])
    const result = await bodyResult
    const disposalReason: unknown = handlerSignal?.reason
    expect(result).toEqual({ ok: false, error: disposalReason })
    expect(disposalSettled).toBe(true)
    expect(registration.active.size).toBe(0)
    expect(internals.downloadHandlers.has(path)).toBe(false)
    expect(cancelCalls).toBe(1)
    await fiber.dispose()
  })

  it('withdraws a real Session ZIP route immediately but rejects disposal on producer cleanup failure', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    const imageLine = '{"type":"user/message","seq":1,"time":1000,"data":{"content":[{"type":"image","attachment":{"attachmentId":"held-image","mediaType":"image/png","bytes":4,"width":1,"height":1}}]}}'
    const root = {
      meta: { version: 0, id: 'session-root', createdAt: 1000, cwd: '/project', delegationDepth: 0 },
      filename: 'session.jsonl',
      content: `${imageLine}\n${randomBytes(192 * 1024).toString('base64')}`,
    }
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('sessionQuery', { traceSession: async () => { throw new Error('descendants disabled') } } as never)
    ctx.provide('sessionPersistence', {
      supportsRawArtifacts: true,
      readRaw: async () => root,
    } as never)
    const cleanupFailure = new Error('real Session ZIP cleanup failed')
    let releaseCleanup!: () => void
    const cleanupHeld = new Promise<void>((resolve) => { releaseCleanup = resolve })
    let reportAttachment!: (signal: AbortSignal) => void
    const attachmentStarted = new Promise<AbortSignal>((resolve) => { reportAttachment = resolve })
    let reportAbort!: () => void
    const attachmentAborted = new Promise<void>((resolve) => { reportAbort = resolve })
    let abortEvents = 0
    ctx.provide('attachments', {
      imageLimits: { maxMessageImageBytes: 4 },
      readImage: async (_ref: unknown, signal?: AbortSignal) => {
        if (signal === undefined) throw new Error('missing attachment signal')
        reportAttachment(signal)
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            abortEvents += 1
            reportAbort()
            resolve()
          }, { once: true })
        })
        await cleanupHeld
        throw cleanupFailure
      },
    } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    const service = hostConnection(ctx) as unknown as Pick<HostConnectionService, 'createSharedFetchHandler'> & {
      downloadHandlers: Map<string, { active: Set<unknown> }>
    }
    let handlerSignal: AbortSignal | undefined
    const path = '/api/session/export'
    const remove = connection.downloads.handle(path, (request, signal) => {
      handlerSignal = signal
      return fetchSessionLogExport(ctx, new Request(request, { signal }), 0)
    }, { authority: 'loopback' })
    const registration = service.downloadHandlers.get(path)
    if (registration === undefined) throw new Error('missing Session export registration')
    const fetch = service.createSharedFetchHandler('/api')
    const response = await fetch.fetch(new Request(
      `http://127.0.0.1${path}?sessionId=session-root`,
      { headers: { host: '127.0.0.1' } },
    ))
    const bodyResult = response.arrayBuffer().then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const attachmentSignal = await attachmentStarted
    expect(registration.active.size).toBe(1)

    const firstDisposal = remove().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const secondDisposal = remove().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await attachmentAborted
    expect((await fetch.fetch(new Request(
      `http://127.0.0.1${path}?sessionId=session-root`,
      { headers: { host: '127.0.0.1' } },
    ))).status).toBe(404)
    const deadline = await Promise.race([
      firstDisposal.then(() => 'settled' as const),
      new Promise<'deadline'>((resolve) => { setTimeout(() => { resolve('deadline') }, 10) }),
    ])
    expect(deadline).toBe('deadline')
    expect(registration.active.size).toBe(1)
    expect(attachmentSignal.aborted).toBe(true)
    expect(handlerSignal?.aborted).toBe(true)
    expect(abortEvents).toBe(1)

    releaseCleanup()
    const [first, second, body] = await Promise.all([firstDisposal, secondDisposal, bodyResult])
    expect(first).toEqual({ ok: false, error: cleanupFailure })
    expect(second).toEqual({ ok: false, error: cleanupFailure })
    const disposalReason: unknown = handlerSignal?.reason
    expect(body).toEqual({ ok: false, error: disposalReason })
    expect(registration.active.size).toBe(0)
    expect(service.downloadHandlers.has(path)).toBe(false)
    expect(abortEvents).toBe(1)
    await fiber.dispose()
  })

  it('fails a HEAD download when its discarded producer body rejects cancellation', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    const fetch = hostConnection(ctx).createSharedFetchHandler('/api')
    const cleanupFailure = new Error('HEAD body cleanup failed')
    const remove = connection.downloads.handle('/api/files/head-failure', async () => {
      return new Response(new ReadableStream<Uint8Array>({
        cancel() {
          return Promise.reject(cleanupFailure)
        },
      }))
    }, { authority: 'loopback' })
    const response = await fetch.fetch(new Request('http://127.0.0.1/api/files/head-failure', {
      method: 'HEAD',
      headers: { host: '127.0.0.1' },
    }))
    expect(response.status).toBe(500)
    await expect(response.text()).resolves.toContain('HEAD body cleanup failed')
    await remove()
    await fiber.dispose()
  })

  it('returns 499 and cancels a body when a pre-aborted handler ignores its signal', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    const fetch = hostConnection(ctx).createSharedFetchHandler('/api')
    const abort = new AbortController()
    const reason = new Error('already disconnected')
    abort.abort(reason)
    let handlerSignal: AbortSignal | undefined
    let cancelledReason: unknown
    const remove = connection.downloads.handle('/api/files/pre-aborted-response', async (_request, signal) => {
      handlerSignal = signal
      return new Response(new ReadableStream<Uint8Array>({
        cancel(cancelReason) {
          cancelledReason = cancelReason
        },
      }))
    }, { authority: 'loopback' })
    const response = await fetch.fetch(new Request('http://127.0.0.1/api/files/pre-aborted-response', {
      headers: { host: '127.0.0.1' },
      signal: abort.signal,
    }))
    expect(response.status).toBe(499)
    expect(handlerSignal?.aborted).toBe(true)
    expect(handlerSignal?.reason).toBe(reason)
    await vi.waitFor(() => { expect(cancelledReason).toBe(reason) })
    await remove()
    await fiber.dispose()
  })

  it('accepts sufficient image capacity and hands both trusted upgrade paths to their native handlers', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
    ctx.provide('attachments', { imageLimits: { maxMessageImageBytes: 2 } } as AttachmentStore)
    const mux = vi.spyOn(WebSocketDownlinks.prototype, 'handleMux').mockImplementation(() => {})
    const host = vi.spyOn(WebSocketDownlinks.prototype, 'handleHost').mockImplementation(() => {})
    const fiber = ctx.plugin({ inject: [...inject], apply }, { maxRequestBodyBytes: Math.ceil(2 * 4 / 3) + 1024 * 1024 })
    try {
      await fiber.await()
      const socket = new PassThrough()
      await upgrades[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, MUX_EVENTS_PATH), socket, Buffer.alloc(0))
      await upgrades[1]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, HOST_EVENTS_PATH), socket, Buffer.alloc(0))
      expect(mux).toHaveBeenCalledOnce()
      expect(host).toHaveBeenCalledOnce()

      const outside = fakeResponse()
      await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, '/outside'), outside.response)
      expect(outside.state.status).toBe(404)
    } finally {
      mux.mockRestore()
      host.mockRestore()
      await fiber.dispose()
    }
  })

  it('honors pre-cancelled streams and aborts active downloads on owner removal', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    const preCancelled = new AbortController()
    preCancelled.abort(new Error('caller left'))
    let sawPreCancelled = false
    const removeSource = connection.events.handle('host', async function * (signal) {
      sawPreCancelled = signal.aborted
      yield { rpcId: 'host-pre-cancelled', payload: { type: 'host/remote-event', event: 'commands/change', args: [] } }
    })
    const iterator = connection.openEventStream('host', preCancelled.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { rpcId: 'host-pre-cancelled' },
      done: false,
    })
    expect(sawPreCancelled).toBe(true)
    await iterator.return?.()
    await removeSource()

    const downloads = hostConnection(ctx)
    const fetch = downloads.createSharedFetchHandler('/api')
    const preAbort = new AbortController()
    preAbort.abort(new Error('pre-aborted'))
    const removePreAborted = connection.downloads.handle('/api/files/pre-aborted', async (_request, signal) => {
      signal.throwIfAborted()
      return new Response('unreachable')
    }, { authority: 'loopback' })
    expect((await fetch.fetch(new Request('http://127.0.0.1/api/files/pre-aborted', {
      headers: { host: '127.0.0.1' },
      signal: preAbort.signal,
    }))).status).toBe(499)
    await removePreAborted()

    const removeFailure = connection.downloads.handle('/api/files/failure', async () => {
      throw new Error('download failed')
    }, { authority: 'loopback' })
    expect((await fetch.fetch(new Request('http://127.0.0.1/api/files/failure', {
      headers: { host: '127.0.0.1' },
    }))).status).toBe(500)
    await removeFailure()

    let started!: () => void
    const active = new Promise<void>((resolve) => { started = resolve })
    let handlerSignal: AbortSignal | undefined
    const removeActive = connection.downloads.handle('/api/files/active', async (_request, signal) => {
      handlerSignal = signal
      started()
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      signal.throwIfAborted()
      return new Response('unreachable')
    }, { authority: 'loopback' })
    const pending = fetch.fetch(new Request('http://127.0.0.1/api/files/active', {
      headers: { host: '127.0.0.1' },
    }))
    await active
    await removeActive()
    expect(handlerSignal?.aborted).toBe(true)
    expect((await pending).status).toBe(499)
    expect(() => connection.downloads.handle('/api/files//bad', async () => new Response(), {
      authority: 'loopback',
    })).toThrow('invalid download path')
    await fiber.dispose()
  })

  it('does not remove a newer owner registration while disposing an older one', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = hostConnection(ctx)
    const internals = hostConnection(ctx) as unknown as {
      eventSources: Map<string, unknown>
      downloadHandlers: Map<string, unknown>
      responseHandler: unknown
    }

    const removeEvent = connection.events.handle('mux', async function * () {})
    const newerEvent = {}
    internals.eventSources.set('mux', newerEvent)
    await removeEvent()
    expect(internals.eventSources.get('mux')).toBe(newerEvent)
    internals.eventSources.delete('mux')

    const removeResponse = connection.responses.handle(async () => ({ accepted: true }))
    const newerResponse = {}
    internals.responseHandler = newerResponse
    await removeResponse()
    expect(internals.responseHandler).toBe(newerResponse)
    internals.responseHandler = undefined

    const path = '/api/files/replace-race'
    const removeDownload = connection.downloads.handle(path, async () => new Response('ok'), {
      authority: 'loopback',
    })
    const newerDownload = {}
    internals.downloadHandlers.set(path, newerDownload)
    await removeDownload()
    expect(internals.downloadHandlers.get(path)).toBe(newerDownload)
    internals.downloadHandlers.delete(path)
    await fiber.dispose()
  })
})

describe('connection node half over a real HTTP server', () => {
  /** Serve the registered prefix route from a real server and return its port. */
  async function serve(routes: WebRoute[]): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
      void routes[0]!.handler(request, response)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    return {
      port: address.port,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
      }),
    }
  }

  /** One real request; `host` spoofs the authority the way a LAN client's browser would send it. */
  function call(port: number, method: string, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path: `${API_PATH}/${method}`, method: 'GET', headers: { host } },
        (response) => {
          response.resume()
          response.on('end', () => { resolve(response.statusCode ?? 0) })
        },
      )
      request.on('error', reject)
      request.end()
    })
  }

  it('answers a declared LAN authority with 403 on every configuration method, over real HTTP', async () => {
    // The fence's input is a real IncomingMessage parsed by Node from the
    // wire, not a hand-assembled object: the Host header a LAN browser sends
    // is exactly what decides loopback-only here, so the boundary is asserted
    // against the parse the server actually performs.
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const { port, close } = await serve(routes)
    try {
      // Reads are as privileged as writes: describe returns the exposed
      // configuration, and credentials.describe probes arbitrary env-var names.
      for (const method of [
        'settings/describe', 'settings/openDocument', 'settings/update', 'settings/replace', 'settings/mutate',
        'credentials/describe', 'credentials/set', 'credentials/unset',
        'host/pickDirectory', 'host/openPath',
        // Carries a draft credential and turns the host into a fetcher for a
        // URL the caller picked: an anonymous LAN caller must not reach it.
        'llm/discoverModels',
        'agentPreset/read', 'agentPreset/copy', 'agentPreset/openDocument', 'agentPreset/remove',
      ]) {
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 403])
      }
      // The model catalog stays reachable for the same authority: a LAN
      // client's model picker needs it, and it carries no key or endpoint
      // state (404 is the empty proxy's carrier answer — the fence passed).
      // `agentPreset.list` joins the model catalog for the same reason: ids and
      // trust only, and a LAN client's preset picker needs it. `select` is
      // reachable too: `session.create` already takes an `agentPreset`, and the
      // deployment's own default already carries bash, so pinning the switch
      // would be a fence beside an open gate.
      for (const method of ['llm/providers', 'llm/models', 'agentPreset/list', 'agentPreset/select']) {
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 404])
      }
      // Loopback reaches everything, configuration included.
      expect(await call(port, 'settings/describe', `127.0.0.1:${String(port)}`)).toBe(404)
    } finally {
      await close()
      await dispose()
    }
  })
})
