/**
 * Closure tests for KnowledgeWikiService (src/index.ts) behavior the
 * surface/queue/summary/network specs leave uncovered: the owned-worker stage
 * seam and its per-stage connection resolver, durable queue migration, unsafe
 * raw-source trees, the review/verification binding gate, session-summary write
 * failures, and disposal ownership of in-flight work.
 *
 * Only non-deterministic boundaries are doubled: the model endpoint is a local
 * HTTP server the owned isolate really calls over the network stack, the
 * embedding endpoint is a stubbed global fetch (network), and the parent-owned
 * stage isolate is an in-process adapter. Every filesystem, queue, graph,
 * review and ingest behavior below is the production implementation running
 * against a real temp-dir workspace.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import KnowledgeWikiService, { isBlockedNetworkAddress, type Config } from '../src/index.ts'
import { appendCandidateReviews } from '../src/reviews.ts'
import type { KnowledgeWikiStageExecutor } from '../src/stage-executor.ts'
import type { ProjectExecutionContext } from '../src/project-context.ts'
import type { CandidateVerificationResult, IngestQueueTask } from '../src/types.ts'
import { wikiTestConfig } from './config-fixture.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

interface IngestOutcomeLike {
  written: string[]
  warnings: string[]
  status: 'ok' | 'degraded' | 'error'
  errorCode?: string
}

interface QueueSnapshotLike {
  tasks: IngestQueueTask[]
  running: boolean
  cancelled: boolean
}

/** Private service surface exercised by these closure tests. */
interface ClosureSurface {
  snapshots: { dispose(): void; currentGeneration(root: string): number }
  queue: IngestQueueTask[]
  ingestSource(request: { path: string }): Promise<IngestOutcomeLike>
  ingestQueueAdd(request: { inputs: string[] }): Promise<QueueSnapshotLike>
  ingestQueueStatus(): Promise<QueueSnapshotLike>
  ingestQueueCancel(): Promise<QueueSnapshotLike>
  drainQueue(): Promise<void>
  scanSources(): Promise<void>
  restoreQueue(projectRoot?: string): void
  markIngested(input: string, context?: ProjectExecutionContext): string | undefined
  currentHash(input: string, projectRoot?: string): string | undefined
  readCache(projectRoot?: string): Record<string, string>
  writeCache(cache: Record<string, string>, projectRoot?: string): void
  queueFile(projectRoot?: string): string
  listRawSources(projectRoot?: string): string[]
  recordKnowledgeRetrieval(paths: string[], projectRoot?: string): void
  search(request: { query: string; topK?: number }): Promise<Array<{ path: string; score: number }>>
  knowledgeUtility(): Promise<Array<{ path: string; retrievalHits: number }>>
  writePage(request: { path: string; content: string; expectedContent?: string }): Promise<Record<string, unknown>>
  lint(): Promise<{
    brokenLinks: Array<{ from: string; target: string }>
    emptyPages: string[]
    totalPages: number
  }>
  pageContent(request: { path: string }): Promise<{ path: string; content: string }>
  reviews(request: { status?: string; limit?: number }): Promise<Array<{ id: string; resolved?: boolean }>>
  resolveReview(request: { reviewId: string; action?: string }): Promise<boolean>
  summarizeSession(sessionId: string | undefined): Promise<void>
  deepResearch(request: { topic: string }, signal: AbortSignal): Promise<{
    findings: Array<{ title: string; path: string }>
    warnings: string[]
    degraded: boolean
    errorCode?: string
  }>
  verifyCandidate(
    request: { reviewId: string; action: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' | 'Archive' },
    signal: AbortSignal,
  ): Promise<CandidateVerificationResult>
  [Service.init](): Promise<void>
}

const roots: string[] = []
const contexts: Context[] = []
const services: ClosureSurface[] = []
const servers: Server[] = []

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** Real workspace layout: <root>/wiki plus <root>/raw/sources. */
function workspace(prefix: string): { root: string; wikiRoot: string } {
  const root = tempRoot(prefix)
  const wikiRoot = join(root, 'wiki')
  mkdirSync(join(root, 'raw', 'sources'), { recursive: true })
  mkdirSync(wikiRoot, { recursive: true })
  return { root, wikiRoot }
}

/** Credential surface double: resolves only the seeded references. */
function seedCredentials(seed: Record<string, string>): { resolve(ref: CredentialRef): Promise<{ value: string } | undefined> } {
  const values = new Map<CredentialRef, string>()
  for (const [key, value] of Object.entries(seed)) values.set(credentialRef(key), value)
  return {
    resolve: (ref) => {
      const found = values.get(ref)
      return Promise.resolve(found === undefined ? undefined : { value: found })
    },
  }
}

function create(ctx: Context, config: Pick<Config, 'wikiRoot' | 'mainRoot'> & Partial<Config>): ClosureSurface {
  const service = new KnowledgeWikiService(ctx, wikiTestConfig(config)) as unknown as ClosureSurface
  services.push(service)
  return service
}

/** Content of one summary decision; only the LLM boundary is synthesized. */
function summaryDecision(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'candidate',
    title: 'Stable Topic',
    topic_key: 'stable-topic',
    issue_key: '',
    claims: ['claim'],
    decisions: ['decision'],
    procedures: ['procedure'],
    verification_evidence: ['测试通过'],
    related: ['concepts/one'],
    scores: { reusable: 2, novelty: 2, evidence: 2, stability: 2 },
    ...overrides,
  })
}

function longEvents(): unknown[] {
  return [
    { type: 'turn/start' },
    { type: 'user/message', data: { content: '用户提出一个可复用问题。'.repeat(12) } },
    { type: 'assistant/message', data: { content: '助手给出稳定方法、验证证据和回滚边界。'.repeat(12) } },
  ]
}

/** Stage isolate double that settles only when its owner aborts it. */
function hangingStageExecutor(observed: AbortSignal[]): KnowledgeWikiStageExecutor {
  return {
    isolation: 'owned-worker-v1',
    execute(_request, signal) {
      observed.push(signal)
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('stage aborted'))
        }, { once: true })
      })
    },
  }
}

/** Real chat-completions endpoint the owned isolate fetches. */
async function startModelServer(answer: (callIndex: number) => string): Promise<{
  baseUrl: string
  authorizations: string[]
}> {
  const authorizations: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      authorizations.push(request.headers.authorization ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        choices: [{ message: { content: answer(authorizations.length - 1) } }],
      }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing model listener')
  return { baseUrl: 'http://127.0.0.1:' + String(address.port), authorizations }
}

function resetRawSources(root: string): string {
  const sources = join(root, 'raw', 'sources')
  rmSync(sources, { recursive: true, force: true })
  mkdirSync(sources, { recursive: true })
  return sources
}

let root: string
let wikiRoot: string
let ctx: Context
let service: ClosureSurface

beforeEach(() => {
  const created = workspace('wiki-closure-')
  root = created.root
  wikiRoot = created.wikiRoot
  ctx = new Context()
  contexts.push(ctx)
  Object.defineProperty(ctx, 'credentials', {
    configurable: true,
    value: seedCredentials({}),
  })
  service = create(ctx, {
    wikiRoot, mainRoot: root, credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
  })
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  for (const item of services.splice(0)) item.snapshots.dispose()
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const item of roots.splice(0)) rmSync(item, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('owned stage isolate seam', () => {
  it('ingests through the owned worker isolate with the configured llm credential', async () => {
    const model = await startModelServer(index => index === 0 ? 'analysis of the note' : 'no FILE blocks here')
    const ownedCtx = new Context()
    contexts.push(ownedCtx)
    Object.defineProperty(ownedCtx, 'credentials', {
      configurable: true,
      value: seedCredentials({ WIKI_LLM_KEY: 'declared-key' }),
    })
    const owned = create(ownedCtx, {
      wikiRoot, mainRoot: root, credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
      llmCredential: 'WIKI_LLM_KEY', llmBaseUrl: model.baseUrl, ownedStageExecutor: true,
    })
    writeFileSync(join(root, 'raw', 'sources', 'note.md'),
      'Reusable source about code, tests, API, and deployment.', 'utf8')

    const outcome = await owned.ingestSource({ path: 'note.md' })

    expect(outcome.status).toBe('ok')
    expect(outcome.warnings).toEqual([])
    expect(outcome.written).toContain('wiki/_governance/ingest-candidate-log.md')
    expect(outcome.written.some(path => path.startsWith('wiki/_candidates/ingest/sources/'))).toBe(true)
    for (const path of outcome.written) expect(existsSync(join(root, path))).toBe(true)
    // The parent resolved the connection facts and the isolate really sent them.
    expect(model.authorizations).toEqual(['Bearer declared-key', 'Bearer declared-key'])
  })

  it('prefers the settings-declared apiKeyEnv over the process environment default', async () => {
    const model = await startModelServer(index => index === 0 ? 'analysis' : 'no FILE blocks')
    const ownedCtx = new Context()
    contexts.push(ownedCtx)
    Object.defineProperty(ownedCtx, 'credentials', {
      configurable: true,
      value: seedCredentials({ DECLARED_ENV: 'settings-key' }),
    })
    ownedCtx.provide('settings', {
      remoteDescribe: () => ({
        namespaces: [
          { ns: 'llm-other', value: { apiKeyEnv: 'IGNORED_ENV' } },
          { ns: 'llm-deepseek', value: { apiKeyEnv: 'DECLARED_ENV' } },
        ],
      }),
    })
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'process-key'
    try {
      const owned = create(ownedCtx, {
        wikiRoot, mainRoot: root, credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
        llmBaseUrl: model.baseUrl, ownedStageExecutor: true,
      })
      writeFileSync(join(root, 'raw', 'sources', 'note.md'), 'Reusable source about code and tests.', 'utf8')

      expect((await owned.ingestSource({ path: 'note.md' })).status).toBe('ok')
      expect(model.authorizations[0]).toBe('Bearer settings-key')
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  it('falls back to the declared environment key when settings cannot describe itself', async () => {
    const model = await startModelServer(index => index === 0 ? 'analysis' : 'no FILE blocks')
    const ownedCtx = new Context()
    contexts.push(ownedCtx)
    Object.defineProperty(ownedCtx, 'credentials', { configurable: true, value: seedCredentials({}) })
    ownedCtx.provide('settings', {
      remoteDescribe: () => { throw new Error('settings surface unavailable') },
    })
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'process-key'
    try {
      const owned = create(ownedCtx, {
        wikiRoot, mainRoot: root, credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
        llmBaseUrl: model.baseUrl, ownedStageExecutor: true,
      })
      writeFileSync(join(root, 'raw', 'sources', 'note.md'), 'Reusable source about code and tests.', 'utf8')

      expect((await owned.ingestSource({ path: 'note.md' })).status).toBe('ok')
      expect(model.authorizations[0]).toBe('Bearer process-key')
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  it('fails the owned stage loudly when no credential resolves at all', async () => {
    const model = await startModelServer(() => 'unused')
    const ownedCtx = new Context()
    contexts.push(ownedCtx)
    Object.defineProperty(ownedCtx, 'credentials', { configurable: true, value: seedCredentials({}) })
    // A settings service without a describe surface must not fail the stage by itself.
    ownedCtx.provide('settings', {})
    const previous = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      const owned = create(ownedCtx, {
        wikiRoot, mainRoot: root, credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
        llmBaseUrl: model.baseUrl, ownedStageExecutor: true,
      })
      writeFileSync(join(root, 'raw', 'sources', 'note.md'), 'Reusable source about code and tests.', 'utf8')

      const outcome = await owned.ingestSource({ path: 'note.md' })
      expect(outcome).toMatchObject({ written: [], status: 'error', errorCode: 'ingest-failed' })
      expect(outcome.warnings[0]).toContain('no model connection facts')
      expect(model.authorizations).toEqual([])
      expect(existsSync(join(wikiRoot, '_governance'))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })
})

describe('review and verification gates', () => {
  it('rejects every incomplete verifier authority shape before any verification work', async () => {
    const provided = new Map<string, unknown>()
    vi.spyOn(ctx, 'get').mockImplementation(name => provided.get(name))
    const full = verifierAuthority()
    const partials: unknown[] = [
      null, 42, 'authority',
      { ...full, authorityId: 1 },
      { ...full, sourceIdentity: 'not-a-function' },
      { ...full, verifyCandidate: 'not-a-function' },
      { ...full, validateCandidateResult: undefined },
      { ...full, sealPromotion: undefined },
      { ...full, validatePromotion: undefined },
      {},
    ]
    for (const value of partials) {
      provided.set('knowledgeWikiVerifierAuthority', value)
      await expect(service.verifyCandidate(
        { reviewId: 'missing-review', action: 'Promote' },
        new AbortController().signal,
      )).resolves.toEqual({ ok: false, evidence: [], errorCode: 'verifier-authority-unavailable' })
    }
    // The complete shape passes the gate and reaches the review lookup instead.
    provided.set('knowledgeWikiVerifierAuthority', full)
    await expect(service.verifyCandidate(
      { reviewId: 'missing-review', action: 'Promote' },
      new AbortController().signal,
    )).resolves.toEqual({ ok: false, evidence: [], errorCode: 'review-not-found' })

    // A verifier result whose outcomes are not independent outcomes is rejected
    // by the result contract before the review lookup.
    provided.set('knowledgeWikiVerifierAuthority', {
      ...full,
      verifyCandidate: async (request: Parameters<typeof full.verifyCandidate>[0], signal: AbortSignal) => ({
        ...(await full.verifyCandidate(request, signal)),
        outcomes: ['not-an-outcome'],
      }),
    })
    await expect(service.verifyCandidate(
      { reviewId: 'missing-review', action: 'Promote' },
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: false })
  })

  it('keeps the receipt but reports failure when the candidate changes after verification', async () => {
    const candidatePath = '_candidates/ingest/concepts/closure-candidate.md'
    const candidateFull = join(wikiRoot, candidatePath)
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    mkdirSync(dirname(candidateFull), { recursive: true })
    writeFileSync(candidateFull, [
      '---',
      'type: concept',
      'status: candidate',
      'origin: ingest',
      'title: Closure candidate',
      'sources: ["repo:ark/closure"]',
      '---',
      '',
      '# Closure candidate',
      '',
      'Independent verification binding and durable receipt evidence.',
    ].join('\n'), 'utf8')
    appendCandidateReviews(reviewFile, root, 'raw/evidence/closure.json', [('wiki/' + candidatePath)])
    const reviewId = (JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<{ id: string }>)[0]!.id
    const base = verifierAuthority()
    const racingAuthority = {
      ...base,
      async verifyCandidate(request: Parameters<typeof base.verifyCandidate>[0], signal: AbortSignal) {
        const result = await base.verifyCandidate(request, signal)
        // A concurrent editor rewrites the candidate between verification and binding.
        writeFileSync(candidateFull, readFileSync(candidateFull, 'utf8') + '\nchanged\n', 'utf8')
        return result
      },
    }
    ctx.provide('knowledgeWikiVerifierAuthority', racingAuthority)

    const result = await service.verifyCandidate({ reviewId, action: 'Promote' }, new AbortController().signal)

    expect(result).toMatchObject({ ok: false, result: 'pass', errorCode: 'verification-failed' })
    if (result.receiptId === undefined) throw new Error('expected the authentic receipt to be retained')
    expect(existsSync(join(dirname(reviewFile), 'verification-receipts', result.receiptId + '.json'))).toBe(true)
    const item = (JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<{
      verification?: { status?: string; receipts?: unknown[] }
    }>)[0]!
    expect(item.verification).toMatchObject({ status: 'pending', receipts: [] })
  })

  it('stringifies a primitive research failure instead of reporting it as a missing executor', async () => {
    ctx.provide('knowledgeWikiStageExecutor', {
      isolation: 'owned-worker-v1',
      execute() {
        throw 'primitive research failure'
      },
    })

    await expect(service.deepResearch({ topic: 'closure topic' }, new AbortController().signal)).resolves.toEqual({
      findings: [],
      warnings: ['primitive research failure'],
      degraded: true,
      errorCode: 'research-failed',
    })
  })

  it('reports a missing stage executor for deep research instead of a generic failure', async () => {
    await expect(service.deepResearch({ topic: 'closure topic' }, new AbortController().signal)).resolves.toEqual({
      findings: [],
      warnings: [expect.stringContaining('stage executor unavailable')],
      degraded: true,
      errorCode: 'stage-executor-unavailable',
    })
  })
})

describe('raw source tree safety', () => {
  it('refuses a source root that is not an ordinary directory', async () => {
    const sources = join(root, 'raw', 'sources')
    rmSync(sources, { recursive: true, force: true })
    writeFileSync(sources, 'not a directory', 'utf8')
    await expect(service.scanSources()).rejects.toThrow('raw source root is not an ordinary directory')

    rmSync(sources, { force: true })
    const real = join(root, 'real-sources')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, sources)
    await expect(service.scanSources()).rejects.toThrow('raw source root is not an ordinary directory')
    expect((await service.ingestQueueStatus()).tasks).toEqual([])
  })

  it('propagates a non-missing stat failure for the source root', async () => {
    // raw/ is a file, so lstatSync('raw/sources') fails with ENOTDIR, which is
    // not a missing-path error: the scanner must not pretend the tree is empty.
    rmSync(join(root, 'raw'), { recursive: true, force: true })
    writeFileSync(join(root, 'raw'), 'blocks the source root', 'utf8')

    await expect(service.scanSources()).rejects.toThrow(/ENOTDIR/u)
    expect((await service.ingestQueueStatus()).tasks).toEqual([])
  })

  it('refuses non-regular, hard-linked, and oversized raw sources', async () => {
    const sources = resetRawSources(root)
    if (process.platform !== 'win32') {
      // mkfifo is POSIX-only; the non-regular refusal contract on win32 is
      // covered by the symlink/hard-link cases in this same test.
      execFileSync('/usr/bin/mkfifo', [join(sources, 'pipe.md')])
      await expect(service.scanSources()).rejects.toThrow('non-regular raw source is not allowed')
    }

    resetRawSources(root)
    writeFileSync(join(root, 'origin.md'), 'shared bytes', 'utf8')
    linkSync(join(root, 'origin.md'), join(sources, 'linked.md'))
    await expect(service.scanSources()).rejects.toThrow('hard-linked raw source is not allowed')

    resetRawSources(root)
    const huge = join(sources, 'huge.md')
    const descriptor = openSync(huge, 'w')
    try {
      // Sparse: the ceiling is asserted on the real size without writing 100 MiB.
      ftruncateSync(descriptor, 100 * 1024 * 1024 + 1)
    } finally {
      closeSync(descriptor)
    }
    await expect(service.scanSources()).rejects.toThrow('raw source exceeds 100 MiB')
    expect((await service.ingestQueueStatus()).tasks).toEqual([])
  })
})

describe('durable queue migration', () => {
  it('restores every persisted task field, including lease and cancellation bookkeeping', async () => {
    const queuePath = join(root, '.llm-wiki', 'ingest-queue.json')
    mkdirSync(dirname(queuePath), { recursive: true })
    writeFileSync(queuePath, JSON.stringify([{
      id: 3,
      input: 'legacy.md',
      status: 'error',
      createdAt: 11,
      projectGeneration: 2,
      ingestedHash: 'hash-3',
      written: ['wiki/_candidates/legacy.md', 7],
      warnings: ['kept-warning', 9],
      error: 'boom',
      failedAt: 5,
      completedAt: 6,
      cancelRequestedAt: 4,
      runId: 'run-3',
      leaseStartedAt: 2,
    }]), 'utf8')

    service.restoreQueue(root)

    expect((await service.ingestQueueStatus()).tasks).toEqual([{
      id: 3,
      input: 'legacy.md',
      projectRoot: root,
      wikiRoot,
      projectGeneration: 2,
      createdAt: 11,
      status: 'error',
      ingestedHash: 'hash-3',
      written: ['wiki/_candidates/legacy.md'],
      warnings: ['kept-warning'],
      error: 'boom',
      failedAt: 5,
      completedAt: 6,
      cancelRequestedAt: 4,
      runId: 'run-3',
      leaseStartedAt: 2,
    }])
  })

  it('propagates a non-missing queue read failure instead of showing an empty queue', () => {
    const queuePath = join(root, '.llm-wiki', 'ingest-queue.json')
    mkdirSync(queuePath, { recursive: true })
    expect(() => { service.restoreQueue(root) }).toThrow('not a unique ordinary file')
    // The failed root stays unrestored: a later call must fail the same way.
    expect(() => { service.restoreQueue(root) }).toThrow('not a unique ordinary file')
    expect(service.queue).toEqual([])
  })

  it('re-enqueues a restored error task that has no failure timestamp', async () => {
    const queuePath = join(root, '.llm-wiki', 'ingest-queue.json')
    mkdirSync(dirname(queuePath), { recursive: true })
    writeFileSync(queuePath, JSON.stringify([{ id: 1, input: 'a.md', status: 'error' }]), 'utf8')
    service.restoreQueue(root)
    writeFileSync(join(root, 'raw', 'sources', 'a.md'), 'A', 'utf8')

    await service.scanSources()

    expect((await service.ingestQueueStatus()).tasks.map(task => task.status)).toEqual(['error', 'pending'])
  })

  it('skips restored rows that carry no usable status', async () => {
    const queuePath = join(root, '.llm-wiki', 'ingest-queue.json')
    mkdirSync(dirname(queuePath), { recursive: true })
    writeFileSync(queuePath, JSON.stringify([
      { id: 1, input: 'no-status.md' },
      { id: 2, input: 'unknown-status.md', status: 'archived' },
    ]), 'utf8')

    service.restoreQueue(root)

    expect((await service.ingestQueueStatus()).tasks).toEqual([])
    expect(service.queue).toEqual([])
  })

  it('normalizes a leading slash and keeps one task per cache-relative identity', async () => {
    writeFileSync(join(root, 'raw', 'sources', 'a.md'), 'A', 'utf8')

    const added = await service.ingestQueueAdd({ inputs: ['/a.md'] })
    expect(added.tasks.map(task => task.input)).toEqual(['a.md'])
    // The project-relative spelling of the same identity dedupes onto that task.
    expect((await service.ingestQueueAdd({ inputs: ['a.md'] })).tasks).toHaveLength(1)

    await service.drainQueue()
    const drained = (await service.ingestQueueStatus()).tasks[0]
    expect(drained?.input).toBe('a.md')
    expect(drained?.status).toBe('error')
    expect(drained?.error).toContain('stage executor unavailable')
  })
})

describe('ingest admission and ownership', () => {
  it('reports a project-relative source that was queued under its cache-relative identity', async () => {
    writeFileSync(join(root, 'raw', 'sources', 'a.md'), 'A', 'utf8')

    const outcome = await service.ingestSource({ path: '/raw/sources/a.md' })

    expect(outcome).toEqual({
      written: [], warnings: ['ingest task was not admitted'], status: 'error', errorCode: 'invalid-input',
    })
    // The admitted task stays queued under its normalized identity.
    expect((await service.ingestQueueStatus()).tasks.map(task => task.input)).toEqual(['a.md'])
    await service.ingestQueueCancel()
    await service.drainQueue()
  })

  it('reports a queued task that a concurrent cancel cleared without an error message', async () => {
    const observed: AbortSignal[] = []
    ctx.provide('knowledgeWikiStageExecutor', hangingStageExecutor(observed))
    writeFileSync(join(root, 'raw', 'sources', 'a.md'), 'A', 'utf8')
    writeFileSync(join(root, 'raw', 'sources', 'b.md'), 'B', 'utf8')

    const running = service.ingestSource({ path: 'a.md' })
    expect((await service.ingestQueueStatus()).running).toBe(true)
    const queued = service.ingestSource({ path: 'b.md' })
    await service.ingestQueueCancel()

    const [cancelledRunning, cancelledQueued] = await Promise.all([running, queued])
    expect(cancelledRunning).toMatchObject({ written: [], status: 'error', errorCode: 'cancelled' })
    expect(cancelledRunning.warnings).toEqual(['knowledge-wiki ingest cancelled'])
    expect(cancelledQueued).toMatchObject({ written: [], status: 'error', errorCode: 'cancelled' })
    expect(cancelledQueued.warnings).toEqual([expect.stringMatching(/^ingest task \d+ did not complete$/u)])
    expect(observed.length).toBeGreaterThanOrEqual(1)
    expect(observed.every(signal => signal.aborted)).toBe(true)
    expect((await service.ingestQueueStatus()).tasks.map(task => task.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('aborts owned ingest and background summary work when the service fiber is disposed', async () => {
    const external = tempRoot('wiki-closure-external-')
    const observed: AbortSignal[] = []
    const provided = new Map<string, unknown>([
      ['knowledgeWikiStageExecutor', hangingStageExecutor(observed)],
      ['sessionQuery', {
        readSession: () => Promise.resolve({ session: { cwd: external }, events: longEvents() }),
      }],
    ])
    vi.spyOn(ctx, 'get').mockImplementation(name => provided.get(name))
    const warn = vi.fn()
    Object.defineProperty(ctx, 'logger', {
      configurable: true,
      value: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    })
    const timerDispose = vi.fn()
    Object.defineProperty(ctx, 'timer', {
      configurable: true,
      value: { interval: vi.fn(() => timerDispose) },
    })
    writeFileSync(join(root, 'raw', 'sources', 'a.md'), 'A', 'utf8')

    await service[Service.init]()
    const summary = service.summarizeSession('session-in-flight')
    const ingest = service.ingestSource({ path: 'a.md' })
    expect((await service.ingestQueueStatus()).running).toBe(true)

    await ctx.fiber.dispose()
    const [outcome] = await Promise.all([ingest, summary])

    expect(outcome).toMatchObject({ written: [], status: 'error', errorCode: 'ingest-failed' })
    expect(outcome.warnings).toEqual(['knowledge-wiki disposed'])
    expect(warn).toHaveBeenCalledWith('[knowledge-wiki] session summary failed')
    expect(observed.length).toBeGreaterThanOrEqual(1)
    expect(observed.every(signal => signal.aborted)).toBe(true)
    expect(timerDispose).toHaveBeenCalledOnce()
    expect(existsSync(join(external, 'wiki'))).toBe(false)
  })
})

describe('session summary write failures', () => {
  function sessionCtx(readSession: () => Promise<unknown>, answer: string): { warn: ReturnType<typeof vi.fn> } {
    const provided = new Map<string, unknown>([
      ['sessionQuery', { readSession }],
      ['knowledgeWikiStageExecutor', {
        isolation: 'owned-worker-v1',
        execute: () => Promise.resolve({ text: answer }),
      }],
    ])
    vi.spyOn(ctx, 'get').mockImplementation(name => provided.get(name))
    const warn = vi.fn()
    Object.defineProperty(ctx, 'logger', {
      configurable: true,
      value: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    })
    return { warn }
  }

  it('writes nothing when the summary stage returns no text', async () => {
    const external = tempRoot('wiki-closure-empty-')
    const reader = () => Promise.resolve({ session: { cwd: external }, events: longEvents() })
    const provided = new Map<string, unknown>([
      ['sessionQuery', { readSession: reader }],
      ['knowledgeWikiStageExecutor', {
        isolation: 'owned-worker-v1',
        execute: () => Promise.resolve({ text: null }),
      }],
    ])
    vi.spyOn(ctx, 'get').mockImplementation(name => provided.get(name))

    await service.summarizeSession('session-null-text')

    expect(existsSync(join(external, 'wiki'))).toBe(false)
  })

  it('reports an unsafe candidate path instead of writing a session summary', async () => {
    const external = tempRoot('wiki-closure-symlink-')
    const target = join(external, 'wiki', '_candidates', 'topics', 'stable-topic.md')
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(join(external, 'missing-target.md'), target)
    const { warn } = sessionCtx(
      () => Promise.resolve({ session: { cwd: external }, events: longEvents() }),
      summaryDecision(),
    )

    await service.summarizeSession('session-symlink')

    expect(warn).toHaveBeenCalledWith('[knowledge-wiki] session summary write failed')
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    expect(existsSync(join(external, 'missing-target.md'))).toBe(false)
    expect(existsSync(join(external, '.llm-wiki', 'review.json'))).toBe(false)
  })
})

describe('page, search, and utility edges', () => {
  it('returns empty content for a page that does not exist yet', async () => {
    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true })
    expect(await service.pageContent({ path: 'concepts/absent.md' }))
      .toEqual({ path: 'concepts/absent.md', content: '' })
    // Unsafe paths still surface instead of degrading to an empty page.
    await expect(service.pageContent({ path: '../outside.md' })).rejects.toThrow('traversal')
  })

  it('refuses vision work when an image has a credential but no owned executor', async () => {
    Object.defineProperty(ctx, 'credentials', {
      configurable: true,
      value: seedCredentials({ VISION_API_KEY: 'vision-secret' }),
    })
    writeFileSync(join(root, 'raw', 'sources', 'image.png'), Buffer.from('png'))

    const outcome = await service.ingestSource({ path: 'image.png' })

    expect(outcome).toEqual({
      written: [],
      warnings: ['knowledge Wiki stage executor unavailable; refusing vision work'],
      status: 'error',
      errorCode: 'ingest-failed',
    })
    expect(existsSync(join(wikiRoot, '_candidates', 'ingest', 'media', 'image.png'))).toBe(false)
  })

  it('keeps the copied media page when the vision stage returns no caption', async () => {
    Object.defineProperty(ctx, 'credentials', {
      configurable: true,
      value: seedCredentials({ VISION_API_KEY: 'vision-secret' }),
    })
    ctx.provide('knowledgeWikiStageExecutor', {
      isolation: 'owned-worker-v1',
      execute: () => Promise.resolve({ text: null }),
    })
    writeFileSync(join(root, 'raw', 'sources', 'image.png'), Buffer.from('png'))

    const outcome = await service.ingestSource({ path: 'image.png' })

    expect(outcome).toEqual({
      written: ['_candidates/ingest/media/image.png'],
      warnings: ['视觉说明生成失败（检查 apiKey/网络）'],
      status: 'degraded',
    })
    expect(existsSync(join(wikiRoot, '_candidates', 'ingest', 'media', 'image.png'))).toBe(true)
    // Without a caption there is no source page and no candidate review.
    expect(existsSync(join(wikiRoot, '_candidates', 'ingest', 'sources', 'image.md'))).toBe(false)
    expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(false)
  })

  it('skips the compare-and-swap when the expected content targets a missing page', async () => {
    expect(await service.writePage({
      path: '_candidates/fresh.md', content: 'fresh body', expectedContent: 'stale',
    })).toEqual({ path: '_candidates/fresh.md', ok: true })
    expect(readFileSync(join(wikiRoot, '_candidates', 'fresh.md'), 'utf8')).toBe('fresh body')
  })

  it('degrades semantic search once and keeps serving keyword results', async () => {
    const warn = vi.fn()
    Object.defineProperty(ctx, 'logger', {
      configurable: true,
      value: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    })
    Object.defineProperty(ctx, 'credentials', {
      configurable: true,
      value: seedCredentials({ VISION_API_KEY: 'embedding-key' }),
    })
    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true })
    writeFileSync(join(wikiRoot, 'concepts', 'alpha.md'), [
      '---', 'type: concept', 'title: Alpha', '---', '', '# Alpha', '', 'alpha reusable method and validation', '',
    ].join('\n'), 'utf8')
    const embeddingCalls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      embeddingCalls.push(url)
      return Promise.reject(new Error('embedding request failed (401)'))
    })

    expect((await service.search({ query: 'alpha', topK: 1 }))[0]?.path).toBe('concepts/alpha.md')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('embedding request failed (401)')
    // A second query degrades silently: the diagnostic is reported once.
    expect((await service.search({ query: 'alpha validation', topK: 1 }))[0]?.path).toBe('concepts/alpha.md')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(embeddingCalls).toHaveLength(2)
    expect(await service.search({ query: 'the and' })).toEqual([])
  })

  it('keys its durable cache and utility artifacts to the active project root', async () => {
    writeFileSync(join(root, 'raw', 'sources', 'a.md'), 'A', 'utf8')
    const hash = createHash('sha256').update('A').digest('hex')

    expect(service.markIngested('a.md')).toBe(hash)
    expect(service.currentHash('a.md')).toBe(hash)
    expect(service.currentHash('https://example.test/a')).toBeUndefined()
    expect(service.queueFile()).toBe(join(root, '.llm-wiki', 'ingest-queue.json'))

    service.writeCache({ 'a.md': hash })
    expect(service.readCache()).toEqual({ 'a.md': hash })
    expect(JSON.parse(readFileSync(join(root, '.llm-wiki', 'ingest-cache.json'), 'utf8')))
      .toEqual({ 'a.md': hash })

    // The scanner reads raw/sources of the active project root by default.
    expect(service.listRawSources()).toEqual(['a.md'])

    // The recorded hash is the scanner's dedup contract.
    await service.scanSources()
    expect((await service.ingestQueueStatus()).tasks).toEqual([])

    service.recordKnowledgeRetrieval(['concepts/alpha.md'])
    expect((await service.knowledgeUtility()).find(item => item.path === 'concepts/alpha.md'))
      .toMatchObject({ path: 'concepts/alpha.md', retrievalHits: 1 })
  })

  it('refuses IPv6 targets outside the global unicast block', () => {
    // 2000::/3 is the only IPv6 block the fetcher accepts, so every address
    // outside it is refused before the range allow-list is even consulted.
    for (const address of ['4000::1', '8000::1', 'c000::1', 'e000::1', 'fe00::1']) {
      expect(isBlockedNetworkAddress(address)).toBe(true)
    }
    // Inside 2000::/3 the blocked-range list still governs.
    expect(isBlockedNetworkAddress('2001:db8::1')).toBe(true)
    expect(isBlockedNetworkAddress('2400:cb00::1')).toBe(false)
  })

  it('rejects a malformed review state on the read surface', async () => {
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    mkdirSync(dirname(reviewFile), { recursive: true })
    writeFileSync(reviewFile, 'null', 'utf8')
    await expect(service.reviews({})).rejects.toThrow('invalid knowledge review state')
    writeFileSync(reviewFile, JSON.stringify([{ id: 'advisory', resolved: false }]), 'utf8')
    expect((await service.reviews({})).map(item => item.id)).toEqual(['advisory'])
  })

  it('keeps an unverified candidate unresolved without invalidating snapshots', async () => {
    const candidatePath = '_candidates/ingest/concepts/unverified.md'
    const candidateFull = join(wikiRoot, candidatePath)
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    mkdirSync(dirname(candidateFull), { recursive: true })
    writeFileSync(candidateFull, [
      '---', 'type: concept', 'status: candidate', 'origin: ingest',
      'title: Unverified candidate', 'sources: ["repo:ark/closure"]', '---', '',
      '# Unverified candidate', '', 'No independent verification has been bound to this Candidate.',
    ].join('\n'), 'utf8')
    appendCandidateReviews(reviewFile, root, 'raw/evidence/unverified.json', ['wiki/' + candidatePath])
    const reviewId = (JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<{ id: string }>)[0]!.id
    const before = service.snapshots.currentGeneration(wikiRoot)

    expect(await service.resolveReview({ reviewId, action: 'Promote' })).toBe(false)

    expect(service.snapshots.currentGeneration(wikiRoot)).toBe(before)
    expect(existsSync(join(wikiRoot, 'concepts', 'unverified.md'))).toBe(false)
    expect(existsSync(candidateFull)).toBe(true)
    expect((await service.reviews({})).map(item => item.resolved)).toEqual([false])
  })

  it('resolves every wikilink spelling it declares supported', async () => {
    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true })
    writeFileSync(join(wikiRoot, 'concepts', 'alpha.md'), '# Alpha', 'utf8')
    writeFileSync(join(wikiRoot, 'top.md'), '# Top', 'utf8')
    writeFileSync(join(wikiRoot, 'concepts', 'exact.md'),
      '[[concepts/alpha.md]] [[alpha]] [[top]] [[ghost]]', 'utf8')

    const lint = await service.lint()

    expect(lint.brokenLinks).toEqual([{ from: 'concepts/exact.md', target: 'ghost' }])
    expect(lint.totalPages).toBe(3)
    expect(lint.emptyPages).toEqual([])
  })
})
