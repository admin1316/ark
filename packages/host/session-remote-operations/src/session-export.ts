/**
 * Host-owned Session log download.
 *
 * The download streams each persisted Session artifact verbatim, optionally
 * includes every descendant under `subagents/`, and carries each referenced
 * image once under `media/`. A live Session crosses the authoritative flush
 * barrier immediately before its raw artifact is read. Compression and the
 * response queue are bounded, and request or consumer cancellation terminates
 * the producer rather than yielding a truncated archive.
 *
 * @module @deepseek-ai/dsh-host-session-remote-operations/session-export
 */

import { Zip, ZipDeflate } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionRawArtifact } from '@deepseek-ai/dsh-session-persistence'
import type { SessionLineageNode, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { z } from 'zod'

/** Final Host path for the Native Session archive download. */
export const SESSION_EXPORT_PATH = '/api/session/export'

/** Valid fflate DEFLATE levels accepted by Session export. */
export type SessionLogCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/** Balanced default for Session archive compression. */
export const DEFAULT_SESSION_LOG_COMPRESSION_LEVEL: SessionLogCompressionLevel = 6

/** The services a Session export needs (the live store is optional). */
export interface SessionLogExportDeps {
  readonly sessionQuery: SessionQueryEngine | undefined
  readonly sessionPersistence: SessionPersistence | undefined
  readonly attachments: AttachmentStore | undefined
  readonly sessions: SessionStore | undefined
}

/** Export services narrowed to the mounted owners used by streaming. */
export interface SessionLogExportReady {
  readonly sessionQuery: SessionQueryEngine
  readonly sessionPersistence: SessionPersistence
  readonly attachments: AttachmentStore
  readonly sessions: SessionStore | undefined
}

interface PreparedSessionLogExport {
  readonly ready: SessionLogExportReady
  readonly root: SessionRawArtifact
  readonly sessionId: SessionId
  readonly includeDescendants: boolean
  readonly headers: Headers
}

const sessionLogQuerySchema = z.object({
  sessionId: z.string().min(1).transform(value => SessionId(value)),
  includeDescendants: z.union([z.literal('true'), z.literal('false')]).optional(),
}).transform(query => ({
  sessionId: query.sessionId,
  includeDescendants: query.includeDescendants === 'true',
}))

/**
 * Validate one deployment compression value without silently rounding.
 * @param value - configured level or undefined for the balanced default.
 * @returns the exact accepted compression level.
 */
export function sessionLogCompressionLevel(value?: number): SessionLogCompressionLevel {
  const resolved = value ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 9) {
    throw new Error(`sessionExportCompressionLevel must be an integer from 0 to 9; received ${String(resolved)}`)
  }
  return resolved as SessionLogCompressionLevel
}

/**
 * Resolve the persistence, lineage, attachment, and live-session owners.
 * @param ctx - composed Host context.
 * @returns mounted owners, retaining absence for fail-loud HTTP responses.
 */
export function sessionLogExportDeps(ctx: Context): SessionLogExportDeps {
  return {
    sessionQuery: ctx.get('sessionQuery'),
    sessionPersistence: ctx.get('sessionPersistence'),
    attachments: ctx.get('attachments'),
    sessions: ctx.get('sessions'),
  }
}

/**
 * Flush a live Session immediately before reading its raw durable artifact.
 * @param deps - export owners including the optional live Session store.
 * @param id - Session being read.
 * @param signal - caller cancellation around the durability barrier.
 */
export async function flushLiveSessionLog(
  deps: Pick<SessionLogExportDeps, 'sessions'>,
  id: SessionId,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const sessions = deps.sessions
  if (sessions === undefined) return
  const session = sessions.get(id)
  if (session === undefined) return
  await sessions.flush(session)
  signal?.throwIfAborted()
}

/** One exported artifact or referenced media object. */
export type SessionLogZipEntry =
  | { readonly path: string; readonly content: string }
  | { readonly path: string; readonly data: Uint8Array }

const MEDIA_TYPE_EXTENSIONS: Record<ImageAttachmentRef['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

function mediaEntryPath(ref: ImageAttachmentRef): string {
  return `media/${String(ref.attachmentId)}.${MEDIA_TYPE_EXTENSIONS[ref.mediaType]}`
}

function collectImageRefs(content: unknown, refs: Map<string, ImageAttachmentRef>): void {
  if (!Array.isArray(content)) return
  const pending: unknown[] = Array.from(content as readonly unknown[])
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { type?: unknown; attachment?: unknown; content?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      refs.set(String(ref.attachmentId), ref)
    }
    if (Array.isArray(block.content)) {
      pending.push(...Array.from(block.content as readonly unknown[]))
    }
  }
}

function collectEventImageRefs(event: unknown, refs: Map<string, ImageAttachmentRef>): void {
  const data = (event as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return
  const carrier = data as {
    content?: unknown
    message?: { content?: unknown }
    inserted?: Array<{ content?: unknown }>
    chunk?: { type?: unknown; block?: unknown }
  }
  collectImageRefs(carrier.content, refs)
  if (carrier.message !== undefined) collectImageRefs(carrier.message.content, refs)
  if (carrier.inserted !== undefined) {
    for (const message of carrier.inserted) collectImageRefs(message.content, refs)
  }
  if (carrier.chunk?.type === 'block-end') collectImageRefs([carrier.chunk.block], refs)
}

function imageRefsInArtifact(content: string): Map<string, ImageAttachmentRef> {
  const refs = new Map<string, ImageAttachmentRef>()
  for (const line of content.split('\n')) {
    if (line === '') continue
    try {
      collectEventImageRefs(JSON.parse(line), refs)
    } catch {
      // An unparsable line cannot name trusted media, but is still exported verbatim.
    }
  }
  return refs
}

function safeSessionIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * Build the archive filename for one root Session.
 * @param sessionId - root Session identity.
 * @returns path-safe attachment filename.
 */
export function sessionLogZipFilename(sessionId: string): string {
  return `dsh-session-${safeSessionIdSegment(sessionId)}.zip`
}

/**
 * Yield root, descendants, then distinct referenced media in archive order.
 * @param deps - mounted export owners.
 * @param root - already-prepared root artifact.
 * @param sessionId - root Session identity.
 * @param includeDescendants - whether lineage descendants are included.
 * @param signal - read and lineage cancellation.
 * @returns entries in deterministic archive order.
 */
export async function* sessionLogZipEntries(
  deps: SessionLogExportReady,
  root: SessionRawArtifact,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal?: AbortSignal,
): AsyncGenerator<SessionLogZipEntry> {
  const media = new Map<string, ImageAttachmentRef>()
  const rememberMedia = (content: string): void => {
    for (const [id, ref] of imageRefsInArtifact(content)) media.set(id, ref)
  }
  rememberMedia(root.content)
  yield { path: root.filename, content: root.content }
  if (includeDescendants) {
    const seen = new Set<SessionId>([sessionId])
    const collect = async function* (
      nodes: readonly SessionLineageNode[],
    ): AsyncGenerator<SessionLogZipEntry> {
      for (const node of nodes) {
        signal?.throwIfAborted()
        const id = node.session.header.id
        if (seen.has(id)) continue
        seen.add(id)
        await flushLiveSessionLog(deps, id, signal)
        const raw = await deps.sessionPersistence.readRaw(id, signal)
        signal?.throwIfAborted()
        if (raw === undefined) throw new Error(`subagent "${id}" has no stored log artifact`)
        rememberMedia(raw.content)
        yield {
          path: `subagents/${safeSessionIdSegment(id)}/${raw.filename}`,
          content: raw.content,
        }
        yield* collect(node.descendants)
      }
    }
    const lineage = await deps.sessionQuery.traceSession(sessionId, signal)
    signal?.throwIfAborted()
    yield* collect(lineage.descendants)
  }
  for (const ref of media.values()) {
    signal?.throwIfAborted()
    const stored = await deps.attachments.readImage(ref, signal)
    signal?.throwIfAborted()
    yield { path: mediaEntryPath(ref), data: stored.data }
  }
}

const PUSH_CHUNK_CODE_UNITS = 1 << 16
const PUSH_CHUNK_BYTES = 1 << 16
const RESPONSE_HIGH_WATER_MARK_BYTES = 1 << 16

class ResponseCapacityGate {
  private releasePending: (() => void) | undefined

  async wait(
    controller: ReadableStreamDefaultController<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    if (controller.desiredSize === null || controller.desiredSize > 0) return
    await new Promise<void>((resolve) => {
      const release = (): void => {
        this.releasePending = undefined
        signal.removeEventListener('abort', release)
        resolve()
      }
      this.releasePending = release
      signal.addEventListener('abort', release, { once: true })
    })
    signal.throwIfAborted()
  }

  pulled(): void {
    this.releasePending?.()
  }
}

async function pushBinaryChunks(
  deflate: ZipDeflate,
  data: Uint8Array,
  controller: ReadableStreamDefaultController<Uint8Array>,
  capacity: ResponseCapacityGate,
  signal: AbortSignal,
): Promise<void> {
  let offset = 0
  do {
    signal.throwIfAborted()
    const end = Math.min(offset + PUSH_CHUNK_BYTES, data.byteLength)
    const finalChunk = end >= data.byteLength
    deflate.push(data.subarray(offset, end), finalChunk)
    offset = end
    await capacity.wait(controller, signal)
  } while (offset < data.byteLength)
}

async function pushArtifactChunks(
  deflate: ZipDeflate,
  content: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  capacity: ResponseCapacityGate,
  signal: AbortSignal,
): Promise<void> {
  const encoder = new TextEncoder()
  let offset = 0
  let finalChunk: boolean
  do {
    signal.throwIfAborted()
    let end = Math.min(offset + PUSH_CHUNK_CODE_UNITS, content.length)
    if (end < content.length && end - offset > 1) {
      const last = content.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end -= 1
    }
    finalChunk = end >= content.length
    deflate.push(encoder.encode(content.slice(offset, end)), finalChunk)
    offset = end
    await capacity.wait(controller, signal)
  } while (!finalChunk)
}

/**
 * Stream one prepared Session ZIP with byte-capacity backpressure.
 * @param deps - mounted export owners.
 * @param root - prepared root artifact.
 * @param sessionId - root Session identity.
 * @param includeDescendants - whether lineage descendants are included.
 * @param compressionLevel - validated DEFLATE level.
 * @param signal - request cancellation combined with consumer cancellation.
 * @returns pull-aware archive byte stream.
 */
export function streamSessionLogZip(
  deps: SessionLogExportReady,
  root: SessionRawArtifact,
  sessionId: SessionId,
  includeDescendants: boolean,
  compressionLevel: SessionLogCompressionLevel,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const producerAbort = new AbortController()
  const producerSignal = AbortSignal.any([signal, producerAbort.signal])
  let zip: Zip | undefined
  let zipTerminated = false
  let zipTerminationFailed = false
  let zipTerminationFailure: unknown
  let producer!: Promise<void>
  const capacity = new ResponseCapacityGate()
  type ZipOutcome = { readonly kind: 'completed' } | { readonly kind: 'failed' | 'cancelled'; readonly error: Error }
  let settleZip!: (outcome: ZipOutcome) => void
  let terminal: ZipOutcome | undefined
  const zipOutcome = new Promise<ZipOutcome>((resolve) => { settleZip = resolve })
  const settleZipOnce = (outcome: ZipOutcome): boolean => {
    if (terminal !== undefined) return false
    terminal = outcome
    settleZip(outcome)
    return true
  }
  const terminateZip = (): void => {
    if (zip === undefined || zipTerminated) return
    zipTerminated = true
    try {
      zip.terminate()
    } catch (error: unknown) {
      zipTerminationFailed = true
      zipTerminationFailure = error
    }
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (error: unknown): void => {
        const normalized = sessionExportError(producerSignal.aborted ? producerSignal.reason : error)
        if (!settleZipOnce({ kind: 'failed', error: normalized })) return
        controller.error(normalized)
        producerAbort.abort(normalized)
      }
      const archive = new Zip((error, data, final) => {
        if (terminal !== undefined) return
        if (error) {
          fail(error)
          return
        }
        if (producerSignal.aborted) {
          fail(producerSignal.reason)
          return
        }
        try {
          if (data.byteLength > 0) controller.enqueue(data)
          if (final) {
            zipTerminated = true
            controller.close()
            settleZipOnce({ kind: 'completed' })
          }
        } catch (callbackError: unknown) {
          fail(callbackError)
        }
      })
      zip = archive
      producer = (async (): Promise<void> => {
        try {
          for await (const entry of sessionLogZipEntries(deps, root, sessionId, includeDescendants, producerSignal)) {
            producerSignal.throwIfAborted()
            const deflate = new ZipDeflate(entry.path, { level: compressionLevel })
            archive.add(deflate)
            // fflate may report failure and continue its current add() stack.
            // Unwind here before pushing bytes; termination stays outside that callback.
            producerSignal.throwIfAborted()
            if ('content' in entry) {
              await pushArtifactChunks(deflate, entry.content, controller, capacity, producerSignal)
            } else {
              await pushBinaryChunks(deflate, entry.data, controller, capacity, producerSignal)
            }
          }
          producerSignal.throwIfAborted()
          archive.end()
          const outcome = await zipOutcome
          if (outcome.kind !== 'completed') throw outcome.error
        } catch (error: unknown) {
          const normalized = sessionExportError(error)
          if (terminal?.kind !== 'cancelled') fail(normalized)
          terminateZip()
          if (terminal?.kind === 'cancelled') {
            const abortReason: unknown = producerSignal.reason
            if (error === abortReason) return
            throw normalized
          }
        }
      })()
    },
    pull() {
      capacity.pulled()
    },
    async cancel(reason) {
      const cancellation = reason instanceof Error
        ? reason
        : new Error('session log export stream cancelled')
      settleZipOnce({ kind: 'cancelled', error: cancellation })
      producerAbort.abort(cancellation)
      terminateZip()
      await producer
      if (zipTerminationFailed) throw zipTerminationFailure
    },
  }, {
    highWaterMark: RESPONSE_HIGH_WATER_MARK_BYTES,
    size: chunk => chunk.byteLength,
  })
}

function sessionExportError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function prepareSessionLogExport(
  ctx: Context,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal: AbortSignal,
): Promise<PreparedSessionLogExport | Response> {
  const deps = sessionLogExportDeps(ctx)
  if (deps.sessionQuery === undefined || deps.sessionPersistence === undefined || deps.attachments === undefined) {
    return new Response(
      'session log export is unavailable: missing session-query, session-persistence, or attachments service',
      { status: 500 },
    )
  }
  if (!deps.sessionPersistence.supportsRawArtifacts) {
    return new Response(
      'session log export is unavailable: the persistence backend does not expose per-session raw artifacts',
      { status: 501 },
    )
  }
  const ready: SessionLogExportReady = {
    sessionQuery: deps.sessionQuery,
    sessionPersistence: deps.sessionPersistence,
    attachments: deps.attachments,
    sessions: deps.sessions,
  }
  let root: SessionRawArtifact | undefined
  try {
    await flushLiveSessionLog(deps, sessionId, signal)
    root = await deps.sessionPersistence.readRaw(sessionId, signal)
    signal.throwIfAborted()
  } catch {
    signal.throwIfAborted()
    return new Response('session log export failed to prepare the stored artifact', { status: 500 })
  }
  if (root === undefined) return new Response('session not found', { status: 404 })
  return {
    ready,
    root,
    sessionId,
    includeDescendants,
    headers: new Headers({
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${sessionLogZipFilename(sessionId)}"`,
    }),
  }
}

/**
 * Handle the final GET/HEAD Session export endpoint.
 * @param ctx - composed Host context.
 * @param request - trusted request already admitted by Host Connection.
 * @param compressionLevel - validated deployment compression level.
 * @returns bodyless HEAD preflight, streaming GET, or fail-loud status.
 */
export async function fetchSessionLogExport(
  ctx: Context,
  request: Request,
  compressionLevel: SessionLogCompressionLevel,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== SESSION_EXPORT_PATH || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return new Response('not found', { status: 404 })
  }
  const parsed = sessionLogQuerySchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) {
    return new Response('missing or invalid sessionId query parameter', { status: 400 })
  }
  const prepared = await prepareSessionLogExport(
    ctx,
    parsed.data.sessionId,
    parsed.data.includeDescendants,
    request.signal,
  )
  if (prepared instanceof Response) {
    return request.method === 'HEAD'
      ? new Response(null, { status: prepared.status, headers: prepared.headers })
      : prepared
  }
  if (request.method === 'HEAD') {
    return new Response(null, { headers: prepared.headers })
  }
  return new Response(
    streamSessionLogZip(
      prepared.ready,
      prepared.root,
      prepared.sessionId,
      prepared.includeDescendants,
      compressionLevel,
      request.signal,
    ),
    { headers: prepared.headers },
  )
}
