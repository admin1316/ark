import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import KnowledgeWikiService, { type Config } from '../src/index.ts'
import type { IngestQueueTask, KnowledgeProjectContextId } from '../src/types.ts'
import type { ProjectExecutionContext } from '../src/project-context.ts'
import type { KnowledgeWikiStageExecutor } from '../src/stage-executor.ts'
import { wikiTestConfig } from './config-fixture.ts'

interface QueueOwner {
  queue: IngestQueueTask[]
  restoreQueue(root: string): void
  enqueueIngest(input: string, force?: boolean, context?: ProjectExecutionContext): boolean
  drainQueue(): Promise<void>
  scanSources(): Promise<void>
  activeIngest?: { controller: AbortController }
  captureProjectContext(): ProjectExecutionContext
  projectToken(root: string): KnowledgeProjectContextId
  executeQueuedIngest(
    task: IngestQueueTask, context: ProjectExecutionContext, signal: AbortSignal,
  ): Promise<{ written: string[]; warnings: string[] }>
}

const diskFault = vi.hoisted(() => ({ queueWrites: 0, failAt: 0 }))
vi.mock('../src/filesystem.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/filesystem.ts')>()
  return { ...actual, atomicWriteFile: (...args: Parameters<typeof actual.atomicWriteFile>) => {
    if (args[0].endsWith('/ingest-queue.json') && ++diskFault.queueWrites === diskFault.failAt) throw new Error('synthetic queue disk failure')
    actual.atomicWriteFile(...args)
  } }
})

const roots: string[] = []
const contexts: Context[] = []
function fixture(options: Partial<Config> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-admission-'))
  roots.push(root)
  const main = join(root, 'main')
  mkdirSync(join(main, 'wiki'), { recursive: true })
  mkdirSync(join(main, 'raw', 'sources'), { recursive: true })
  const ctx = new Context()
  contexts.push(ctx)
  const config = wikiTestConfig({ wikiRoot: join(main, 'wiki'), mainRoot: main, ...options })
  const service = new KnowledgeWikiService(ctx, config)
  return { root, main, ctx, config, service, owner: service as unknown as QueueOwner }
}
const tick = async (): Promise<void> => { for (let index = 0; index < 12; index++) await Promise.resolve(undefined) }
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  diskFault.queueWrites = 0
  diskFault.failAt = 0
})

describe('task completion and bounded durable admission', () => {
  it('returns the initiating project task even when restored numeric ids collide', async () => {
    const { root, service, owner } = fixture()
    const a = await service.createProject({ name: 'A', path: join(root, 'A') })
    const b = await service.createProject({ name: 'B', path: join(root, 'B') })
    for (const [project, status, output] of [[a, 'done', 'A.md'], [b, 'pending', 'B.md']] as const) {
      mkdirSync(join(project.path, '.llm-wiki'), { recursive: true })
      writeFileSync(join(project.path, '.llm-wiki', 'ingest-queue.json'), JSON.stringify([{ id: 1, input: 'a.md', status, written: [output], warnings: [] }]))
      writeFileSync(join(project.path, 'raw', 'sources', 'a.md'), output)
      owner.restoreQueue(project.path)
    }
    vi.spyOn(owner, 'executeQueuedIngest').mockResolvedValue({ written: ['B.md'], warnings: [] })
    const result = await service.ingestSource({ projectContext: b.projectContext!, path: '/raw/sources/a.md' })
    expect(result.written).toEqual(['B.md'])
  })

  it('settles A without waiting for a later blocked B', async () => {
    const { service, owner, main } = fixture()
    const gate = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    vi.spyOn(owner, 'executeQueuedIngest').mockImplementation(async (task) => {
      if (task.input.endsWith('/B')) { started.resolve(undefined); await gate.promise }
      return { written: [task.input], warnings: [] }
    })
    const token = owner.projectToken(main)
    const a = service.ingestUrl({ projectContext: token, url: 'https://synthetic.test/A' })
    owner.enqueueIngest('https://synthetic.test/B')
    await started.promise
    try { expect((await a).written).toEqual(['https://synthetic.test/A']) } finally { gate.resolve(undefined); await owner.drainQueue() }
  })

  it('rejects an oversized batch or input without partially changing durable state', async () => {
    const { service, owner, main } = fixture({ ingestMaxActiveTasks: 2, ingestMaxBatchInputs: 2, ingestStateMaxBytes: 4096 })
    const projectContext = owner.projectToken(main)
    await expect(service.ingestQueueAdd({ projectContext, inputs: ['a', 'b', 'c'] })).rejects.toThrow('ingestMaxBatchInputs')
    expect(owner.queue).toHaveLength(0)
    expect(() => owner.enqueueIngest('x'.repeat(4096))).toThrow('capacity')
    expect(owner.queue).toHaveLength(0)
    owner.enqueueIngest('https://synthetic.test/A')
    const before = readFileSync(join(main, '.llm-wiki', 'ingest-queue.json'), 'utf8')
    await expect(service.ingestQueueAdd({ projectContext, inputs: ['https://synthetic.test/B', 'https://synthetic.test/C'] })).rejects.toThrow('capacity')
    expect(owner.queue).toHaveLength(1)
    expect(readFileSync(join(main, '.llm-wiki', 'ingest-queue.json'), 'utf8')).toBe(before)
  })

  it('reserves source dispositions for the whole admitted batch', async () => {
    const { service, owner, main } = fixture({ ingestMaxActiveTasks: 4, ingestStateMaxBytes: 4096 })
    mkdirSync(join(main, '.llm-wiki'), { recursive: true })
    writeFileSync(join(main, '.llm-wiki', 'ingest-cache.json'), JSON.stringify({ filler: 'x'.repeat(3970) }))
    await expect(service.ingestQueueAdd({ projectContext: owner.projectToken(main), inputs: ['a.md', 'b.md'] })).rejects.toThrow('capacity')
    expect(owner.queue).toHaveLength(0)
  })

  it('rolls back failed restore and never changes project selection on invalid state', async () => {
    const { root, service, owner, main } = fixture()
    const a = await service.createProject({ name: 'A', path: join(root, 'A') })
    mkdirSync(join(a.path, '.llm-wiki'), { recursive: true })
    writeFileSync(join(a.path, '.llm-wiki', 'ingest-queue.json'), JSON.stringify([{ id: 1, input: 'a.md', status: 'pending' }, { id: 1, input: 'b.md', status: 'pending' }]))
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(service.setProject({ path: a.path })).rejects.toThrow('duplicate')
      expect(owner.queue).toHaveLength(0)
      expect(owner.captureProjectContext().projectRoot).toBe(main)
    }
  })

  it.each([0, 2])('keeps cancellation across history limit %i, restart, and its crash window', async (ingestHistoryLimit) => {
    const { main, config, service, owner } = fixture({ ingestHistoryLimit })
    writeFileSync(join(main, 'raw', 'sources', 'a.md'), 'unchanged')
    owner.enqueueIngest('a.md')
    const pending = readFileSync(join(main, '.llm-wiki', 'ingest-queue.json'), 'utf8')
    await service.ingestQueueCancel({ projectContext: owner.projectToken(main) })
    expect(owner.queue.every(task => task.status === 'cancelled')).toBe(true)
    // The cancellation disposition committed, but the old pending queue survived a crash.
    writeFileSync(join(main, '.llm-wiki', 'ingest-queue.json'), pending)
    const ctx = new Context(); contexts.push(ctx)
    const fresh = new KnowledgeWikiService(ctx, config) as unknown as QueueOwner
    fresh.restoreQueue(main)
    await fresh.scanSources()
    expect(fresh.queue.every(task => task.status === 'cancelled')).toBe(true)
    // A separately admitted manual retry has a fresh admission identity and survives restart.
    fresh.enqueueIngest('a.md', true)
    const ctx2 = new Context(); contexts.push(ctx2)
    const next = new KnowledgeWikiService(ctx2, config) as unknown as QueueOwner
    next.restoreQueue(main)
    expect(next.queue.filter(task => task.status === 'pending')).toHaveLength(1)
  })

  it('returns a bounded capacity failure for oversized stage outcomes and can restore it', async () => {
    const { config, main, service, owner } = fixture({ ingestMaxActiveTasks: 2, ingestStateMaxBytes: 4096 })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(owner, 'executeQueuedIngest').mockResolvedValue({ written: ['preserved.md'], warnings: ['x'.repeat(9000)] })
    const result = await service.ingestUrl({ projectContext: owner.projectToken(main), url: 'https://synthetic.test/large' })
    expect(result.status).toBe('error')
    expect(result.warnings.join()).toContain('generated files were preserved')
    expect(statSync(join(main, '.llm-wiki', 'ingest-queue.json')).size).toBeLessThanOrEqual(4096)
    const ctx = new Context(); contexts.push(ctx)
    const fresh = new KnowledgeWikiService(ctx, config) as unknown as QueueOwner
    fresh.restoreQueue(main)
    expect(fresh.queue[0]?.status).toBe('error')
  })

  it('settles a completed-task waiter when final persistence fails and restores the running lease', async () => {
    const { main, config, service, owner } = fixture()
    vi.spyOn(owner, 'executeQueuedIngest').mockResolvedValue({ written: ['preserved.md'], warnings: [] })
    diskFault.failAt = 3
    const outcome = await service.ingestUrl({ projectContext: owner.projectToken(main), url: 'https://synthetic.test/io' })
    expect(outcome.status).toBe('error')
    expect(outcome.warnings.join()).toContain('synthetic queue disk failure')
    diskFault.failAt = 0
    const ctx = new Context(); contexts.push(ctx)
    const fresh = new KnowledgeWikiService(ctx, config) as unknown as QueueOwner
    fresh.restoreQueue(main)
    expect(fresh.queue[0]?.status).toBe('pending')
  })

  it('consumes the reserved lease bytes when a boundary-sized pending task starts', async () => {
    const { main, owner } = fixture({ ingestMaxActiveTasks: 1, ingestStateMaxBytes: 4096 })
    const base = 'https://synthetic.test/'
    owner.enqueueIngest(base)
    const encoded = statSync(join(main, '.llm-wiki', 'ingest-queue.json')).size
    owner.queue.length = 0
    owner.enqueueIngest(base + 'x'.repeat(4096 - 512 - encoded))
    expect(statSync(join(main, '.llm-wiki', 'ingest-queue.json')).size).toBe(4096 - 512)
    const execute = vi.spyOn(owner, 'executeQueuedIngest').mockResolvedValue({ written: [], warnings: [] })
    await owner.drainQueue()
    expect(execute).toHaveBeenCalledOnce()
    expect(owner.queue[0]?.status).toBe('done')
    expect(owner.activeIngest).toBeUndefined()
  })

  it('releases the active owner when persisting the starting lease fails', async () => {
    const { main, service, owner } = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const execute = vi.spyOn(owner, 'executeQueuedIngest').mockResolvedValue({ written: [], warnings: [] })
    diskFault.failAt = 2
    const result = await service.ingestUrl({ projectContext: owner.projectToken(main), url: 'https://synthetic.test/start' })
    expect(result.status).toBe('error')
    expect(result.warnings.join()).toContain('synthetic queue disk failure')
    expect(execute).not.toHaveBeenCalled()
    expect(owner.activeIngest).toBeUndefined()
  })

  it('retains the newest terminal history while preserving completed source versions', async () => {
    const { owner } = fixture({ ingestHistoryLimit: 1 })
    vi.spyOn(owner, 'executeQueuedIngest').mockResolvedValue({ written: [], warnings: [] })
    for (const input of ['https://synthetic.test/one', 'https://synthetic.test/two']) {
      owner.enqueueIngest(input)
      await owner.drainQueue()
    }
    expect(owner.queue.map(task => task.input)).toEqual(['https://synthetic.test/two'])
  })

  it.each([null, [], { a: null }, { a: { retryAfter: 'later' } }])('rejects malformed disposition state %j', (value) => {
    const { owner, main } = fixture()
    mkdirSync(join(main, '.llm-wiki'), { recursive: true })
    writeFileSync(join(main, '.llm-wiki', 'ingest-cache.json'), JSON.stringify(value))
    expect(() => owner.enqueueIngest('a.md')).toThrow('disposition')
    expect(owner.queue).toHaveLength(0)
  })
})

describe('research operation ownership', () => {
  it.each([0, -1, Number.POSITIVE_INFINITY, 3_600_001, 1.5])('rejects invalid researchTimeoutMs %s at configuration load', (researchTimeoutMs) => {
    expect(() => wikiTestConfig({ wikiRoot: '/synthetic/wiki', researchTimeoutMs })).toThrow()
  })

  it('starts the total deadline before asynchronous preflight and clears its timer after quiescence', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<undefined>()
    const { ctx, main, owner, service } = fixture({ researchConcurrency: 1, researchTimeoutMs: 10 })
    let preflightSignal: AbortSignal | undefined
    const execute = vi.fn<KnowledgeWikiStageExecutor['execute']>()
    ctx.provide('knowledgeWikiStageExecutor', {
      isolation: 'owned-worker-v1',
      async assertSearchAvailable(signal) { preflightSignal = signal; await gate.promise },
      execute,
    } satisfies KnowledgeWikiStageExecutor)
    const projectContext = owner.projectToken(main)
    const pending = service.deepResearch({ projectContext, topic: 'held preflight' }, new AbortController().signal)
    try {
      await tick()
      expect((await service.projectStatus({ projectContext })).researchTimeoutMs).toBe(10)
      await vi.advanceTimersByTimeAsync(10)
      expect(preflightSignal?.aborted).toBe(true)
      expect(execute).not.toHaveBeenCalled()
      gate.resolve(undefined)
      const result = await pending
      expect(result.errorCode).toBe('timeout')
      expect(result.findings).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      gate.resolve(undefined)
      await pending
      vi.useRealTimers()
    }
  })

  it('holds capacity after deadline until the stage stops and rejects its late success before writing', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<undefined>()
    const { ctx, main, owner, service } = fixture({ researchConcurrency: 1, researchTimeoutMs: 10 })
    let stageSignal: AbortSignal | undefined
    let calls = 0
    let settling = false
    ctx.provide('knowledgeWikiStageExecutor', {
      isolation: 'owned-worker-v1', assertSearchAvailable() {},
      async execute(_request, signal) {
        calls++
        stageSignal = signal
        if (calls === 1) await gate.promise
        return { text: calls === 1 ? 'late query' : '' }
      },
    } satisfies KnowledgeWikiStageExecutor)
    const projectContext = owner.projectToken(main)
    const pending = service.deepResearch({ projectContext, topic: 'late stage' }, new AbortController().signal)
    const observed = pending.then(() => { settling = true })
    try {
      await tick()
      await vi.advanceTimersByTimeAsync(10)
      expect(stageSignal?.aborted).toBe(true)
      expect(settling).toBe(false)
      const busy = await service.deepResearch({ projectContext, topic: 'waiting topic' }, new AbortController().signal)
      expect(busy.warnings.join()).toContain('busy')
      expect(calls).toBe(1)
      gate.resolve(undefined)
      expect((await pending).errorCode).toBe('timeout')
      await observed
      expect(existsSync(join(main, 'wiki', '_candidates', 'research'))).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      const next = await service.deepResearch({ projectContext, topic: 'new topic' }, new AbortController().signal)
      expect(next.errorCode).toBe('invalid-queries')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      gate.resolve(undefined)
      await observed
      vi.useRealTimers()
    }
  })

  it('shares duplicates, bounds other topics, and detaches one cancelled subscriber', async () => {
    const { ctx, service, main, owner } = fixture({ researchConcurrency: 1 })
    const gate = Promise.withResolvers<undefined>()
    let expansions = 0
    let synthesis = 0
    let ownerSignal: AbortSignal | undefined
    const executor: KnowledgeWikiStageExecutor = {
      isolation: 'owned-worker-v1', assertSearchAvailable() {},
      async execute(request, signal) {
        ownerSignal = signal
        if (request.kind === 'web-search') return { text: null, sources: [{ url: 'https://source.test' }] }
        if (request.kind !== 'llm-complete') throw new Error('unexpected stage')
        if (request.operation === 'research query expansion') { expansions++; await gate.promise; return { text: 'focused query' } }
        synthesis++
        return { text: '--- FILE: wiki/_candidates/research/shared.md ---\n---\ntitle: Shared\n---\n\nComplete\n--- END FILE ---' }
      },
    }
    ctx.provide('knowledgeWikiStageExecutor', executor)
    const projectContext = owner.projectToken(main)
    const cancel = new AbortController()
    const first = service.deepResearch({ projectContext, topic: 'same' }, cancel.signal)
    const firstObserved = first.catch((error: unknown) => error)
    const second = service.deepResearch({ projectContext, topic: ' same ' }, new AbortController().signal)
    await tick()
    expect(expansions).toBe(1)
    const busy = await service.deepResearch({ projectContext, topic: 'other' }, new AbortController().signal)
    expect(busy.warnings.join()).toContain('busy')
    cancel.abort(new Error('subscriber stopped'))
    await firstObserved
    expect(ownerSignal?.aborted).toBe(false)
    gate.resolve(undefined)
    expect((await second).findings).toHaveLength(1)
    expect(synthesis).toBe(1)
  })

  it('aborts the shared owner only after the final subscriber cancels', async () => {
    const { ctx, service, main, owner } = fixture()
    const stopped = Promise.withResolvers<undefined>()
    let stageSignal: AbortSignal | undefined
    ctx.provide('knowledgeWikiStageExecutor', {
      isolation: 'owned-worker-v1', assertSearchAvailable() {},
      execute: (_request, signal) => new Promise((_resolve, reject) => {
        stageSignal = signal
        signal.addEventListener('abort', () => { stopped.resolve(undefined); reject(signal.reason instanceof Error ? signal.reason : new Error('owner stopped')) }, { once: true })
      }),
    } satisfies KnowledgeWikiStageExecutor)
    const a = new AbortController(), b = new AbortController()
    const request = { projectContext: owner.projectToken(main), topic: 'shared' }
    const first = service.deepResearch(request, a.signal).catch((error: unknown) => error)
    const second = service.deepResearch(request, b.signal).catch((error: unknown) => error)
    await tick()
    a.abort(); await first
    expect(stageSignal?.aborted).toBe(false)
    b.abort(); await second; await stopped.promise
    expect(stageSignal?.aborted).toBe(true)
  })
})
