/** Deadline and cancellation supervision for Knowledge Wiki stages. */

const stageWorkerJoins = new WeakMap<AbortSignal, Set<Promise<void>>>()

/**
 * Register the actual exit proof for a worker owned by this stage signal.
 * @param signal - The exact child signal passed to the worker executor.
 * @param join - The real worker join; it resolves after exit or rejects with an Error after exit.
 * @internal Only the in-process owned-worker executor registers join proofs.
 */
export function registerKnowledgeWikiStageWorkerJoin(signal: AbortSignal, join: Promise<void>): void {
  let joins = stageWorkerJoins.get(signal)
  if (joins === undefined) {
    joins = new Set()
    stageWorkerJoins.set(signal, joins)
  }
  joins.add(join)
  const registeredJoins = joins
  void join.then(
    () => { registeredJoins.delete(join) },
    () => { registeredJoins.delete(join) },
  )
}

function joinKnowledgeWikiStageWorkers(signal: AbortSignal): Promise<void> {
  return Promise.allSettled([...(stageWorkerJoins.get(signal) ?? [])]).then((results) => {
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  })
}

/** Complete request for one Knowledge Wiki stage, including its operation-specific timeout. */
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
    readonly apiKey: string
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
 * Executor declaring a parent-owned process/worker implementation. The marker
 * describes the provider; it does not prove that abort stops or joins its work.
 */
export interface KnowledgeWikiStageExecutor {
  readonly isolation: 'owned-worker-v1' | 'owned-subprocess-v1'
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
 * Supervise a stage deadline and owner cancellation.
 * Timeout/owner cancellation aborts the child and waits for every worker join
 * registered by the in-process owned-worker executor before rejecting. It
 * propagates a join failure only after all registered joins settle. A join that
 * never settles leaves this call pending. Opaque providers and a connection
 * resolver still pending before worker creation have no join here, so this
 * wrapper cannot prove they stopped; the owned executor checks cancellation
 * after its resolver returns to prevent a late worker from starting.
 * @param executor - Parent-owned executor responsible for terminating its isolate on abort; absence rejects.
 * @param request - Stage input with a finite, positive timeoutMs deadline.
 * @param ownerSignal - Parent cancellation forwarded to the stage's dedicated controller.
 * @returns The executor result if it settles first; cancellation/deadline rejects after currently registered joins settle.
 * @throws Rejects for unavailable execution, invalid deadlines, cancellation, timeout, executor failure, or join failure.
 */
export function executeKnowledgeWikiStage(
  executor: KnowledgeWikiStageExecutor | undefined,
  request: KnowledgeWikiStageRequest,
  ownerSignal: AbortSignal,
): Promise<KnowledgeWikiStageResult> {
  if (executor === undefined) {
    return Promise.reject(new Error('knowledge Wiki stage executor unavailable; refusing non-cooperative work'))
  }
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    return Promise.reject(new Error('invalid knowledge Wiki stage deadline'))
  }
  if (ownerSignal.aborted) {
    return Promise.reject(ownerSignal.reason instanceof Error
      ? ownerSignal.reason
      : new Error('knowledge Wiki stage aborted'))
  }
  const controller = new AbortController()
  return new Promise((resolve, reject) => {
    let settled = false
    let cancellationStarted = false
    function finish(operation: () => void): void {
      settled = true
      clearTimeout(timeout)
      ownerSignal.removeEventListener('abort', abortFromOwner)
      operation()
    }
    const cancelAndJoin = (error: Error, abortReason: unknown = error): void => {
      if (settled || cancellationStarted) return
      cancellationStarted = true
      controller.abort(abortReason)
      void joinKnowledgeWikiStageWorkers(controller.signal).then(
        () => { finish(() => { reject(error) }) },
        (joinError: unknown) => {
          finish(() => {
            // The private owner registers native Worker termination failures as Error.
            const failure: Error = joinError as Error
            reject(failure)
          })
        },
      )
    }
    const abortFromOwner = (): void => {
      cancelAndJoin(ownerSignal.reason instanceof Error
        ? ownerSignal.reason
        : new Error('knowledge Wiki stage aborted'), ownerSignal.reason)
    }
    ownerSignal.addEventListener('abort', abortFromOwner, { once: true })
    const timeout = setTimeout(() => {
      const error = new Error(`knowledge Wiki ${request.kind} timed out after ${request.timeoutMs}ms`)
      cancelAndJoin(error)
    }, request.timeoutMs)
    void executor.execute(request, controller.signal).then(
      (value) => { if (!cancellationStarted) finish(() => { resolve(value) }) },
      (error: unknown) => {
        if (!cancellationStarted) finish(() => {
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      },
    )
  })
}
