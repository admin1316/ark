import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import KnowledgeWikiService from '../src/index.ts'
import type { IngestQueueTask } from '../src/types.ts'
import type { ProjectExecutionContext } from '../src/project-context.ts'
import { executeKnowledgeWikiStage } from '../src/stage-executor.ts'

/** Private service surface exercised by the queue tests. */
interface TestService {
  scanSources(): Promise<void>
  drainQueue(): Promise<void>
  enqueueIngest(input: string, force?: boolean): boolean
  restoreQueue(projectRoot?: string): void
  markIngested(input: string, context?: ProjectExecutionContext): string | undefined
  executeQueuedIngest(
    task: IngestQueueTask,
    context: ProjectExecutionContext,
    signal: AbortSignal,
  ): Promise<{ written: string[]; warnings: string[] }>
  queue: IngestQueueTask[]
  ingestSource(input: { path: string }): Promise<{ written: string[]; warnings: string[] }>
  createProject(input: { name: string; path: string }): Promise<{ path: string; error?: string }>
  setProject(input: { path: string }): Promise<{ current: string }>
  ingestQueueStatus(): Promise<{ tasks: IngestQueueTask[]; running: boolean; cancelled: boolean }>
  ingestQueueCancel(): Promise<{ tasks: IngestQueueTask[]; running: boolean; cancelled: boolean }>
}

let root: string
let ctx: Context
let service: TestService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kw-queue-'))
  mkdirSync(join(root, 'raw', 'sources', 'ark-sessions'), { recursive: true })
  mkdirSync(join(root, 'wiki'), { recursive: true })
  writeFileSync(join(root, 'wiki', 'index.md'), '# Wiki Index\n')
  writeFileSync(join(root, 'raw', 'sources', 'ark-sessions', 'a.md'), 'content A')
  ctx = new Context()
  service = new KnowledgeWikiService(ctx, { wikiRoot: join(root, 'wiki'), mainRoot: root, credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm' }) as unknown as TestService
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('scanSources', () => {
  it('enqueues new files without writing the cache (cache only after success)', async () => {
    await service.scanSources()
    expect(service.queue.map(task => task.input)).toEqual(['ark-sessions/a.md'])
    expect(service.queue[0]!.status).toBe('pending')
    expect(existsSync(join(root, '.llm-wiki', 'ingest-cache.json'))).toBe(false)
  })

  it('does not re-enqueue an unchanged file after a successful ingest', async () => {
    vi.spyOn(service, 'executeQueuedIngest').mockResolvedValue({ written: [], warnings: [] })
    await service.scanSources()
    await service.drainQueue()
    expect(service.queue[0]!.status).toBe('done')
    expect(existsSync(join(root, '.llm-wiki', 'ingest-cache.json'))).toBe(true)
    service.queue.length = 0
    await service.scanSources()
    expect(service.queue).toHaveLength(0)
  })

  it('re-enqueues a changed file', async () => {
    vi.spyOn(service, 'executeQueuedIngest').mockResolvedValue({ written: [], warnings: [] })
    await service.scanSources()
    await service.drainQueue()
    writeFileSync(join(root, 'raw', 'sources', 'ark-sessions', 'a.md'), 'content B')
    await service.scanSources()
    expect(service.queue.filter(task => task.input === 'ark-sessions/a.md')).toHaveLength(2)
  })

  it('fails closed on a raw-source symlink instead of hashing external bytes', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'kw-queue-outside-'))
    try {
      writeFileSync(join(outside, 'secret.md'), 'outside')
      symlinkSync(join(outside, 'secret.md'), join(root, 'raw', 'sources', 'linked.md'))
      await expect(service.scanSources()).rejects.toThrow(/symbolic links are not allowed/u)
      expect(service.queue.some(task => task.input === 'linked.md')).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('failure detection', () => {
  it('treats a warnings-only outcome as a failure (no cache write, cooldown)', async () => {
    vi.spyOn(service, 'executeQueuedIngest').mockResolvedValue({ written: [], warnings: ['LLM key invalid'] })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    await service.scanSources()
    await service.drainQueue()
    expect(service.queue[0]!.status).toBe('error')
    expect(service.queue[0]!.failedAt).toBeTypeOf('number')
    expect(errorLog).toHaveBeenCalledWith('[knowledge-wiki] ingest failed:', 'ark-sessions/a.md', 'LLM key invalid')
    expect(existsSync(join(root, '.llm-wiki', 'ingest-cache.json'))).toBe(false)
    await service.scanSources()
    expect(service.queue.filter(task => task.status === 'pending')).toHaveLength(0)
  })
})

describe('failure cooldown', () => {
  it('keeps a failed task on cooldown and retries after it elapses', async () => {
    vi.spyOn(service, 'executeQueuedIngest').mockRejectedValue(new Error('LLM key invalid'))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    await service.scanSources()
    await service.drainQueue()
    expect(service.queue[0]!.status).toBe('error')
    expect(service.queue[0]!.failedAt).toBeTypeOf('number')
    expect(errorLog).toHaveBeenCalledWith('[knowledge-wiki] ingest failed:', 'ark-sessions/a.md', 'LLM key invalid')
    expect(existsSync(join(root, '.llm-wiki', 'ingest-cache.json'))).toBe(false)

    // Still on cooldown: scan must not re-enqueue.
    await service.scanSources()
    expect(service.queue.filter(task => task.status === 'pending')).toHaveLength(0)

    // Cooldown elapsed: re-enqueued.
    service.queue[0] = { ...service.queue[0]!, failedAt: Date.now() - 61 * 60 * 1000 }
    await service.scanSources()
    expect(service.queue.filter(task => task.status === 'pending')).toHaveLength(1)
  })
})

describe('owned timeout and quiescence', () => {
  it('aborts the same task, awaits its late resolution, and never commits a timed-out result', async () => {
    vi.useFakeTimers()
    try {
      let observedAbort = false
      vi.spyOn(service, 'executeQueuedIngest').mockImplementation((_task, _context, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            observedAbort = true
            queueMicrotask(() => { resolve({ written: ['_candidates/late.md'], warnings: [] }) })
          }, { once: true })
        }))
      service.enqueueIngest('ark-sessions/a.md')
      const drain = service.drainQueue()
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      await drain

      expect(observedAbort).toBe(true)
      expect(service.queue[0]).toMatchObject({
        status: 'error',
        error: 'ingest timed out after 5 minutes',
      })
      expect(service.queue[0]!.failedAt).toBeTypeOf('number')
      expect(service.queue[0]!.written).toBeUndefined()
      expect(existsSync(join(root, '.llm-wiki', 'ingest-cache.json'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues to the next queue item after a forced non-cooperative stage timeout', async () => {
    vi.useFakeTimers()
    try {
      writeFileSync(join(root, 'raw', 'sources', 'ark-sessions', 'b.md'), 'content B')
      service.enqueueIngest('ark-sessions/a.md')
      service.enqueueIngest('ark-sessions/b.md')
      vi.spyOn(service, 'executeQueuedIngest').mockImplementation(async (task, _context, signal) => {
        if (task.input.endsWith('a.md')) {
          await executeKnowledgeWikiStage({
            isolation: 'owned-worker-v1',
            execute: () => new Promise(() => {}),
          }, {
            kind: 'file-extract',
            path: task.input,
            timeoutMs: 25,
          }, signal)
        }
        return { written: [`_candidates/${task.id}.md`], warnings: [] }
      })
      const drain = service.drainQueue()
      await vi.advanceTimersByTimeAsync(25)
      await drain
      expect(service.queue.map(task => task.status)).toEqual(['error', 'done'])
      expect(service.queue[0]!.error).toContain('timed out after 25ms')
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists a running lease and a user cancellation tombstone', async () => {
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    vi.spyOn(service, 'executeQueuedIngest').mockImplementation((_task, _context, signal) =>
      new Promise((_resolve, reject) => {
        started()
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('ingest aborted'))
        }, { once: true })
      }))
    service.enqueueIngest('ark-sessions/a.md')
    const drain = service.drainQueue()
    await didStart
    const running = JSON.parse(readFileSync(join(root, '.llm-wiki', 'ingest-queue.json'), 'utf8')) as IngestQueueTask[]
    expect(running[0]).toMatchObject({ status: 'running' })
    expect(running[0]!.runId).toBeTypeOf('string')
    expect(running[0]!.leaseStartedAt).toBeTypeOf('number')

    await service.ingestQueueCancel()
    await drain
    const cancelled = JSON.parse(readFileSync(join(root, '.llm-wiki', 'ingest-queue.json'), 'utf8')) as IngestQueueTask[]
    expect(cancelled[0]).toMatchObject({ status: 'cancelled' })
    expect(cancelled[0]!.cancelRequestedAt).toBeTypeOf('number')
    expect(cancelled[0]!.completedAt).toBeTypeOf('number')
  })
})

describe('queue persistence', () => {
  it('persists pending tasks and restores them on a fresh service', async () => {
    service.enqueueIngest('ark-sessions/a.md')
    const queueFile = join(root, '.llm-wiki', 'ingest-queue.json')
    expect(existsSync(queueFile)).toBe(true)
    const durable = JSON.parse(readFileSync(queueFile, 'utf8')) as IngestQueueTask[]
    expect(durable).toHaveLength(1)
    expect(durable[0]).toMatchObject({
      id: 1,
      input: 'ark-sessions/a.md',
      projectRoot: root,
      wikiRoot: join(root, 'wiki'),
      projectGeneration: 0,
      status: 'pending',
    })
    expect(durable[0]!.createdAt).toBeTypeOf('number')

    const ctx2 = new Context()
    const fresh = new KnowledgeWikiService(ctx2, { wikiRoot: join(root, 'wiki'), mainRoot: root, credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm' }) as unknown as TestService
    fresh.restoreQueue()
    expect(fresh.queue.map(task => task.input)).toEqual(['ark-sessions/a.md'])
    expect(fresh.queue[0]!.status).toBe('pending')
    await ctx2.fiber.dispose()
  })

  it('persists error outcomes and cooldown state', async () => {
    vi.spyOn(service, 'executeQueuedIngest').mockRejectedValue(new Error('x'))
    await service.scanSources()
    await service.drainQueue()
    const durable = JSON.parse(readFileSync(join(root, '.llm-wiki', 'ingest-queue.json'), 'utf8')) as unknown[]
    expect(durable).toHaveLength(1)
    expect(durable[0]).toMatchObject({ status: 'error', error: 'x' })
    expect((durable[0] as IngestQueueTask).failedAt).toBeTypeOf('number')
  })

  it('migrates a legacy queue record using the queue file owning workspace', async () => {
    const queueFile = join(root, '.llm-wiki', 'ingest-queue.json')
    mkdirSync(join(queueFile, '..'), { recursive: true })
    writeFileSync(queueFile, JSON.stringify([{ id: 7, input: 'ark-sessions/a.md', status: 'pending' }]))
    const ctx2 = new Context()
    const fresh = new KnowledgeWikiService(ctx2, {
      wikiRoot: join(root, 'wiki'),
      mainRoot: root,
      credential: 'VISION_API_KEY',
      llmProvider: 'p',
      llmModel: 'm',
    }) as unknown as TestService

    fresh.restoreQueue(root)

    expect(fresh.queue[0]).toMatchObject({
      id: 7,
      projectRoot: root,
      wikiRoot: join(root, 'wiki'),
      status: 'pending',
    })
    await ctx2.fiber.dispose()
  })
})

describe('enqueueIngest dedup', () => {
  it('skips pending/running duplicates and honors manual re-run of done tasks', () => {
    expect(service.enqueueIngest('ark-sessions/a.md')).toBe(true)
    expect(service.enqueueIngest('ark-sessions/a.md')).toBe(false)
    const realHash = createHash('sha256').update('content A').digest('hex')
    service.queue[0] = { ...service.queue[0]!, status: 'done', written: [], ingestedHash: realHash }
    // Unchanged content + no force: a true duplicate, blocked.
    expect(service.enqueueIngest('ark-sessions/a.md')).toBe(false)
    // Manual re-run (force) bypasses the unchanged-content guard.
    expect(service.enqueueIngest('ark-sessions/a.md', true)).toBe(true)
  })

  it('re-enqueues a done task when the source content changed', () => {
    service.enqueueIngest('ark-sessions/a.md')
    const oldHash = createHash('sha256').update('content A').digest('hex')
    writeFileSync(join(root, 'raw', 'sources', 'ark-sessions', 'a.md'), 'content B')
    service.queue[0] = { ...service.queue[0]!, status: 'done', written: [], ingestedHash: oldHash }
    expect(service.enqueueIngest('ark-sessions/a.md')).toBe(true)
  })

  it('dedupes a project-relative input against a scanner-relative task', () => {
    expect(service.enqueueIngest('ark-sessions/a.md')).toBe(true)
    expect(service.enqueueIngest('raw/sources/ark-sessions/a.md')).toBe(false)
    expect(service.queue[0]!.input).toBe('ark-sessions/a.md')
  })

  it('scopes duplicate identities and queue snapshots to their workspace', async () => {
    const external = mkdtempSync(join(tmpdir(), 'kw-queue-scope-'))
    try {
      expect(await service.createProject({ name: 'External', path: external }))
        .toEqual({ path: external })
      expect(service.enqueueIngest('ark-sessions/a.md')).toBe(true)
      await service.setProject({ path: external })
      expect(service.enqueueIngest('ark-sessions/a.md')).toBe(true)

      expect(service.queue.map(task => task.projectRoot)).toEqual([root, external])
      const snapshot = await service.ingestQueueStatus()
      expect(snapshot.tasks).toHaveLength(1)
      expect(snapshot.tasks[0]!.projectRoot).toBe(external)
    } finally {
      rmSync(external, { recursive: true, force: true })
    }
  })
})

describe('pending cancellation', () => {
  it('atomically cancels every pending task and suppresses unchanged scanner requeue', async () => {
    writeFileSync(join(root, 'raw', 'sources', 'ark-sessions', 'b.md'), 'content B')
    expect(service.enqueueIngest('ark-sessions/a.md')).toBe(true)
    expect(service.enqueueIngest('ark-sessions/b.md')).toBe(true)

    const cancelled = await service.ingestQueueCancel()
    expect(cancelled.tasks.map(task => task.status)).toEqual(['cancelled', 'cancelled'])
    expect(cancelled.tasks.every(task => typeof task.ingestedHash === 'string')).toBe(true)

    await service.scanSources()
    expect(service.queue.filter(task => task.status === 'pending')).toHaveLength(0)

    writeFileSync(join(root, 'raw', 'sources', 'ark-sessions', 'a.md'), 'content A changed')
    await service.scanSources()
    expect(service.queue.filter(task => task.status === 'pending').map(task => task.input))
      .toEqual(['ark-sessions/a.md'])
  })

  it('restores cancelled-source tombstones across service restart', async () => {
    service.enqueueIngest('ark-sessions/a.md')
    await service.ingestQueueCancel()

    const durable = JSON.parse(readFileSync(join(root, '.llm-wiki', 'ingest-queue.json'), 'utf8')) as IngestQueueTask[]
    expect(durable).toHaveLength(1)
    expect(durable[0]).toMatchObject({ input: 'ark-sessions/a.md', status: 'cancelled' })

    const ctx2 = new Context()
    const fresh = new KnowledgeWikiService(ctx2, {
      wikiRoot: join(root, 'wiki'),
      mainRoot: root,
      credential: 'VISION_API_KEY',
      llmProvider: 'p',
      llmModel: 'm',
    }) as unknown as TestService
    fresh.restoreQueue(root)
    expect(fresh.queue).toHaveLength(1)
    expect(fresh.queue[0]).toMatchObject({ input: 'ark-sessions/a.md', status: 'cancelled' })
    await fresh.scanSources()
    expect(fresh.queue.filter(task => task.status === 'pending')).toHaveLength(0)
    await ctx2.fiber.dispose()
  })
})

describe('ingest path dispatch', () => {
  it('restores the raw/sources prefix when dispatching a scanned task', async () => {
    const spy = vi.spyOn(service, 'executeQueuedIngest').mockResolvedValue({ written: [], warnings: [] })
    await service.scanSources()
    await service.drainQueue()
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'ark-sessions/a.md', projectRoot: root }),
      expect.objectContaining({ projectRoot: root, wikiRoot: join(root, 'wiki') }),
      expect.any(AbortSignal),
    )
    expect(service.queue[0]!.status).toBe('done')
  })

  it('keeps an A task bound to A after switching the active project to B', async () => {
    const external = mkdtempSync(join(tmpdir(), 'kw-queue-external-'))
    try {
      mkdirSync(join(external, 'wiki'), { recursive: true })
      mkdirSync(join(external, 'raw', 'sources'), { recursive: true })
      writeFileSync(join(external, 'wiki', 'index.md'), '# External\n')
      const spy = vi.spyOn(service, 'executeQueuedIngest').mockResolvedValue({ written: [], warnings: [] })
      service.enqueueIngest('ark-sessions/a.md')

      await service.setProject({ path: external })
      await service.drainQueue()

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ projectRoot: root }),
        expect.objectContaining({ projectRoot: root, wikiRoot: join(root, 'wiki') }),
        expect.any(AbortSignal),
      )
      expect(existsSync(join(root, '.llm-wiki', 'ingest-cache.json'))).toBe(true)
      expect(existsSync(join(external, '.llm-wiki', 'ingest-cache.json'))).toBe(false)
    } finally {
      rmSync(external, { recursive: true, force: true })
    }
  })
})
