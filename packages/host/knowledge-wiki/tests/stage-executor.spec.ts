import { describe, expect, it, vi } from 'vitest'
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
