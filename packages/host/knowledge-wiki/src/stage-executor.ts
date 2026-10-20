/** Hard-deadline execution contract for non-cooperative Knowledge Wiki stages. */

export type KnowledgeWikiStageRequest =
  | {
    readonly kind: 'file-extract'
    readonly path: string
    readonly timeoutMs: number
  }
  | {
    readonly kind: 'web-search'
    readonly query: string
    readonly maxResults: number
    readonly timeoutMs: number
  }
  | {
    readonly kind: 'llm-complete'
    readonly provider: string
    readonly model: string
    readonly prompt: string
    readonly operation: string
    readonly timeoutMs: number
  }
  | {
    readonly kind: 'vision-describe'
    readonly provider: string
    readonly model: string
    readonly path: string
    readonly timeoutMs: number
  }

/** Result returned by the externally owned stage isolate. */
export interface KnowledgeWikiStageResult {
  readonly text: string | null
  readonly sources?: Array<{
    readonly url: string
    readonly title?: string
    readonly snippet?: string
  }>
}

/**
 * Parent-owned process/worker executor. The capability marker is part of the
 * trust contract: abort must terminate the owned isolate, not merely detach it.
 */
export interface KnowledgeWikiStageExecutor {
  readonly isolation: 'owned-worker-v1' | 'owned-subprocess-v1'
  /**
   * Bind an operation's model calls before its first model request.
   * @param route - Fixed text route and number of one-shot model requests.
   * @param signal - Cancellation while preparing the operation.
   * @returns Executor whose prepared calls retain this operation's provider generation.
   */
  prepareOperation?(
    route: { readonly provider: string; readonly model: string; readonly modelCalls: number },
    signal: AbortSignal,
  ): Promise<KnowledgeWikiStageExecutor>
  /** Local provider preflight before research spends a model request. */
  assertSearchAvailable?(signal?: AbortSignal): void | Promise<void>
  execute(request: KnowledgeWikiStageRequest, signal: AbortSignal): Promise<KnowledgeWikiStageResult>
}

/**
 * Recognize the declared stage-executor capability without executing it.
 * @param value - Optional service value to inspect.
 * @returns True for an owned-worker-v1/owned-subprocess-v1 marker and callable execute member.
 * This structural check does not prove that abort actually terminates the isolate.
 */
export function isKnowledgeWikiStageExecutor(value: unknown): value is KnowledgeWikiStageExecutor {
  return typeof value === 'object'
    && value !== null
    && (Reflect.get(value, 'isolation') === 'owned-worker-v1'
      || Reflect.get(value, 'isolation') === 'owned-subprocess-v1')
    && typeof Reflect.get(value, 'execute') === 'function'
}

/**
 * Apply an owner deadline and await the executor's cancellation/termination boundary.
 * @param executor - Owner whose execute promise settles only after its work stops.
 * @param request - Stage input and finite positive deadline.
 * @param ownerSignal - Cancellation forwarded to the stage controller.
 * @returns Result after work settles; cancellation takes precedence over late success.
 * @throws For unavailable execution, invalid deadlines, cancellation, or stage failure.
 */
export async function executeKnowledgeWikiStage(
  executor: KnowledgeWikiStageExecutor | undefined,
  request: KnowledgeWikiStageRequest,
  ownerSignal: AbortSignal,
): Promise<KnowledgeWikiStageResult> {
  if (executor === undefined) throw new Error('knowledge Wiki stage executor unavailable; refusing non-cooperative work')
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error('invalid knowledge Wiki stage deadline')
  const controller = new AbortController()
  const abortFromOwner = (): void => { controller.abort(ownerSignal.reason) }
  const error = (): Error => controller.signal.reason instanceof Error
    ? controller.signal.reason : new Error('knowledge Wiki stage aborted')
  ownerSignal.addEventListener('abort', abortFromOwner, { once: true })
  if (ownerSignal.aborted) abortFromOwner()
  const timeout = setTimeout(() => {
    controller.abort(new Error(`knowledge Wiki ${request.kind} timed out after ${request.timeoutMs}ms`))
  }, request.timeoutMs)
  const checkAbort = (): void => { if (controller.signal.aborted) throw error() }
  try {
    checkAbort()
    const result = await executor.execute(request, controller.signal)
    checkAbort()
    return result
  } catch (cause) {
    checkAbort()
    throw cause instanceof Error ? cause : new Error(String(cause))
  } finally {
    clearTimeout(timeout)
    ownerSignal.removeEventListener('abort', abortFromOwner)
  }
}
