import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import type {
  ConnectionEventFrame, ConnectionServerEvent, HostConnectionEventReader,
} from '../src/rpc.ts'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../src/api-path.ts'
import {
  DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WEBSOCKET_CLOSE_GRACE_MS,
  rejectWebSocketUpgrade,
  WebSocketDownlinks,
} from '../src/websocket-downlink.ts'

type EventSource = (signal: AbortSignal) => AsyncIterable<ConnectionEventFrame>

const running: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(close => close()))
  vi.restoreAllMocks()
})

function untilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

async function * idle(signal: AbortSignal): AsyncGenerator<ConnectionEventFrame> {
  await untilAbort(signal)
}

function sources(mux: EventSource, host: EventSource): HostConnectionEventReader {
  return {
    openEventStream(channel, signal) {
      return channel === 'mux' ? mux(signal) : host(signal)
    },
  }
}

async function serve(downlinks: WebSocketDownlinks): Promise<{
  origin: string
  close: () => Promise<void>
}> {
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
    if (pathname === MUX_EVENTS_PATH) downlinks.handleMux(request, socket, head)
    else if (pathname === HOST_EVENTS_PATH) downlinks.handleHost(request, socket, head)
    else socket.destroy()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `ws://127.0.0.1:${String(port)}`,
    close: async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    },
  }
}

function read(socket: WebSocket): Promise<ConnectionServerEvent> {
  return once(socket, 'message').then(([data]) => JSON.parse(rawText(data as RawData)) as ConnectionServerEvent)
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8')
  return data.toString('utf8')
}

function readMany(socket: WebSocket, count: number): Promise<ConnectionServerEvent[]> {
  return new Promise((resolve) => {
    const frames: ConnectionServerEvent[] = []
    const receive = (data: RawData): void => {
      frames.push(JSON.parse(rawText(data)) as ConnectionServerEvent)
      if (frames.length !== count) return
      socket.off('message', receive)
      resolve(frames)
    }
    socket.on('message', receive)
  })
}

async function acceptedSocket(downlinks: WebSocketDownlinks): Promise<WebSocket> {
  const server = (downlinks as unknown as { server: { clients: Set<WebSocket> } }).server
  let accepted: WebSocket | undefined
  await vi.waitFor(() => {
    accepted = server.clients.values().next().value
    expect(accepted).toBeDefined()
  })
  return accepted as WebSocket
}

describe('WebSocket downlinks', () => {
  it('writes one closed 403 HTTP response for a rejected upgrade', async () => {
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    rejectWebSocketUpgrade(socket)
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
  })

  it('carries mux and host over independent downstream sockets and cancels each source on close', async () => {
    let muxAborted = false
    let hostAborted = false
    const downlinks = new WebSocketDownlinks(sources(
      async function * (signal) {
        try {
          yield {
            rpcId: 'mux-1',
            payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
          }
          await untilAbort(signal)
        } finally {
          muxAborted = true
        }
      },
      async function * (signal) {
        try {
          yield { rpcId: 'host-1', payload: { type: 'host/remote-event', event: 'commands/change', args: [] } }
          await untilAbort(signal)
        } finally {
          hostAborted = true
        }
      },
    ))
    const host = await serve(downlinks)
    running.push(host.close)

    const mux = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const hostSocket = new WebSocket(`${host.origin}${HOST_EVENTS_PATH}`)
    const muxFrame = read(mux)
    const hostFrame = read(hostSocket)
    expect(await muxFrame).toEqual({
      type: 'server-request',
      rpcId: 'mux-1',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
    })
    expect(await hostFrame).toEqual({
      type: 'server-request',
      rpcId: 'host-1',
      method: 'host/remote-event',
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    })

    const muxClosed = once(mux, 'close')
    const hostClosed = once(hostSocket, 'close')
    mux.close()
    hostSocket.close()
    await Promise.all([muxClosed, hostClosed])
    await vi.waitFor(() => {
      expect(muxAborted).toBe(true)
      expect(hostAborted).toBe(true)
    })
  })

  it('preserves stable approval and question response correlation on the mux carrier', async () => {
    const downlinks = new WebSocketDownlinks(sources(
      async function * (signal) {
        yield {
          rpcId: 'approval-rpc',
          payload: {
            type: 'approval/requested',
            sessionId: 'session-1',
            approvalId: 'approval-1',
            toolName: 'bash',
          },
        }
        yield {
          rpcId: 'question-rpc',
          payload: {
            type: 'question/requested',
            sessionId: 'session-1',
            questions: [{ id: 'choice', question: 'Continue?' }],
          },
        }
        await untilAbort(signal)
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const mux = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const [approval, question] = await readMany(mux, 2)
    expect(approval).toMatchObject({
      type: 'server-request',
      rpcId: 'approval-rpc',
      method: 'approval/requested',
      payload: { approvalId: 'approval-1' },
    })
    expect(question).toMatchObject({
      type: 'server-request',
      rpcId: 'question-rpc',
      method: 'question/requested',
      payload: { sessionId: 'session-1' },
    })
  })

  it('keeps the host stream live across a mux-only reconnect and owns both heartbeats', async () => {
    let muxGeneration = 0
    let muxAborted = 0
    let hostAborted = false
    const heartbeat = vi.spyOn(globalThis, 'setInterval')
    const downlinks = new WebSocketDownlinks(sources(
      async function * (signal) {
        const generation = ++muxGeneration
        try {
          yield {
            rpcId: `mux-${String(generation)}`,
            payload: { type: 'session/subscribed', sessionId: `session-${String(generation)}`, lastSeq: generation },
          }
          await untilAbort(signal)
        } finally {
          muxAborted++
        }
      },
      async function * (signal) {
        try {
          yield { rpcId: 'host-live', payload: { type: 'host/remote-event', event: 'commands/change', args: [] } }
          await untilAbort(signal)
        } finally {
          hostAborted = true
        }
      },
    ))
    const listener = await serve(downlinks)
    running.push(listener.close)
    try {
      const firstMux = new WebSocket(`${listener.origin}${MUX_EVENTS_PATH}`)
      const hostSocket = new WebSocket(`${listener.origin}${HOST_EVENTS_PATH}`)
      expect((await read(firstMux)).payload).toMatchObject({ sessionId: 'session-1', lastSeq: 1 })
      expect((await read(hostSocket)).payload).toMatchObject({ type: 'host/remote-event' })

      const firstClosed = once(firstMux, 'close')
      firstMux.close()
      await firstClosed
      await vi.waitFor(() => { expect(muxAborted).toBe(1) })
      expect(hostSocket.readyState).toBe(WebSocket.OPEN)
      expect(hostAborted).toBe(false)

      const secondMux = new WebSocket(`${listener.origin}${MUX_EVENTS_PATH}`)
      expect((await read(secondMux)).payload).toMatchObject({ sessionId: 'session-2', lastSeq: 2 })

      const server = (downlinks as unknown as { server: { clients: Set<WebSocket> } }).server
      await vi.waitFor(() => { expect(server.clients.size).toBe(2) })
      const closedPing = vi.fn()
      const closedSocket = { readyState: WebSocket.CLOSED, ping: closedPing } as unknown as WebSocket
      server.clients.add(closedSocket)
      const pings = [...server.clients]
        .filter(socket => socket !== closedSocket)
        .map(socket => vi.spyOn(socket, 'ping'))
      const heartbeatCall = heartbeat.mock.calls.find(call => (
        call[1] === DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS
      ))
      if (heartbeatCall === undefined || typeof heartbeatCall[0] !== 'function') {
        throw new Error('WebSocket downlink did not register its heartbeat')
      }
      heartbeatCall[0]()
      for (const ping of pings) expect(ping).toHaveBeenCalledOnce()
      expect(closedPing).not.toHaveBeenCalled()
      for (const ping of pings) ping.mockRestore()
      server.clients.delete(closedSocket)
    } finally {
      heartbeat.mockRestore()
    }
  })

  it('rejects client messages because upstream remains HTTP', async () => {
    let aborted = false
    const downlinks = new WebSocketDownlinks(sources(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          aborted = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send('upstream payload')
    const [code, reason] = await closed as [number, Buffer]
    expect(code).toBe(1008)
    expect(String(reason)).toBe('downlink only')
    await vi.waitFor(() => { expect(aborted).toBe(true) })
  })

  it('sends stream/error before closing when a source fails', async () => {
    const downlinks = new WebSocketDownlinks(sources(
      async function * () {
        throw new Error('mux source failed')
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const failure = read(socket)
    const closed = once(socket, 'close')
    expect((await failure).payload).toEqual({
      type: 'stream/error',
      channel: 'mux',
      error: { code: 'EVENT_STREAM_FAILED', message: 'mux source failed', details: {} },
    })
    await closed
  })

  it.each([null, 'primitive source failure', 42])('normalizes an untyped source failure %j on the actual socket', async (error) => {
    const downlinks = new WebSocketDownlinks(sources(async function * () { throw error }, idle))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const failure = read(socket)
    const closed = once(socket, 'close')
    expect((await failure).payload).toEqual({
      type: 'stream/error', channel: 'mux',
      error: { code: 'EVENT_STREAM_FAILED', message: String(error), details: {} },
    })
    await closed
  })

  it.each([
    { channel: 'mux', success: null },
    { channel: 'mux', success: undefined },
    { channel: 'host', success: null },
    { channel: 'host', success: undefined },
  ] as const)('keeps $channel open when a successful Ping callback carries $success', async ({ channel, success }) => {
    const heartbeat = vi.spyOn(globalThis, 'setInterval')
    let sourceAborted = false
    const source: EventSource = async function * (signal) {
      try { await untilAbort(signal) } finally { sourceAborted = true }
    }
    const downlinks = new WebSocketDownlinks(sources(source, source))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${channel === 'mux' ? MUX_EVENTS_PATH : HOST_EVENTS_PATH}`)
    const frames: RawData[] = []
    socket.on('message', (frame: RawData) => { frames.push(frame) })
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const heartbeatCall = heartbeat.mock.calls.find(call => call[1] === DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS)
    if (heartbeatCall === undefined || typeof heartbeatCall[0] !== 'function') throw new Error('missing heartbeat')
    const realPing = accepted.ping.bind(accepted)
    // Keep real wire Ping/Pong; vary only the transport callback's permitted
    // empty-success representation. Actual Errors remain unchanged.
    const ping = vi.spyOn(accepted, 'ping').mockImplementation(((callback: (error?: Error | null) => void) => {
      realPing((error?: Error | null) => { callback(error ?? success) })
    }) as WebSocket['ping'])
    for (let tick = 0; tick < 2; tick += 1) {
      const pong = once(accepted, 'pong')
      heartbeatCall[0]()
      await pong
      expect(frames.map(rawText)).toEqual([])
      expect(socket.readyState).toBe(WebSocket.OPEN)
      expect(sourceAborted).toBe(false)
    }
    expect(ping).toHaveBeenCalledTimes(2)
  })

  it('accepts real pong replies, then bounds a ping failure when the peer stops reading', async () => {
    const heartbeat = vi.spyOn(globalThis, 'setInterval')
    const timers = vi.spyOn(globalThis, 'setTimeout')
    let sourceAborted = false
    const downlinks = new WebSocketDownlinks(sources(async function * (signal) {
      try { await untilAbort(signal) } finally { sourceAborted = true }
    }, idle))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const heartbeatCall = heartbeat.mock.calls.find(call => call[1] === DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS)
    if (heartbeatCall === undefined || typeof heartbeatCall[0] !== 'function') throw new Error('missing heartbeat')
    const frames: RawData[] = []
    socket.on('message', (frame: RawData) => { frames.push(frame) })
    for (let count = 0; count < 2; count++) {
      const pong = once(accepted, 'pong')
      heartbeatCall[0]()
      await pong
      expect(frames.map(rawText)).toEqual([])
      expect(socket.readyState).toBe(WebSocket.OPEN)
      expect(sourceAborted).toBe(false)
    }
    expect(frames).toEqual([])

    socket.pause()
    const peerClosed = once(socket, 'close')
    const acceptedClosed = once(accepted, 'close')
    const terminate = vi.spyOn(accepted, 'terminate')
    const ping = vi.spyOn(accepted, 'ping').mockImplementation(((callback: (error?: Error) => void) => {
      callback(new Error('ping transport failed'))
    }) as WebSocket['ping'])
    heartbeatCall[0]()
    await vi.waitFor(() => { expect(sourceAborted).toBe(true) })
    expect(ping).toHaveBeenCalledOnce()
    expect(terminate).not.toHaveBeenCalled()
    const deadline = timers.mock.calls.find(call => call[1] === DEFAULT_WEBSOCKET_CLOSE_GRACE_MS)
    if (deadline === undefined || typeof deadline[0] !== 'function') throw new Error('missing bounded close deadline')
    deadline[0]()
    await acceptedClosed
    expect(terminate).toHaveBeenCalledOnce()
    socket.resume()
    await peerClosed
  })

  it('preserves a typed source failure and closes only that channel socket', async () => {
    const sourceError = Object.assign(new Error('bounded queue overflow'), {
      code: 'EVENT_QUEUE_OVERFLOW',
      details: { maximumFrames: 4096, queuedFrames: 4096 },
    })
    const downlinks = new WebSocketDownlinks(sources(
      async function * () { throw sourceError },
      async function * (signal) {
        yield {
          rpcId: 'host-live',
          payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
        }
        await untilAbort(signal)
      },
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const mux = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const hostSocket = new WebSocket(`${host.origin}${HOST_EVENTS_PATH}`)
    const muxClosed = once(mux, 'close')
    const hostFrame = read(hostSocket)
    const failure = await read(mux)
    expect(failure.payload).toEqual({
      type: 'stream/error',
      channel: 'mux',
      error: {
        code: 'EVENT_QUEUE_OVERFLOW',
        message: 'bounded queue overflow',
        details: { maximumFrames: 4096, queuedFrames: 4096 },
      },
    })
    await muxClosed
    expect((await hostFrame).payload).toMatchObject({ type: 'host/remote-event' })
    expect(hostSocket.readyState).toBe(WebSocket.OPEN)
  })

  it('sends a visible timeout error and deterministically closes a peer that misses pong', async () => {
    const heartbeat = vi.spyOn(globalThis, 'setInterval')
    const downlinks = new WebSocketDownlinks(sources(idle, idle))
    const host = await serve(downlinks)
    running.push(host.close)
    try {
      const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
      await once(socket, 'open')
      const accepted = await acceptedSocket(downlinks)
      const internals = downlinks as unknown as {
        leases: Map<WebSocket, { awaitingPong: boolean }>
      }
      const lease = internals.leases.get(accepted)
      if (lease === undefined) throw new Error('missing socket heartbeat lease')
      lease.awaitingPong = true
      const heartbeatCall = heartbeat.mock.calls.find(call => (
        call[1] === DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS
      ))
      if (heartbeatCall === undefined || typeof heartbeatCall[0] !== 'function') {
        throw new Error('WebSocket downlink did not register its heartbeat')
      }
      const failure = read(socket)
      const closed = once(socket, 'close')
      heartbeatCall[0]()
      expect((await failure).payload).toEqual({
        type: 'stream/error',
        channel: 'mux',
        error: {
          code: 'EVENT_HEARTBEAT_TIMEOUT',
          message: 'native event peer missed its pong deadline',
          details: { channel: 'mux' },
        },
      })
      const [code] = await closed as [number, Buffer]
      expect(code).toBe(1011)
    } finally {
      heartbeat.mockRestore()
    }
  })

  it('aborts the source when an accepted socket reports a transport error', async () => {
    let aborted = false
    const downlinks = new WebSocketDownlinks(sources(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          aborted = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const closed = once(socket, 'close')
    accepted.emit('error', new Error('transport failed'))
    await closed
    expect(aborted).toBe(true)
  })

  it('drops a source frame that races after the client has closed', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    let sourceSignal: AbortSignal | undefined
    const downlinks = new WebSocketDownlinks(sources(
      async function * (signal) {
        sourceSignal = signal
        try {
          await gate
          yield {
            rpcId: 'late',
            payload: { type: 'session/subscribed', sessionId: 'session-late', lastSeq: 0 },
          }
        } finally {
          finish()
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.close()
    await closed
    await vi.waitFor(() => { expect(sourceSignal?.aborted).toBe(true) })
    release()
    await finished
  })

  it('contains socket send callback failures and closes the downlink', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const downlinks = new WebSocketDownlinks(sources(
      async function * () {
        await gate
        yield {
          rpcId: 'send-failure',
          payload: { type: 'session/subscribed', sessionId: 'session-send', lastSeq: 0 },
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const send = vi.spyOn(accepted, 'send').mockImplementation(((
      _data: unknown,
      optionsOrCallback?: unknown,
      callback?: (error?: Error) => void,
    ) => {
      const done = typeof optionsOrCallback === 'function'
        ? optionsOrCallback as (error?: Error) => void
        : callback
      done?.(new Error('socket send failed'))
    }) as WebSocket['send'])
    const closed = once(socket, 'close')
    release()
    await closed
    expect(send).toHaveBeenCalledTimes(2)
    send.mockRestore()
  })

  it('rejects when its acceptor has already closed', async () => {
    const downlinks = new WebSocketDownlinks(sources(idle, idle))
    await downlinks.close()
    await expect(downlinks.close()).rejects.toThrow('The server is not running')
  })

  it('waits for source cleanup before teardown resolves', async () => {
    let cleanupStarted!: () => void
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    let cleaned = false
    const downlinks = new WebSocketDownlinks(sources(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          cleanupStarted()
          await cleanupGate
          cleaned = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    let closed = false
    const closing = host.close().then(() => { closed = true })
    try {
      await started
      expect(closed).toBe(false)
      releaseCleanup()
      await closing
      expect(cleaned).toBe(true)
    } finally {
      releaseCleanup()
      await closing
    }
  })
})
