/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  BlockAssembler,
  LlmError,
  createAssistantMessage,
  deepFreeze,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import type { Scope, Scoped } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { Context } from '@deepseek-ai/cordis'
import { RuntimeContextProjection } from './runtime-context.ts'
import { executeToolCalls } from './tool-calls.ts'
import { DEFAULT_AGENT_TURN_BUDGET } from './constants.ts'
import type { AgentTurnBudgetLimits } from './constants.ts'

/** One finite dimension of the authoritative per-turn execution budget. */
export type AgentTurnBudgetDimension = 'elapsed-ms' | 'steps' | 'model-attempts' | 'tool-calls'

/** Lossless accounting captured at a budget or quiescence boundary. */
export interface AgentTurnBudgetUsage {
  elapsedMs: number
  steps: number
  modelAttempts: number
  toolCalls: number
}

/** Durable terminal reason emitted when a finite turn budget is exhausted. */
export interface AgentTurnBudgetExhaustedReason {
  kind: 'budget-exhausted'
  dimension: AgentTurnBudgetDimension
  limit: number
  observed: number
  usage: AgentTurnBudgetUsage
}

/** Await boundary that remained live after its cancellation grace elapsed. */
export type AgentOperationStage =
  | 'system-prompt'
  | 'pre-step'
  | 'request-config'
  | 'prepare-call'
  | 'provider-iterator'
  | 'provider-close'
  | 'request-recovery'
  | 'tool-policy'
  | 'tool-body'
  | 'tool-finalize'
  | 'turn-stopping'

/** Exact process-local residual reported without pretending the agent is quiescent. */
export interface AgentQuiescenceResidual {
  code: 'AGENT_OPERATION_UNRESPONSIVE'
  abortKind: AgentCancelCause['kind'] | 'budget-exhausted' | 'unknown'
  graceMs: number
  operations: { stage: AgentOperationStage; count: number }[]
  budget: AgentTurnBudgetUsage
}

declare module '@deepseek-ai/dsh-session/types' {
  interface TurnEndReasonMap {
    /** The loop stopped before admitting work beyond one finite turn budget. */
    'budget-exhausted': AgentTurnBudgetExhaustedReason
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Cancellation reached its finite grace boundary while same-process code
     * was still executing. The Agent remains registered and non-quiescent.
     * Scope-filtered dispatch keys the carrier by `payload.agent`, preserving
     * its base filter and admitting unscoped listeners or listeners in that
     * agent's scope or an enclosing scope. This is a process-local notification.
     * @param payload - Live agent, current turn and step, and residual-operation accounting.
     * @mode emit
     */
    'agent/quiescence-timeout'(this: Scoped<Agent>, payload: {
      agent: Agent
      turn: number
      step: number
      residual: AgentQuiescenceResidual
    }): void
  }
}

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | {
    kind: 'running'
    abort: AbortController
    turn: number
    step: number
    wakeRequested: boolean
    budget?: TurnBudget
    residual: ReturnType<typeof Promise.withResolvers<AgentQuiescenceResidual>>
  }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; assembly: PromptAssembly }

type ActivityBoundary = {
  done: Promise<void>
  residual: Promise<AgentQuiescenceResidual>
}

/** Internal first-cause marker carried by the turn AbortSignal. */
class TurnBudgetExhaustedError extends Error {
  constructor(readonly reason: AgentTurnBudgetExhaustedReason) {
    super(`agent turn budget exhausted: ${reason.dimension} observed ${reason.observed}, limit ${reason.limit}`)
    this.name = 'TurnBudgetExhaustedError'
  }
}

/**
 * Bounded wait outcome for same-process code that ignored cancellation. The
 * operation is deliberately NOT detached: the Agent stays registered and
 * running until the underlying promise really settles.
 */
export class AgentQuiescenceTimeoutError extends Error {
  /** Identifies cancellation that exceeded its grace with operations still active. */
  readonly code = 'AGENT_OPERATION_UNRESPONSIVE'

  constructor(readonly residual: AgentQuiescenceResidual) {
    const operations = residual.operations.map(item => `${item.stage}×${item.count}`).join(', ')
    super(`agent cancellation did not quiesce within ${residual.graceMs}ms; still active: ${operations}`)
    this.name = 'AgentQuiescenceTimeoutError'
  }
}

/** Per-turn counter, deadline, and non-detaching cancellation monitor. */
class TurnBudget {
  private readonly startedAt = Date.now()
  private readonly operations = new Map<symbol, AgentOperationStage>()
  private readonly elapsedTimer: ReturnType<typeof setTimeout>
  private graceTimer: ReturnType<typeof setTimeout> | undefined
  private abortStartedAt: number | undefined
  private reportedResidual = false
  private closed = false
  private steps = 0
  private modelAttempts = 0
  private toolCalls = 0
  private _exhaustion: AgentTurnBudgetExhaustedReason | undefined

  constructor(
    private readonly limits: AgentTurnBudgetLimits,
    private readonly abort: AbortController,
    private readonly reportResidual: (residual: AgentQuiescenceResidual) => void,
  ) {
    this.abort.signal.addEventListener('abort', this.onAbort, { once: true })
    this.elapsedTimer = setTimeout(() => {
      if (!this.abort.signal.aborted) {
        this.markExhausted('elapsed-ms', this.limits.maxElapsedMs, this.usage.elapsedMs)
      }
    }, this.limits.maxElapsedMs)
  }

  get exhaustion(): AgentTurnBudgetExhaustedReason | undefined {
    return this._exhaustion
  }

  get usage(): AgentTurnBudgetUsage {
    return {
      elapsedMs: Math.max(0, Date.now() - this.startedAt),
      steps: this.steps,
      modelAttempts: this.modelAttempts,
      toolCalls: this.toolCalls,
    }
  }

  consumeStep(): void {
    this.consume('steps', 1)
  }

  consumeModelAttempt(): void {
    this.consume('model-attempts', 1)
  }

  consumeToolCalls(count: number): void {
    this.consume('tool-calls', count)
  }

  /** Await one same-process boundary without abandoning it after cancellation. */
  async monitor<T>(stage: AgentOperationStage, operation: () => PromiseLike<T> | T): Promise<T> {
    // Cancellation-aware cleanup (tool result materialization, iterator
    // return) is allowed to enter after abort. Its caller owns whether the
    // operation is still semantically admissible; this monitor only tracks
    // quiescence and must not suppress canonical aborted results.
    if (!this.abort.signal.aborted) this.checkElapsed()
    const token = Symbol(stage)
    this.operations.set(token, stage)
    if (this.abort.signal.aborted) this.armResidualDeadline()
    try {
      return await operation()
    } finally {
      this.operations.delete(token)
    }
  }

  close(): void {
    this.closed = true
    clearTimeout(this.elapsedTimer)
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer)
    this.abort.signal.removeEventListener('abort', this.onAbort)
  }

  private consume(dimension: Exclude<AgentTurnBudgetDimension, 'elapsed-ms'>, amount: number): void {
    this.abort.signal.throwIfAborted()
    this.checkElapsed()
    const current = dimension === 'steps'
      ? this.steps
      : dimension === 'model-attempts'
        ? this.modelAttempts
        : this.toolCalls
    const limit = dimension === 'steps'
      ? this.limits.maxSteps
      : dimension === 'model-attempts'
        ? this.limits.maxModelAttempts
        : this.limits.maxToolCalls
    const observed = current + amount
    if (observed > limit) {
      throw this.markExhausted(dimension, limit, observed)
    }
    if (dimension === 'steps') this.steps = observed
    else if (dimension === 'model-attempts') this.modelAttempts = observed
    else this.toolCalls = observed
  }

  private checkElapsed(): void {
    const elapsed = Math.max(0, Date.now() - this.startedAt)
    if (elapsed >= this.limits.maxElapsedMs) {
      throw this.markExhausted('elapsed-ms', this.limits.maxElapsedMs, elapsed)
    }
  }

  private markExhausted(
    dimension: AgentTurnBudgetDimension,
    limit: number,
    observed: number,
  ): TurnBudgetExhaustedError {
    if (this._exhaustion !== undefined) return new TurnBudgetExhaustedError(this._exhaustion)
    const reason: AgentTurnBudgetExhaustedReason = {
      kind: 'budget-exhausted',
      dimension,
      limit,
      observed,
      usage: this.usage,
    }
    this._exhaustion = reason
    const error = new TurnBudgetExhaustedError(reason)
    this.abort.abort(error)
    return error
  }

  private readonly onAbort = (): void => {
    this.abortStartedAt = Date.now()
    this.armResidualDeadline()
  }

  private armResidualDeadline(): void {
    if (this.closed || this.reportedResidual || this.graceTimer !== undefined) return
    const elapsed = this.abortStartedAt === undefined ? 0 : Math.max(0, Date.now() - this.abortStartedAt)
    const delay = Math.max(0, this.limits.cancellationGraceMs - elapsed)
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined
      if (this.closed || this.reportedResidual || this.operations.size === 0) return
      this.reportedResidual = true
      const counts = new Map<AgentOperationStage, number>()
      for (const stage of this.operations.values()) counts.set(stage, (counts.get(stage) ?? 0) + 1)
      const abortReason: unknown = this.abort.signal.reason
      const abortKind: AgentQuiescenceResidual['abortKind'] = abortReason instanceof TurnBudgetExhaustedError
        ? 'budget-exhausted'
        : typeof abortReason === 'object' && abortReason !== null && 'kind' in abortReason
          && (abortReason.kind === 'user' || abortReason.kind === 'parent'
            || abortReason.kind === 'hook' || abortReason.kind === 'disposed')
          ? abortReason.kind
          : 'unknown'
      this.reportResidual({
        code: 'AGENT_OPERATION_UNRESPONSIVE',
        abortKind,
        graceMs: this.limits.cancellationGraceMs,
        operations: [...counts].map(([stage, count]) => ({ stage, count })),
        budget: this.usage,
      })
    }, delay)
  }
}

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private activity: ActivityBoundary = {
    done: Promise.resolve(),
    residual: new Promise<AgentQuiescenceResidual>(() => undefined),
  }
  private closing = false

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  private readonly runtimeContext: RuntimeContextProjection

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    private readonly turnBudgetLimits: AgentTurnBudgetLimits = DEFAULT_AGENT_TURN_BUDGET,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (cause.kind === 'disposed') this.closing = true
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing) throw new Error(`agent "${this.id}" lifecycle is disposing`)
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activity = {
      done: done.promise,
      residual: new Promise<AgentQuiescenceResidual>(() => undefined),
    }
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake. The sole exception: while the
   * initiator scope is closing (teardown/HMR) no driver can start — the wake
   * is dropped and the phase converges back to idle.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.closing) return
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    // Narrowed idle phase captured before the running assignment so the
    // catch path below can converge back to it regardless of flow analysis.
    const { lastTurn } = this.phase
    const driver = Promise.withResolvers<void>()
    const residual = Promise.withResolvers<AgentQuiescenceResidual>()
    this.activity = { done: driver.promise, residual: residual.promise }
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: lastTurn,
      step: 0,
      wakeRequested: false,
      residual,
    })
    try {
      this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
    } catch {
      // The initiator scope is closing (teardown/HMR): no driver can start.
      // Converge the phase back to idle and settle the activity promise —
      // leaving it pending would wedge whenIdle() and every later wake on
      // this agent, deadlocking disposal.
      this.setPhase({ kind: 'idle', lastTurn })
      driver.resolve()
    }
  }

  async whenIdle(): Promise<void> {
    let activity: ActivityBoundary
    do {
      activity = this.activity
      const outcome = await Promise.race([
        activity.done.then(() => ({ kind: 'done' as const })),
        activity.residual.then(residual => ({ kind: 'residual' as const, residual })),
      ])
      if (outcome.kind === 'residual') throw new AgentQuiescenceTimeoutError(outcome.residual)
    } while (activity !== this.activity)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested, budget } = this.phase
        budget?.close()
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(
    target: InboxTarget,
    position: { turn: number; step: number },
    budget: TurnBudget,
  ): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const assembly = await budget.monitor(
      'system-prompt',
      () => this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal)),
    )
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    const context = this.runtimeContext.project(joinContextSections(sections), sections)
    const decision = await budget.monitor('pre-step', () => this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      }),
    ))
    signal.throwIfAborted()
    return decision.kind === 'reject' ? decision : { ...decision, assembly }
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    const budget = phase.budget = new TurnBudget(this.turnBudgetLimits, phase.abort, (residual) => {
      phase.residual.resolve(residual)
      this.dispatch.emit('agent/quiescence-timeout', {
        turn: phase.turn,
        step: phase.step,
        residual,
      })
    })
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step }, budget)
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        // A removed waking message or an enter decision rewritten to empty
        // still owns the initial turn boundary, but it spends no model call.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        budget.consumeStep()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          // max-tokens is sticky: once any step hits the ceiling, later steps
          // that complete normally must not downgrade the turn outcome.
          const stepEnd = await this.step(decision.assembly, budget)
          // max-tokens stays sticky: a later completed step must not
          // downgrade the turn outcome.
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await budget.monitor('turn-stopping', () => this.dispatch.serial('agent/turn-stopping', { turn, signal }))
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (budget.exhaustion !== undefined) {
        turnEnds = budget.exhaustion
        if (this.inbox.nextStep.length > 0) {
          this.inbox.splice('next-step', 0, this.inbox.nextStep.length, [])
        }
        // Follow-ups are separate user intent, not work owned by the exhausted
        // turn. Replay them under a fresh turn budget after this driver closes.
        phase.wakeRequested ||= this.inbox.nextTurn.length > 0
        return false
      }
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, anything
      // else flattens to `errorChain` text under the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      } finally {
        budget.close()
        delete phase.budget
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(assembly: PromptAssembly, budget: TurnBudget): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()
    const system = renderPrompt(assembly)

    while (true) {
      budget.consumeModelAttempt()
      const { request, preparedCall } = await this.buildRequest(
        turn, step, assembly.tools, system, this.session.deriveMessages(), signal, budget,
      )
      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []
      let sawFinish = false
      try {
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        const iterator = stream[Symbol.asyncIterator]()
        signal.throwIfAborted()
        let completed = false
        try {
          while (true) {
            const item = await budget.monitor('provider-iterator', () => iterator.next())
            if (item.done) {
              completed = true
              break
            }
            const chunk = item.value
            signal.throwIfAborted()
            sawFinish ||= chunk.type === 'finish'
            chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
            assembler.push(chunk)
          }
        } finally {
          if (!completed && iterator.return !== undefined) {
            await budget.monitor('provider-close', async () => {
              await iterator.return?.()
            })
          }
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        if (signal.aborted) {
          const content = assembler.interruptedBlocks()
          if (content.length > 0) {
            this.session.append('assistant/message', {
              turn,
              step,
              message: createAssistantMessage({
                content,
                source: { provider: request.provider, model: request.model },
              }),
              interrupted: true,
              ...assembler.usage === undefined ? {} : { usage: assembler.usage },
            }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
          }
        }
        throw error
      }
      const finish = sawFinish
        ? assembler.finish
        : {
          kind: 'error' as const,
          failure: {
            message: 'model stream closed without a terminal finish chunk',
            code: 'STREAM_CLOSED',
          },
        }
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        const action = await budget.monitor('request-recovery', () => this.dispatch.waterfall(
          'agent/request-error', {
            turn,
            step,
            provider: request.provider,
            failure: finish.failure,
            retryPolicy: preparedCall?.retryPolicy,
            signal,
          },
          () => Promise.resolve<RequestErrorAction>(undefined),
        ))
        signal.throwIfAborted()
        if (action?.kind !== 'retry') {
          throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
        }
        continue
      }

      const message = createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: request.provider,
          model: request.model,
          ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
        },
      })
      this.session.append(
        'assistant/message',
        {
          turn,
          step,
          message,
          ...assembler.usage === undefined ? {} : { usage: assembler.usage },
        },
        { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
      )
      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'completed' }
      // A cancellation fired by an assistant-message observer still owes one
      // synthetic call/result pair per requested tool. Do not replace that
      // replay contract with a budget check after cancellation has won.
      if (!signal.aborted) budget.consumeToolCalls(toolCalls.length)
      const { concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
        (stage, operation) => budget.monitor(stage, operation),
      )
      return concluded ? { kind: 'completed' } : null
    }
  }

  /**
   * Compose one frozen request and bind it to the adapter registration that
   * resolved its exact-model defaults.
   */
  private async buildRequest(
    turn: number,
    step: number,
    tools: GenerateOptions['tools'] & object,
    system: string,
    boundaryMessages: Message[],
    signal: AbortSignal,
    budget: TurnBudget,
  ): Promise<{ request: GenerateOptions; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // A loop instance starts from its declared route, restoring only an explicit
    // effort owned by that exact model. Later steps re-resolve marked defaults.
    const persistedHeader = session.requestHeader()
    const persistedConfig = persistedHeader?.config
    const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
    const reasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      && persistedHeader?.adapterDefaults?.reasoningEffort !== true
      ? persistedConfig.reasoningEffort
      : undefined
    const maxTokens = this.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await budget.monitor('request-config', () => this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    ))
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await budget.monitor('prepare-call', () => this.loopCtx.llm.prepareCall(proposedConfig, signal))
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()

    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...system ? { system } : {},
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.session.requestHeader()
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', { header, reason: 'change' })
    }

    const contextWindow = preparedCall?.context?.contextWindow
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    const request = markAgentLoopRequest(deepFreeze({
      ...header.config,
      messages: boundaryMessages,
      ...header.system !== undefined ? { system: header.system } : {},
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return { request, ...preparedCall === undefined ? {} : { preparedCall } }
  }
}
