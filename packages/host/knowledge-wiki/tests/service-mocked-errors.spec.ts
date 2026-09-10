import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

const mocks = vi.hoisted(() => ({
  applyCandidateReview: vi.fn(),
  buildGraph: vi.fn(),
  listPages: vi.fn(),
  readPage: vi.fn(),
  renameFailure: undefined as unknown,
  unlinkSync: vi.fn(),
  writeFailure: undefined as unknown,
}))

vi.mock('../src/graph.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/graph.ts')>()
  return {
    ...actual,
    buildGraph: mocks.buildGraph,
    listPages: mocks.listPages,
    readPage: mocks.readPage,
  }
})
vi.mock('../src/reviews.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reviews.ts')>()
  return { ...actual, applyCandidateReview: mocks.applyCandidateReview }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (mocks.renameFailure !== undefined) throw mocks.renameFailure
      actual.renameSync(...args)
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      mocks.unlinkSync(...args)
      actual.unlinkSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (mocks.writeFailure !== undefined && String(args[0]).endsWith('/concepts/Primitive-Page.md')) {
        throw mocks.writeFailure
      }
      actual.writeFileSync(...args)
    },
  }
})

import KnowledgeWikiService from '../src/index.ts'

interface ErrorSurface {
  snapshots: { dispose(): void }
  graph(): Promise<object>
  list(): Promise<unknown[]>
  lint(): Promise<object>
  writePage(request: { path: string; content: string }): Promise<Record<string, unknown>>
  createProject(request: { name: string; path: string }): Promise<{ path: string; error?: string }>
  resolveReview(request: { reviewId: string; action?: string }): Promise<boolean>
  resolveReviews(request: { ids: string[]; action?: string }): Promise<number>
}

let root: string
let ctx: Context
let service: ErrorSurface

beforeEach(() => {
  vi.clearAllMocks()
  mocks.renameFailure = undefined
  mocks.writeFailure = undefined
  root = mkdtempSync(join(tmpdir(), 'wiki-service-mocked-errors-'))
  mkdirSync(join(root, 'wiki'), { recursive: true })
  ctx = new Context()
  service = new KnowledgeWikiService(ctx, {
    wikiRoot: join(root, 'wiki'), mainRoot: root,
    credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
  }) as unknown as ErrorSurface
})

afterEach(async () => {
  service.snapshots.dispose()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('service-local error isolation', () => {
  it('propagates graph and list owner failures instead of presenting empty data', async () => {
    mocks.buildGraph.mockImplementation(() => { throw new Error('graph failed') })
    mocks.listPages.mockImplementation(() => { throw new Error('list failed') })
    await expect(service.graph()).rejects.toThrow('graph failed')
    await expect(service.list()).rejects.toThrow('list failed')
  })

  it('propagates a page read failure from lint', async () => {
    mocks.listPages.mockReturnValue([{ name: 'bad.md', path: 'bad.md', isDir: false, size: 1 }])
    mocks.readPage.mockImplementation(() => { throw new Error('read failed') })
    await expect(service.lint()).rejects.toThrow('read failed')
  })

  it('cleans temporary writes after rename failures for pages and workspace registry', async () => {
    mocks.renameFailure = new Error('rename failed')
    const page = await service.writePage({ path: '_candidates/a.md', content: 'content' })
    expect(page).toMatchObject({ ok: false, error: 'rename failed' })
    expect(mocks.unlinkSync).toHaveBeenCalled()

    mocks.unlinkSync.mockClear()
    const project = await service.createProject({ name: 'External', path: join(root, 'external') })
    expect(project).toMatchObject({ path: '', error: 'rename failed' })
    expect(mocks.unlinkSync).toHaveBeenCalled()

    mocks.unlinkSync.mockClear()
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    mkdirSync(dirname(reviewFile), { recursive: true })
    const before = JSON.stringify([
      { id: 'advisory', title: 'A', type: 'suggestion', reviewKind: 'advisory', resolved: false },
    ])
    writeFileSync(reviewFile, before, 'utf8')
    await expect(service.resolveReview({ reviewId: 'advisory' })).rejects.toThrow('rename failed')
    expect(readFileSync(reviewFile, 'utf8')).toBe(before)
    expect(mocks.unlinkSync).toHaveBeenCalled()
  })

  it('stringifies primitive page and project write failures', async () => {
    mocks.renameFailure = 'primitive rename failure'
    expect(await service.writePage({ path: '_candidates/p.md', content: 'content' }))
      .toMatchObject({ ok: false, error: 'primitive rename failure' })
    expect(await service.createProject({ name: 'External', path: join(root, 'primitive-external') }))
      .toMatchObject({ path: '', error: 'primitive rename failure' })

    mocks.renameFailure = 'primitive page creation failure'
    expect(await (service as unknown as { createPage(request: { title: string }): Promise<Record<string, unknown>> })
      .createPage({ title: 'Primitive Page' }))
      .toMatchObject({ path: '', ok: false, error: 'primitive page creation failure' })
  })

  it('invalidates after a candidate resolution and propagates resolver failures', async () => {
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    mkdirSync(dirname(reviewFile), { recursive: true })
    writeFileSync(reviewFile, JSON.stringify([
      { id: 'candidate', title: 'C', type: 'candidate-approval', reviewKind: 'candidate', resolved: false },
    ]), 'utf8')
    mocks.applyCandidateReview.mockReturnValueOnce(true)
    expect(await service.resolveReview({ reviewId: 'candidate', action: 'Promote' })).toBe(true)
    mocks.applyCandidateReview.mockImplementationOnce(() => { throw new Error('resolver failed') })
    await expect(service.resolveReview({ reviewId: 'candidate' })).rejects.toThrow('resolver failed')
    mocks.applyCandidateReview.mockImplementationOnce(() => { throw new Error('bulk resolver failed') })
    await expect(service.resolveReviews({ ids: ['candidate', 'candidate'] })).rejects.toThrow('bulk resolver failed')
  })
})
