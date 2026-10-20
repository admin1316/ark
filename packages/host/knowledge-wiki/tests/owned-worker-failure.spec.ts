import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  workers: [] as Array<{
    handlers: Map<string, (value: unknown) => void>
    stopped: ReturnType<typeof Promise.withResolvers<number>>
    terminations: number
  }>,
}))
vi.mock('node:worker_threads', () => ({ Worker: class {
  handlers = new Map<string, (value: unknown) => void>()
  stopped = Promise.withResolvers<number>()
  terminations = 0
  constructor() { state.workers.push(this) }
  once(name: string, handler: (value: unknown) => void) { this.handlers.set(name, handler); return this }
  terminate() { this.terminations += 1; return this.stopped.promise }
} }))
import { createOwnedStageExecutor } from '../src/owned-stage-executor.ts'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

const request = { kind: 'file-extract' as const, path: '/synthetic/source.md', timeoutMs: 1000 }
describe('file worker outcome and quiescence', () => {
  it.each(['error', 'exit', 'abort'] as const)('handles %s once and waits for actual termination', async (event) => {
    const executor = createOwnedStageExecutor({ llm: {} as LlmRuntime, web: () => undefined, attachments: () => undefined })
    const controller = new AbortController()
    let settled = false
    const operation = executor.execute(request, controller.signal)
    const observed = operation.then(() => { settled = true }, () => { settled = true })
    const worker = state.workers.at(-1)!
    if (event === 'abort') controller.abort(new Error('owner stopped'))
    else worker.handlers.get(event)!(event === 'exit' ? 12 : new Error('worker fault'))
    await Promise.resolve()
    await Promise.resolve()
    expect(worker.terminations).toBe(1)
    expect(settled).toBe(false)
    // Competing notifications cannot resolve a failed/cancelled stage.
    worker.handlers.get('message')!({ ok: true, text: 'late' })
    worker.stopped.resolve(0)
    const message = event === 'exit' ? 'exited without a result' : event === 'abort' ? 'owner stopped' : 'worker fault'
    await expect(operation).rejects.toThrow(message)
    await observed
    expect(worker.terminations).toBe(1)
  })
})
