import { projectRequest } from './project-request-fixture.ts'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
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
import { wikiTestConfig } from './config-fixture.ts'

interface IngestSurface {
  snapshots: { currentGeneration(root: string): number; dispose(): void }
  ingestSource: KnowledgeWikiService['ingestSource']
  deepResearch: KnowledgeWikiService['deepResearch']
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
  service = new KnowledgeWikiService(ctx, wikiTestConfig({
    wikiRoot, mainRoot: root, llmProvider: 'p', llmModel: 'm',
  })) as unknown as IngestSurface
})

afterEach(async () => {
  service.snapshots.dispose()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('service ingest routing', () => {
  it('creates a missing ordinary Wiki directory for the first image import', async () => {
    rmSync(wikiRoot, { recursive: true })
    writeFileSync(join(root, 'raw', 'sources', 'first.png'), Buffer.from('first image'))
    const outcome = await service.ingestSource({ ...projectRequest(service), path: 'first.png' })
    expect(outcome.written).toEqual(['_candidates/ingest/media/first.png'])
    expect(existsSync(join(wikiRoot, '_candidates', 'ingest', 'media', 'first.png'))).toBe(true)
    expect(mocks.describeImage).not.toHaveBeenCalled()
  })

  it('refuses an image media ancestor symlink before copying bytes or invoking vision', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wiki-image-outside-'))
    try {
      mkdirSync(join(outside, 'ingest', 'media'), { recursive: true })
      symlinkSync(outside, join(wikiRoot, '_candidates'), 'dir')
      writeFileSync(join(root, 'raw', 'sources', 'image.png'), Buffer.from('private fixture image'))
      const outcome = await service.ingestSource({ ...projectRequest(service), path: 'image.png' })
      expect(outcome).toMatchObject({ written: [], status: 'error' })
      expect(outcome.warnings.join('\n')).toMatch(/symbolic link|unsafe directory/u)
      expect(existsSync(join(outside, 'ingest', 'media', 'image.png'))).toBe(false)
      expect(mocks.describeImage).not.toHaveBeenCalled()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('keeps image captions and reviews inside the project when the caption ancestor is a link', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wiki-caption-outside-'))
    try {
      mkdirSync(join(wikiRoot, '_candidates', 'ingest'), { recursive: true })
      symlinkSync(outside, join(wikiRoot, '_candidates', 'ingest', 'sources'), 'dir')
      writeFileSync(join(root, 'raw', 'sources', 'image.png'), Buffer.from('fixture image'))
      Object.assign(service, { connections: () => ({ textProvider: 'p', textModel: 'm', visionProvider: 'fixture-vision', visionModel: 'fixture-image' }) })
      mocks.describeImage.mockResolvedValueOnce('Fixture caption')
      const outcome = await service.ingestSource({ ...projectRequest(service), path: 'image.png' })
      expect(outcome).toMatchObject({ written: [], status: 'error' })
      expect(existsSync(join(outside, 'image.md'))).toBe(false)
      expect(existsSync(join(wikiRoot, '_candidates', 'ingest', 'media', 'image.png'))).toBe(true)
      expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('routes normal sources through the two-stage owner and invalidates only written results', async () => {
    const source = join(root, 'raw', 'sources', 'a.md')
    writeFileSync(source, 'source', 'utf8')
    mocks.runIngest
      .mockResolvedValueOnce({ written: ['wiki/_candidates/a.md'], warnings: [] })
      .mockResolvedValueOnce({ written: [], warnings: [] })
    const before = service.snapshots.currentGeneration(wikiRoot)
    expect(await service.ingestSource({ ...projectRequest(service), path: 'raw/sources/a.md' })).toEqual({
      written: ['wiki/_candidates/a.md'], warnings: [], status: 'ok',
    })
    expect(service.snapshots.currentGeneration(wikiRoot)).toBe(before + 1)
    expect(await service.ingestSource({ ...projectRequest(service), path: 'a.md' })).toEqual({ written: [], warnings: [], status: 'ok' })

    mocks.runIngest.mockRejectedValueOnce('primitive ingest failure')
    await expect(service.ingestSource({ ...projectRequest(service), path: 'a.md' })).resolves.toMatchObject({
      status: 'error', errorCode: 'ingest-failed', warnings: ['primitive ingest failure'],
    })
    await expect(service.ingestSource({ ...projectRequest(service), path: '../escape' })).resolves.toMatchObject({
      status: 'error', errorCode: 'invalid-input', warnings: [expect.stringContaining('traversal')],
    })
    await expect(service.ingestSource({ ...projectRequest(service), path: 'missing.md' })).resolves.toMatchObject({
      status: 'error', errorCode: 'invalid-input', warnings: [expect.stringContaining('ENOENT')],
    })
    await expect(service.ingestSource({ ...projectRequest(service), path: 'raw/sources/' })).resolves.toMatchObject({
      status: 'error', errorCode: 'invalid-input',
      warnings: ['raw source path must name a file below raw/sources'],
    })
  })

  it('copies images immediately and adds a caption page only when vision succeeds', async () => {
    const image = join(root, 'raw', 'sources', 'image.png')
    writeFileSync(image, Buffer.from('png'))

    const before = service.snapshots.currentGeneration(wikiRoot)
    const noKey = await service.ingestSource({ ...projectRequest(service), path: 'image.png' })
    expect(noKey.written).toEqual(['_candidates/ingest/media/image.png'])
    expect(noKey.warnings).toHaveLength(1)
    expect(mocks.describeImage).not.toHaveBeenCalled()
    expect(service.snapshots.currentGeneration(wikiRoot)).toBe(before + 1)

    apiKey = 'secret'
    Object.assign(service, { connections: () => ({ textProvider: 'p', textModel: 'm', visionProvider: 'fixture-vision', visionModel: 'fixture-image' }) })
    mocks.describeImage.mockResolvedValueOnce('A factual caption')
    const captioned = await service.ingestSource({ ...projectRequest(service), path: 'raw/sources/image.png' })
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
    expect(await service.deepResearch({ ...projectRequest(service), topic: 'topic' }, new AbortController().signal)).toEqual({
      findings: [{ title: 'result.md', path: candidatePath }],
      sourceCount: 1,
      warnings: [],
      degraded: false,
    })
    expect(service.snapshots.currentGeneration(wikiRoot)).toBe(before + 1)

    mocks.research.mockResolvedValueOnce({ written: [], sourceCount: 0, warnings: [] })
    expect(await service.deepResearch({ ...projectRequest(service), topic: 'empty' }, new AbortController().signal)).toEqual({ findings: [], sourceCount: 0, warnings: [], degraded: false })
    mocks.research.mockRejectedValueOnce(new Error('research failed'))
    await expect(service.deepResearch({ ...projectRequest(service), topic: 'error' }, new AbortController().signal)).resolves.toEqual({
      findings: [],
      sourceCount: 0,
      warnings: ['research failed'],
      degraded: true,
      errorCode: 'research-failed',
    })
  })
})
