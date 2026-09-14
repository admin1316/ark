/**
 * Host ownership for generated Session Remote operations and archived
 * Workspace-session retirement.
 *
 * The package reads each domain's live owner directly. It deliberately owns
 * no durable transcript, workspace, attachment, or model-catalog copy.
 * Its bounded semantic reader retains numeric history indices and explicitly
 * released content materializations over the existing Session query owner.
 * Other maps serialize identity creation/resume, retain exact AgentHandle
 * capabilities, and hold the session-local selection consumed by prompt assembly.
 *
 * @module @deepseek-ai/dsh-host-session-remote-operations
 */

import { Buffer } from 'node:buffer'
import { installPromptReceipts, promptDigest, type PromptReceipt } from './prompt-receipts.ts'
import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-subagent'
import {
  type Agent,
  type AgentHandle,
  type AgentOptions,
  type AgentSetup,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { sessionModelSelection, type SessionModelSelection } from '@deepseek-ai/dsh-agent-default-model/session-selection'
import {
  PresetMountError,
  UnknownPresetError,
  resolveSessionPreset,
  type PresetBearingSession,
} from '@deepseek-ai/dsh-agent-presets'
import {
  ApiRemoteSessionNotFound,
  ApiRemoteSubagentSessionOwnership,
  apiRemoteSubagentOwnershipError,
  hasApiRemoteSubagentOwner,
} from '@deepseek-ai/dsh-api-remotes/agent-lookup'
import {
  AttachmentError,
  admitEncodedImages,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-commands'
import {
  createUserMessage,
  freezeMessage,
  type ContentBlock,
  type MessageSource,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-jobs'
import {
  findToolCallArguments,
  SessionId,
  isAppendSurfaceEvent,
  snapshotJsonValue,
  type JsonValue,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionRemoteAcceptedValue,
  type SessionRemoteAttachmentRequest,
  type SessionRemoteAttachmentValue,
  type SessionRemoteCancelRequest,
  type SessionRemoteCatalogFailure,
  type SessionRemoteCreateRequest,
  type SessionRemoteCreateValue,
  type SessionRemoteEvent,
  type SessionRemoteFailure,
  type SessionRemoteForkRequest,
  type SessionRemoteForkValue,
  type SessionRemoteHistoryEntry,
  type SessionRemoteHistoryRequest,
  type SessionRemoteHistoryValue,
  type SessionRemoteRawHistoryRequest,
  type SessionRemoteRawHistoryValue,
  type SessionRemoteListRequest,
  type SessionRemoteListValue,
  type SessionRemoteModels,
  type SessionRemoteModelsRequest,
  type SessionRemoteOperations,
  type SessionRemotePromptContentPart,
  type SessionPromptInvocationId,
  type SessionRemotePromptRequest,
  type SessionRemotePromptValue,
  type SessionRemoteProjections,
  type SessionRemoteProviderGroup,
  type SessionRemoteRenameRequest,
  type SessionRemoteRenameValue,
  type SessionRemoteResult,
  type SessionRemoteSearchItem,
  type SessionRemoteSearchRequest,
  type SessionRemoteSearchValue,
  type SessionRemoteSelectModelRequest,
  type SessionRemoteSelectModelValue,
  type SessionRemoteSummary,
  type SessionRemoteUpdateQueueRequest,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-host-connection'
import { SessionQueryError, type SessionSearchCursor } from '@deepseek-ai/dsh-session-query'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
import { isSkillName, isUserInvocable } from '@deepseek-ai/dsh-skill'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-tools'
import {
  WorkspaceId as brandWorkspaceId,
  WorkspaceSessionDeletionBlockedError,
  type Workspace,
  type WorkspaceSessionRetirer,
} from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import { SemanticHistoryReader, SemanticHistoryError, type SemanticHistoryLimits } from './semantic-history.ts'
import {
  fetchSessionLogExport,
  sessionLogCompressionLevel,
  SESSION_EXPORT_PATH,
  type SessionLogCompressionLevel,
} from './session-export.ts'

export {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  fetchSessionLogExport,
  flushLiveSessionLog,
  SESSION_EXPORT_PATH,
  sessionLogCompressionLevel,
  sessionLogZipEntries,
  sessionLogZipFilename,
  streamSessionLogZip,
} from './session-export.ts'
export type {
  SessionLogCompressionLevel,
  SessionLogExportDeps,
  SessionLogExportReady,
  SessionLogZipEntry,
} from './session-export.ts'

/** Persisted hint shared by Session listing and the projection cache. */
export interface SessionListMetadata {
  readonly blank: boolean
  readonly lastPromptAt: number | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    sessionListMetadata: SessionListMetadata
    imageLimits: null
  }
  interface SessionProjectionMap {
    sessionListMetadata: SessionListMetadata
    imageLimits: ImageAttachmentLimits
  }
}


/** Composition options owned by the Host, not by the generated wire contract. */
export interface Config {
  /** Project directory used when Session creation names neither workspace nor cwd. */
  readonly cwd?: string
  /** Maximum physical cold artifact bytes eligible for a list projection read; 0 disables it. */
  readonly coldBlankProbeMaxBytes?: number
  /** DEFLATE level for each Session archive entry; defaults to 6. */
  readonly sessionExportCompressionLevel?: SessionLogCompressionLevel
  /** Bounded semantic read reuse; eviction never invalidates a fixed-cut cursor. */
  readonly semanticHistory?: SemanticHistoryLimits
}

const DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024
const COLD_SUMMARY_BATCH_SIZE = 16
const DEFAULT_MAX_MESSAGES = 50
const MAX_HISTORY_MESSAGES = 2_048
const MAX_HISTORY_PAGE_EVENTS = 2_048
const MAX_HISTORY_PAGE_ENCODED_BYTES = 1_048_576
const SESSION_SEARCH_RESULT_LIMIT = 20
const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240
const SESSION_SEARCH_PROVIDER_CALL_LIMIT = 100
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

const sessionListMetadataSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

const imageLimitsSchema: z.ZodType<ImageAttachmentLimits> = z.object({
  maxImageBytes: z.number().int().positive(),
  maxImagesPerMessage: z.number().int().positive(),
  maxMessageImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  maxImageDimension: z.number().int().positive(),
  mediaTypes: z.array(z.union([
    z.literal('image/png'),
    z.literal('image/jpeg'),
    z.literal('image/webp'),
    z.literal('image/gif'),
  ])),
})

/** Requested identity already belongs to another project directory. */
class SessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      `session "${sessionId}" already exists with cwd ${JSON.stringify(existingCwd)}; `
      + `requested ${JSON.stringify(requestedCwd)}`,
    )
  }
}

/** Requested preset differs from the composition whose tools produced the log. */
class SessionPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
    readonly existingPreset: string | undefined,
  ) {
    super(
      existingPreset === undefined
        ? `session "${sessionId}" records no agent preset; requested ${JSON.stringify(requestedPreset)}`
        : `session "${sessionId}" runs ${JSON.stringify(existingPreset)}; requested ${JSON.stringify(requestedPreset)}`,
    )
  }
}

type SessionReadState = {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

type HistorySource =
  | { readonly kind: 'attached'; readonly session: Session }
  | { readonly kind: 'detached'; readonly header: SessionHeader; readonly events: readonly SessionEvent[] }


/** Build one successful generated-port result. */
function success<Value>(value: Value): SessionRemoteResult<Value> {
  return { ok: true, value }
}

/** Preserve the Promise-shaped Host port for one synchronous mutation. */
function settled<Value>(result: SessionRemoteResult<Value>): Promise<SessionRemoteResult<Value>> {
  return Promise.resolve(result)
}

/** Build one stable generated-port business failure. */
function failure(
  code: string,
  message: string,
  details: JsonValue = {},
): SessionRemoteFailure {
  return { ok: false, error: { code, message, details } }
}

/** Generated-port cancellation spelling. */
function cancelled(message = 'session Remote invocation was cancelled'): SessionRemoteFailure {
  return failure('cancelled', message)
}

/** Return a lossless detached projection value or omit an invalid optional view. */
function jsonValue(value: unknown): JsonValue | undefined {
  return snapshotJsonValue(value) as JsonValue | undefined
}

/** Read live abort state across awaits. */
function aborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Code-point-safe result snippet bound. */
function truncateUnicodeCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count += 1
    end += codePoint.length
  }
  return value
}

/** Session-header fields shared by attached and cold listing rows. */
function summaryFields(
  header: SessionHeader,
  projections?: SessionRemoteProjections,
): Pick<SessionRemoteSummary, 'parentSessionId' | 'origin' | 'cwd' | 'agentPreset'> {
  const preset = projections?.values.agentPreset
  return {
    ...header.parentSession === undefined ? {} : { parentSessionId: header.parentSession },
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...typeof preset !== 'string' ? {} : { agentPreset: preset },
  }
}

/** Convert a projection snapshot without leaking mutable registry state. */
function remoteProjections(value: unknown): SessionRemoteProjections | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const candidate = value as { asOfSeq?: unknown; values?: unknown }
  const asOfSeq = candidate.asOfSeq
  if (typeof asOfSeq !== 'number' || !Number.isSafeInteger(asOfSeq) || candidate.values === null
    || typeof candidate.values !== 'object' || Array.isArray(candidate.values)) return undefined
  const values = jsonValue(candidate.values)
  if (values === undefined || Array.isArray(values) || values === null || typeof values !== 'object') return undefined
  return {
    asOfSeq,
    values,
  }
}

/** Convert one validated durable event to the generated Remote envelope. */
function remoteEvent(event: SessionEvent): SessionRemoteEvent {
  const envelope = event as SessionEvent & {
    readonly sourceEventSeqs?: readonly number[]
    readonly surfaceOp?: unknown
  }
  const data = jsonValue(event.data)
  if (data === undefined) throw new Error(`session event ${event.type} has no lossless JSON payload`)
  const surfaceOp = envelope.surfaceOp === undefined ? undefined : jsonValue(envelope.surfaceOp)
  if (envelope.surfaceOp !== undefined && surfaceOp === undefined) {
    throw new Error(`session event ${event.type} has no lossless surface operation`)
  }
  return {
    type: event.type,
    seq: event.seq,
    time: event.time,
    data,
    ...envelope.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: [...envelope.sourceEventSeqs] },
    ...surfaceOp === undefined ? {} : { surfaceOp },
    ...event.ignorable === true ? { ignorable: true as const } : {},
  }
}

interface HistoryEventWindow {
  readonly events: readonly SessionEvent[]
  readonly hasMore: boolean
}

interface HistoryEntryWindow {
  readonly events: readonly SessionEvent[]
  readonly entries: readonly SessionRemoteHistoryEntry[]
  readonly hasMore: boolean
}

/** Find the exclusive array end for one sequence cursor without copying the log. */
function historyEndIndex(events: readonly SessionEvent[], beforeSeq: number | undefined): number {
  if (beforeSeq === undefined) return events.length
  let lower = 0
  let upper = events.length
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2)
    if ((events[middle] as SessionEvent).seq < beforeSeq) lower = middle + 1
    else upper = middle
  }
  return lower
}

/**
 * Select one newest-first bounded event window. Message count is a secondary
 * readability boundary; the hard event bound always wins.
 */
function historyEventWindow(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
  maxEvents: number,
): HistoryEventWindow {
  const end = historyEndIndex(events, beforeSeq)
  let start = end
  let count = 0
  let groupStart: number | undefined
  while (start > 0 && end - start < maxEvents) {
    start -= 1
    const event = events[start] as SessionEvent
    if (groupStart !== undefined) {
      if (event.seq <= groupStart) break
      continue
    }
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count += 1
    if (count < maxMessages) continue
    groupStart = event.seq
    for (const source of event.sourceEventSeqs ?? []) {
      groupStart = Math.min(groupStart, source)
    }
    if (event.seq <= groupStart) break
  }
  const page = events.slice(start, end)
  return {
    events: page,
    hasMore: start > 0,
  }
}

/** UTF-8 bytes occupied by one encoded history entry in the response array. */
function historyEntryBytes(entry: SessionRemoteHistoryEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8')
}

/**
 * Apply the hard encoded-byte bound after presentation metadata is attached.
 * If the newest single entry itself exceeds the bound, return that one entry
 * so the monotonic cursor still advances instead of livelocking.
 */
function historyEntryWindow(
  source: HistoryEventWindow,
  project: (event: SessionEvent, page: readonly SessionEvent[]) => SessionRemoteHistoryEntry,
  maximumEncodedBytes: number,
): HistoryEntryWindow {
  if (source.events.length === 0) {
    return { events: [], entries: [], hasMore: false }
  }
  let start = source.events.length
  let encodedBytes = 2 // JSON array brackets.
  while (start > 0) {
    const entry = project(source.events[start - 1] as SessionEvent, source.events)
    const entryBytes = historyEntryBytes(entry)
    const separatorBytes = start === source.events.length ? 0 : 1
    if (encodedBytes + separatorBytes + entryBytes > maximumEncodedBytes) {
      if (start === source.events.length) {
        start -= 1
        encodedBytes += entryBytes
      }
      break
    }
    start -= 1
    encodedBytes += separatorBytes + entryBytes
  }
  const events = source.events.slice(start)
  // Re-project the retained suffix so a tool result cannot retain presentation
  // metadata derived from a call that the byte boundary removed.
  const entries = events.map(event => project(event, events))
  const finalEncodedBytes = Buffer.byteLength(JSON.stringify(entries), 'utf8')
  if (entries.length > 1 && finalEncodedBytes > maximumEncodedBytes) {
    throw new Error('history presentation metadata exceeded the encoded page budget')
  }
  const hasMore = source.hasMore || start > 0
  return {
    events,
    entries,
    hasMore,
  }
}

/** Project one tool event through the owning Tool definition, fail-soft. */
function eventView(
  ctx: Context,
  event: SessionEvent,
  page: readonly SessionEvent[],
  scope?: ScopeKey,
): JsonValue | undefined {
  const tools = ctx.get('tools')
  if (tools === undefined) return undefined
  try {
    if (event.type === 'tool/call') {
      const data = event.data
      const view = tools.get(data.name, scope)?.presentCall?.(JSON.parse(data.arguments))
      return view === undefined ? undefined : jsonValue({ for: 'call', view })
    }
    if (event.type === 'tool/result') {
      const message = event.data.message
      const result = message.content[0]
      const call = findToolCallArguments(page, message.source.callId)
      if (call === undefined) return undefined
      const view = tools.get(call.name, scope)?.presentResult?.(call.args, {
        content: result.content,
        isError: result.isError === true,
        ...event.data.meta === undefined ? {} : { meta: event.data.meta },
      })
      return view === undefined ? undefined : jsonValue({ for: 'result', view })
    }
  } catch (error: unknown) {
    ctx.logger.warn(`session Remote presenter failed for ${event.type}: ${String(error)}`)
  }
  return undefined
}

/** Search durable event carriers for an authorized attachment reference. */
function imageBlockIn(
  content: unknown,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const block = value as { type?: unknown; attachment?: unknown; content?: unknown }
    if (block.type === 'image' && block.attachment !== null && typeof block.attachment === 'object') {
      const ref = block.attachment as ImageAttachmentRef
      if (match(ref)) return ref
    }
    if (block.type === 'tool-result') {
      const nested = imageBlockIn(block.content, match)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Search every durable content carrier in one event. */
function imageInEvent(
  event: SessionEvent,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  const data = event.data as {
    content?: unknown
    message?: { content?: unknown }
    inserted?: Array<{ content?: unknown }>
    chunk?: { type?: unknown; block?: unknown }
  }
  const direct = imageBlockIn(data.content, match)
  if (direct !== undefined) return direct
  const wrapped = imageBlockIn(data.message?.content, match)
  if (wrapped !== undefined) return wrapped
  for (const message of data.inserted ?? []) {
    const inserted = imageBlockIn(message.content, match)
    if (inserted !== undefined) return inserted
  }
  return event.type === 'assistant/chunk' && data.chunk?.type === 'block-end'
    ? imageBlockIn([data.chunk.block], match)
    : undefined
}

/** Resolve one attachment only when the addressed Session log references it. */
function referencedImage(
  events: readonly SessionEvent[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageInEvent(event, ref => String(ref.attachmentId) === attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}

/** Whether the transcript currently ends inside an open turn. */
function hasOpenTurn(session: Session): boolean {
  return session.events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    ?.type === 'turn/start'
}

/** Host implementation of G2's generated Session port and Workspace retirer. */
export class SessionRemoteOperationsService extends Service
  implements SessionRemoteOperations, WorkspaceSessionRetirer {
  static inject = [
    'agentDefaultModel',
    'agents',
    'attachments',
    'llm',
    'sessions',
    'workspaceRegistry',
  ]

  private readonly coldBlankProbeMaxBytes: number
  private readonly defaultCwd: string
  /** Exact loopback-only path for streaming Session archives. */
  readonly path = SESSION_EXPORT_PATH
  private readonly sessionExportCompressionLevel: SessionLogCompressionLevel
  private readonly handles = new Map<SessionId, AgentHandle>()
  private readonly creations = new Map<SessionId, Promise<Agent>>()
  private readonly resumes = new Map<SessionId, Promise<Agent>>()
  private readonly admissionChains = new WeakMap<Agent, Promise<void>>()
  private readonly lifetime = new AbortController()
  private readonly semanticHistory: SemanticHistoryReader

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionRemoteOperations')
    this.semanticHistory = new SemanticHistoryReader(ctx, (source) => {
      let scope: Promise<ScopeKey | undefined> | undefined
      return async (event, dependencies) => {
        // Non-tool domain records need only the lossless wire envelope. Resolve
        // one historical preset scope lazily for all tool entries in this body.
        const view = event.type === 'tool/call' || event.type === 'tool/result'
          ? eventView(ctx, event, dependencies, await (scope ??= this.standingPresenterScope(source)))
          : undefined
        return { event: remoteEvent(event), ...view === undefined ? {} : { view } }
      }
    }, config.semanticHistory)
    this.coldBlankProbeMaxBytes = config.coldBlankProbeMaxBytes ?? DEFAULT_COLD_BLANK_PROBE_MAX_BYTES
    if (!Number.isSafeInteger(this.coldBlankProbeMaxBytes) || this.coldBlankProbeMaxBytes < 0) {
      throw new RangeError('coldBlankProbeMaxBytes must be a non-negative safe integer')
    }
    this.defaultCwd = config.cwd ?? process.cwd()
    this.sessionExportCompressionLevel = sessionLogCompressionLevel(config.sessionExportCompressionLevel)
    if (!isAbsolute(this.defaultCwd)) {
      throw new Error(`host-session-remote-operations cwd must be absolute: ${JSON.stringify(this.defaultCwd)}`)
    }
    ctx.provide('workspaceSessionRetirer', this)
    ctx.inject(['connection'], connectionCtx => connectionCtx.connection.downloads.handle(
      this.path,
      (request, signal) => this.fetch(request, signal),
      { authority: 'loopback' },
    ))
    ctx.on('agent/disposed', ({ agent }) => {
      if (this.handles.get(agent.id)?.agent === agent) this.handles.delete(agent.id)
    })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('session Remote operations disposed'))
      this.semanticHistory.clear()
      const handles = [...this.handles.values()]
      this.handles.clear()
      await Promise.allSettled(handles.map(handle => handle.dispose({ keepInbox: true })))
    }, 'host-session-remote-operations: owned Agent handles')

    ctx.inject(['sessionProjections'], (projectionCtx) => {
      installPromptReceipts(projectionCtx)
      projectionCtx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
        key: 'sessionListMetadata',
        stateSchema: sessionListMetadataSchema,
        init: () => ({ blank: true, lastPromptAt: null }),
        apply: (state, event) => {
          const blank = state.blank && event.type !== 'turn/start'
          const latest = event.type === 'user/message' && event.data.source.kind === 'user'
            ? event.time
            : state.lastPromptAt
          return blank === state.blank && latest === state.lastPromptAt
            ? state
            : { blank, lastPromptAt: latest }
        },
        wire: { viewSchema: sessionListMetadataSchema, view: state => state },
        stateVersion: 1,
      })
    })
    ctx.inject(['sessionProjections', 'attachments'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'imageLimits', null>({
        key: 'imageLimits',
        stateSchema: z.null(),
        init: () => null,
        apply: state => state,
        wire: { viewSchema: imageLimitsSchema, view: () => projectionCtx.attachments.imageLimits },
        stateVersion: 1,
      })
    })
  }

  /**
   * Handle the Host-owned Native Session archive endpoint.
   * @param request - authenticated download request carrying Session export query fields.
   * @param signal - optional Connection-owned cancellation signal.
   * @returns the streamed archive response or a closed HTTP error response.
   */
  fetch(request: Request, signal?: AbortSignal): Promise<Response> {
    return fetchSessionLogExport(
      this.ctx,
      signal === undefined ? request : new Request(request, { signal }),
      this.sessionExportCompressionLevel,
    )
  }

  /** Return the current default for a fresh or resumed Agent. */
  private agentOptions(): AgentOptions {
    return { ...this.ctx.agentDefaultModel.currentSelection() }
  }

  /** Install or retrieve the session-local request selection. */
  private selectionFor(agent: Agent): SessionModelSelection {
    return sessionModelSelection(this.ctx, agent)
  }

  /** Resolve and mount the preset that owns one Agent's tool composition. */
  private async composeAgent(presetId: string | undefined): Promise<{
    readonly agentPreset?: string
    readonly setup: AgentSetup
  }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      return {
        setup: (agentCtx) => {
          const agent = agentCtx.agent
          if (agent === undefined) throw new Error('session Remote setup has no scoped agent')
          this.selectionFor(agent)
        },
      }
    }
    const resolved = await presets.resolve(presetId)
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx) => {
        const agent = agentCtx.agent
        if (agent === undefined) throw new Error('session Remote setup has no scoped agent')
        this.selectionFor(agent)
        await presets.mount(agentCtx, resolved.id)
      },
    }
  }

  /** Revalidate Workspace archive/deletion admission around publication. */
  private withSessionAdmission(
    setup: AgentSetup | undefined,
    checks: readonly { sessionId: SessionId; revision: number }[],
  ): AgentSetup {
    return async (agentCtx) => {
      const prepared = await setup?.(agentCtx)
      return {
        commit: () => {
          for (const check of checks) {
            this.ctx.workspaceRegistry.assertSessionAdmission(check.sessionId, check.revision)
          }
          prepared?.commit()
          for (const check of checks) {
            this.ctx.workspaceRegistry.assertSessionAdmission(check.sessionId, check.revision)
          }
        },
      }
    }
  }

  /** Retain the exact lifecycle capability returned by AgentRegistry. */
  private ownHandle(handle: AgentHandle): Agent {
    this.handles.set(handle.agent.id, handle)
    return handle.agent
  }

  /** Stable subagent ownership fence shared by all generic Session methods. */
  private subagentFailure(sessionId: SessionId): SessionRemoteFailure {
    const error = apiRemoteSubagentOwnershipError(sessionId)
    return failure(error.code, error.message, error.details)
  }

  /** Assert a caller cannot adopt a Session under another preset. */
  private assertPresetUnchanged(
    sessionId: SessionId,
    requested: string | undefined,
    existing: string | undefined,
  ): void {
    if (requested === undefined || requested === existing) return
    throw new SessionPresetConflict(sessionId, requested, existing)
  }

  /** Read one attached or persisted Session without acquiring a live Agent. */
  private async readSessionState(
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<SessionReadState> {
    signal.throwIfAborted()
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return { id: attached.id, header: attached.header, events: [...attached.events] }
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('session persistence is not configured')
    }
    const header = (await persistence.list(signal)).find(candidate => candidate.id === sessionId)
    if (header === undefined || header.cwd === undefined) {
      throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
    }
    const inspected = await persistence.inspect(sessionId, signal)
    signal.throwIfAborted()
    if (inspected.meta.cwd === undefined) {
      throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
    }
    return { id: inspected.meta.id, header: inspected.meta, events: [...inspected.events] }
  }

  /** Resolve one ordinary Session to a live Agent, resuming once per id. */
  private async agentFor(sessionId: SessionId): Promise<SessionRemoteResult<Agent>> {
    const revision = this.ctx.workspaceRegistry.sessionAdmissionRevision(sessionId)
    try {
      this.ctx.workspaceRegistry.assertSessionAdmission(sessionId, revision)
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      return failure('agent-busy', reason, { reason })
    }
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      if (hasApiRemoteSubagentOwner(this.ctx, live.session, live)) return this.subagentFailure(sessionId)
      return success(live)
    }
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiRemoteSubagentOwner(this.ctx, attached, undefined)) {
      return this.subagentFailure(sessionId)
    }
    let resume = this.resumes.get(sessionId)
    if (resume === undefined) {
      resume = (async () => {
        const inspected = await this.readSessionState(sessionId, this.lifetime.signal)
        if (hasApiRemoteSubagentOwner(this.ctx, { header: inspected.header }, undefined)) {
          throw new ApiRemoteSubagentSessionOwnership(sessionId)
        }
        const preset = resolveSessionPreset({ header: inspected.header, events: inspected.events })
        const composition = await this.composeAgent(preset)
        const handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.agentOptions(),
          signal: this.lifetime.signal,
          setup: this.withSessionAdmission(composition.setup, [{ sessionId, revision }]),
        })
        return this.ownHandle(handle)
      })().finally(() => {
        this.resumes.delete(sessionId)
      })
      this.resumes.set(sessionId, resume)
    }
    try {
      const agent = await resume
      this.ctx.workspaceRegistry.assertSessionAdmission(sessionId, revision)
      if (hasApiRemoteSubagentOwner(this.ctx, agent.session, agent)) return this.subagentFailure(sessionId)
      return success(agent)
    } catch (error: unknown) {
      if (error instanceof ApiRemoteSessionNotFound) {
        return failure('session-not-found', error.message, { sessionId })
      }
      if (error instanceof ApiRemoteSubagentSessionOwnership) return this.subagentFailure(error.sessionId)
      const raced = this.ctx.agents.get(sessionId)
      if (raced !== undefined) {
        if (hasApiRemoteSubagentOwner(this.ctx, raced.session, raced)) return this.subagentFailure(sessionId)
        return success(raced)
      }
      return failure('internal', `resume failed for session "${sessionId}": ${String(error)}`)
    }
  }

  /** Serialize model switching and prompt admission for one exact Agent. */
  private serializeAdmission<Value>(
    agent: Agent,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const result = (this.admissionChains.get(agent) ?? Promise.resolve()).then(operation)
    this.admissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /** One exact projection cut for an attached or detached transcript. */
  private projectionsFor(source: HistorySource): SessionRemoteProjections | undefined {
    const projections = this.ctx.get('sessionProjections')
    if (projections === undefined) return undefined
    try {
      const snapshot = source.kind === 'attached'
        ? projections.snapshot(source.session)
        : projections.restore({}, source.events, 0, source.header).snapshot
      return remoteProjections(snapshot)
    } catch (error: unknown) {
      this.ctx.logger.warn(`session Remote projections unavailable: ${String(error)}`)
      return undefined
    }
  }

  /** Resolve the presentation scope without resuming a cold Session. */
  private async presenterScope(
    sessionId: SessionId,
    source: PresetBearingSession,
  ): Promise<ScopeKey | undefined> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    return this.standingPresenterScope(source)
  }

  /** Historical scope is resolved from the caller's fixed cut, never today's live preset. */
  private async standingPresenterScope(source: PresetBearingSession): Promise<ScopeKey | undefined> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    try {
      return await presets.standingKeyFor(resolveSessionPreset(source))
    } catch {
      return undefined
    }
  }

  /** Cached listing hints never materialize a missing projection or replay a log. */
  private listProjections(header: SessionHeader, session?: Session): SessionRemoteProjections | undefined {
    try {
      return remoteProjections(session === undefined
        ? this.ctx.get('sessionProjectionCache')?.cachedSnapshot(header)
        : this.ctx.get('sessionProjections')?.cachedSnapshot(session))
    } catch (error: unknown) {
      this.ctx.logger.warn(`session.list: cached projections unavailable for "${header.id}": ${String(error)}`)
      return undefined
    }
  }

  private attachedSummary(session: Session): SessionRemoteSummary {
    const projections = this.listProjections(session.header, session)
    const metadata = sessionListMetadataSchema.safeParse(projections?.values.sessionListMetadata)
    return {
      sessionId: session.id,
      updatedAt: Math.max(session.header.createdAt, metadata.success ? metadata.data.lastPromptAt ?? 0 : 0),
      running: this.ctx.agents.get(session.id)?.status === 'running',
      blank: metadata.success ? metadata.data.blank : session.seq === 0,
      ...summaryFields(session.header, projections),
      ...projections === undefined ? {} : { projections },
    }
  }

  /** Only small physical artifacts may be observed for an unknown cold blank hint. */
  private async smallColdProjections(query: Context['sessionQuery'], header: SessionHeader, signal: AbortSignal): Promise<SessionRemoteProjections | undefined> {
    if (this.coldBlankProbeMaxBytes === 0) return undefined
    const location = this.ctx.get('sessionPersistence')?.locate(header)
    if (location === undefined) return undefined
    signal.throwIfAborted()
    try {
      if ((await stat(location.path)).size > this.coldBlankProbeMaxBytes) return undefined
    } catch {
      signal.throwIfAborted()
      return undefined
    }
    try {
      using observation = await query.observeSession(header.id, { signal, projectionMode: 'all' })
      signal.throwIfAborted()
      return remoteProjections(observation.projections)
    } catch (error: unknown) {
      signal.throwIfAborted()
      this.ctx.logger.warn(`session.list: small cold observation for "${header.id}" failed; serving it visible: ${String(error)}`)
      return undefined
    }
  }

  private async coldSummary(query: Context['sessionQuery'], header: SessionHeader, signal: AbortSignal): Promise<SessionRemoteSummary> {
    const cached = this.listProjections(header)
    const metadata = sessionListMetadataSchema.safeParse(cached?.values.sessionListMetadata)
    const projections = metadata.success && !metadata.data.blank
      ? cached
      : await this.smallColdProjections(query, header, signal) ?? cached
    const raced = this.ctx.sessions.get(header.id)
    if (raced !== undefined) return this.attachedSummary(raced)
    const current = sessionListMetadataSchema.safeParse(projections?.values.sessionListMetadata)
    return {
      sessionId: header.id,
      updatedAt: Math.max(header.createdAt, current.success ? current.data.lastPromptAt ?? 0 : 0),
      running: false,
      // Large, inaccessible, or failed observations remain unknown and visible.
      blank: current.success ? current.data.blank : false,
      ...summaryFields(header, projections),
      ...projections === undefined ? {} : { projections },
    }
  }

  /** Reuse query corpus visibility and cached hints; bound concurrent physical probes. */
  private async visibleSummaries(query: Context['sessionQuery'], signal: AbortSignal): Promise<SessionRemoteSummary[]> {
    signal.throwIfAborted()
    const records = await query.listSessions(signal)
    signal.throwIfAborted()
    const rows: SessionRemoteSummary[] = []
    const cold: SessionHeader[] = []
    for (const record of records) {
      const live = this.ctx.sessions.get(record.header.id)
      if (live !== undefined) rows.push(this.attachedSummary(live))
      else if (record.header.cwd !== undefined) cold.push(record.header)
    }
    for (let offset = 0; offset < cold.length; offset += COLD_SUMMARY_BATCH_SIZE) {
      signal.throwIfAborted()
      const settled = await Promise.allSettled(cold.slice(offset, offset + COLD_SUMMARY_BATCH_SIZE)
        .map(header => this.coldSummary(query, header, signal)))
      for (const result of settled) {
        if (result.status === 'rejected') throw result.reason
        rows.push(result.value)
      }
    }
    rows.sort((left, right) => right.updatedAt - left.updatedAt)
    return rows
  }

  /** List every attached or persisted Session visible to ordinary routing. */
  async list(
    _request: SessionRemoteListRequest,
    signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemoteListValue>> {
    if (aborted(signal)) return cancelled()
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) {
      return failure(
        'internal',
        'session listing is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
      )
    }
    try {
      return success({ items: await this.visibleSummaries(query, signal) })
    } catch (error: unknown) {
      if (aborted(signal)) return cancelled()
      return failure('internal', `session listing failed: ${String(error)}`)
    }
  }

  /** Search current message surfaces, then enforce ordinary Session visibility. */
  async search(
    request: SessionRemoteSearchRequest,
    signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemoteSearchValue>> {
    if (aborted(signal)) return cancelled('session search was aborted')
    const query = request.query.trim()
    if (query.length === 0 || query.length > 500 || query.includes('\0')) {
      return failure('invalid-argument', 'session search query must be 1-500 non-NUL characters')
    }
    const sessionQuery = this.ctx.get('sessionQuery')
    if (sessionQuery === undefined) {
      return failure(
        'internal',
        'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
      )
    }
    try {
      const visible = await sessionQuery.listSessions(signal)
      signal.throwIfAborted()
      const visibleIds = new Set(visible
        .filter(record => record.header.cwd !== undefined)
        .map(record => record.header.id))
      if (visibleIds.size === 0) return success({ items: [], hasMore: false })
      const accepted: SessionRemoteSearchItem[] = []
      const acceptedIds = new Set<SessionId>()
      const seenCursors = new Set<SessionSearchCursor>()
      let cursor: SessionSearchCursor | undefined
      let calls = 0
      let pageLimit = SESSION_SEARCH_RESULT_LIMIT
      while (accepted.length <= SESSION_SEARCH_RESULT_LIMIT) {
        signal.throwIfAborted()
        if (calls >= SESSION_SEARCH_PROVIDER_CALL_LIMIT) {
          throw new Error(`session search provider exceeded ${SESSION_SEARCH_PROVIDER_CALL_LIMIT} calls`)
        }
        calls += 1
        const requestedCursor = cursor
        const requestedLimit = pageLimit
        let page
        try {
          page = await sessionQuery.searchSessions({
            query,
            eventFilters: [
              { kind: 'type', values: ['user/message', 'assistant/message'] },
              { kind: 'surface', values: ['current'] },
            ],
            limit: requestedLimit,
            ...requestedCursor === undefined ? {} : { cursor: requestedCursor },
          }, { signal })
        } catch (error: unknown) {
          if (requestedCursor === undefined && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_INVALID_LIMIT' && requestedLimit > 1) {
            pageLimit = Math.max(1, Math.floor(requestedLimit / 2))
            continue
          }
          if (requestedCursor !== undefined && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_STALE_CURSOR') {
            accepted.length = 0
            acceptedIds.clear()
            seenCursors.clear()
            cursor = undefined
            continue
          }
          throw error
        }
        signal.throwIfAborted()
        if (page.items.length > requestedLimit) {
          throw new Error(`session search provider returned ${page.items.length} items; maximum is ${requestedLimit}`)
        }
        for (const hit of page.items) {
          if (accepted.length > SESSION_SEARCH_RESULT_LIMIT) continue
          if (!visibleIds.has(hit.header.id)
            || hit.bestMatch.sessionId !== hit.header.id
            || hit.bestMatch.surface !== 'current'
            || !MESSAGE_TYPES.has(hit.bestMatch.type)
            || acceptedIds.has(hit.header.id)) continue
          acceptedIds.add(hit.header.id)
          accepted.push({
            sessionId: hit.header.id,
            snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
          })
        }
        if (page.nextCursor !== undefined) {
          if (seenCursors.has(page.nextCursor)) throw new Error('session search provider repeated a cursor')
          seenCursors.add(page.nextCursor)
        }
        if (accepted.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      return success({
        items: accepted.slice(0, SESSION_SEARCH_RESULT_LIMIT),
        hasMore: accepted.length > SESSION_SEARCH_RESULT_LIMIT,
      })
    } catch (error: unknown) {
      if (aborted(signal)
        || (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED')) {
        return cancelled('session search was aborted')
      }
      return failure('internal', `session search failed: ${String(error)}`)
    }
  }

  /** Resolve or create one explicit identity once, preserving cwd and preset ownership. */
  private async ensureSession(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    requestedPreset: string | undefined,
    signal: AbortSignal,
  ): Promise<Agent> {
    let creation = this.creations.get(sessionId)
    if (creation === undefined) {
      creation = (async () => {
        signal.throwIfAborted()
        const revision = this.ctx.workspaceRegistry.sessionAdmissionRevision(sessionId)
        this.ctx.workspaceRegistry.assertSessionAdmission(sessionId, revision)
        const live = this.ctx.agents.get(sessionId)
        const attached = this.ctx.sessions.get(sessionId)
        if (attached !== undefined && hasApiRemoteSubagentOwner(this.ctx, attached, live)) {
          throw new ApiRemoteSubagentSessionOwnership(sessionId)
        }
        if (live !== undefined) return live

        const persistence = checkPersistedIdentity ? this.ctx.get('sessionPersistence') : undefined
        const stored = persistence === undefined
          ? undefined
          : (await persistence.list(signal)).find(header => header.id === sessionId)
        signal.throwIfAborted()
        if (persistence !== undefined && stored !== undefined) {
          const inspected = await persistence.inspect(sessionId, signal)
          if (hasApiRemoteSubagentOwner(this.ctx, { header: inspected.meta }, undefined)) {
            throw new ApiRemoteSubagentSessionOwnership(sessionId)
          }
          if (inspected.meta.cwd !== cwd) {
            throw new SessionCwdConflict(sessionId, cwd, inspected.meta.cwd)
          }
          const storedPreset = resolveSessionPreset({ header: inspected.meta, events: inspected.events })
          this.assertPresetUnchanged(sessionId, requestedPreset, storedPreset)
          const composition = await this.composeAgent(storedPreset)
          const handle = await this.ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: this.agentOptions(),
            signal,
            setup: this.withSessionAdmission(composition.setup, [{ sessionId, revision }]),
          })
          return this.ownHandle(handle)
        }

        await mkdir(cwd, { recursive: true })
        signal.throwIfAborted()
        const composition = await this.composeAgent(requestedPreset)
        const handle = await this.ctx.agents.create({
          sessionId,
          agentOptions: this.agentOptions(),
          signal,
          meta: {
            cwd,
            ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
          },
          setup: this.withSessionAdmission(composition.setup, [{ sessionId, revision }]),
        })
        return this.ownHandle(handle)
      })().catch((error: unknown) => {
        const raced = this.ctx.agents.get(sessionId)
        if (raced !== undefined) {
          if (hasApiRemoteSubagentOwner(this.ctx, raced.session, raced)) {
            throw new ApiRemoteSubagentSessionOwnership(sessionId)
          }
          return raced
        }
        const attached = this.ctx.sessions.get(sessionId)
        if (attached !== undefined && hasApiRemoteSubagentOwner(this.ctx, attached, undefined)) {
          throw new ApiRemoteSubagentSessionOwnership(sessionId)
        }
        throw error
      }).finally(() => {
        this.creations.delete(sessionId)
      })
      this.creations.set(sessionId, creation)
    }
    const agent = await creation
    if (hasApiRemoteSubagentOwner(this.ctx, agent.session, agent)) {
      throw new ApiRemoteSubagentSessionOwnership(sessionId)
    }
    this.assertPresetUnchanged(sessionId, requestedPreset, resolveSessionPreset(agent.session))
    if (agent.session.header.cwd !== cwd) {
      throw new SessionCwdConflict(sessionId, cwd, agent.session.header.cwd)
    }
    return agent
  }

  /** Create or adopt one ordinary Agent-backed Session. */
  async create(
    request: SessionRemoteCreateRequest,
    signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemoteCreateValue>> {
    if (aborted(signal)) return cancelled()
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      return failure('invalid-argument', 'session.create accepts workspaceId or cwd, not both')
    }
    const sessionId = request.sessionId ?? SessionId(`session-${randomUUID()}`)
    let workspace: Workspace | undefined
    if (request.workspaceId !== undefined) {
      workspace = this.ctx.workspaceRegistry.get(brandWorkspaceId(request.workspaceId))
      if (workspace === undefined) {
        return failure(
          'workspace-not-found',
          `workspace "${request.workspaceId}" not found`,
          { workspaceId: request.workspaceId },
        )
      }
    }
    const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
    if (!isAbsolute(cwd)) return failure('invalid-argument', 'session cwd must be absolute', { cwd })
    try {
      const agent = await this.ensureSession(
        sessionId,
        cwd,
        request.sessionId !== undefined,
        request.agentPreset,
        signal,
      )
      if (aborted(signal)) return cancelled()
      if (workspace !== undefined && !workspace.sessionIds.includes(sessionId)) {
        try {
          await workspace.attachSession(sessionId)
        } catch (error: unknown) {
          return failure(
            'workspace-attach-failed',
            `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
            { sessionId, workspaceId: workspace.id },
          )
        }
      }
      const agentPreset = resolveSessionPreset(agent.session)
      return success({
        sessionId,
        ...agentPreset === undefined ? {} : { agentPreset },
      })
    } catch (error: unknown) {
      if (aborted(signal)) return cancelled()
      if (error instanceof SessionPresetConflict) {
        return failure('agent-preset-conflict', error.message, {
          sessionId: error.sessionId,
          requestedPreset: error.requestedPreset,
          ...error.existingPreset === undefined ? {} : { existingPreset: error.existingPreset },
        })
      }
      if (error instanceof UnknownPresetError) {
        return failure('agent-preset-not-found', error.message, {
          agentPreset: error.presetId,
          available: [...error.available],
        })
      }
      if (error instanceof PresetMountError) {
        return failure('agent-preset-invalid', error.message, {
          agentPreset: error.presetId,
          reason: error.reason,
        })
      }
      if (error instanceof SessionCwdConflict) {
        return failure('session-conflict', error.message, {
          sessionId: error.sessionId,
          requestedCwd: error.requestedCwd,
          ...error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd },
        })
      }
      if (error instanceof ApiRemoteSubagentSessionOwnership) return this.subagentFailure(error.sessionId)
      return failure('internal', `failed to create session "${sessionId}": ${String(error)}`)
    }
  }

  /** Resolve one history source without acquiring an Agent owner. */
  private async historySource(
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<HistorySource> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) return { kind: 'attached', session: attached }
    const state = await this.readSessionState(sessionId, signal)
    return { kind: 'detached', header: state.header, events: state.events }
  }

  /**
   * Serve a consistent attached-or-cold transcript page and projection cut.
   * When `hasMore` is true, the first returned event sequence is the strictly
   * smaller exclusive `beforeSeq` cursor for the next request.
   */
  history(request: SessionRemoteRawHistoryRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteRawHistoryValue>>
  history(request: SessionRemoteHistoryRequest, signal: AbortSignal): Promise<SessionRemoteResult<SessionRemoteHistoryValue>>
  async history(
    request: SessionRemoteHistoryRequest,
    signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemoteHistoryValue>> {
    const readSignal = AbortSignal.any([signal, this.lifetime.signal])
    if (aborted(readSignal)) return cancelled()
    if (request.view === 'semantic' || request.view === 'content') {
      try {
        return success(await this.semanticHistory.read(request, readSignal))
      } catch (error: unknown) {
        if (aborted(readSignal) || this.lifetime.signal.aborted) return cancelled()
        if (error instanceof SemanticHistoryError) return failure(error.code, error.message)
        return failure('internal', `semantic history unavailable: ${String(error)}`)
      }
    }
    if (request.beforeSeq !== undefined
      && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0)) {
      return failure('invalid-argument', 'beforeSeq must be a non-negative safe integer')
    }
    if (request.maxEvents !== undefined
      && (!Number.isSafeInteger(request.maxEvents)
        || request.maxEvents < 1
        || request.maxEvents > MAX_HISTORY_PAGE_EVENTS)) {
      return failure('invalid-argument', `maxEvents must be an integer from 1 through ${String(MAX_HISTORY_PAGE_EVENTS)}`)
    }
    if (request.maxMessages !== undefined
      && (!Number.isSafeInteger(request.maxMessages)
        || request.maxMessages < 1
        || request.maxMessages > MAX_HISTORY_MESSAGES)) {
      return failure(
        'invalid-argument',
        `maxMessages must be an integer from 1 through ${String(MAX_HISTORY_MESSAGES)}`,
      )
    }
    try {
      using fixed = request.view === 'raw' || request.sourceRevision !== undefined || request.expectedSubagentMode !== undefined
        ? await this.semanticHistory.observe(request, readSignal) : undefined
      const source: HistorySource = fixed === undefined ? await this.historySource(request.sessionId, readSignal)
        : { kind: 'detached', header: fixed.observed.header, events: fixed.observed.events }
      const bearing: PresetBearingSession = source.kind === 'attached'
        ? { header: source.session.header, events: source.session.events }
        : { header: source.header, events: source.events }
      if (request.expectedParentSessionId !== undefined && bearing.header.parentSession !== request.expectedParentSessionId) {
        return failure('subagent-unauthorized', 'subagent parent changed during history read', { sessionId: request.sessionId })
      }
      if (bearing.header.origin === 'subagent' && fixed === undefined) {
        return failure('subagent-unauthorized', 'child history requires its direct parent and mode')
      }
      let scope = fixed === undefined ? await this.presenterScope(request.sessionId, bearing) : undefined
      readSignal.throwIfAborted()
      fixed?.assertCurrent()
      // A bound read retains the actual immutable observation/lease. Later
      // appends cannot enter its page or change the authorized descriptor cut.
      const events = fixed?.observed.events ?? (source.kind === 'attached' ? source.session.events : source.events)
      const projections = fixed === undefined && request.beforeSeq === undefined
        ? this.projectionsFor(source) : undefined
      const binding = fixed === undefined ? {} : {
        view: 'raw' as const, sourceRevision: fixed.revision, asOfThroughSeq: fixed.through,
      }
      const sourcePage = historyEventWindow(
        events,
        fixed === undefined ? request.beforeSeq : Math.min(request.beforeSeq ?? fixed.through + 1, fixed.through + 1),
        request.maxMessages ?? DEFAULT_MAX_MESSAGES,
        request.maxEvents ?? MAX_HISTORY_PAGE_EVENTS,
      )
      if (fixed !== undefined && sourcePage.events.some(event => event.type === 'tool/call' || event.type === 'tool/result')) {
        scope = await this.standingPresenterScope(this.semanticHistory.presentationSource(
          fixed.observed, fixed.identity, fixed.through, readSignal,
        ))
        readSignal.throwIfAborted()
        this.lifetime.signal.throwIfAborted()
        fixed.assertCurrent()
      }
      const fixedValue = {
        ...binding,
        events: [] as SessionRemoteHistoryEntry[],
        hasMore: true,
        ...projections === undefined ? {} : { projections },
      }
      const fixedEncodedBytes = Buffer.byteLength(JSON.stringify(fixedValue), 'utf8')
      if (fixedEncodedBytes > MAX_HISTORY_PAGE_ENCODED_BYTES) {
        throw new Error('history projection baseline exceeded the encoded page budget')
      }
      const eventArrayBudget = MAX_HISTORY_PAGE_ENCODED_BYTES - fixedEncodedBytes + 2
      const page = historyEntryWindow(sourcePage, (event, pageEvents) => {
        const view = eventView(this.ctx, event, pageEvents, scope)
        return {
          event: remoteEvent(event),
          ...view === undefined ? {} : { view },
        }
      }, eventArrayBudget)
      const value: SessionRemoteHistoryValue = {
        ...binding,
        events: page.entries,
        hasMore: page.hasMore,
        ...projections === undefined ? {} : { projections },
      }
      const valueEncodedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
      if (valueEncodedBytes > MAX_HISTORY_PAGE_ENCODED_BYTES && page.entries.length !== 1) {
        throw new Error('history page exceeded the encoded byte budget')
      }
      fixed?.assertCurrent()
      return success(value)
    } catch (error: unknown) {
      if (aborted(readSignal)) return cancelled()
      if (error instanceof SemanticHistoryError) return failure(error.code, error.message)
      if (error instanceof ApiRemoteSessionNotFound) {
        return failure('session-not-found', error.message, { sessionId: request.sessionId })
      }
      return failure(
        'internal',
        `history unavailable for session "${request.sessionId}": ${String(error)}`,
      )
    }
  }

  /** Build the advisory provider/model catalog directly from LlmRuntime. */
  private async modelCatalog(signal: AbortSignal): Promise<{
    readonly groups: SessionRemoteProviderGroup[]
    readonly failures: SessionRemoteCatalogFailure[]
  }> {
    const catalog = await Promise.all(this.ctx.llm.listProviders().map(async (provider) => {
      try {
        signal.throwIfAborted()
        const models = await this.ctx.llm.listModels(provider.id)
        const entries = await Promise.all(models.map(async (model) => {
          const resolved = await this.ctx.llm.resolveModelInfo(provider.id, model.id, signal)
          return {
            id: model.id,
            name: model.name,
            ...model.description === undefined ? {} : { description: model.description },
            ...resolved.reasoning === undefined
              ? {}
              : {
                reasoning: {
                  efforts: resolved.reasoning.efforts.map(effort => ({
                    id: effort.id,
                    name: effort.name,
                    ...effort.description === undefined ? {} : { description: effort.description },
                  })),
                  ...resolved.reasoning.defaultEffort === undefined
                    ? {}
                    : { defaultEffort: resolved.reasoning.defaultEffort },
                },
              },
          }
        }))
        return {
          kind: 'group' as const,
          value: { id: provider.id, name: provider.name, models: entries },
        }
      } catch (error: unknown) {
        if (signal.aborted) throw error
        return {
          kind: 'failure' as const,
          value: {
            id: provider.id,
            name: provider.name,
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }))
    return {
      groups: catalog.flatMap(item => item.kind === 'group' && item.value.models.length > 0 ? [item.value] : []),
      failures: catalog.flatMap(item => item.kind === 'failure' ? [item.value] : []),
    }
  }

  /** Report the current session route and advisory model catalog. */
  async models(
    request: SessionRemoteModelsRequest,
    signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemoteModels>> {
    if (aborted(signal)) return cancelled()
    const found = await this.agentFor(request.sessionId)
    if (!found.ok) return found
    try {
      signal.throwIfAborted()
      const current = this.selectionFor(found.value).current
      const catalog = await this.modelCatalog(signal)
      const routable = this.ctx.llm.listProviders().some(provider => provider.id === current.provider)
      return success({
        current: { ...current },
        routable,
        groups: catalog.groups,
        failures: catalog.failures,
      })
    } catch (error: unknown) {
      if (aborted(signal)) return cancelled()
      return failure('internal', `model catalog unavailable: ${String(error)}`)
    }
  }

  /** Validate and apply one session-local provider/model/reasoning selection. */
  async selectModel(
    request: SessionRemoteSelectModelRequest,
    signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemoteSelectModelValue>> {
    if (aborted(signal)) return cancelled()
    const found = await this.agentFor(request.sessionId)
    if (!found.ok) return found
    return this.serializeAdmission(found.value, async () => {
      try {
        const resolved = await this.ctx.llm.resolveCallConfig({
          provider: request.provider,
          model: request.model,
          ...request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) },
        }, signal)
        signal.throwIfAborted()
        const selected: ModelSelection = {
          provider: resolved.provider,
          model: resolved.model,
          ...resolved.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: resolved.reasoningEffort },
        }
        found.value.session.append('model/selection', selected)
        this.selectionFor(found.value)
        try {
          await this.ctx.agentDefaultModel.saveSelection(selected)
        } catch (error: unknown) {
          this.ctx.logger.warn(`session model selection was not saved as default: ${String(error)}`)
        }
        return success({ selected: { ...selected } })
      } catch (error: unknown) {
        if (aborted(signal)) return cancelled()
        return failure(
          'model-unavailable',
          error instanceof Error ? error.message : String(error),
          { provider: request.provider, model: request.model },
        )
      }
    })
  }

  /** Append a user-owned durable title through SessionTitleService. */
  async rename(
    request: SessionRemoteRenameRequest,
    signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemoteRenameValue>> {
    if (aborted(signal)) return cancelled()
    const found = await this.agentFor(request.sessionId)
    if (!found.ok) return found
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) {
      return failure(
        'internal',
        'renaming is unavailable: this deployment mounts no session-title service',
      )
    }
    try {
      signal.throwIfAborted()
      const accepted = titles.rename(found.value.session, request.title)
      return success({ title: accepted.title, seq: accepted.eventSeq })
    } catch (error: unknown) {
      if (aborted(signal)) return cancelled()
      if (error instanceof SessionTitleInvalidError) {
        return failure('title-invalid', error.message, { sessionId: request.sessionId })
      }
      return failure('internal', `failed to rename session "${request.sessionId}": ${String(error)}`)
    }
  }

  /** Resolve the Workspace inherited by an ordinary fork. */
  private async forkWorkspace(
    source: SessionReadState,
    signal: AbortSignal,
  ): Promise<Workspace | undefined> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    if (direct !== undefined || source.header.origin !== 'subagent') return direct
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) {
      throw new Error('cannot resolve a subagent fork workspace without session-query')
    }
    const lineage = await query.traceSession(source.id, signal)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }

  /** Fork one completed-turn prefix under a new exact Agent lifecycle handle. */
  async fork(
    request: SessionRemoteForkRequest,
    signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemoteForkValue>> {
    signal = AbortSignal.any([signal, this.lifetime.signal])
    if (aborted(signal)) return cancelled()
    if (request.atSeq !== undefined
      && (!Number.isSafeInteger(request.atSeq) || request.atSeq < 0)) {
      return failure('invalid-argument', 'atSeq must be a non-negative safe integer')
    }
    const parentRevision = this.ctx.workspaceRegistry.sessionAdmissionRevision(request.sessionId)
    try {
      this.ctx.workspaceRegistry.assertSessionAdmission(request.sessionId, parentRevision)
    } catch (error: unknown) {
      return failure(
        'fork-unavailable',
        error instanceof Error ? error.message : String(error),
        { sessionId: request.sessionId },
      )
    }
    let fixed: Awaited<ReturnType<SemanticHistoryReader['observe']>> | undefined
    let checkedSource: Awaited<ReturnType<SemanticHistoryReader['observe']>> | undefined
    try {
      let source: SessionReadState
      try {
        if (request.sourceRevision !== undefined) {
          const observation = await this.semanticHistory.observe(request, signal)
          fixed = observation
          source = { id: request.sessionId, header: observation.observed.header, events: observation.observed.events }
          if (request.atSeq !== undefined && request.atSeq > observation.through) {
            return failure('invalid-argument', 'fork anchor is outside the bound history cut')
          }
        } else {
          source = await this.readSessionState(request.sessionId, signal)
        }
      } catch (error: unknown) {
        if (aborted(signal)) return cancelled()
        if (error instanceof SemanticHistoryError) return failure(error.code, error.message)
        if (error instanceof ApiRemoteSessionNotFound) {
          return failure('session-not-found', error.message, { sessionId: request.sessionId })
        }
        return failure(
          'internal',
          `fork source unavailable for session "${request.sessionId}": ${String(error)}`,
        )
      }
      const lastSeq = fixed?.through ?? (source.events.at(-1)?.seq ?? -1)
      const anchoredBoundary = request.atSeq === undefined
        ? undefined
        : source.events.find(event => event.type === 'turn/end' && event.seq >= (request.atSeq as number) && event.seq <= lastSeq)
      const boundary = anchoredBoundary
        ?? (request.atSeq === undefined || request.atSeq > lastSeq
          ? source.events.findLast(event => event.type === 'turn/end' && event.seq <= lastSeq)
          : undefined)
      if (boundary === undefined) {
        return failure(
          'fork-unavailable',
          request.atSeq !== undefined && request.atSeq <= lastSeq
            ? `session "${request.sessionId}" has not completed the turn containing event ${request.atSeq}`
            : `session "${request.sessionId}" has no completed turn to fork from`,
          { sessionId: request.sessionId },
        )
      }
      let cut = boundary.seq + 1
      while (cut <= lastSeq && source.events[cut]?.type !== 'turn/start') cut += 1
      let workspace: Workspace | undefined
      try {
        workspace = await this.forkWorkspace(source, signal)
      } catch (error: unknown) {
        if (aborted(signal)) return cancelled()
        return failure(
          'internal',
          `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`,
        )
      }
      const childId = SessionId(`session-${randomUUID()}`)
      const childRevision = this.ctx.workspaceRegistry.sessionAdmissionRevision(childId)
      // This seed is taken only from the initial immutable observation. Later
      // source validation never supplies replacement events or a newer preset.
      const seed = source.events.slice(0, cut)
      let handle: AgentHandle | undefined
      try {
        fixed?.assertCurrent()
        const composition = await this.composeAgent(resolveSessionPreset({
          header: source.header, events: fixed === undefined ? source.events : seed,
        }))
        const admission = this.withSessionAdmission(composition.setup, [
          { sessionId: request.sessionId, revision: parentRevision },
          { sessionId: childId, revision: childRevision },
        ])
        const bound = fixed
        const setup: AgentSetup = bound === undefined ? admission : async (agentCtx) => {
          const prepared = await admission(agentCtx)
          bound.assertCurrent()
          // Reuse the source owner after all asynchronous composition work. A
          // cold lease is a pinned snapshot, not an external-file write lock.
          const checked = await this.semanticHistory.observe({
            ...request, sourceRevision: bound.revision,
          }, signal)
          checkedSource = checked
          const assertSource = () => {
            signal.throwIfAborted()
            bound.assertCurrent()
            checked.assertCurrent()
            if (bound.observed.source === 'prepared' && this.ctx.sessions.get(request.sessionId) !== undefined) {
              throw new SemanticHistoryError('history-stale-source', 'fork source became live before publication')
            }
          }
          assertSource()
          return { commit: () => {
            assertSource()
            prepared?.commit()
            assertSource()
          } }
        }

        handle = await this.ctx.agents.create({
          sessionId: childId,
          seed,
          meta: {
            ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
            parentSession: source.id,
            seedLength: cut,
            ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
          },
          agentOptions: this.agentOptions(),
          signal,
          setup,
        })
        signal.throwIfAborted()
        await this.ctx.sessions.flush(handle.agent.session)
        signal.throwIfAborted()
        this.ownHandle(handle)
      } catch (error: unknown) {
        if (handle !== undefined) {
          try {
            await handle.dispose()
          } catch (disposeError: unknown) {
            this.ctx.logger.warn(`failed to dispose undurable fork "${childId}": ${String(disposeError)}`)
          }
        }
        if (aborted(signal)) return cancelled()
        if (error instanceof SemanticHistoryError) return failure(error.code, error.message)
        return failure(
          'internal',
          `failed to fork session "${request.sessionId}": ${String(error)}`,
        )
      }
      if (workspace !== undefined) {
        try {
          await workspace.attachSession(childId)
        } catch (error: unknown) {
          return failure(
            'workspace-attach-failed',
            `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
            { sessionId: childId, workspaceId: workspace.id },
          )
        }
      }
      return success({ sessionId: childId })
    } finally {
      // Both leases cover every early return and cancellation. A release
      // failure must not replace the operation's original result or error.
      for (const observation of [checkedSource, fixed]) {
        try { observation?.[Symbol.dispose]() }
        catch { this.ctx.logger.warn('failed to release a fork source observation') }
      }
    }
  }

  /** Promote base64 image parts to durable references in caller order. */
  private async durablePromptContent(
    content: readonly SessionRemotePromptContentPart[],
  ): Promise<ContentBlock[]> {
    if (content.every(part => part.type === 'text')) {
      return content.map(part => ({ type: 'text', text: part.text }))
    }
    const refs = await admitEncodedImages(
      this.ctx.attachments,
      content.filter(part => part.type === 'image'),
    )
    let next = 0
    return content.map(part => part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', attachment: refs[next++] as ImageAttachmentRef })
  }

  /** Revalidate one resolved prompt target at its synchronous delivery commit. */
  private assertPromptAdmission(sessionId: SessionId, agent: Agent): void {
    const revision = this.ctx.workspaceRegistry.sessionAdmissionRevision(sessionId)
    this.ctx.workspaceRegistry.assertSessionAdmission(sessionId, revision)
    if (this.ctx.agents.get(sessionId) !== agent || this.ctx.sessions.get(sessionId) !== agent.session) {
      throw new Error(`session "${sessionId}" lifecycle changed before prompt delivery`)
    }
  }

  /** Admit an unmatched slash line only when the live Agent can resolve its exact user-invocable skill. */
  private async admitUnknownCommandAsSkill(
    commandLine: string,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const name = commandLine.slice(1).trim().split(/\s/u, 1)[0] ?? ''
    if (!isSkillName(name)) return undefined
    const registry = agent.ctx.get('skills') ?? this.ctx.get('skills')
    if (registry === undefined) return undefined
    const skills = await registry.list({ cwd: agent.session.header.cwd, scope: agent, signal })
    return skills.some(skill => skill.name === name && isUserInvocable(skill))
      ? commandLine
      : undefined
  }

  /** Read the existing projection without retaining a second transcript or receipt cache. */
  private promptReceipt(session: Session, invocationId: SessionPromptInvocationId): PromptReceipt | undefined {
    const state = this.ctx.get('sessionProjections')?.stateOf(session, 'promptReceipts')
    if (state === undefined) throw new Error('ordinary prompt receipt projection is unavailable')
    return Object.hasOwn(state.entries, invocationId) ? state.entries[invocationId] : undefined
  }

  private receiptConflict(receipt: PromptReceipt, digest: string): SessionRemoteFailure | undefined {
    return receipt.conflict || receipt.digest === null || receipt.digest !== digest
      ? failure('invocation-conflict', 'invocationId was already accepted with different or unverifiable input') : undefined
  }

  /** Once accepted, caller cancellation cannot undo delivery or bypass durability confirmation. */
  private async confirmPrompt(
    session: Session, invocationId: SessionPromptInvocationId,
  ): Promise<SessionRemoteResult<SessionRemotePromptValue>> {
    try {
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined || !await this.ctx.sessions.flush(session)) {
        throw new Error('ordinary prompt has no durability owner')
      }
      await persistence.ensureMaterialized(session)
      return success({ accepted: true })
    } catch (error: unknown) {
      return failure('prompt-durability-unconfirmed', 'prompt was accepted but its durable acknowledgement is not confirmed', {
        accepted: true, invocationId, reason: String(error),
      })
    }
  }

  /** Confirm a retry before provider lookup or Agent activation, including a cold completed Session. */
  private async acceptedPrompt(
    request: SessionRemotePromptRequest, digest: string, signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemotePromptValue> | undefined> {
    const revision = this.ctx.workspaceRegistry.sessionAdmissionRevision(request.sessionId)
    try {
      this.ctx.workspaceRegistry.assertSessionAdmission(request.sessionId, revision)
    } catch (error: unknown) {
      return failure('agent-busy', 'session lifecycle changed before prompt admission', { reason: String(error) })
    }
    const live = this.ctx.sessions.get(request.sessionId)
    if (live !== undefined) {
      if (hasApiRemoteSubagentOwner(this.ctx, live, this.ctx.agents.get(request.sessionId))) return this.subagentFailure(request.sessionId)
      const receipt = this.promptReceipt(live, request.invocationId)
      if (receipt === undefined) return undefined
      return this.receiptConflict(receipt, digest) ?? this.confirmPrompt(live, request.invocationId)
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    using borrowed = await persistence.borrowSession(request.sessionId, signal)
    signal.throwIfAborted()
    this.ctx.workspaceRegistry.assertSessionAdmission(request.sessionId, revision)
    if (this.ctx.sessions.get(request.sessionId) !== undefined) return await this.acceptedPrompt(request, digest, signal)
    if (borrowed.source === 'live') return failure('agent-busy', 'session lifecycle changed while verifying prompt admission')
    const session = borrowed.preparedSession
    if (hasApiRemoteSubagentOwner(this.ctx, session, undefined)) return this.subagentFailure(request.sessionId)
    this.ctx.get('sessionProjectionCache')?.hydratePrepared(session, borrowed.inspection.meta, borrowed.inspection.events)
    const receipt = this.promptReceipt(session, request.invocationId)
    if (receipt === undefined) return undefined
    // This exact retained source was already read from persistence; no live flush or Agent resume is needed.
    return this.receiptConflict(receipt, digest) ?? success({ accepted: true })
  }

  /** Admit ordinary queued or steering input to the exact live Agent. */
  async prompt(
    request: SessionRemotePromptRequest,
    signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemotePromptValue>> {
    if (aborted(signal)) return cancelled()
    if (request.invocationId.length === 0) {
      return failure(
        'invalid-invocation-id',
        'invocationId must be a non-empty opaque prompt identity',
      )
    }
    const canonicalTimeZone = request.clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && canonicalTimeZone === undefined) {
      return failure(
        'invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: request.clientTimeZone },
      )
    }
    const digest = promptDigest(request, canonicalTimeZone)
    try {
      const accepted = await this.acceptedPrompt(request, digest, signal)
      if (accepted !== undefined) return accepted
    } catch (error: unknown) {
      if (aborted(signal)) return cancelled()
      return failure('prompt-unavailable', 'cannot verify ordinary prompt admission', { reason: String(error) })
    }
    const found = await this.agentFor(request.sessionId)
    if (!found.ok) return found
    const agent = found.value

    const commandLine = request.content.length === 1 && request.content[0]?.type === 'text'
      && request.content[0].text.startsWith('/')
      ? request.content[0].text
      : undefined
    if (commandLine !== undefined) {
      const commands = this.ctx.get('commands')
      if (commands === undefined) {
        return failure('unknown-command', 'this deployment mounts no command registry')
      }
      try {
        const execution = await commands.execute(agent, commandLine, [], signal)
        if (execution === undefined) {
          // Preserve a recognized skill gesture for dsh-tool-skill's pre-step
          // owner; every other unmatched slash line remains a command error.
          const skillPrompt = await this.admitUnknownCommandAsSkill(commandLine, agent, signal)
          if (skillPrompt === undefined) {
            return failure(
              'unknown-command',
              `unknown command: ${commandLine.split(/\s/u, 1)[0]}`,
            )
          }
          request = { ...request, content: [{ type: 'text', text: skillPrompt }] }
        } else {
          if (execution.result.kind === 'error') {
            return failure('command-error', execution.result.text)
          }
          return success({
            accepted: true,
            command: {
              kind: 'success',
              ...execution.result.text === undefined ? {} : { text: execution.result.text },
            },
          })
        }
      } catch (error: unknown) {
        if (aborted(signal)) return cancelled()
        return failure('command-error', error instanceof Error ? error.message : String(error))
      }
    }
    const selection = this.selectionFor(agent).current
    if (!this.ctx.llm.listProviders().some(provider => provider.id === selection.provider)) {
      return failure(
        'model-unavailable',
        `no adapter serves provider "${selection.provider}"; select a model for this session`,
        { provider: selection.provider, model: selection.model },
      )
    }
    // The Ark host path mirrors the controller: empty prompts never start a turn.
    const hasContent = request.content.some(
      part => part.type !== 'text' || part.text.trim().length > 0,
    )
    if (!hasContent) {
      return failure(
        'bad-request',
        'prompt content must include non-whitespace text or an attachment',
        {},
      )
    }
    const admit = async (): Promise<SessionRemoteResult<SessionRemotePromptValue>> => {
      try {
        signal.throwIfAborted()
        const receipt = this.promptReceipt(agent.session, request.invocationId)
        if (receipt !== undefined) {
          return this.receiptConflict(receipt, digest) ?? await this.confirmPrompt(agent.session, request.invocationId)
        }
        if (this.ctx.get('sessionPersistence') === undefined) {
          return failure('prompt-unavailable', 'ordinary prompts require a persistence owner')
        }
        // Ark 定制：图片一律允许上传，能否识别由模型自行决定；不再按模型模态拦截。
        const content = await this.durablePromptContent(request.content)
        signal.throwIfAborted()
        const source: MessageSource = {
          kind: 'user',
          invocationId: request.invocationId,
          promptDigest: digest,
          ...(canonicalTimeZone === undefined ? {} : { clientTimeZone: canonicalTimeZone }),
        }
        const message: UserMessage = createUserMessage({ content, source })
        this.assertPromptAdmission(request.sessionId, agent)
        try {
          if (request.mode === 'steer') agent.steer(message)
          else agent.followup(message)
        } catch (error: unknown) {
          // A reentrant observer can throw or cancel after the log append committed.
          if (this.promptReceipt(agent.session, request.invocationId) === undefined) throw error
        }
        if (this.promptReceipt(agent.session, request.invocationId) === undefined) throw new Error('inbox did not record prompt acceptance')
        return await this.confirmPrompt(agent.session, request.invocationId)
      } catch (error: unknown) {
        if (aborted(signal)) return cancelled()
        if (error instanceof AttachmentError) {
          return failure('attachment-error', error.message, { reason: error.code })
        }
        return failure('agent-busy', 'prompt rejected', { reason: String(error) })
      }
    }
    return this.serializeAdmission(agent, admit)
  }

  /** Return bytes only for an image referenced by the addressed Session log. */
  async attachment(
    request: SessionRemoteAttachmentRequest,
    signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemoteAttachmentValue>> {
    if (aborted(signal)) return cancelled()
    try {
      const state = await this.readSessionState(request.sessionId, signal)
      const ref = referencedImage(state.events, request.attachmentId)
      if (ref === undefined) {
        return failure(
          'attachment-error',
          'Image is not referenced by this session.',
          { reason: 'ATTACHMENT_NOT_REFERENCED' },
        )
      }
      const stored = await this.ctx.attachments.readImage(ref, signal)
      return success({
        attachment: stored.ref,
        data: Buffer.from(stored.data).toString('base64'),
      })
    } catch (error: unknown) {
      if (aborted(signal)) return cancelled()
      if (error instanceof ApiRemoteSessionNotFound) {
        return failure('session-not-found', error.message, { sessionId: request.sessionId })
      }
      if (error instanceof AttachmentError) {
        return failure('attachment-error', error.message, { reason: error.code })
      }
      return failure(
        'internal',
        `attachment authorization unavailable for session "${request.sessionId}": ${String(error)}`,
      )
    }
  }

  /** Validate one queue edit as text-only ContentBlock data. */
  private queueEditContent(content: readonly JsonValue[]): ContentBlock[] | undefined {
    const blocks: ContentBlock[] = []
    for (const value of content) {
      if (value === null || Array.isArray(value) || typeof value !== 'object') return undefined
      const block = value as Record<string, JsonValue>
      if (block.type !== 'text' || typeof block.text !== 'string') return undefined
      blocks.push({ type: 'text', text: block.text })
    }
    return blocks
  }

  /** Edit, remove, or immediately steer one exact pending inbox message. */
  updateQueue(
    request: SessionRemoteUpdateQueueRequest,
    signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemoteAcceptedValue>> {
    if (aborted(signal)) return settled(cancelled())
    const edited = request.action.kind === 'edit'
      ? this.queueEditContent(request.action.content)
      : undefined
    if (request.action.kind === 'edit' && edited === undefined) {
      return settled(failure(
        'attachment-error',
        'queue edits accept text content only',
        { reason: 'QUEUE_EDIT_NON_TEXT' },
      ))
    }
    if (edited !== undefined && !edited.some(block => block.type === 'text' && block.text.trim().length > 0)) {
      return settled(failure('invalid-argument', 'queue edit content must not be empty'))
    }
    const agent = this.ctx.agents.get(request.sessionId)
    // Upstream lets a continuable subagent's queue be edited, removed, and
    // steered; the child's inbox is its only turn queue, so mutating it here
    // is semantically correct. The shared ownership fence stays for every
    // other generic route (prompt, cancel, cold resume), so only an identity
    // with no live Agent at all — one that could not be a continuable child —
    // keeps rejecting below. A cold child has no live inbox to mutate, so it
    // rejects as queue-item-not-found rather than resuming under this route.
    if (agent === undefined) {
      return settled(failure(
        'queue-item-not-found',
        'queued item is no longer pending',
        { itemId: request.itemId },
      ))
    }
    const messageId = MessageId(request.itemId)
    const target = agent.inbox.nextTurn.some(message => message.id === messageId)
      ? 'next-turn'
      : agent.inbox.nextStep.some(message => message.id === messageId) ? 'next-step' : undefined
    const message = target === undefined
      ? undefined
      : (target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep)
        .find(candidate => candidate.id === messageId)
    if (target === undefined || message === undefined) {
      return settled(failure(
        'queue-item-not-found',
        'queued item is no longer pending',
        { itemId: request.itemId },
      ))
    }
    if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      return settled(failure(
        'steer-unavailable',
        'current turn no longer accepts steering',
        { itemId: request.itemId },
      ))
    }
    if (request.action.kind === 'edit') {
      agent.inbox.replace(messageId, freezeMessage({ ...message, content: edited as ContentBlock[] }))
    } else {
      agent.inbox.remove(messageId)
      if (request.action.kind === 'steer') agent.steer(message)
    }
    return settled(success({ accepted: true }))
  }

  /** Cancel the active ordinary turn while preserving queued input. */
  cancel(
    request: SessionRemoteCancelRequest,
    signal: AbortSignal,
  ): Promise<SessionRemoteResult<SessionRemoteAcceptedValue>> {
    if (aborted(signal)) return settled(cancelled())
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      return settled(failure(
        'session-not-found',
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId },
      ))
    }
    if (hasApiRemoteSubagentOwner(this.ctx, agent.session, agent)) {
      return settled(this.subagentFailure(request.sessionId))
    }
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return settled(success({ accepted: true }))
  }

  /**
   * Retire one archived resident only through the exact handle this Host owns.
   * The Workspace registry performs the subsequent descendant ordering,
   * persistence reservation check, durable delete, and account cleanup.
   */
  async retireArchivedSession(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return
    const handle = this.handles.get(sessionId)
    if (handle === undefined || handle.agent !== agent || !this.ctx.agents.roots().includes(agent)) {
      throw new WorkspaceSessionDeletionBlockedError(sessionId, 'resident')
    }

    let disposal: Promise<void> | undefined
    try {
      await agent.runMaintenance((maintenanceSignal) => {
        signal.throwIfAborted()
        maintenanceSignal.throwIfAborted()
        const currentHandle = this.handles.get(sessionId)
        const unsafe = currentHandle !== handle
          || handle.agent !== agent
          || this.ctx.agents.get(sessionId) !== agent
          || this.ctx.sessions.get(sessionId) !== agent.session
          || !this.ctx.agents.roots().includes(agent)
          || !this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
          || agent.status !== 'idle'
          || agent.inbox.hasPending
          || hasOpenTurn(agent.session)
          || (this.ctx.get('jobs')?.list(agent).some(job => job.ownerSession === sessionId) ?? false)
        if (unsafe) throw new WorkspaceSessionDeletionBlockedError(sessionId, 'resident')
        signal.throwIfAborted()
        disposal = handle.dispose()
        return Promise.resolve()
      })
    } finally {
      if (disposal !== undefined) await disposal
    }
  }
}

export default SessionRemoteOperationsService
