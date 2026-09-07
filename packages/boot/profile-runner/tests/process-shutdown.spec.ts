import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createProcessShutdown,
  PROCESS_SHUTDOWN_TIMEOUT_MS,
} from '../src/process-shutdown.ts'

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('process shutdown', () => {
  it('completes naturally after disposal resolves and reports a nonzero exit when it rejects', async () => {
    const resolvedExit = vi.fn()
    const resolvedComplete = vi.fn()
    const resolved = createProcessShutdown(() => Promise.resolve(), resolvedExit, resolvedComplete)
    await resolved.shutdown(0)
    expect(resolvedComplete).toHaveBeenCalledOnce()
    expect(resolvedComplete).toHaveBeenCalledWith(0)
    expect(resolvedExit).not.toHaveBeenCalled()

    const rejectedExit = vi.fn()
    const rejectedComplete = vi.fn()
    const reportFailure = vi.fn()
    const rejection = new Error('dispose failed')
    const rejected = createProcessShutdown(
      () => Promise.reject(rejection),
      rejectedExit,
      rejectedComplete,
      PROCESS_SHUTDOWN_TIMEOUT_MS,
      reportFailure,
    )
    await rejected.shutdown(0)
    expect(rejectedExit).toHaveBeenCalledOnce()
    expect(rejectedExit).toHaveBeenCalledWith(1)
    expect(rejectedComplete).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledWith(rejection)
  })

  it('uses process.exitCode for default normal completion', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(_code => undefined as never)
    const originalExitCode = process.exitCode
    process.exitCode = undefined
    const shutdown = createProcessShutdown(() => Promise.resolve())

    try {
      await shutdown.shutdown(7)

      expect(process.exitCode).toBe(7)
      expect(exit).not.toHaveBeenCalled()
      shutdown.interrupt(9)
      expect(exit).toHaveBeenCalledWith(9)
    } finally {
      process.exitCode = originalExitCode
    }
  })

  it.each(['stackless error', 'non-error rejection'])('reports %s and preserves a fatal caller code', async (kind) => {
    const error = new Error('dispose diagnostic')
    Object.defineProperty(error, 'stack', { value: undefined })
    const failure = kind === 'stackless error' ? error : 'dispose diagnostic'
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.fn()
    const complete = vi.fn()
    const shutdown = createProcessShutdown(async () => { throw failure }, exit, complete)

    await shutdown.shutdown(7)

    expect(stderr).toHaveBeenCalledExactlyOnceWith('dsh: shutdown failed: dispose diagnostic')
    expect(exit).toHaveBeenCalledExactlyOnceWith(7)
    expect(complete).not.toHaveBeenCalled()
  })

  it('reports a timeout once even if disposal later rejects and the diagnostic sink throws', async () => {
    vi.useFakeTimers()
    const disposal = deferred()
    const exit = vi.fn()
    const complete = vi.fn()
    const reportFailure = vi.fn(() => { throw new Error('diagnostic sink unavailable') })
    const shutdown = createProcessShutdown(
      () => disposal.promise, exit, complete, PROCESS_SHUTDOWN_TIMEOUT_MS, reportFailure,
    )
    const pending = shutdown.shutdown(7)

    await vi.advanceTimersByTimeAsync(PROCESS_SHUTDOWN_TIMEOUT_MS)
    expect(reportFailure).toHaveBeenCalledOnce()
    expect(reportFailure.mock.calls[0]).toEqual([expect.objectContaining({ name: 'ProcessShutdownTimeoutError' })])
    expect(exit).toHaveBeenCalledExactlyOnceWith(7)

    disposal.reject(new Error('late dispose rejection'))
    await pending
    expect(reportFailure).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(complete).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('forces exit when graceful disposal reaches its bound', async () => {
    vi.useFakeTimers()
    const disposal = deferred()
    const exit = vi.fn()
    const complete = vi.fn()
    const reportFailure = vi.fn()
    const shutdown = createProcessShutdown(
      () => disposal.promise,
      exit,
      complete,
      PROCESS_SHUTDOWN_TIMEOUT_MS,
      reportFailure,
    )
    const pending = shutdown.shutdown(0)

    await vi.advanceTimersByTimeAsync(PROCESS_SHUTDOWN_TIMEOUT_MS - 1)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
    expect(reportFailure.mock.calls[0]?.[0]).toMatchObject({
      name: 'ProcessShutdownTimeoutError',
    })

    disposal.resolve()
    await pending
    expect(exit).toHaveBeenCalledOnce()
    expect(complete).not.toHaveBeenCalled()
  })

  it('honors a caller-supplied grace period', async () => {
    vi.useFakeTimers()
    const disposal = deferred()
    const exit = vi.fn()
    const shutdown = createProcessShutdown(() => disposal.promise, exit, vi.fn(), 25)
    const pending = shutdown.shutdown(0)

    await vi.advanceTimersByTimeAsync(24)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledOnce()

    disposal.resolve()
    await pending
  })

  it('lets the first Ctrl+C join a normal disposal and force-exits after it settles', async () => {
    const disposal = deferred()
    const exit = vi.fn()
    const complete = vi.fn()
    const shutdown = createProcessShutdown(() => disposal.promise, exit, complete)
    const pending = shutdown.shutdown(0)

    shutdown.interrupt(130)
    expect(exit).not.toHaveBeenCalled()

    disposal.resolve()
    await pending
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)
    expect(complete).not.toHaveBeenCalled()
  })

  it('forces exit after disposal started by a signal', async () => {
    const disposal = deferred()
    const exit = vi.fn()
    const complete = vi.fn()
    const shutdown = createProcessShutdown(() => disposal.promise, exit, complete)

    shutdown.interrupt(143)
    disposal.resolve()
    await shutdown.shutdown(0)

    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(143)
    expect(complete).not.toHaveBeenCalled()
  })

  it('drains on the first signal and forces on the second signal', async () => {
    const disposal = deferred()
    const dispose = vi.fn(() => disposal.promise)
    const exit = vi.fn()
    const shutdown = createProcessShutdown(dispose, exit, vi.fn())

    shutdown.interrupt(143)
    await Promise.resolve()
    expect(dispose).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()

    shutdown.interrupt(130)
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)

    disposal.resolve()
    await shutdown.shutdown(0)
    expect(exit).toHaveBeenCalledOnce()
  })

  it('coalesces shutdown calls and upgrades a concurrent fatal result without a second disposer', async () => {
    const disposal = deferred()
    const dispose = vi.fn(() => disposal.promise)
    const exit = vi.fn()
    const complete = vi.fn()
    const shutdown = createProcessShutdown(dispose, exit, complete)

    const first = shutdown.shutdown(0)
    const second = shutdown.shutdown(1)
    expect(second).toBe(first)
    expect(exit).not.toHaveBeenCalled()

    disposal.resolve()
    await first
    expect(dispose).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith(1)
    expect(exit).not.toHaveBeenCalled()
  })

  it('coalesces concurrent fatal and signal shutdown through one disposer and one exit code', async () => {
    const disposal = deferred()
    const dispose = vi.fn(() => disposal.promise)
    const exit = vi.fn()
    const complete = vi.fn()
    const shutdown = createProcessShutdown(dispose, exit, complete)

    const fatal = shutdown.shutdown(1)
    shutdown.interrupt(0)
    expect(dispose).toHaveBeenCalledTimes(0)
    await Promise.resolve()
    expect(dispose).toHaveBeenCalledOnce()

    disposal.resolve()
    await fatal
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
    expect(complete).not.toHaveBeenCalled()
  })

  it('lets a signal force exit while natural completion drains remaining handles', async () => {
    const exit = vi.fn()
    const complete = vi.fn()
    const shutdown = createProcessShutdown(() => Promise.resolve(), exit, complete)

    await shutdown.shutdown(0)
    shutdown.interrupt(130)

    expect(complete).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)
  })
})
