/**
 * Authoritative Native event projections and interactive response correlation.
 *
 * Durable Sessions, Agents, Workspaces, jobs, and projections remain owned by
 * their domain services. This package owns only their live Native projection,
 * the two reconnectable event sources, and the pending human-interaction table
 * paired with the exact response carrier.
 *
 * @module @deepseek-ai/dsh-host-native-events
 */

import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { API_REMOTE_FORWARDED_EVENTS } from '@deepseek-ai/dsh-api-remotes/events'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-credentials'
import type {
  ConnectionEventChannel,
  ConnectionEventFrame,
  ConnectionResponseReceipt,
} from '@deepseek-ai/dsh-host-connection'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { errorChain, type CallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  findToolCallArguments,
  isJsonValue,
  type JsonValue,
  type Session,
  type SessionEvent,
  type SessionEventMap,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import {
  workspaceDomainState,
  workspaceRecord,
  type Workspace,
  type WorkspaceId,
  type WorkspaceRecord,
  type WorkspaceRemoteView,
} from '@deepseek-ai/dsh-workspace'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Native event and interactive-response owner. */
    nativeEvents: NativeEventsService
  }
}

/** One pending inbox occurrence in the authoritative queue snapshot. */
export interface NativeQueuedInboxItem {
  readonly id: UserMessage['id']
  readonly placement: 'queued' | 'steering' | 'context'
  readonly message: UserMessage
}

/** Tool-owned render intent accompanying one live durable event. */
export type NativeToolEventView =
  | { readonly for: 'call'; readonly view: JsonValue }
  | { readonly for: 'result'; readonly view: JsonValue }

/** Public projection of a background job. */
export interface NativeJobView {
  readonly id: JobSnapshot['id']
  readonly kind: JobSnapshot['kind']
  readonly label: string
  readonly status: JobSnapshot['status']
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** Native mux-stream payloads. */
export type NativeMuxFrame =
  | NativeStreamBaselineFrame<'mux'>
  | { readonly type: 'session/event'; readonly sessionId: SessionId; readonly event: SessionEvent; readonly view?: NativeToolEventView }
  | { readonly type: 'session/subscribed'; readonly sessionId: SessionId; readonly lastSeq: number }
  | { readonly type: 'approval/requested'; readonly sessionId: SessionId; readonly approvalId: ApprovalRequestId; readonly toolName: string; readonly callId?: CallId; readonly reason?: string }
  | { readonly type: 'approval/resolved'; readonly sessionId: SessionId; readonly approvalId: ApprovalRequestId; readonly outcome: ApprovalOutcome }
  | { readonly type: 'question/requested'; readonly sessionId: SessionId; readonly questions: AskUserQuestionItem[] }
  | { readonly type: 'question/resolved'; readonly sessionId: SessionId; readonly questionRpcId: string; readonly outcome: 'answered' | 'cancelled' }
  | { readonly type: 'session/queue'; readonly sessionId: SessionId; readonly items: NativeQueuedInboxItem[] }
  | { readonly type: 'session/jobs'; readonly sessionId: SessionId; readonly jobs: NativeJobView[] }
  | { readonly type: 'session/projection'; readonly sessionId: SessionId; readonly key: string; readonly value: unknown; readonly seq: number }

/** Native Host-stream payloads. */
export type NativeHostFrame =
  | NativeStreamBaselineFrame<'host'>
  | {
    readonly type: 'host/session-added'
    readonly sessionId: SessionId
    readonly blank: boolean
    readonly parentSessionId?: SessionId
    readonly origin?: 'subagent'
    readonly cwd?: string
    readonly agentPreset?: string
  }
  | { readonly type: 'host/session-removed'; readonly sessionId: SessionId }
  | { readonly type: 'host/session-deleted'; readonly sessionId: SessionId; readonly archivedSessionIds: readonly SessionId[] }
  | { readonly type: 'host/session-status'; readonly sessionId: SessionId; readonly running: boolean }
  | { readonly type: 'host/agent-error'; readonly sessionId: SessionId; readonly message: string }
  | { readonly type: 'host/workspace-changed'; readonly workspace: WorkspaceRemoteView }
  | { readonly type: 'host/workspace-removed'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'host/workspace-order-changed'; readonly workspaceIds: readonly WorkspaceId[] }
  | { readonly type: 'host/archived-sessions-changed'; readonly archivedSessionIds: readonly SessionId[] }
  | { readonly type: 'host/remote-event'; readonly event: string; readonly args: JsonValue[] }

/** One explicit snapshot boundary for a reconnectable event generation. */
export interface NativeStreamBaselineFrame<Channel extends ConnectionEventChannel> {
  readonly [key: string]: unknown
  readonly type: 'stream/baseline'
  readonly channel: Channel
  readonly generation: string
  readonly phase: 'begin' | 'complete'
  readonly sessionIds?: readonly SessionId[]
}

interface PendingApproval {
  readonly rpcId: string
  readonly sessionId: SessionId
  readonly approvalId: ApprovalRequestId
  readonly toolName: string
  readonly callId?: CallId
  readonly reason?: string
  readonly resolve: (outcome: ApprovalOutcome) => void
}

interface PendingQuestion {
  readonly rpcId: string
  readonly sessionId: SessionId
  readonly questions: AskUserQuestionItem[]
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (error: UserQuestionError) => void
  readonly signal?: AbortSignal
  onAbort?: () => void
}

interface ClientResponse {
  readonly type: 'client-response'
  readonly rpcId: string
  readonly result:
    | { readonly ok: true; readonly value?: unknown }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: unknown } }
}

interface ApprovalResponse {
  readonly sessionId: string
  readonly approvalId: string
  readonly outcome: 'allowed-once' | 'rejected'
}

interface QuestionResponse {
  readonly sessionId: string
  readonly answer: {
    readonly answers: Array<{
      readonly id: string
      readonly selected: string[]
      readonly custom?: string
    }>
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function clientResponse(value: unknown): ClientResponse | undefined {
  const envelope = record(value)
  const result = record(envelope?.result)
  if (envelope?.type !== 'client-response' || typeof envelope.rpcId !== 'string'
    || typeof result?.ok !== 'boolean') return undefined
  if (result.ok) {
    return {
      type: 'client-response',
      rpcId: envelope.rpcId,
      result: { ok: true, ...Object.hasOwn(result, 'value') ? { value: result.value } : {} },
    }
  }
  const error = record(result.error)
  if (typeof error?.code !== 'string' || typeof error.message !== 'string'
    || !Object.hasOwn(error, 'details')) return undefined
  return {
    type: 'client-response',
    rpcId: envelope.rpcId,
    result: {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    },
  }
}

function approvalResponse(value: unknown): ApprovalResponse | undefined {
  const payload = record(value)
  if (typeof payload?.sessionId !== 'string' || payload.sessionId.length === 0
    || typeof payload.approvalId !== 'string' || payload.approvalId.length === 0
    || (payload.outcome !== 'allowed-once' && payload.outcome !== 'rejected')) return undefined
  return {
    sessionId: payload.sessionId,
    approvalId: payload.approvalId,
    outcome: payload.outcome,
  }
}

function questionResponse(value: unknown): QuestionResponse | undefined {
  const payload = record(value)
  const answer = record(payload?.answer)
  if (typeof payload?.sessionId !== 'string' || payload.sessionId.length === 0
    || !Array.isArray(answer?.answers)) return undefined
  const answers: QuestionResponse['answer']['answers'] = []
  for (const candidate of answer.answers) {
    const item = record(candidate)
    if (typeof item?.id !== 'string' || !Array.isArray(item.selected)
      || !item.selected.every(value => typeof value === 'string')
      || (item.custom !== undefined && typeof item.custom !== 'string')) return undefined
    answers.push({
      id: item.id,
      selected: item.selected,
      ...item.custom === undefined ? {} : { custom: item.custom },
    })
  }
  return { sessionId: payload.sessionId, answer: { answers } }
}

/** Maximum queued frames retained by one socket generation. */
export const NATIVE_EVENT_QUEUE_MAX_FRAMES = 4_096

/** Maximum encoded frame bytes retained by one socket generation. */
export const NATIVE_EVENT_QUEUE_MAX_BYTES = 8 * 1024 * 1024

class NativeEventQueueError extends Error {
  readonly code: 'EVENT_QUEUE_OVERFLOW' | 'EVENT_FRAME_ENCODING_FAILED'
  readonly details: Readonly<Record<string, number | string>>

  constructor(
    code: NativeEventQueueError['code'],
    message: string,
    details: NativeEventQueueError['details'],
  ) {
    super(message)
    this.name = 'NativeEventQueueError'
    this.code = code
    this.details = details
  }
}

interface QueuedFrame {
  readonly frame: ConnectionEventFrame
  readonly bytes: number
}

/**
 * Single-consumer bounded ring joining synchronous Host events to one socket.
 * Overflow fails that generation so reconnect baselines/history recover every
 * durable or replayable frame; no event class is silently discarded.
 */
class FrameQueue {
  private readonly buffer: Array<QueuedFrame | undefined>
  private head = 0
  private tail = 0
  private size = 0
  private bufferedBytes = 0
  private waiter: (() => void) | undefined
  private done = false
  private failure: NativeEventQueueError | undefined

  private readonly maximumFrames = NATIVE_EVENT_QUEUE_MAX_FRAMES
  private readonly maximumBytes = NATIVE_EVENT_QUEUE_MAX_BYTES

  constructor() {
    this.buffer = Array.from(
      { length: this.maximumFrames },
      (): QueuedFrame | undefined => undefined,
    )
  }

  push(item: ConnectionEventFrame): void {
    if (this.done || this.failure !== undefined) return
    let bytes: number
    try {
      bytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
    } catch (error) {
      this.fail(new NativeEventQueueError(
        'EVENT_FRAME_ENCODING_FAILED',
        `native event frame could not be encoded: ${String(error)}`,
        { maximumFrames: this.maximumFrames, maximumBytes: this.maximumBytes },
      ))
      return
    }
    if (this.size >= this.maximumFrames || bytes > this.maximumBytes
      || this.bufferedBytes + bytes > this.maximumBytes) {
      this.fail(new NativeEventQueueError(
        'EVENT_QUEUE_OVERFLOW',
        'native event socket generation exceeded its bounded queue',
        {
          maximumFrames: this.maximumFrames,
          maximumBytes: this.maximumBytes,
          queuedFrames: this.size,
          queuedBytes: this.bufferedBytes,
          incomingBytes: bytes,
        },
      ))
      return
    }
    this.buffer[this.tail] = { frame: item, bytes }
    this.tail = (this.tail + 1) % this.maximumFrames
    this.size += 1
    this.bufferedBytes += bytes
    this.waiter?.()
  }

  end(): void {
    this.done = true
    this.waiter?.()
  }

  async * iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<ConnectionEventFrame> {
    const onAbort = (): void => { this.waiter?.() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        if (signal.aborted) return
        const frame = this.take()
        if (frame !== undefined) {
          yield frame
          continue
        }
        if (this.done) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.buffer.fill(undefined)
      this.size = 0
      this.bufferedBytes = 0
      cleanup()
    }
  }

  private fail(error: NativeEventQueueError): void {
    if (this.done || this.failure !== undefined) return
    this.failure = error
    this.waiter?.()
  }

  private take(): ConnectionEventFrame | undefined {
    if (this.failure !== undefined) throw this.failure
    if (this.size === 0) return undefined
    const queued = this.buffer[this.head]
    if (queued === undefined) throw new Error('native event queue ring invariant failed')
    this.buffer[this.head] = undefined
    this.head = (this.head + 1) % this.maximumFrames
    this.size -= 1
    this.bufferedBytes -= queued.bytes
    return queued.frame
  }
}

function eventFrame(
  payload: NativeMuxFrame | NativeHostFrame,
  rpcId: string = randomUUID(),
): ConnectionEventFrame {
  return { rpcId, payload: payload }
}

function requestedFrame(pending: PendingApproval): ConnectionEventFrame {
  return eventFrame({
    type: 'approval/requested',
    sessionId: pending.sessionId,
    approvalId: pending.approvalId,
    toolName: pending.toolName,
    ...pending.callId === undefined ? {} : { callId: pending.callId },
    ...pending.reason === undefined ? {} : { reason: pending.reason },
  }, pending.rpcId)
}

function sessionBlank(session: Session): boolean {
  return !session.events.some(event => event.type === 'turn/start')
}

function sessionListFields(header: SessionHeader, events: readonly SessionEvent[]): {
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
  readonly agentPreset?: string
} {
  const agentPreset = resolveSessionPreset({ header, events })
  return {
    ...header.parentSession === undefined ? {} : { parentSessionId: header.parentSession },
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...agentPreset === undefined ? {} : { agentPreset },
  }
}

function jobViews(snapshots: readonly JobSnapshot[]): NativeJobView[] {
  return snapshots.map(job => ({
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    ...job.detail === undefined ? {} : { detail: job.detail },
    startedAt: job.startedAt,
    ...job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt },
  }))
}

function workspaceView(workspace: Workspace): WorkspaceRemoteView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

function changedWorkspaceView(workspaceId: string, value: unknown): WorkspaceRemoteView {
  const record: WorkspaceRecord = workspaceRecord.parse(value)
  return {
    workspaceId: workspaceId as WorkspaceId,
    path: record.path,
    title: record.title,
    sessionIds: [...record.sessionIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function jsonArgs(event: string, args: readonly unknown[]): JsonValue[] {
  for (const [index, arg] of args.entries()) {
    if (!isJsonValue(arg)) {
      throw new Error(`forwarded host event "${event}" argument ${String(index)} is not lossless JSON data`)
    }
  }
  return args as JsonValue[]
}

function toolEventView(
  ctx: Context,
  event: SessionEvent,
  argsFor: (callId: string) => unknown,
  agent: Agent | undefined,
): NativeToolEventView | undefined {
  const tools = ctx.get('tools')
  if (tools === undefined) return undefined
  try {
    if (event.type === 'tool/call') {
      const data = event.data
      const view = tools.get(data.name, agent)?.presentCall?.(JSON.parse(data.arguments))
      if (view === undefined || !isJsonValue(view)) return undefined
      return { for: 'call', view: view as unknown as JsonValue }
    }
    if (event.type === 'tool/result') {
      const { message, meta } = event.data
      const result = message.content[0]
      const call = argsFor(message.source.callId) as { name: string; args: unknown } | undefined
      if (call === undefined) return undefined
      const view = tools.get(call.name, agent)?.presentResult?.(call.args, {
        content: result.content,
        isError: result.isError === true,
        ...meta === undefined ? {} : { meta },
      })
      if (view === undefined || !isJsonValue(view)) return undefined
      return { for: 'result', view: view as unknown as JsonValue }
    }
  } catch (error: unknown) {
    ctx.logger.warn(`host-native-events presenter failed for ${event.type}: ${String(error)}`)
  }
  return undefined
}

function queueItems(
  agent: Agent,
  splice?: SessionEventMap['agent/inbox/spliced'],
): NativeQueuedInboxItem[] {
  const project = (target: 'next-turn' | 'next-step'): readonly UserMessage[] => {
    const messages = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep
    return splice?.target === target
      ? messages.toSpliced(splice.start, splice.removedCount ?? 0, ...splice.inserted)
      : messages
  }
  return [
    ...project('next-turn').map(message => ({ id: message.id, placement: 'queued' as const, message })),
    ...project('next-step').map(message => ({
      id: message.id,
      placement: message.source.kind === 'user' ? 'steering' as const : 'context' as const,
      message,
    })),
  ]
}

function matchesQuestions(
  payload: QuestionResponse,
  pending: PendingQuestion,
): boolean {
  if (payload.sessionId !== pending.sessionId) return false
  if (payload.answer.answers.length !== pending.questions.length) return false
  return payload.answer.answers.every((answer, index) => {
    const question = pending.questions[index] as AskUserQuestionItem
    if (answer.id !== question.id) return false
    if (new Set(answer.selected).size !== answer.selected.length) return false
    const custom = answer.custom?.trim()
    if (custom !== undefined && custom === '') return false
    if (question.multiSelect !== true) {
      if (custom !== undefined && answer.selected.length > 0) return false
      if (answer.selected.length > 1) return false
    }
    const labels = new Set(question.options?.map(option => option.label) ?? [])
    return answer.selected.every(label => labels.has(label))
  })
}

/** Sole Host owner for Native event projection and answer correlation. */
export class NativeEventsService extends Service {
  static inject = ['agents', 'connection', 'sessions', 'userQuestions', 'workspaceRegistry']

  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly muxQueues = new Set<FrameQueue>()

  constructor(ctx: Context) {
    super(ctx, 'nativeEvents')
    ctx.connection.events.handle('mux', signal => this.openMux(signal))
    ctx.connection.events.handle('host', signal => this.openHost(signal))
    ctx.connection.responses.handle((message, signal) => this.respond(message, signal))

    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.onChanged((session, key, value, seq) => {
        this.broadcast({ type: 'session/projection', sessionId: session.id, key, value, seq })
      })
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'agent/inbox/spliced') return
      const agent = ctx.agents.get(session.id)
      if (agent?.session !== session) return
      this.broadcast({ type: 'session/queue', sessionId: session.id, items: queueItems(agent, event.data) })
    })

    const disposeQuestions = ctx.userQuestions.registerProvider({
      ask: request => this.askQuestion(request),
    })
    ctx.effect(() => () => {
      disposeQuestions()
      for (const pending of [...this.pendingQuestions.values()]) {
        this.claimQuestion(pending, 'cancelled')
        pending.reject(new UserQuestionError(
          'native user-questions provider was disposed', 'ASK_ABORTED'))
      }
      for (const pending of [...this.pendingApprovals.values()]) pending.resolve('cancelled')
      for (const queue of this.muxQueues) queue.end()
      this.muxQueues.clear()
    }, 'host-native-events: pending interactions')

    if (ctx.get('approval') !== undefined) this.registerApprovalAnswerer()
  }

  /**
   * Test whether one Session still owns an answerable human interaction.
   * @param sessionId - Session identity whose pending questions and approvals are inspected.
   * @returns whether at least one answerable interaction remains pending.
   */
  hasPendingSession(sessionId: SessionId): boolean {
    return [...this.pendingQuestions.values()].some(pending => pending.sessionId === sessionId)
      || [...this.pendingApprovals.values()].some(pending => pending.sessionId === sessionId)
  }

  private broadcast(payload: NativeMuxFrame): void {
    const envelope = eventFrame(payload)
    for (const queue of this.muxQueues) queue.push(envelope)
  }

  private askQuestion(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const sessionId = request.agent?.id
    if (sessionId === undefined) {
      return Promise.reject(new UserQuestionError(
        'native user interaction requires an agent-owned session', 'ASK_MISSING_AGENT'))
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(new UserQuestionError(
        'ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
    }
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const pending: PendingQuestion = {
        rpcId: randomUUID(),
        sessionId,
        questions: request.questions,
        resolve,
        reject,
        ...request.signal === undefined ? {} : { signal: request.signal },
      }
      const onAbort = (): void => {
        this.claimQuestion(pending, 'cancelled')
        reject(new UserQuestionError(
          'ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
      }
      pending.onAbort = onAbort
      this.pendingQuestions.set(pending.rpcId, pending)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      const envelope = eventFrame({
        type: 'question/requested',
        sessionId,
        questions: request.questions,
      }, pending.rpcId)
      for (const queue of this.muxQueues) queue.push(envelope)
    })
  }

  private claimQuestion(pending: PendingQuestion, outcome: 'answered' | 'cancelled'): void {
    if (!this.pendingQuestions.delete(pending.rpcId)) return
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    this.broadcast({
      type: 'question/resolved',
      sessionId: pending.sessionId,
      questionRpcId: pending.rpcId,
      outcome,
    })
  }

  private registerApprovalAnswerer(): void {
    this.ctx.on('approval/request', (request, next) => {
      if (request.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')
      const claimed = new Set<ApprovalRequestId>()
      for (const entry of this.pendingApprovals.values()) claimed.add(entry.approvalId)
      const decided = new Set<ApprovalRequestId>()
      let approvalId: ApprovalRequestId | undefined
      for (let index = request.agent.session.events.length - 1; index >= 0; index -= 1) {
        const event = request.agent.session.events[index] as SessionEvent
        if (event.type === 'approval/decided') {
          decided.add(event.data.id)
        } else if (event.type === 'approval/asked') {
          if (decided.has(event.data.id) || claimed.has(event.data.id)) continue
          if ((request.callId ?? null) !== (event.data.callId ?? null)) continue
          approvalId = event.data.id
          break
        }
      }
      if (approvalId === undefined) return next()
      const id = approvalId
      return new Promise<ApprovalOutcome>((resolve) => {
        const settle = (outcome: ApprovalOutcome): void => {
          if (!this.pendingApprovals.delete(pending.rpcId)) return
          request.signal?.removeEventListener('abort', onAbort)
          this.broadcast({
            type: 'approval/resolved',
            sessionId: pending.sessionId,
            approvalId: id,
            outcome,
          })
          resolve(outcome)
        }
        const onAbort = (): void => { settle('cancelled') }
        const pending: PendingApproval = {
          rpcId: randomUUID(),
          sessionId: request.agent.session.id,
          approvalId: id,
          toolName: request.toolName,
          ...request.callId === undefined ? {} : { callId: request.callId },
          ...request.reason === undefined ? {} : { reason: request.reason },
          resolve: settle,
        }
        this.pendingApprovals.set(pending.rpcId, pending)
        request.signal?.addEventListener('abort', onAbort, { once: true })
        const envelope = requestedFrame(pending)
        for (const queue of this.muxQueues) queue.push(envelope)
      })
    })
  }

  private respond(message: unknown, signal: AbortSignal): ConnectionResponseReceipt {
    signal.throwIfAborted()
    const envelope = clientResponse(message)
    if (envelope === undefined) return { accepted: false, reason: 'bad-response' }
    const approval = this.pendingApprovals.get(envelope.rpcId)
    if (approval !== undefined) {
      if (!envelope.result.ok) return { accepted: false, reason: 'bad-response' }
      const payload = approvalResponse(envelope.result.value)
      if (payload === undefined
        || payload.sessionId !== approval.sessionId
        || payload.approvalId !== approval.approvalId) {
        return { accepted: false, reason: 'bad-response' }
      }
      signal.throwIfAborted()
      approval.resolve(payload.outcome)
      return { accepted: true }
    }

    const pending = this.pendingQuestions.get(envelope.rpcId)
    if (pending === undefined) return { accepted: false, reason: 'not-pending' }
    if (!envelope.result.ok) {
      if (envelope.result.error.code !== 'cancelled') {
        return { accepted: false, reason: 'bad-response' }
      }
      signal.throwIfAborted()
      this.claimQuestion(pending, 'cancelled')
      pending.reject(new UserQuestionError(
        'the user cancelled ask_user_question', 'ASK_CANCELLED'))
      return { accepted: true }
    }
    const payload = questionResponse(envelope.result.value)
    if (payload === undefined || !matchesQuestions(payload, pending)) {
      return { accepted: false, reason: 'bad-response' }
    }
    signal.throwIfAborted()
    this.claimQuestion(pending, 'answered')
    pending.resolve({
      answers: payload.answer.answers.map(answer => ({
        id: answer.id,
        selected: answer.selected,
        ...answer.custom === undefined ? {} : { custom: answer.custom },
      })),
    })
    return { accepted: true }
  }

  private openMux(signal: AbortSignal): AsyncIterable<ConnectionEventFrame> {
    const queue = new FrameQueue()
    this.muxQueues.add(queue)
    const generation = randomUUID()
    const sessions = this.ctx.sessions.list()
    const sessionIds = sessions.map(session => session.id)
    queue.push(eventFrame({
      type: 'stream/baseline',
      channel: 'mux',
      generation,
      phase: 'begin',
    }))
    for (const session of sessions) {
      queue.push(eventFrame({
        type: 'session/subscribed',
        sessionId: session.id,
        lastSeq: session.seq - 1,
      }))
    }
    for (const pending of this.pendingQuestions.values()) {
      queue.push(eventFrame({
        type: 'question/requested',
        sessionId: pending.sessionId,
        questions: pending.questions,
      }, pending.rpcId))
    }
    for (const pending of this.pendingApprovals.values()) queue.push(requestedFrame(pending))
    for (const session of sessions) {
      const agent = this.ctx.agents.get(session.id)
      if (agent?.session === session && agent.inbox.hasPending) {
        queue.push(eventFrame({
          type: 'session/queue',
          sessionId: session.id,
          items: queueItems(agent),
        }))
      }
    }
    const jobs = this.ctx.get('jobs')
    if (jobs !== undefined) {
      for (const session of sessions) {
        const views = jobViews(jobs.list(this.ctx.agents.get(session.id)))
        if (views.length > 0) {
          queue.push(eventFrame({ type: 'session/jobs', sessionId: session.id, jobs: views }))
        }
      }
    }

    const openCalls = new Map<SessionId, Map<string, { name: string; args: unknown }>>()
    const disposers = [
      this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
        if (event.type === 'tool/call') {
          const data = event.data
          try {
            let table = openCalls.get(session.id)
            if (table === undefined) {
              table = new Map<string, { name: string; args: unknown }>()
              openCalls.set(session.id, table)
            }
            table.set(data.callId, { name: data.name, args: JSON.parse(data.arguments) })
          } catch {
            // The event still ships without a specialized result view.
          }
        } else if (event.type === 'turn/end') {
          openCalls.delete(session.id)
        }
        const agent = this.ctx.agents.get(session.id)
        const view = toolEventView(
          this.ctx,
          event,
          callId => openCalls.get(session.id)?.get(callId)
            ?? findToolCallArguments(session.events, callId),
          agent,
        )
        queue.push(eventFrame({
          type: 'session/event',
          sessionId: session.id,
          event,
          ...view === undefined ? {} : { view },
        }))
      }),
      this.ctx.on('session/created', (session: Session) => {
        queue.push(eventFrame({
          type: 'session/subscribed',
          sessionId: session.id,
          lastSeq: session.seq - 1,
        }))
        const views = jobs === undefined ? [] : jobViews(jobs.list(this.ctx.agents.get(session.id)))
        if (views.length > 0) {
          queue.push(eventFrame({ type: 'session/jobs', sessionId: session.id, jobs: views }))
        }
      }),
      this.ctx.on('session/disposed', (session: Session) => { openCalls.delete(session.id) }),
      ...jobs === undefined ? [] : [jobs.onJobsChanged((owner) => {
        if (owner !== undefined) {
          queue.push(eventFrame({
            type: 'session/jobs',
            sessionId: owner.id,
            jobs: jobViews(jobs.list(owner)),
          }))
          return
        }
        for (const session of this.ctx.sessions.list()) {
          queue.push(eventFrame({
            type: 'session/jobs',
            sessionId: session.id,
            jobs: jobViews(jobs.list(this.ctx.agents.get(session.id))),
          }))
        }
      })],
    ]
    queue.push(eventFrame({
      type: 'stream/baseline',
      channel: 'mux',
      generation,
      phase: 'complete',
      sessionIds,
    }))
    return queue.iterate(signal, () => {
      this.muxQueues.delete(queue)
      for (const dispose of disposers) dispose()
    })
  }

  private openHost(signal: AbortSignal): AsyncIterable<ConnectionEventFrame> {
    const queue = new FrameQueue()
    const generation = randomUUID()
    const sessions = this.ctx.sessions.list()
    const sessionIds = sessions.map(session => session.id)
    queue.push(eventFrame({
      type: 'stream/baseline',
      channel: 'host',
      generation,
      phase: 'begin',
    }))
    const committedWorkspaces = this.ctx.workspaceRegistry.list()
    const committedWorkspaceIds = new Set(committedWorkspaces.map(workspace => String(workspace.id)))
    let committedWorkspaceOrder = committedWorkspaces.map(workspace => workspace.id)
    for (const session of sessions) {
      queue.push(eventFrame({
        type: 'host/session-status',
        sessionId: session.id,
        running: this.ctx.agents.get(session.id)?.status === 'running',
      }))
    }
    const disposers = [
      this.ctx.on('workspace/archived-sessions-changed', (archivedSessionIds: readonly SessionId[]) => {
        queue.push(eventFrame({
          type: 'host/archived-sessions-changed',
          archivedSessionIds: [...archivedSessionIds],
        }))
      }),
      this.ctx.on('workspace/session-deleted', (
        sessionId: SessionId,
        archivedSessionIds: readonly SessionId[],
      ) => {
        queue.push(eventFrame({
          type: 'host/session-deleted',
          sessionId,
          archivedSessionIds: [...archivedSessionIds],
        }))
      }),
      this.ctx.on('session/created', (session: Session) => {
        queue.push(eventFrame({
          type: 'host/session-added',
          sessionId: session.id,
          blank: sessionBlank(session),
          ...sessionListFields(session.header, session.events),
        }))
      }),
      this.ctx.on('session/disposed', (session: Session) => {
        queue.push(eventFrame({ type: 'host/session-removed', sessionId: session.id }))
      }),
      this.ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: AgentStatus }) => {
        queue.push(eventFrame({
          type: 'host/session-status',
          sessionId: agent.id,
          running: status === 'running',
        }))
      }),
      this.ctx.on('agent/error', ({ agent, error }: { agent: Agent; error: unknown }) => {
        queue.push(eventFrame({
          type: 'host/agent-error',
          sessionId: agent.id,
          message: errorChain(error),
        }))
      }),
      this.ctx.on('domain/changed', (change) => {
        if (change.domain !== 'workspace') return
        if (change.table === '') {
          if (change.operation !== 'put') return
          const state = workspaceDomainState.parse(change.value)
          const orderChanged = state.workspaceIds.length === committedWorkspaceOrder.length
            && state.workspaceIds.every(workspaceId => committedWorkspaceIds.has(String(workspaceId)))
            && state.workspaceIds.some((workspaceId, index) => workspaceId !== committedWorkspaceOrder[index])
          for (const workspaceId of state.workspaceIds) {
            if (committedWorkspaceIds.has(workspaceId)) continue
            const workspace = this.ctx.workspaceRegistry.get(workspaceId)
            if (workspace === undefined) {
              throw new Error(`committed workspace registry references missing workspace "${workspaceId}"`)
            }
            committedWorkspaceIds.add(workspaceId)
            queue.push(eventFrame({ type: 'host/workspace-changed', workspace: workspaceView(workspace) }))
          }
          committedWorkspaceOrder = [...state.workspaceIds]
          if (orderChanged) {
            queue.push(eventFrame({
              type: 'host/workspace-order-changed',
              workspaceIds: [...state.workspaceIds] as WorkspaceId[],
            }))
          }
          return
        }
        if (change.table !== 'workspaces') return
        if (change.operation === 'deleted') {
          if (!committedWorkspaceIds.delete(change.key)) return
          queue.push(eventFrame({
            type: 'host/workspace-removed',
            workspaceId: change.key as WorkspaceId,
          }))
          return
        }
        if (!committedWorkspaceIds.has(change.key)) return
        queue.push(eventFrame({
          type: 'host/workspace-changed',
          workspace: changedWorkspaceView(change.key, change.value),
        }))
      }),
      ...API_REMOTE_FORWARDED_EVENTS.map(name => this.ctx.on(
        name,
        ((...args: unknown[]) => {
          queue.push(eventFrame({
            type: 'host/remote-event',
            event: name,
            args: jsonArgs(name, args),
          }))
        }),
      )),
    ]
    queue.push(eventFrame({
      type: 'stream/baseline',
      channel: 'host',
      generation,
      phase: 'complete',
      sessionIds,
    }))
    return queue.iterate(signal, () => { for (const dispose of disposers) dispose() })
  }
}

export default NativeEventsService
