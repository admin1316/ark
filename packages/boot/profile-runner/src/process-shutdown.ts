/** Bounded, escalating process shutdown for the long-lived CLI surfaces. */

/** Maximum grace allowed for the application tree to dispose before process exit. */
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000

/** Typed diagnostic for a disposer that did not quiesce inside its grace period. */
export class ProcessShutdownTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`application disposal timed out after ${String(timeoutMs)}ms`)
    this.name = 'ProcessShutdownTimeoutError'
  }
}

/** Process-exit controller shared by normal completion and Unix signal handlers. */
export interface ProcessShutdown {
  /** Start or join graceful disposal before allowing natural completion with `code`. */
  shutdown(code: number): Promise<void>
  /** Start graceful disposal followed by exit, or force exit when shutdown is already running. */
  interrupt(code: number): void
}

/**
 * Create one process-exit controller around an application disposer.
 * @param dispose - Whole-application teardown that resolves at quiescence.
 * @param forceExit - Function that exits the process immediately, replaceable by tests.
 * @param complete - Function that records the natural completion code, replaceable by tests.
 * @param timeoutMs - Grace before forced exit, replaceable by tests.
 * @param reportFailure - Diagnostic sink called at most once for disposer failure
 *   or timeout; defaults to stderr. Its exceptions are swallowed before forced exit.
 * @returns A controller whose normal calls coalesce and whose repeated signal call escalates.
 */
export function createProcessShutdown(
  dispose: () => Promise<void>,
  forceExit: (code: number) => void = (code) => { process.exit(code) },
  complete: (code: number) => void = (code) => { process.exitCode = code },
  timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS,
  reportFailure: (error: unknown) => void = (error) => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error(`dsh: shutdown failed: ${detail}`)
  },
): ProcessShutdown {
  let pending: Promise<void> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let completed = false
  let forceExited = false
  let forceAfterDispose = false
  let interruptCount = 0
  let requestedCode = 0
  let failureReported = false

  const clearExitTimeout = (): void => {
    /* v8 ignore else -- shutdown() arms the timer before any asynchronous exit path can run. */
    if (timeout !== undefined) clearTimeout(timeout)
  }

  const forceExitOnce = (code: number): void => {
    if (forceExited) return
    forceExited = true
    clearExitTimeout()
    forceExit(code)
  }

  const completeOnce = (code: number): void => {
    if (completed || forceExited) return
    completed = true
    clearExitTimeout()
    complete(code)
  }

  const mergeCode = (code: number): void => {
    if (requestedCode === 0 && code !== 0) requestedCode = code
  }

  const failOnce = (error: unknown): void => {
    if (!failureReported) {
      failureReported = true
      try {
        reportFailure(error)
      } catch {
        // A diagnostic sink must never suppress the non-zero failure outcome.
      }
    }
    forceExitOnce(requestedCode === 0 ? 1 : requestedCode)
  }

  const start = (): Promise<void> => {
    if (pending !== undefined) return pending
    timeout = setTimeout(() => { failOnce(new ProcessShutdownTimeoutError(timeoutMs)) }, timeoutMs)
    pending = Promise.resolve().then(dispose).then(
      () => {
        if (forceAfterDispose) forceExitOnce(requestedCode)
        else completeOnce(requestedCode)
      },
      (error: unknown) => { failOnce(error) },
    )
    return pending
  }

  return {
    shutdown(code) {
      mergeCode(code)
      return start()
    },
    interrupt(code) {
      if (code !== 0) requestedCode = code
      else mergeCode(code)
      forceAfterDispose = true
      interruptCount += 1
      if (completed || interruptCount > 1) {
        forceExitOnce(requestedCode)
        return
      }
      void start()
    },
  }
}
