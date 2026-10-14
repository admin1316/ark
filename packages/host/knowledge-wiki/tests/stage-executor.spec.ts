import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOwnedStageExecutor } from '../src/owned-stage-executor.ts'
import {
  executeKnowledgeWikiStage,
  isKnowledgeWikiStageExecutor,
  type KnowledgeWikiStageExecutor,
} from '../src/stage-executor.ts'

const request = {
  kind: 'file-extract' as const,
  path: '/fixture/source',
  timeoutMs: 25,
}
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('owned Knowledge Wiki stage deadlines', () => {
  it('recognizes both owned executor kinds and rejects missing or malformed capabilities', () => {
    const execute = vi.fn(async () => ({ text: 'unused' }))
    for (const isolation of ['owned-worker-v1', 'owned-subprocess-v1']) {
      expect(isKnowledgeWikiStageExecutor({ isolation, execute })).toBe(true)
      expect(isKnowledgeWikiStageExecutor({ isolation, execute: 'not callable' })).toBe(false)
    }
    for (const value of [undefined, null, 1, {}, { isolation: 'unowned', execute }]) {
      expect(isKnowledgeWikiStageExecutor(value)).toBe(false)
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid deadline %s before executing', async (timeoutMs) => {
    const execute = vi.fn(async () => ({ text: 'must not execute' }))
    await expect(executeKnowledgeWikiStage(
      { isolation: 'owned-worker-v1', execute }, { ...request, timeoutMs }, new AbortController().signal,
    )).rejects.toThrow('invalid knowledge Wiki stage deadline')
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([new Error('already stopped'), 'already stopped'])('rejects pre-aborted owner %s without starting work', async (reason) => {
    const execute = vi.fn(async () => ({ text: 'must not execute' }))
    const owner = new AbortController()
    owner.abort(reason)
    const operation = executeKnowledgeWikiStage({ isolation: 'owned-worker-v1', execute }, request, owner.signal)
    if (reason instanceof Error) await expect(operation).rejects.toBe(reason)
    else await expect(operation).rejects.toThrow('knowledge Wiki stage aborted')
    expect(execute).not.toHaveBeenCalled()
  })

  it('returns the exact result and removes the deadline and owner listener on success', async () => {
    vi.useFakeTimers()
    const result = { text: 'extracted document' }
    const owner = new AbortController()
    const execute = vi.fn(async () => result)
    const removeListener = vi.spyOn(owner.signal, 'removeEventListener')
    try {
      await expect(executeKnowledgeWikiStage({ isolation: 'owned-worker-v1', execute }, request, owner.signal))
        .resolves.toBe(result)
      expect(execute).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal))
      expect(removeListener).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      removeListener.mockRestore()
      vi.useRealTimers()
    }
  })

  it.each([new Error('stage failed'), 'stage failed'])('normalizes executor rejection %s', async (failure) => {
    const executor: KnowledgeWikiStageExecutor = {
      isolation: 'owned-subprocess-v1',
      execute: async () => { throw failure },
    }
    const operation = executeKnowledgeWikiStage(executor, request, new AbortController().signal)
    if (failure instanceof Error) await expect(operation).rejects.toBe(failure)
    else await expect(operation).rejects.toThrow('stage failed')
  })

  it('keeps owner cancellation authoritative when the executor settles late', async () => {
    const child = Promise.withResolvers<{ text: string }>()
    let childSignal: AbortSignal | undefined
    const executor: KnowledgeWikiStageExecutor = {
      isolation: 'owned-worker-v1',
      execute: (_request, signal) => {
        childSignal = signal
        return child.promise
      },
    }
    const owner = new AbortController()
    const operation = executeKnowledgeWikiStage(executor, request, owner.signal)
    owner.abort('cancelled by parent')
    await expect(operation).rejects.toThrow('knowledge Wiki stage aborted')
    expect(childSignal?.aborted).toBe(true)
    expect(childSignal?.reason).toBe('cancelled by parent')
    child.resolve({ text: 'late result' })
    await child.promise
    await expect(operation).rejects.toThrow('knowledge Wiki stage aborted')
  })

  it('fails closed before starting when no owned executor is injected', async () => {
    await expect(executeKnowledgeWikiStage(undefined, request, new AbortController().signal))
      .rejects.toThrow('stage executor unavailable')
  })

  it('returns at the hard deadline even when the external stage never settles', async () => {
    vi.useFakeTimers()
    let observedAbort = false
    const executor: KnowledgeWikiStageExecutor = {
      isolation: 'owned-subprocess-v1',
      execute: (_request, signal) => new Promise(() => {
        signal.addEventListener('abort', () => { observedAbort = true }, { once: true })
      }),
    }
    try {
      const operation = executeKnowledgeWikiStage(executor, request, new AbortController().signal)
      const rejected = expect(operation).rejects.toThrow('timed out after 25ms')
      await vi.advanceTimersByTimeAsync(25)
      await rejected
      expect(observedAbort).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for the owned file worker to exit before returning from owner cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-wrapper-abort-'))
    roots.push(root)
    const file = join(root, 'note.md')
    writeFileSync(file, 'local-only file; no provider or network')
    const owner = new AbortController()
    const originalOnce = Reflect.get(Worker.prototype, 'once')
    const originalTerminate = Reflect.get(Worker.prototype, 'terminate')
    let workerExit = false
    let termination: Promise<number> | undefined
    let signalExit: (() => void) | undefined
    const exited = new Promise<void>((resolve) => { signalExit = resolve })
    vi.spyOn(Worker.prototype, 'once').mockImplementation(function (this: Worker, event, listener) {
      const result = originalOnce.call(this, event, listener)
      if (event === 'message') queueMicrotask(() => { owner.abort(new Error('cancelled by outer owner')) })
      return result
    })
    vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker, ...args) {
      originalOnce.call(this, 'exit', () => { workerExit = true; signalExit?.() })
      termination = originalTerminate.apply(this, args)
      return termination
    })
    try {
      const operation = executeKnowledgeWikiStage(
        createOwnedStageExecutor({ resolveConnection: async () => { throw new Error('no connection expected') } }),
        { ...request, timeoutMs: 10_000 },
        owner.signal,
      )
      await expect(operation).rejects.toThrow('cancelled by outer owner')
      expect(termination).toBeDefined()
      expect(workerExit).toBe(true)
      await termination
      await exited
    } finally {
      vi.restoreAllMocks()
      await termination
    }
  })

  it('waits for the owned file worker to exit before returning at its deadline', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'stage-wrapper-deadline-'))
    roots.push(root)
    const file = join(root, 'note.md')
    writeFileSync(file, 'local-only file; no provider or network')
    const originalOnce = Reflect.get(Worker.prototype, 'once')
    const originalTerminate = Reflect.get(Worker.prototype, 'terminate')
    let signalStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    let workerExit = false
    let termination: Promise<number> | undefined
    vi.spyOn(Worker.prototype, 'once').mockImplementation(function (this: Worker, event, listener) {
      const result = originalOnce.call(this, event, listener)
      if (event === 'message') signalStarted?.()
      return result
    })
    vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker, ...args) {
      originalOnce.call(this, 'exit', () => { workerExit = true })
      termination = originalTerminate.apply(this, args)
      return termination
    })
    try {
      const operation = executeKnowledgeWikiStage(
        createOwnedStageExecutor({ resolveConnection: async () => { throw new Error('no connection expected') } }),
        { ...request, timeoutMs: 25 },
        new AbortController().signal,
      )
      await started
      const rejected = expect(operation).rejects.toThrow('timed out after 25ms')
      vi.advanceTimersByTime(25)
      await rejected
      expect(termination).toBeDefined()
      expect(workerExit).toBe(true)
      await termination
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
      await termination
    }
  })

  it('ignores the deadline after owner cancellation while an owned worker is still joining', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'stage-wrapper-cancel-join-deadline-'))
    roots.push(root)
    const file = join(root, 'note.md')
    writeFileSync(file, 'local-only file; no provider or network')
    const owner = new AbortController()
    const originalOnce = Reflect.get(Worker.prototype, 'once')
    const originalTerminate = Reflect.get(Worker.prototype, 'terminate')
    let messageListenerReady: (() => void) | undefined
    const messageReady = new Promise<void>((resolve) => { messageListenerReady = resolve })
    let releaseTermination: (() => void) | undefined
    const terminationReleased = new Promise<void>((resolve) => { releaseTermination = resolve })
    let termination: Promise<number> | undefined
    let terminationCalls = 0
    let workerExited = false
    let operationSettled = false
    vi.spyOn(Worker.prototype, 'once').mockImplementation(function (this: Worker, event, listener) {
      const result = originalOnce.call(this, event, listener)
      if (event === 'message') messageListenerReady?.()
      return result
    })
    vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker, ...args) {
      terminationCalls += 1
      originalOnce.call(this, 'exit', () => { workerExited = true })
      termination = terminationReleased.then(() => originalTerminate.apply(this, args))
      return termination
    })

    try {
      const operation = executeKnowledgeWikiStage(
        createOwnedStageExecutor({ resolveConnection: async () => { throw new Error('no connection expected') } }),
        { ...request, timeoutMs: 25 },
        owner.signal,
      )
      void operation.then(() => { operationSettled = true }, () => { operationSettled = true })
      await messageReady
      owner.abort(new Error('owner stopped before deadline'))
      await Promise.resolve()
      expect(terminationCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(25)
      expect({ terminationCalls, workerExited, operationSettled }).toEqual({
        terminationCalls: 1,
        workerExited: false,
        operationSettled: false,
      })

      releaseTermination?.()
      await expect(operation).rejects.toThrow('owner stopped before deadline')
      expect(workerExited).toBe(true)
      await termination
    } finally {
      releaseTermination?.()
      vi.restoreAllMocks()
      vi.useRealTimers()
      await termination
    }
  })

  it.each(['throw', 'reject'] as const)('rejects a %s worker termination only after the real worker exits', async (failureMode) => {
    const root = mkdtempSync(join(tmpdir(), 'stage-wrapper-termination-error-'))
    roots.push(root)
    const file = join(root, 'note.md')
    writeFileSync(file, 'local-only file; no provider or network')
    const owner = new AbortController()
    const originalOnce = Reflect.get(Worker.prototype, 'once')
    let workerExit = false
    let terminationCalled = false
    vi.spyOn(Worker.prototype, 'once').mockImplementation(function (this: Worker, event, listener) {
      const result = originalOnce.call(this, event, listener)
      if (event === 'message') queueMicrotask(() => { owner.abort(new Error('cancelled with termination failure')) })
      return result
    })
    vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      terminationCalled = true
      originalOnce.call(this, 'exit', () => { workerExit = true })
      if (failureMode === 'throw') throw new Error('termination failed')
      return Promise.reject(new Error('termination failed'))
    })
    try {
      const operation = executeKnowledgeWikiStage(
        createOwnedStageExecutor({ resolveConnection: async () => { throw new Error('no connection expected') } }),
        { ...request, timeoutMs: 10_000 },
        owner.signal,
      )
      const failure = await operation.then(() => undefined, (error: unknown): unknown => error)
      expect({
        message: failure instanceof Error ? failure.message : String(failure),
        terminationCalled,
        workerExit,
      }).toEqual({ message: 'termination failed', terminationCalled: true, workerExit: true })
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('blocks a late owned worker after cancelling a still-pending connection resolver', async () => {
    const connection = Promise.withResolvers<{ baseUrl: string; apiKey: string }>()
    const owner = new AbortController()
    const originalOnce = Reflect.get(Worker.prototype, 'once')
    let messageListeners = 0
    let resolverSettled = false
    void connection.promise.then(() => { resolverSettled = true })
    vi.spyOn(Worker.prototype, 'once').mockImplementation(function (this: Worker, event, listener) {
      if (event === 'message') messageListeners += 1
      return originalOnce.call(this, event, listener)
    })
    const operation = executeKnowledgeWikiStage(
      createOwnedStageExecutor({ resolveConnection: () => connection.promise }),
      { kind: 'llm-complete', provider: 'offline-test', model: 'unused', prompt: 'unused', operation: 'unused', timeoutMs: 10_000 },
      owner.signal,
    )
    try {
      await Promise.resolve()
      expect(resolverSettled).toBe(false)
      owner.abort(new Error('cancelled during connection lookup'))
      await expect(operation).rejects.toThrow('cancelled during connection lookup')
      expect(resolverSettled).toBe(false)
      expect(messageListeners).toBe(0)
      connection.resolve({ baseUrl: 'http://127.0.0.1:1', apiKey: '' })
      await connection.promise
      await Promise.resolve()
      await Promise.resolve()
      expect(messageListeners).toBe(0)
    } finally {
      connection.resolve({ baseUrl: 'http://127.0.0.1:1', apiKey: '' })
      await connection.promise
      vi.restoreAllMocks()
    }
  })

  it('joins every owned worker registered to the same stage signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-wrapper-shared-signal-'))
    roots.push(root)
    const file = join(root, 'note.md')
    writeFileSync(file, 'local-only file; no provider or network')
    const owner = new AbortController()
    const originalOnce = Reflect.get(Worker.prototype, 'once')
    const originalTerminate = Reflect.get(Worker.prototype, 'terminate')
    const exitCodes: number[] = []
    const terminations: Array<Promise<number>> = []
    let messageListeners = 0
    let signalReady: (() => void) | undefined
    const bothWorkersReady = new Promise<void>((resolve) => { signalReady = resolve })
    vi.spyOn(Worker.prototype, 'once').mockImplementation(function (this: Worker, event, listener) {
      const result = originalOnce.call(this, event, listener)
      if (event === 'message') {
        messageListeners += 1
        if (messageListeners === 2) {
          signalReady?.()
          queueMicrotask(() => { owner.abort(new Error('cancelled shared workers')) })
        }
      }
      return result
    })
    vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker, ...args) {
      originalOnce.call(this, 'exit', (code: number) => { exitCodes.push(code) })
      const termination = originalTerminate.apply(this, args)
      terminations.push(termination)
      return termination
    })
    try {
      const owned = createOwnedStageExecutor({ resolveConnection: async () => { throw new Error('no connection expected') } })
      const composed: KnowledgeWikiStageExecutor = {
        isolation: 'owned-worker-v1',
        execute: async (stageRequest, signal) => {
          const results = await Promise.all([owned.execute(stageRequest, signal), owned.execute(stageRequest, signal)])
          return results[0]
        },
      }
      const operation = executeKnowledgeWikiStage(composed, { ...request, timeoutMs: 10_000 }, owner.signal)
      await bothWorkersReady
      await expect(operation).rejects.toThrow('cancelled shared workers')
      expect(terminations).toHaveLength(2)
      expect(exitCodes).toHaveLength(2)
      await Promise.all(terminations)
    } finally {
      vi.restoreAllMocks()
      await Promise.all(terminations)
    }
  })

  it('waits for every owned worker exit before propagating a join failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-wrapper-join-failure-'))
    roots.push(root)
    const file = join(root, 'note.md')
    writeFileSync(file, 'local-only file; no provider or network')
    const owner = new AbortController()
    const originalOnce = Reflect.get(Worker.prototype, 'once')
    const originalTerminate = Reflect.get(Worker.prototype, 'terminate')
    let messageListeners = 0
    let signalReady: (() => void) | undefined
    const bothWorkersReady = new Promise<void>((resolve) => { signalReady = resolve })
    let markFirstExited: (() => void) | undefined
    const firstExited = new Promise<void>((resolve) => { markFirstExited = resolve })
    let markSecondExited: (() => void) | undefined
    const secondExited = new Promise<void>((resolve) => { markSecondExited = resolve })
    let releaseSecondTermination: (() => void) | undefined
    const secondTerminationReleased = new Promise<void>((resolve) => { releaseSecondTermination = resolve })
    let terminationCalls = 0
    let firstExitObserved = false
    let secondExitObserved = false
    let operationSettled = false

    vi.spyOn(Worker.prototype, 'once').mockImplementation(function (this: Worker, event, listener) {
      const result = originalOnce.call(this, event, listener)
      if (event === 'message') {
        messageListeners += 1
        if (messageListeners === 2) {
          signalReady?.()
          queueMicrotask(() => { owner.abort(new Error('cancelled with one failed worker join')) })
        }
      }
      return result
    })
    vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker, ...args) {
      terminationCalls += 1
      const index = terminationCalls
      originalOnce.call(this, 'exit', () => {
        if (index === 1) {
          firstExitObserved = true
          markFirstExited?.()
        } else {
          secondExitObserved = true
          markSecondExited?.()
        }
      })
      if (index === 1) {
        return originalTerminate.apply(this, args).then(() => {
          throw new Error('first worker join failed after exit')
        })
      }
      return secondTerminationReleased.then(() => originalTerminate.apply(this, args))
    })

    try {
      const owned = createOwnedStageExecutor({ resolveConnection: async () => { throw new Error('no connection expected') } })
      const composed: KnowledgeWikiStageExecutor = {
        isolation: 'owned-worker-v1',
        execute: async (stageRequest, signal) => {
          const results = await Promise.all([owned.execute(stageRequest, signal), owned.execute(stageRequest, signal)])
          return results[0]
        },
      }
      const operation = executeKnowledgeWikiStage(composed, { ...request, timeoutMs: 10_000 }, owner.signal)
      void operation.then(() => { operationSettled = true }, () => { operationSettled = true })
      await bothWorkersReady
      await firstExited
      await new Promise<void>(resolve => setImmediate(resolve))
      expect({ terminationCalls, firstExitObserved, secondExitObserved, operationSettled }).toEqual({
        terminationCalls: 2,
        firstExitObserved: true,
        secondExitObserved: false,
        operationSettled: false,
      })

      releaseSecondTermination?.()
      await expect(operation).rejects.toThrow('first worker join failed after exit')
      await secondExited
      expect(secondExitObserved).toBe(true)
    } finally {
      releaseSecondTermination?.()
      vi.restoreAllMocks()
    }
  })

  it('propagates owner cancellation without waiting for a non-cooperative stage', async () => {
    const executor: KnowledgeWikiStageExecutor = {
      isolation: 'owned-worker-v1',
      execute: () => new Promise(() => {}),
    }
    const owner = new AbortController()
    const operation = executeKnowledgeWikiStage(executor, request, owner.signal)
    owner.abort(new Error('owner stopped'))
    await expect(operation).rejects.toThrow('owner stopped')
  })
})
