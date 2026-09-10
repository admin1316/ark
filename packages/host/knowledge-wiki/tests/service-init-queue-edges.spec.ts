import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import KnowledgeWikiService from '../src/index.ts'
import type { IngestQueueTask } from '../src/types.ts'
import type { ProjectExecutionContext } from '../src/project-context.ts'

interface QueueSurface {
  snapshots: { dispose(): void }
  queue: IngestQueueTask[]
  queueDrain: Promise<void> | undefined
  restoreQueue(root?: string): void
  persistQueue(root?: string): void
  currentHash(input: string, root?: string): string | undefined
  listRawSources(root?: string): string[]
  ingestQueueAdd(request: { inputs: string[] }): Promise<object>
  ingestQueueCancel(): Promise<object>
  cancelPendingForRoot(root: string): boolean
  executeQueuedIngest(task: IngestQueueTask, context: ProjectExecutionContext, signal: AbortSignal): Promise<object>
  ingestUrlWithContext(request: { url: string }, context: ProjectExecutionContext, signal: AbortSignal): Promise<object>
  ingestSourceWithContext(request: { path: string }, context: ProjectExecutionContext, signal: AbortSignal): Promise<object>
  drainQueue(): Promise<void>
  markIngested(input: string, context?: ProjectExecutionContext): string | undefined
  scanSources(): Promise<void>
  summarizeSession(id: string | undefined): Promise<void>
  [Service.init](): Promise<void>
}

let root: string
let ctx: Context
let service: QueueSurface

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wiki-service-queue-edges-'))
  mkdirSync(join(root, 'wiki'), { recursive: true })
  mkdirSync(join(root, 'raw', 'sources', 'nested'), { recursive: true })
  writeFileSync(join(root, 'raw', 'sources', 'a.md'), 'A', 'utf8')
  writeFileSync(join(root, 'raw', 'sources', 'nested', 'b.md'), 'B', 'utf8')
  ctx = new Context()
  service = new KnowledgeWikiService(ctx, {
    wikiRoot: join(root, 'wiki'), mainRoot: root,
    credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
  }) as unknown as QueueSurface
})

afterEach(async () => {
  service.snapshots.dispose()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('service initialization', () => {
  it('installs the timer, snapshot disposer, and session-disposal callback', async () => {
    let tick = (): void => {}
    const timerDispose = vi.fn()
    Object.defineProperty(ctx, 'timer', {
      configurable: true,
      value: {
        interval: vi.fn((callback: () => void) => {
          tick = callback
          return timerDispose
        }),
      },
    })
    const scan = vi.spyOn(service, 'scanSources').mockResolvedValue()
    const drain = vi.spyOn(service, 'drainQueue').mockResolvedValue()
    const summarize = vi.spyOn(service, 'summarizeSession').mockResolvedValue()

    await service[Service.init]()
    tick()
    const emit: unknown = Reflect.get(ctx, 'emit')
    if (typeof emit !== 'function') throw new Error('missing Context emit method')
    Reflect.apply(emit, ctx, ['agent/disposed', { agent: { id: 'session-1' } }])
    await Promise.resolve()

    expect(scan).toHaveBeenCalledOnce()
    expect(drain).toHaveBeenCalledOnce()
    expect(summarize).toHaveBeenCalledWith('session-1')

    const failingContext = new Context()
    Object.defineProperty(failingContext, 'timer', {
      configurable: true,
      value: { interval: () => { throw 'timer primitive failure' } },
    })
    const failing = new KnowledgeWikiService(failingContext, {
      wikiRoot: join(root, 'other-wiki'), mainRoot: root,
      credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
    }) as unknown as QueueSurface
    await expect(failing[Service.init]()).rejects.toThrow('knowledge-wiki synchronous operation failed')
    failing.snapshots.dispose()
    await failingContext.fiber.dispose()
  })
})

describe('queue restore and dispatch edges', () => {
  it('rejects a non-array and migrates valid legacy rows including terminal outcomes', async () => {
    const queueFile = join(root, '.llm-wiki', 'ingest-queue.json')
    mkdirSync(join(root, '.llm-wiki'), { recursive: true })
    writeFileSync(queueFile, '{}', 'utf8')
    expect(() => { service.restoreQueue(root) }).toThrow('invalid knowledge ingest queue state')
    expect(service.queue).toEqual([])

    const recoveryContext = new Context()
    const recovery = new KnowledgeWikiService(recoveryContext, {
      wikiRoot: join(root, 'wiki'), mainRoot: root,
      credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
    }) as unknown as QueueSurface
    try {
      writeFileSync(queueFile, JSON.stringify([
        null,
        {},
        { input: 'done.md', status: 'done' },
        { input: 'a.md', status: 'running', createdAt: 'bad', projectGeneration: 'bad' },
        { id: 9, input: 'cancel.md', status: 'cancelled', createdAt: 1, projectGeneration: 2, ingestedHash: 'hash' },
        { id: 10, input: 'cancel.md', status: 'cancelled' },
      ]), 'utf8')
      recovery.restoreQueue(root)
      recovery.restoreQueue(root)
      expect(recovery.queue).toHaveLength(3)
      expect(recovery.queue[0]).toMatchObject({ input: 'done.md', status: 'done' })
      expect(recovery.queue[1]).toMatchObject({ input: 'a.md', status: 'pending', projectGeneration: 0 })
      expect(recovery.queue[2]).toMatchObject({ id: 9, status: 'cancelled', ingestedHash: 'hash' })
    } finally {
      recovery.snapshots.dispose()
      await recoveryContext.fiber.dispose()
    }
  })

  it('covers URL/source dispatch, already-running drain, no-op cancellation, and hashes', async () => {
    const context: ProjectExecutionContext = Object.freeze({
      projectRoot: root, wikiRoot: join(root, 'wiki'), generation: 0, startedAt: 1,
    })
    const url = vi.spyOn(service, 'ingestUrlWithContext').mockResolvedValue({ written: [], warnings: [] })
    const source = vi.spyOn(service, 'ingestSourceWithContext').mockResolvedValue({ written: [], warnings: [] })
    const baseTask: IngestQueueTask = {
      id: 1, input: 'https://example.test', projectRoot: root, wikiRoot: join(root, 'wiki'),
      projectGeneration: 0, createdAt: 1, status: 'pending',
    }
    const signal = new AbortController().signal
    await service.executeQueuedIngest(baseTask, context, signal)
    await service.executeQueuedIngest({ ...baseTask, input: 'a.md' }, context, signal)
    expect(url).toHaveBeenCalled()
    expect(source).toHaveBeenCalledWith({ path: 'raw/sources/a.md' }, context, signal)

    const activeDrain = Promise.resolve()
    service.queueDrain = activeDrain
    expect(service.drainQueue()).toBe(activeDrain)
    service.queueDrain = undefined
    service.queue.push({ ...baseTask, id: 2, status: 'done' })
    service.queue.push({ ...baseTask, id: 3, projectRoot: '/other', status: 'pending' })
    expect(service.cancelPendingForRoot(root)).toBe(false)
    expect(service.currentHash('https://example.test', root)).toBeUndefined()
    expect(() => service.currentHash('missing.md', root)).toThrow()
    expect(service.markIngested('https://example.test', context)).toBeUndefined()
    expect(() => service.markIngested('missing.md', context)).toThrow()
  })

  it('marks a hung queue task as timed out, keeps that work non-cancelled, and drains later tasks', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const stillRunning = new Promise<{ written: string[]; warnings: string[] }>((resolve) => {
      release = () => { resolve({ written: ['late.md'], warnings: [] }) }
    })
    const task: IngestQueueTask = {
      id: 10, input: 'a.md', projectRoot: root, wikiRoot: join(root, 'wiki'),
      projectGeneration: 0, createdAt: 1, status: 'pending',
    }
    const later: IngestQueueTask = { ...task, id: 11, input: 'nested/b.md' }
    service.queue.push(task, later)
    vi.spyOn(service, 'executeQueuedIngest')
      .mockReturnValueOnce(stillRunning)
      .mockResolvedValueOnce({ written: ['next.md'], warnings: [] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const draining = service.drainQueue()
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      release?.()
      await draining
      expect(service.queue[0]).toMatchObject({ status: 'error', error: 'ingest timed out after 5 minutes' })
      expect(service.queue[0]?.error).not.toContain('cancel')
      expect(service.queue[1]).toMatchObject({ status: 'done', written: ['next.md'] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('records URL success without a source hash and stringifies primitive failures', async () => {
    const urlTask: IngestQueueTask = {
      id: 30, input: 'https://example.test', projectRoot: root, wikiRoot: join(root, 'wiki'),
      projectGeneration: 0, createdAt: 1, status: 'pending',
    }
    service.queue.push(urlTask)
    const execute = vi.spyOn(service, 'executeQueuedIngest').mockResolvedValueOnce({ written: ['clip'], warnings: [] })
    await service.drainQueue()
    expect(service.queue[0]).toMatchObject({ status: 'done', written: ['clip'] })
    expect(service.queue[0]?.ingestedHash).toBeUndefined()

    service.queue.push({ ...urlTask, id: 31, input: 'a.md', status: 'pending' })
    execute.mockRejectedValueOnce('primitive queue failure')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await service.drainQueue()
    expect(service.queue[1]).toMatchObject({ status: 'error', error: 'primitive queue failure' })
  })

  it('cancels URL work without inventing an ingested hash', () => {
    service.queue.push({
      id: 40, input: 'https://example.test', projectRoot: root, wikiRoot: join(root, 'wiki'),
      projectGeneration: 0, createdAt: 1, status: 'pending',
    })
    expect(service.cancelPendingForRoot(root)).toBe(true)
    expect(service.queue[0]).toMatchObject({ status: 'cancelled' })
    expect(service.queue[0]?.ingestedHash).toBeUndefined()
  })

  it('adds queue work through the public wrapper and fails loudly on persistence errors', async () => {
    vi.spyOn(service, 'drainQueue').mockResolvedValue()
    const snapshot = await service.ingestQueueAdd({ inputs: ['a.md', 'nested/b.md'] }) as { tasks: unknown[] }
    expect(snapshot.tasks).toHaveLength(2)

    const blockedRoot = join(root, 'blocked-root')
    writeFileSync(blockedRoot, 'file', 'utf8')
    expect(() => { service.persistQueue(blockedRoot) }).toThrow()
    expect(await service.ingestQueueCancel()).toMatchObject({ running: false })
  })

  it('skips completed rows during an otherwise empty drain', async () => {
    service.queue.push({
      id: 20, input: 'a.md', projectRoot: root, wikiRoot: join(root, 'wiki'),
      projectGeneration: 0, createdAt: 1, status: 'done', written: [],
    })
    await service.drainQueue()
    expect(service.queue[0]?.status).toBe('done')
  })

  it('lists visible nested sources and hides dotfiles and node_modules', () => {
    writeFileSync(join(root, 'raw', 'sources', '.hidden'), 'hidden', 'utf8')
    mkdirSync(join(root, 'raw', 'sources', 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'raw', 'sources', 'node_modules', 'x'), 'x', 'utf8')
    symlinkSync(join(root, 'missing-source'), join(root, 'raw', 'sources', 'broken-link'))
    expect(() => service.listRawSources(root)).toThrow(/symbolic links are not allowed/u)
    rmSync(join(root, 'raw', 'sources', 'broken-link'))
    expect(service.listRawSources(root).sort()).toEqual(['a.md', 'nested/b.md'])
    expect(service.listRawSources(join(root, 'missing'))).toEqual([])
    expect(service.currentHash('a.md', root)).toBe(createHash('sha256').update('A').digest('hex'))
    service.queue.push({
      id: 99, input: 'a.md', projectRoot: root, wikiRoot: join(root, 'wiki'),
      projectGeneration: 0, createdAt: 1, status: 'pending',
    })
    service.persistQueue()
    expect(JSON.parse(readFileSync(join(root, '.llm-wiki', 'ingest-queue.json'), 'utf8'))).toHaveLength(1)
  })
})
