/** Synthetic ingest peer exercising the retained Worker protocol; not a browser Runtime implementation. */

import { randomUUID } from 'node:crypto'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import WebSocket, { type RawData } from 'ws'
import { InspectorSourceBuffer } from '../../src/shared/bridge/buffer.ts'
import { InspectorQueryConnection } from '../../src/shared/bridge/rpc.ts'
import { InspectorSourceConnection } from '../../src/shared/bridge/publisher.ts'
import { publishCordisTree } from '../../src/shared/cordis/publisher.ts'
import { createInspectorService } from '../../src/shared/service.ts'
import { inspectorId } from '../../src/shared/bridge/ids.ts'
import { parseWorkerSourceFrame, type InspectorSourceDescriptor, type SourceToWorkerFrame, type WorkerToSourceFrame } from '../../src/shared/bridge/messages/observation.ts'
import type { InspectorClientBootstrap } from '../../src/shared/bridge/messages/control.ts'
import type { ClientRuntimeRequestFrame, ClientRuntimeResult } from '../../src/shared/bridge/messages/runtime/index.ts'
import type { ClientSourceResult } from '../../src/shared/bridge/messages/sources/index.ts'

interface SourceCatalog {
  readonly sourceText: string
  readonly sourceMap: string
  readonly sourceUrl: string
  readonly sourceMapUrl: string
}

/** One test-owned source; Runtime results are supplied explicitly by each test. */
export class InspectorProtocolFixture extends InspectorSourceConnection {
  readonly frames: WorkerToSourceFrame[] = []
  runtimeResult: ((frame: ClientRuntimeRequestFrame) => ClientRuntimeResult | undefined) | undefined
  private socket: WebSocket | undefined
  private readonly context = new Context()
  private child?: Fiber
  private added: Fiber | undefined
  private disposeTree: (() => void) | undefined
  private readonly sourceBytes: { source: Buffer; map: Buffer } | undefined
  private readonly records: InspectorSourceBuffer
  protected readonly queries: InspectorQueryConnection
  private source: InspectorSourceDescriptor
  protected readonly publisher

  private constructor(private readonly bootstrap: InspectorClientBootstrap, label: string, private readonly catalog?: SourceCatalog) {
    super()
    this.source = {
      sourceId: inspectorId<'InspectorSourceId'>(`protocol-${randomUUID()}`, 'sourceId'),
      generation: inspectorId<'InspectorSourceGeneration'>(randomUUID(), 'generation'),
      kind: 'client', label, timeOriginMs: performance.timeOrigin,
      capabilities: [{ type: 'client-runtime', origin: 'http://protocol.test' }, { type: 'client-console' },
        ...catalog === undefined ? [] : [{ type: 'client-sources' as const }]],
    }
    this.sourceBytes = catalog === undefined ? undefined
      : { source: Buffer.from(catalog.sourceText), map: Buffer.from(catalog.sourceMap) }
    this.records = new InspectorSourceBuffer({ ...bootstrap, topics: ['cordis/tree', 'client/probe'] })
    this.queries = new InspectorQueryConnection({ timeoutMs: bootstrap.queryTimeoutMs, maxFrameBytes: bootstrap.maxFrameBytes })
    this.publisher = {
      publish: (...args: Parameters<InspectorSourceBuffer['publish']>) => { this.records.publish(...args); this.flush() },
      setState: (...args: Parameters<InspectorSourceBuffer['setState']>) => { this.records.setState(...args); this.flush() },
    }
  }

  static async start(
    bootstrap: InspectorClientBootstrap,
    options: { label?: string; sourceCatalog?: SourceCatalog } = {},
  ): Promise<InspectorProtocolFixture> {
    const fixture = new InspectorProtocolFixture(bootstrap, options.label ?? 'Protocol source', options.sourceCatalog)
    try {
      fixture.child = fixture.context.plugin({ name: 'protocol-child', apply() {} }).ctx.fiber
      await fixture.child.await()
      await fixture.connect()
      fixture.disposeTree = publishCordisTree(fixture.context, fixture, {
        maxNodes: bootstrap.maxCordisNodes, maxBytes: bootstrap.maxFrameBytes - 4_096,
      })
      return fixture
    } catch (error) {
      await fixture.close()
      throw error
    }
  }

  /** Send an explicit typed peer response or event to the real Worker. */
  send(frame: SourceToWorkerFrame): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Protocol fixture is disconnected')
    this.socket.send(JSON.stringify(frame))
  }

  /** Current source generation for constructing explicit protocol events. */
  get identity(): Pick<InspectorSourceDescriptor, 'sourceId' | 'generation'> {
    return { sourceId: this.source.sourceId, generation: this.source.generation }
  }

  getCordisTree() { return createInspectorService(this).cordis.getTree() }

  refreshTree(): Promise<void> {
    this.context.emit('internal/status', this.context.fiber, this.context.fiber.state)
    return Promise.resolve()
  }

  async addFiber(): Promise<number> {
    this.added = this.context.plugin({ name: 'dynamic-protocol-child', apply() {} }).ctx.fiber
    await this.added.await()
    const uid = this.added.uid
    if (uid === null) throw new Error('Protocol fixture Fiber has no assigned UID')
    return uid
  }

  async removeFiber(): Promise<void> { await this.added?.dispose(); this.added = undefined }

  /** Deterministically reconnect the same logical source with a fresh transport generation. */
  async disconnect(): Promise<void> {
    await this.disconnectSocket()
    this.source = { ...this.source, generation: inspectorId<'InspectorSourceGeneration'>(randomUUID(), 'generation') }
    await this.connect()
  }

  async close(): Promise<void> {
    this.disposeTree?.()
    this.disposeTree = undefined
    this.queries.close('Protocol fixture closed')
    await this.disconnectSocket()
    await this.context.fiber.dispose()
  }

  private async disconnectSocket(): Promise<void> {
    const socket = this.socket
    this.socket = undefined
    this.queries.disconnect('Protocol fixture disconnected')
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) return
    const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
    socket.terminate()
    await closed
  }

  private async connect(): Promise<void> {
    const socket = new WebSocket(this.bootstrap.endpoint, this.bootstrap.protocol)
    this.socket = socket
    const accepted = Promise.withResolvers<undefined>()
    const timer = setTimeout(() => { accepted.reject(new Error('Protocol fixture admission timed out')) }, this.bootstrap.queryTimeoutMs)
    socket.once('error', accepted.reject)
    socket.on('message', (data) => {
      try {
        const value: unknown = JSON.parse(rawText(data))
        if (this.queries.receive(value)) return
        const frame = parseWorkerSourceFrame(value)
        if (this.frames.length >= this.bootstrap.maxQueuedRecords) throw new Error('Protocol fixture frame budget exceeded')
        this.frames.push(frame)
        if (frame.t === 'source/accepted') {
          this.queries.connect(this.source.sourceId, this.source.generation, { send: (value) => { socket.send(JSON.stringify(value)) } })
          this.send(this.records.replacement(this.source.sourceId, this.source.generation))
          this.flush()
          accepted.resolve(undefined)
        } else if (frame.t === 'source/rejected') {
          accepted.reject(new Error(frame.message))
        } else if (frame.t === 'source/resnapshot') {
          this.send(this.records.replacement(this.source.sourceId, this.source.generation))
        } else if (frame.t === 'client-runtime/request') {
          const result = this.runtimeResult?.(frame)
          if (result !== undefined) this.send({ v: 0, t: 'client-runtime/response', ...this.identity, sessionId: frame.sessionId,
            requestId: frame.requestId, outcome: { ok: true, result } })
        } else if (frame.t === 'client-sources/request' && this.catalog !== undefined) {
          const command = frame.command
          const key = inspectorId<'RuntimeScriptKey'>('fixture-script', 'scriptKey')
          let result: ClientSourceResult
          if (command.op === 'list-scripts') {
            result = { op: 'list-scripts', scripts: [{ scriptKey: key, url: this.catalog.sourceUrl, hash: 'test',
              sourceMapUrl: this.catalog.sourceMapUrl, isModule: false, length: this.catalog.sourceText.length,
              startLine: 0, startColumn: 0, endLine: this.catalog.sourceText.split('\n').length - 1, endColumn: 0 }] }
          } else {
            const content = command.content === 'source' ? this.sourceBytes!.source : this.sourceBytes!.map
            const data = content.subarray(command.offset, command.offset + Math.min(command.maxBytes, 1_024))
            result = { op: 'get-content-chunk', scriptKey: command.scriptKey, content: command.content,
              offset: command.offset, available: true, data: data.toString('base64'),
              nextOffset: command.offset + data.length, eof: command.offset + data.length === content.length }
          }
          this.send({ v: 0, t: 'client-sources/response', ...this.identity, sessionId: frame.sessionId,
            requestId: frame.requestId, outcome: { ok: true, result } })
        }
      } catch (error) { accepted.reject(error); socket.terminate() }
    })
    socket.once('open', () => { this.send({ v: 0, t: 'source/open', source: this.source, topics: ['cordis/tree', 'client/probe'] }) })
    try { await accepted.promise } finally { clearTimeout(timer) }
  }

  private flush(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    while (this.records.hasPending) {
      const frame = this.records.takeBatch(this.source.sourceId, this.source.generation)
      if (frame !== undefined) this.send(frame)
    }
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}
