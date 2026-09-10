/**
 * Tool execution pipeline: pre/guard/around/post policy, cancellation fusion,
 * result projection, and final notification. ToolRuntime owns this executor
 * and keeps the public `execute` and scheduler surface; the executor holds the
 * cancellation-sensitive staged state (deferred contexts, body-invoked flags,
 * fused signals) and receives the registry lookups it needs at construction.
 *
 * Caller context is never captured: every pipeline entry takes the caller's
 * {@link ToolRuntime} and its CALLING context, so waterfalls, events, and
 * effect binding resolve on the calling fiber, exactly as the original
 * `this.ctx` reads did. The staged scheduler entries invoked through
 * `[TOOL_RUNTIME_SCHEDULER]` receive the raw service instance and its root
 * context, matching the pre-split scheduler's captured-`this` binding.
 * @module @deepseek-ai/dsh-tools/src/executor
 */

import { Context } from '@deepseek-ai/cordis'
import { assertNever, deepFreeze, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue, UserMessage } from '@deepseek-ai/dsh-session'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
// Type-only: makes `ctx.get('approval')` resolve to the ApprovalService
// augmentation. The seam stays optional at runtime — see `serviceAsk`.
import type {} from '@deepseek-ai/dsh-user-approval'
import { RUN_CODE_NAME } from './code-mode.ts'
import { validateJsonSchemaValue } from './json-schema.ts'
import type {
  PreToolDecision,
  PostToolDecision,
  ScheduledToolDispatch,
  ScheduledToolPreparation,
  ToolDefinition,
  ToolErrorInfo,
  ToolExecution,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolExecutionSuccess,
  ToolExecutionToken,
  ToolRunContext,
  ToolRuntime,
} from './index.ts'
import type { ToolRegistry } from './registry.ts'

/** Canonical error code for cancellation after a tool body was invoked. */
export const TOOL_ABORTED = 'ABORTED'

/** Canonical error code for cancellation before a tool body was invoked. */
export const TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'

/**
 * Thrown (internally) when the model requests a tool that isn't registered.
 * Extends {@link HarnessError} (`code: 'UNKNOWN_TOOL'`) so an unknown-tool
 * failure is as routable as a tool-thrown one — retry/sandbox/replay code can
 * distinguish it from a tool body's own error.
 */
export class ToolNotFoundError extends HarnessError {
  /**
   * @param toolName - the name the caller asked for.
   * @param reachableFrom - how the model reaches this tool instead, when the
   *   name IS visible and only the presentation denies calling it directly.
   *   Omitted for a name that is registered nowhere.
   */
  constructor(toolName: string, reachableFrom?: string) {
    super(
      reachableFrom === undefined
        ? `unknown tool "${toolName}"`
        : `unknown tool "${toolName}": ${reachableFrom}`,
      'UNKNOWN_TOOL',
    )
    this.name = 'ToolNotFoundError'
  }
}

/** Thrown when a tool body or post-policy value violates its declared output. */
export class ToolOutputError extends HarnessError {
  /** Schema/value violations in validation order. */
  readonly violations: string[]

  constructor(toolName: string, violations: string[]) {
    super(`tool "${toolName}" returned invalid output: ${violations.join('; ')}`, 'INVALID_TOOL_OUTPUT')
    this.name = 'ToolOutputError'
    this.violations = violations
  }
}

/** Registry-owned live execution object; public pipeline views stay readonly. */
type MutableToolRunContext = Omit<ToolRunContext, 'signal'> & { signal: AbortSignal }

/** Caller cancellation and dispatch state kept outside the around-wrapper view. */
interface ToolCancellationState {
  readonly callerSignal: AbortSignal
  bodyInvoked: boolean
}

/** One dispatch-scoped fused signal plus listener cleanup after the body settles. */
interface FusedToolSignal {
  readonly signal: AbortSignal
  dispose(): void
}

/** Approval decision plus whether the approval channel reported cancellation. */
interface ToolAskResolution {
  readonly decision: Extract<PreToolDecision, { kind: 'allow' | 'deny' }>
  readonly approvalCancelled: boolean
}

/** Convert one projector exception into the canonical invalid-output failure. */
function projectionError(toolName: string, projector: 'render' | 'presentationMeta', error: unknown): ToolOutputError {
  return new ToolOutputError(toolName, [`output.${projector} failed: ${errorMessage(error)}`])
}

/** Snapshot one projector result before later durable-result materialization. */
function snapshotProjection<T>(toolName: string, projector: 'render' | 'presentationMeta', candidate: T): T {
  try {
    const detached = snapshotJsonValue(candidate)
    if (detached === undefined) {
      throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`])
    }
    return detached
  } catch (error: unknown) {
    if (error instanceof ToolOutputError) throw error
    throw projectionError(toolName, projector, error)
  }
}

/** Snapshot one body or policy value into the canonical invalid-output failure class. */
function snapshotToolValue(toolName: string, candidate: unknown): JsonValue {
  try {
    const detached = snapshotJsonValue(candidate)
    if (detached === undefined) throw new ToolOutputError(toolName, ['value is not lossless JSON'])
    return detached as JsonValue
  } catch (error: unknown) {
    if (error instanceof ToolOutputError) throw error
    throw new ToolOutputError(toolName, [`value snapshot failed: ${errorMessage(error)}`])
  }
}

/**
 * Best-effort human-readable message from an arbitrary thrown value: Error
 * instances use `.message`; non-Error objects with a string `message`
 * property (e.g. `throw { message: 'denied' }`) use it too; everything else
 * is stringified.
 * @param error - the thrown value.
 * @returns the best-effort message.
 */
export function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'object' && error !== null
      && 'message' in error && typeof error.message === 'string') {
      return error.message
    }
    return String(error)
  } catch {
    // A hostile thrown value can trap `instanceof`, property access, or string
    // coercion. Error normalization is the outermost safety boundary, so its
    // fallback must itself be total.
    return '<unprintable thrown value>'
  }
}

/** Derive one failure message from policy feedback without changing its rendered blocks. */
function failureMessageFromContent(content: ContentBlock[]): string {
  const text = content
    .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
    .join('\n')
  return text.length > 0 ? text : 'tool result blocked by post-execute policy'
}

/** Snapshot and freeze one durable tool-result projection or reject lossy data. */
function materializePresentation<T>(candidate: T): T {
  const detached = snapshotJsonValue(candidate)
  if (detached === undefined) {
    throw new TypeError('tool result must be losslessly JSON-serializable')
  }
  return deepFreeze(detached)
}

/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error: unknown): ToolErrorInfo | undefined {
  try {
    return error instanceof HarnessError ? { name: error.name, code: error.code } : undefined
  } catch {
    return undefined
  }
}

/**
 * Tool execution pipeline. Pre-policy, guards, around-dispatch, post-policy,
 * definition-owned content finalization, and final notification run here;
 * registration and presentation live in the {@link ToolRegistry} the executor
 * was constructed with. Public pipeline views stay on the service; this class
 * is the internal implementation.
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry

  /** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
  private deferredContexts = new WeakMap<ToolRunContext, UserMessage[]>()
  /** Executions whose tool body declared the current turn complete. */
  private concludingExecutions = new WeakSet<ToolExecution>()
  /** Original caller cancellation, kept outside the wrapper-mutable execution object. */
  private cancellationStates = new WeakMap<ToolRunContext, ToolCancellationState>()
  /** Definition-owned final content transform snapshotted before policy begins. */
  private contentFinalizers = new WeakMap<ToolRunContext, ToolDefinition['finalizeContent']>()
  /** Registry-normalized results and the exact dispatch that validated each value. */
  private readonly canonicalResults = new WeakMap<object, ToolExecutionToken>()

  constructor(registry: ToolRegistry) {
    this.registry = registry
  }

  /**
   * Execute through pre-policy, guards, around-dispatch, post-policy,
   * definition-owned content finalization, and final notification. Tool and
   * listener failures resolve as materialized error results; an invisible tool
   * reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
   * snapshot final observers receive. Cancellation
   * arriving after entry and before final result materialization skips a
   * not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
   * successful started outcome with `ABORTED`; already-started work is still
   * drained and may retain a tool-owned structured error.
   * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
   * @param ctx - the calling context.
   * @param exec - the typed same-process call input. The registry assigns its
   *   correlation token before policy begins.
   * @returns the materialized final result.
   */
  async execute(runtime: ToolRuntime, ctx: Context, exec: ToolExecutionInput): Promise<ToolExecutionResult> {
    return this.prepareExecution(runtime, ctx, exec, prepared => this.completeScheduledExecution(runtime, ctx, prepared))
  }

  private async completeScheduledExecution(
    runtime: ToolRuntime,
    ctx: Context,
    prepared: ScheduledToolPreparation,
  ): Promise<ToolExecutionResult> {
    switch (prepared.kind) {
      case 'dispatch': {
        const dispatched = await this.dispatchScheduledExecution(runtime, ctx, prepared.exec)
        return dispatched.kind === 'post-result'
          ? await this.finalizeScheduledExecution(runtime, ctx, prepared.exec, dispatched.result)
          : this.finishScheduledExecution(runtime, ctx, prepared.exec, dispatched.result)
      }
      case 'post-result':
        return await this.finalizeScheduledExecution(runtime, ctx, prepared.exec, prepared.result)
      case 'final-result':
        return this.finishScheduledExecution(runtime, ctx, prepared.exec, prepared.result)
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(prepared, 'scheduled tool preparation')
    }
  }

  private createExecution(exec: ToolExecutionInput): ScheduledToolPreparation | { kind: 'ready'; exec: MutableToolRunContext } {
    const deferredContexts: UserMessage[] = []
    const token = createExecutionToken()
    const callId = exec.callId
    const rootCallId = exec.rootCallId ?? callId
    const name = exec.name
    const agent = exec.agent
    const parent = exec.parent
    const signal = exec.signal
    // Distinguish a mode-collapsed call (visible in the scope, denied only by
    // the `code` collapse) from a genuinely unknown tool. A collapsed call is
    // deterministically denied, so it terminates BEFORE the extensible policy
    // pipeline: pre-execute listeners, approval `ask`, and guards must never
    // observe — or worse, approve — a call that can only fail. An unknown tool
    // keeps the historical dispatch-stage `UNKNOWN_TOOL` path so policy
    // listeners still see every name that reaches the registry.
    const visible = this.registry.get(name, agent)
    const collapsed = visible !== undefined && this.registry.collapses(name, agent, parent !== undefined)
    const concludingExecutions = this.concludingExecutions
    const base = {
      token,
      callId,
      rootCallId,
      name,
      signal,
      ...agent !== undefined ? { agent } : {},
      ...parent !== undefined ? { parent } : {},
      deferContext(context: UserMessage): void {
        deferredContexts.push(context)
      },
      concludeTurn(): void {
        concludingExecutions.add(this as unknown as ToolExecution)
      },
    }
    // Capture the finalizer BEFORE argument materialization: the
    // `finalizeContent` contract snapshots the callback when the call starts,
    // and an arguments getter can replace or clear the registered callback
    // during `snapshotJsonValue`. The collapse only decides whether the
    // CAPTURED callback is retained: the pre-dispatch abort path keeps it
    // (the cancellation contract routes aborted results through it — a getter
    // that aborts mid-materialization before an invalid-args failure lands in
    // the same retained path), while the `UNKNOWN_TOOL` denial and the
    // invalid-args failure of a NON-ABORTED collapsed call drop it (the call
    // could never execute).
    const capturedFinalizer = visible?.finalizeContent?.bind(visible)
    const finalizerFor = (): ToolDefinition['finalizeContent'] | undefined =>
      collapsed && !signal.aborted ? undefined : capturedFinalizer
    try {
      const detached = snapshotJsonValue(exec.arguments)
      if (detached === undefined) {
        throw new TypeError('tool execution arguments must be losslessly JSON-serializable')
      }
      const execution: MutableToolRunContext = { ...base, arguments: deepFreeze(detached) }
      this.deferredContexts.set(execution, deferredContexts)
      this.contentFinalizers.set(execution, finalizerFor())
      this.cancellationStates.set(execution, {
        callerSignal: signal,
        bodyInvoked: false,
      })
      if (collapsed) {
        // The collapse denies the call before the policy pipeline, but a
        // pre-dispatch abort still keeps the established cancellation
        // contract: `prepare`'s caller-cancellation check is skipped for
        // final-results, so honor the abort here instead of surfacing
        // `UNKNOWN_TOOL` on an already-cancelled call.
        if (signal.aborted) {
          return { kind: 'final-result', exec: execution, result: toolAbortedBeforeDispatchResult() }
        }
        // The name IS visible here, so the denial carries the route the model
        // must take instead. Without it the model reads a bare `unknown tool`
        // for a tool the prompt just declared and concludes the deployment is
        // broken rather than correcting itself.
        return {
          kind: 'final-result',
          exec: execution,
          result: toolErrorResult(new ToolNotFoundError(
            name,
            `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`,
          )),
        }
      }
      return { kind: 'ready', exec: execution }
    } catch (error: unknown) {
      const execution: MutableToolRunContext = { ...base, arguments: undefined }
      this.contentFinalizers.set(execution, finalizerFor())
      return { kind: 'final-result', exec: execution, result: toolErrorResult(error) }
    }
  }

  /**
   * Run the ordered pre-execute and monotonic guard stages for the scheduler.
   * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
   * @param ctx - the calling context.
   * @param input - the caller-supplied execution input.
   * @returns the prepared execution plus the next scheduler stage.
   * @internal
   */
  prepareScheduledExecution(runtime: ToolRuntime, ctx: Context, input: ToolExecutionInput): Promise<ScheduledToolPreparation> {
    return this.prepareExecution(runtime, ctx, input, prepared => prepared)
  }

  private async prepareExecution<T>(
    runtime: ToolRuntime,
    ctx: Context,
    input: ToolExecutionInput,
    next: (prepared: ScheduledToolPreparation) => T | PromiseLike<T>,
  ): Promise<T> {
    const created = this.createExecution(input)
    if (created.kind !== 'ready') return next(created)
    const exec = created.exec
    if (this.callerCancelled(exec)) {
      return next({ kind: 'final-result', exec, result: toolAbortedBeforeDispatchResult() })
    }
    try {
      const carrier = scopeTarget(runtime, exec.agent)
      const gate = await ctx.waterfall(
        carrier, 'tools/pre-execute', exec,
        () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
      )
      const askResolution: ToolAskResolution = gate.kind === 'ask'
        ? await this.serviceAsk(ctx, exec, gate)
        : { decision: gate, approvalCancelled: false }
      const { decision } = askResolution
      if (this.callerCancelled(exec) && askResolution.approvalCancelled) {
        return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
      }
      const denialReason = decision.kind === 'allow'
        ? this.registry.guardReason(exec)
        : decision.reason
      if (denialReason !== undefined) {
        return await next({
          kind: 'post-result',
          exec,
          result: this.materializeFinalResult({
            content: [{ type: 'text', text: `Error: ${denialReason}` }],
            isError: true,
            error: { message: denialReason },
          }),
        })
      }
      if (this.callerCancelled(exec)) {
        return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
      }
      return await next({ kind: 'dispatch', exec })
    } catch (error: unknown) {
      return next({ kind: 'final-result', exec, result: toolErrorResult(error) })
    }
  }

  /** Whether the original caller signal is currently aborted. */
  private callerCancelled(exec: ToolRunContext): boolean {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    return state.callerSignal.aborted
  }

  /** Canonical cancellation outcome selected by whether the tool body started. */
  private cancellationResult(exec: ToolRunContext, prior?: ToolExecutionResult): ToolExecutionResult {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    return state.bodyInvoked
      ? toolAbortedResult(prior)
      : toolAbortedBeforeDispatchResult(prior)
  }

  /**
   * Dispatch the registered body with the original caller signal fused back
   * into any around-wrapper replacement. Cancellation never abandons the body:
   * a started promise reaches quiescence before its outcome becomes `ABORTED`.
   */
  private async dispatchToolBody(exec: MutableToolRunContext): Promise<ToolExecutionResult> {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    const wrapperSignal = exec.signal
    const fused = fuseToolSignals(state.callerSignal, wrapperSignal)
    const signal = fused.signal

    if (isAborted(signal)) {
      fused.dispose()
      return toolAbortedBeforeDispatchResult()
    }
    exec.signal = signal
    try {
      const tool = this.registry.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
      if (!tool) throw new ToolNotFoundError(exec.name)
      state.bodyInvoked = true
      const returned = await tool.execute(exec.arguments, exec)
      const result = this.createSuccessResult(exec, tool, returned)
      return isAborted(signal)
        ? toolAbortedResult(result)
        : result
    } catch (error: unknown) {
      return toolErrorResult(error)
    } finally {
      fused.dispose()
      exec.signal = wrapperSignal
    }
  }

  /**
   * Run around-dispatch and the tool body. Tool and unknown-tool failures still
   * receive post-execute; pipeline failures are already final.
   * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
   * @param ctx - the calling context.
   * @param exec - the prepared execution.
   * @returns whether the result still needs post-execute.
   * @internal
   */
  async dispatchScheduledExecution(runtime: ToolRuntime, ctx: Context, exec: ToolRunContext): Promise<ScheduledToolDispatch> {
    try {
      const mutableExec = exec as MutableToolRunContext
      const carrier = scopeTarget(runtime, exec.agent)
      const result = await ctx.waterfall(
        carrier, 'tools/execute', mutableExec,
        () => this.dispatchToolBody(mutableExec),
      )
      const normalized = this.normalizeDispatchResult(exec, result)
      const deferredContexts = this.deferredContexts.get(exec)
      /* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
      if (deferredContexts === undefined) throw new Error('tool registry scheduler invariant violated: unprepared execution')
      const resultWithDeferredContexts: ToolExecutionResult = deferredContexts.length === 0
        ? normalized
        : this.markCanonical(exec, {
          ...normalized,
          additionalContexts: [
            ...deferredContexts,
            ...normalized.additionalContexts ?? [],
          ],
        })
      return {
        kind: 'post-result',
        result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError
          ? this.cancellationResult(exec, resultWithDeferredContexts)
          : resultWithDeferredContexts,
      }
    } catch (error: unknown) {
      return { kind: 'final-result', result: toolErrorResult(error) }
    }
  }

  /**
   * Run ordered post-execute, then apply definition-owned content finalization,
   * materialize, and notify the final outcome.
   * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
   * @param ctx - the calling context.
   * @param exec - the prepared execution.
   * @param result - dispatch/pre result that still needs post-execute.
   * @returns the materialized final result.
   * @internal
   */
  async finalizeScheduledExecution(
    runtime: ToolRuntime,
    ctx: Context,
    exec: ToolRunContext,
    result: ToolExecutionResult,
  ): Promise<ToolExecutionResult> {
    try {
      const postResult = await this.postExecute(runtime, ctx, exec, result)
      return this.finishScheduledExecution(
        runtime,
        ctx,
        exec,
        this.callerCancelled(exec) && !postResult.isError
          ? this.cancellationResult(exec, postResult)
          : postResult,
      )
    } catch (error: unknown) {
      return this.finishScheduledExecution(runtime, ctx, exec, toolErrorResult(error))
    }
  }

  /**
   * Materialize the candidate, apply definition-owned content finalization,
   * then materialize and notify the authoritative result.
   * @param runtime - the caller-visible service instance (its `ctx` is the calling context).
   * @param ctx - the calling context.
   * @param exec - the prepared execution.
   * @param result - final result.
   * @returns the materialized final result.
   * @internal
   */
  finishScheduledExecution(runtime: ToolRuntime, ctx: Context, exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
    let materializedResult: ToolExecutionResult
    try {
      materializedResult = this.materializeFinalResult(result)
    } catch (error: unknown) {
      materializedResult = this.materializeFinalResult(toolErrorResult(error))
    }
    let finalResult: ToolExecutionResult
    try {
      finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult))
    } catch (error: unknown) {
      finalResult = this.materializeFinalResult(toolErrorResult(error))
    }
    this.notifyResult(runtime, ctx, exec, finalResult)
    return finalResult
  }

  /** Apply the snapshotted tool-owned content transform without exposing other result fields. */
  private applyFinalContent(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
    const finalizeContent = this.contentFinalizers.get(exec)
    if (finalizeContent === undefined) return result
    const content = finalizeContent(exec, result)
    return content === undefined ? result : { ...result, content }
  }

  /** Notify observers without exposing a mutation or error channel into the outcome. */
  private notifyResult(runtime: ToolRuntime, ctx: Context, exec: ToolExecution, result: ToolExecutionResult): void {
    // Freeze the registry's live object before observers receive its readonly
    // WeakMap-keyable view.
    Object.freeze(exec)
    const { name: toolName, callId } = exec
    const reportFailure = (error: unknown): void => {
      ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`)
    }
    const callbacks = ctx.events.dispatch('emit', [
      scopeTarget(runtime, exec.agent), 'tools/result', exec, result,
    ])
    for (const callback of callbacks) {
      try {
        const returned: unknown = callback(exec, result)
        void Promise.resolve(returned).catch(reportFailure)
      } catch (error: unknown) {
        reportFailure(error)
      }
    }
  }

  /**
   * Resolve an `ask` decision to allow/deny through the approval seam. The
   * seam is consumed opportunistically with `ctx.get('approval')` — a
   * deployment that composes no ApprovalService keeps the historical degrade
   * to deny, and an unmount mid-session degrades the same way on the next ask.
   * An agent-less execution also degrades: without an agent there is no
   * session to audit to and no UI to route to. Otherwise the outcome maps
   * one-to-one — `allowed-once` proceeds; the three non-grants deny with
   * distinct reasons so the model can tell a human "no" from an absent
   * approval channel.
   */
  private async serviceAsk(
    ctx: Context,
    exec: ToolExecution,
    ask: Extract<PreToolDecision, { kind: 'ask' }>,
  ): Promise<ToolAskResolution> {
    const approval = ctx.get('approval')
    if (approval === undefined) {
      return {
        decision: { kind: 'deny', reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` },
        approvalCancelled: false,
      }
    }
    if (exec.agent === undefined) {
      return {
        decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` },
        approvalCancelled: false,
      }
    }
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      ...ask.reason !== undefined ? { reason: ask.reason } : {},
      signal: exec.signal,
    })
    switch (outcome) {
      case 'allowed-once': return { decision: { kind: 'allow' }, approvalCancelled: false }
      case 'rejected': return {
        decision: { kind: 'deny', reason: `the user rejected tool "${exec.name}"` },
        approvalCancelled: false,
      }
      case 'cancelled': return {
        decision: { kind: 'deny', reason: `approval for tool "${exec.name}" was cancelled` },
        approvalCancelled: true,
      }
      case 'unavailable': return {
        decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but no approval channel is available` },
        approvalCancelled: false,
      }
      default: return assertNever(outcome, 'ApprovalOutcome')
    }
  }

  /**
   * Run the `tools/post-execute` waterfall over a dispatched `result` and apply
   * its {@link PostToolDecision}: `accept` keeps the call successful (replacing
   * `content` when given), `block` turns it into an `isError` whose content is
   * the corrective `feedback`. Either decision may attach `additionalContexts`,
   * which are ferried on the returned result for the loop's active-batch FIFO.
   * Context deferred by the tool body survives an accepted result but is
   * discarded when the outer call is blocked; a block exposes only context the
   * blocking decision explicitly supplied.
   * Runs inside `execute`'s outer try/catch (a throwing listener → isError).
   */
  private async postExecute(
    runtime: ToolRuntime,
    ctx: Context,
    exec: ToolExecution,
    result: ToolExecutionResult,
  ): Promise<ToolExecutionResult> {
    const decision = await ctx.waterfall(
      scopeTarget(runtime, exec.agent), 'tools/post-execute', exec, result,
      () => Promise.resolve<PostToolDecision>({ kind: 'accept' }),
    )
    const decisionContexts = decision.additionalContexts ?? []
    if (decision.kind === 'block') {
      const message = failureMessageFromContent(decision.feedback)
      return this.markCanonical(exec, {
        content: decision.feedback,
        isError: true,
        error: { message },
        ...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {},
      })
    }
    if (Object.hasOwn(decision, 'content') && Object.hasOwn(decision, 'value')) {
      throw new TypeError('tools/post-execute accept decision cannot replace both value and content')
    }
    const additionalContexts = [
      ...result.additionalContexts ?? [],
      ...decisionContexts,
    ]
    if (Object.hasOwn(decision, 'value')) {
      if (result.isError) {
        throw new TypeError('tools/post-execute cannot replace the value of a failed result')
      }
      const tool = this.registry.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
      if (tool === undefined) throw new ToolNotFoundError(exec.name)
      const replaced = this.createSuccessResult(exec, tool, decision.value)
      return this.markCanonical(exec, {
        ...replaced,
        ...additionalContexts.length > 0 ? { additionalContexts } : {},
      })
    }
    return this.markCanonical(exec, {
      ...result,
      ...decision.content !== undefined ? { content: decision.content } : {},
      ...additionalContexts.length > 0 ? { additionalContexts } : {},
    })
  }

  /** Mark one registry-normalized result as canonical only for its owning dispatch. */
  private markCanonical<T extends ToolExecutionResult>(exec: ToolExecution, result: T): T {
    this.canonicalResults.set(result, exec.token)
    return result
  }

  /** Snapshot, validate, render, and optionally project one successful body value. */
  private createSuccessResult(exec: ToolExecution, tool: ToolDefinition, candidate: unknown): ToolExecutionSuccess {
    const detached = snapshotToolValue(tool.name, candidate)
    const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value')
    if (violations.length > 0) throw new ToolOutputError(tool.name, violations)
    const value = deepFreeze(detached)
    let rendered: ContentBlock[]
    try {
      rendered = tool.output.render(exec.arguments, value)
    } catch (error: unknown) {
      throw projectionError(tool.name, 'render', error)
    }
    const content = snapshotProjection(tool.name, 'render', rendered)
    let meta: JsonValue | undefined
    if (exec.parent === undefined && tool.output.presentationMeta !== undefined) {
      let projected: JsonValue
      try {
        projected = tool.output.presentationMeta(exec.arguments, value)
      } catch (error: unknown) {
        throw projectionError(tool.name, 'presentationMeta', error)
      }
      meta = snapshotProjection(tool.name, 'presentationMeta', projected)
    }
    const concludesTurn = this.concludingExecutions.has(exec)
    return this.markCanonical(exec, this.materializeFinalResult({
      isError: false,
      value,
      content,
      ...meta !== undefined ? { meta } : {},
      ...concludesTurn ? { concludesTurn: true as const } : {},
    }) as ToolExecutionSuccess)
  }

  /** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
  private normalizeDispatchResult(exec: ToolExecution, result: ToolExecutionResult): ToolExecutionResult {
    if (this.canonicalResults.get(result) === exec.token) return result
    if (result.isError) {
      return this.markCanonical(exec, {
        isError: true,
        error: result.error,
        content: result.content,
        ...result.meta !== undefined ? { meta: result.meta } : {},
        ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
      })
    }
    const tool = this.registry.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
    if (tool === undefined) throw new ToolNotFoundError(exec.name)
    const normalized = this.createSuccessResult(exec, tool, result.value)
    return this.markCanonical(exec, {
      ...normalized,
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    })
  }

  /** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
  private materializeFinalResult(result: ToolExecutionResult): ToolExecutionResult {
    const presentation = {
      content: result.content,
      ...result.meta !== undefined ? { meta: result.meta } : {},
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    }
    if (result.isError) {
      return materializePresentation({ isError: true as const, error: result.error, ...presentation })
    }
    const detached = materializePresentation({
      isError: false as const,
      ...presentation,
      ...result.concludesTurn === true ? { concludesTurn: true as const } : {},
    })
    return deepFreeze({ ...detached, value: result.value })
  }
}

/** Mint a same-process correlation token whose identity is its value. */
function createExecutionToken(): ToolExecutionToken {
  return Symbol('dsh.tool.execution') as ToolExecutionToken
}

function toolErrorResult(error: unknown): ToolExecutionResult {
  const info = errorInfo(error)
  const message = errorMessage(error)
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, ...info ? { info } : {} },
  }
}

/** Read live abort state across an await without treating it as synchronously immutable. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Fuse caller and wrapper cancellation without nesting `AbortSignal.any`.
 * Keeping the relay dispatch-scoped also removes listeners when work settles.
 */
function fuseToolSignals(caller: AbortSignal, wrapper: AbortSignal): FusedToolSignal {
  if (caller === wrapper) return { signal: caller, dispose() {} }

  const controller = new AbortController()
  let listening = false
  const dispose = (): void => {
    if (!listening) return
    listening = false
    caller.removeEventListener('abort', abortFromCaller)
    wrapper.removeEventListener('abort', abortFromWrapper)
  }
  const abortFrom = (source: AbortSignal): void => {
    const reason: unknown = source.reason
    controller.abort(reason)
    dispose()
  }
  const abortFromCaller = (): void => { abortFrom(caller) }
  const abortFromWrapper = (): void => { abortFrom(wrapper) }

  if (wrapper.aborted) abortFromWrapper()
  else if (caller.aborted) abortFromCaller()
  else {
    listening = true
    caller.addEventListener('abort', abortFromCaller, { once: true })
    wrapper.addEventListener('abort', abortFromWrapper, { once: true })
  }
  return { signal: controller.signal, dispose }
}

/** Canonical result when cancellation supersedes success after body invocation. */
function toolAbortedResult(prior?: ToolExecutionResult): ToolExecutionResult {
  const additionalContexts = prior?.additionalContexts ?? []
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted' }],
    isError: true,
    error: {
      message: 'tool call aborted',
      info: { name: 'AbortError', code: TOOL_ABORTED },
    },
    ...additionalContexts.length > 0 ? { additionalContexts } : {},
  }
}

/** Canonical result when cancellation prevents tool body invocation. */
function toolAbortedBeforeDispatchResult(prior?: ToolExecutionResult): ToolExecutionResult {
  const additionalContexts = prior?.additionalContexts ?? []
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
    ...additionalContexts.length > 0 ? { additionalContexts } : {},
  }
}
