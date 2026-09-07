import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { bridge } from '../src/http-bridge.ts'

describe('HTTP bridge abort', () => {
  it('destroys a declared-oversize request instead of draining it', async () => {
    const destroyed: true[] = []
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/session.prompt',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
      destroy: () => { destroyed.push(true) },
    })
    let status: number | undefined
    let headers: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      fetch: () => { throw new Error('a rejected request must never reach the handler') },
    }, 1000)
    // The socket must not stay parked draining a body the client can trickle
    // at will after the rejection — same discipline as the chunked overrun.
    expect(status).toBe(413)
    expect(headers).toMatchObject({ connection: 'close' })
    expect(destroyed).toHaveLength(1)
  })

  it('aborts a pending native picker request when the browser disconnects', async () => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'picker-1', method: 'host.pickDirectory', payload: {},
    })
    const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/host.pickDirectory',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead() { return this },
      write() { return true },
      end() { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })
    let carrierSignal: AbortSignal | undefined
    const pending = bridge(request, response, {
      fetch: async (input) => {
        const fetchRequest = input
        carrierSignal = fetchRequest.signal
        resolveStarted()
        if (!fetchRequest.signal.aborted) {
          await new Promise<void>((resolve) => {
            fetchRequest.signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        return Response.json({ aborted: fetchRequest.signal.aborted })
      },
    }, Number.MAX_SAFE_INTEGER)
    await started
    response.emit('close')
    await pending
    expect(carrierSignal?.aborted).toBe(true)
  })

  it('bounds chunked bodies and completes empty responses', async () => {
    const destroyed: true[] = []
    const oversized = Readable.from([Buffer.from('abc')]) as unknown as IncomingMessage
    Object.assign(oversized, {
      url: '/api/session.prompt',
      method: 'POST',
      headers: {},
      destroy: () => { destroyed.push(true) },
    })
    const rejected = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead() { return this },
      write() { return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse
    await bridge(oversized, rejected, { fetch: async () => new Response('must not run') }, 2)
    expect(destroyed.length).toBeGreaterThan(0)

    const empty = Readable.from([]) as unknown as IncomingMessage
    Object.assign(empty, { url: '/api/session.list', method: 'GET', headers: {} })
    let ended = false
    const noBody = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead() { return this },
      write() { throw new Error('empty body must not write') },
      end(this: { writableEnded: boolean }) { ended = true; this.writableEnded = true; return this },
    }) as unknown as ServerResponse
    await bridge(empty, noBody, { fetch: async () => new Response(null, { status: 204 }) })
    expect(ended).toBe(true)
    noBody.emit('close')
  })

  it('waits for drain or close when streaming output applies backpressure', async () => {
    const makeRequest = (): IncomingMessage => {
      const request = Readable.from([]) as unknown as IncomingMessage
      Object.assign(request, { url: '/api/session.list', method: 'GET', headers: {} })
      return request
    }
    for (const event of ['drain', 'close'] as const) {
      let wrote!: () => void
      const writeStarted = new Promise<void>((resolve) => { wrote = resolve })
      let ended = false
      const response = Object.assign(new EventEmitter(), {
        writableEnded: false,
        writeHead() { return this },
        write() { wrote(); return false },
        end(this: { writableEnded: boolean }) { ended = true; this.writableEnded = true; return this },
      }) as unknown as ServerResponse
      const pending = bridge(makeRequest(), response, { fetch: async () => new Response('streamed') })
      await writeStarted
      response.emit(event)
      await pending
      expect(ended).toBe(true)
    }
  })
})
