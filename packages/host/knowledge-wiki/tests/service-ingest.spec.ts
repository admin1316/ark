import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

const mocks = vi.hoisted(() => ({
  describeImage: vi.fn(),
  research: vi.fn(),
  runIngest: vi.fn(),
}))

vi.mock('../src/ingest.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ingest.ts')>()
  return { ...actual, ingestSource: mocks.runIngest }
})
vi.mock('../src/research.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/research.ts')>()
  return { ...actual, deepResearch: mocks.research }
})
vi.mock('../src/vision.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vision.ts')>()
  return { ...actual, describeImage: mocks.describeImage }
})

import KnowledgeWikiService from '../src/index.ts'

interface IngestSurface {
  snapshots: { currentGeneration(root: string): number; dispose(): void }
  ingestSource(request: { path: string }): Promise<{ written: string[]; warnings: string[] }>
  deepResearch(request: { topic: string }): Promise<{ findings: Array<{ title: string; path: string }> }>
}

let root: string
let wikiRoot: string
let ctx: Context
let service: IngestSurface
let apiKey: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'wiki-service-ingest-'))
  wikiRoot = join(root, 'wiki')
  mkdirSync(join(root, 'raw', 'sources'), { recursive: true })
  mkdirSync(wikiRoot, { recursive: true })
  ctx = new Context()
  apiKey = undefined
  Object.defineProperty(ctx, 'credentials', {
    configurable: true,
    value: { resolve: vi.fn(async () => apiKey === undefined ? undefined : { value: apiKey }) },
  })
  Object.defineProperty(ctx, 'llm', {
    configurable: true,
    value: { stream: vi.fn() },
  })
  ctx.provide('knowledgeWikiStageExecutor', {
    isolation: 'owned-worker-v1',
    async execute(request: { kind: string; apiKey?: string; path?: string }) {
      if (request.kind !== 'vision-describe') throw new Error('unexpected stage')
      return { text: await mocks.describeImage(request.apiKey, request.path) as string }
    },
  })
  service = new KnowledgeWikiService(ctx, {
    wikiRoot, mainRoot: root, credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
  }) as unknown as IngestSurface
})

afterEach(async () => {
  service.snapshots.dispose()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('service ingest routing', () => {
  it('routes normal sources through the two-stage owner and invalidates only written results', async () => {
    const source = join(root, 'raw', 'sources', 'a.md')
    writeFileSync(source, 'source', 'utf8')
    mocks.runIngest
      .mockResolvedValueOnce({ written: ['wiki/_candidates/a.md'], warnings: [] })
      .mockResolvedValueOnce({ written: [], warnings: [] })
    const before = service.snapshots.currentGeneration(wikiRoot)
    expect(await service.ingestSource({ path: 'raw/sources/a.md' })).toEqual({
      written: ['wiki/_candidates/a.md'], warnings: [], status: 'ok',
    })
    expect(service.snapshots.currentGeneration(wikiRoot)).toBe(before + 1)
    expect(await service.ingestSource({ path: 'a.md' })).toEqual({ written: [], warnings: [], status: 'ok' })

    mocks.runIngest.mockRejectedValueOnce('primitive ingest failure')
    await expect(service.ingestSource({ path: 'a.md' })).resolves.toMatchObject({
      status: 'error', errorCode: 'ingest-failed', warnings: ['primitive ingest failure'],
    })
    await expect(service.ingestSource({ path: '../escape' })).resolves.toMatchObject({
      status: 'error', errorCode: 'invalid-input', warnings: [expect.stringContaining('traversal')],
    })
    await expect(service.ingestSource({ path: 'missing.md' })).resolves.toMatchObject({
      status: 'error', errorCode: 'invalid-input', warnings: [expect.stringContaining('ENOENT')],
    })
    await expect(service.ingestSource({ path: 'raw/sources/' })).resolves.toMatchObject({
      status: 'error', errorCode: 'invalid-input',
      warnings: ['raw source path must name a file below raw/sources'],
    })
  })

  it('copies images immediately and adds a caption page only when vision succeeds', async () => {
    const image = join(root, 'raw', 'sources', 'image.png')
    writeFileSync(image, Buffer.from('png'))

    const before = service.snapshots.currentGeneration(wikiRoot)
    const noKey = await service.ingestSource({ path: 'image.png' })
    expect(noKey.written).toEqual(['_candidates/ingest/media/image.png'])
    expect(noKey.warnings).toHaveLength(1)
    expect(mocks.describeImage).not.toHaveBeenCalled()
    expect(service.snapshots.currentGeneration(wikiRoot)).toBe(before + 1)

    apiKey = 'secret'
    mocks.describeImage.mockResolvedValueOnce('A factual caption')
    const captioned = await service.ingestSource({ path: 'raw/sources/image.png' })
    expect(captioned.written).toEqual([
      '_candidates/ingest/sources/image.md',
      '_candidates/ingest/media/image.png',
    ])
    expect(captioned.warnings).toEqual([])
    expect(service.snapshots.currentGeneration(wikiRoot)).toBe(before + 2)
    expect(existsSync(join(wikiRoot, '_candidates', 'ingest', 'sources', 'image.md'))).toBe(true)
    expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(true)
  })

  it('returns research findings, invalidates written results, and fails closed', async () => {
    const candidatePath = 'wiki/_candidates/research/result.md'
    const full = join(root, candidatePath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, 'candidate', 'utf8')
    mocks.research.mockResolvedValueOnce({ written: [candidatePath], sourceCount: 1, warnings: [] })
    const before = service.snapshots.currentGeneration(wikiRoot)
    expect(await service.deepResearch({ topic: 'topic' })).toEqual({
      findings: [{ title: 'result.md', path: candidatePath }],
      warnings: [],
      degraded: false,
    })
    expect(service.snapshots.currentGeneration(wikiRoot)).toBe(before + 1)

    mocks.research.mockResolvedValueOnce({ written: [], sourceCount: 0, warnings: [] })
    expect(await service.deepResearch({ topic: 'empty' })).toEqual({ findings: [], warnings: [], degraded: false })
    mocks.research.mockRejectedValueOnce(new Error('research failed'))
    await expect(service.deepResearch({ topic: 'error' })).resolves.toEqual({
      findings: [],
      warnings: ['research failed'],
      degraded: true,
      errorCode: 'research-failed',
    })
  })
})
