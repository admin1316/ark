import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import KnowledgeWikiService from '../src/index.ts'
import type { WikiGraphResult, WikiReviewItem } from '../src/types.ts'

interface Surface {
  snapshots: { invalidate(root: string): void; dispose(): void }
  graph(): Promise<WikiGraphResult>
  fullGraph(): Promise<WikiGraphResult>
  list(): Promise<Array<{ path: string }>>
  search(request: { query: string; topK?: number }): Promise<Array<{ path: string; score: number }>>
  knowledgeUtility(): Promise<Array<{ path: string; utilityScore: number; retrievalHits: number }>>
  recordKnowledgeOutcome(request: { paths: string[]; outcome: 'successful' | 'corrected' | 'neutral' }): Promise<number>
  pageContent(request: { path: string }): Promise<{ path: string; content: string }>
  writePage(request: { path: string; content: string; expectedContent?: string }): Promise<Record<string, unknown>>
  createPage(request: { title: string; content?: string }): Promise<Record<string, unknown>>
  ingestSource(request: { path: string }): Promise<{ written: string[]; warnings: string[] }>
  reviews(request: { status?: string; limit?: number }): Promise<WikiReviewItem[]>
  resolveReview(request: { reviewId: string; action?: string }): Promise<boolean>
  resolveReviews(request: { ids: string[]; action?: string }): Promise<number>
  graphInsights(): Promise<Record<string, unknown[]>>
  computeGraph(): Promise<WikiGraphResult>
  lint(): Promise<{ brokenLinks: Array<{ from: string; target: string }>; emptyPages: string[]; totalPages: number }>
  exportProject(): Promise<{ path: string; error?: string }>
  importProject(request: { path: string }): Promise<{ ok: boolean; error?: string; entries?: string[] }>
}

let root: string
let wikiRoot: string
let ctx: Context
let service: Surface

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wiki-service-surface-'))
  wikiRoot = join(root, 'wiki')
  mkdirSync(join(wikiRoot, 'concepts'), { recursive: true })
  mkdirSync(join(root, 'raw', 'sources'), { recursive: true })
  writeFileSync(join(root, 'purpose.md'), '# Purpose', 'utf8')
  writeFileSync(join(root, 'schema.md'), '# Schema', 'utf8')
  ctx = new Context()
  Object.defineProperty(ctx, 'credentials', {
    configurable: true,
    value: { resolve: vi.fn().mockResolvedValue(undefined) },
  })
  Object.defineProperty(ctx, 'llm', {
    configurable: true,
    value: { stream: vi.fn() },
  })
  service = new KnowledgeWikiService(ctx, {
    wikiRoot,
    mainRoot: root,
    credential: 'VISION_API_KEY',
    llmProvider: 'p',
    llmModel: 'm',
  }) as unknown as Surface
})

afterEach(async () => {
  service.snapshots.dispose()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('empty-library graph, search, and utility surface', () => {
  it('serves graph/list/search from one active Wiki and records retrieval utility', async () => {
    writeFileSync(join(wikiRoot, 'concepts', 'alpha.md'), `---
type: concept
title: Alpha
aliases: ["阿尔法"]
---

# Alpha

alpha reusable method and validation
`, 'utf8')
    expect((await service.graph()).nodes).toHaveLength(1)
    expect(await service.fullGraph()).toEqual(await service.graph())
    expect((await service.list()).map(page => page.path)).toContain('concepts/alpha.md')
    expect((await service.search({ query: 'alpha', topK: 1 }))[0]?.path).toBe('concepts/alpha.md')
    expect((await service.search({ query: 'alpha' }))[0]?.path).toBe('concepts/alpha.md')
    expect(await service.search({ query: 'the and' })).toEqual([])

    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const recorded = JSON.parse(readFileSync(utilityFile, 'utf8')) as Record<string, object>
    writeFileSync(utilityFile, JSON.stringify({
      ...recorded,
      'concepts/low.md': {
        path: 'concepts/low.md', retrievalHits: 1, successfulUses: 0,
        userCorrections: 0, utilityScore: -2,
      },
    }), 'utf8')
    const utility = await service.knowledgeUtility()
    expect(utility[0]).toMatchObject({ path: 'concepts/alpha.md', retrievalHits: 2 })
    expect(await service.recordKnowledgeOutcome({
      paths: ['concepts/alpha.md', 'concepts/alpha.md', '../unsafe'], outcome: 'successful',
    })).toBe(1)
    expect(await service.recordKnowledgeOutcome({
      paths: ['concepts/alpha.md'], outcome: 'corrected',
    })).toBe(1)
    writeFileSync(join(wikiRoot, 'concepts', 'unseen.md'), 'unseen', 'utf8')
    expect(await service.recordKnowledgeOutcome({
      paths: ['concepts/unseen.md'], outcome: 'neutral',
    })).toBe(1)
    expect(await service.recordKnowledgeOutcome({ paths: [], outcome: 'neutral' })).toBe(0)
    expect((await service.knowledgeUtility()).find(item => item.path === 'concepts/alpha.md')?.utilityScore).toBe(-0.5)
  })

  it('keeps an absent Wiki empty but reports credential failures instead of hiding them', async () => {
    const missingWiki = join(root, 'missing-wiki')
    const isolatedContext = new Context()
    Object.defineProperty(isolatedContext, 'credentials', {
      configurable: true,
      value: { resolve: vi.fn().mockRejectedValue(new Error('credentials unavailable')) },
    })
    const isolated = new KnowledgeWikiService(isolatedContext, {
      wikiRoot: missingWiki,
      mainRoot: root,
      credential: 'VISION_API_KEY',
      llmProvider: 'p', llmModel: 'm',
    }) as unknown as Surface
    expect(await isolated.graph()).toEqual({ nodes: [], edges: [], communities: [] })
    expect(await isolated.list()).toEqual([])
    await expect(isolated.search({ query: 'none' })).rejects.toThrow('credentials unavailable')
    expect(await isolated.knowledgeUtility()).toEqual([])
    isolated.snapshots.dispose()
    await isolatedContext.fiber.dispose()
  })
})

describe('page read/write CAS surface', () => {
  it('reads files, hides directories and unsafe paths, and enforces candidate-only generated creates', async () => {
    const canonical = join(wikiRoot, 'concepts', 'alpha.md')
    writeFileSync(canonical, 'old', 'utf8')
    expect(await service.pageContent({ path: 'concepts/alpha.md' })).toEqual({
      path: 'concepts/alpha.md', content: 'old',
    })
    expect(await service.pageContent({ path: 'concepts' })).toEqual({ path: 'concepts', content: '' })
    await expect(service.pageContent({ path: '../outside' })).rejects.toThrow('traversal')

    expect(await service.writePage({ path: 'concepts/new.md', content: 'new' })).toMatchObject({ ok: false })
    expect(await service.writePage({
      path: 'concepts/alpha.md', content: 'new', expectedContent: 'stale',
    })).toMatchObject({ ok: false, conflict: true })
    expect(await service.writePage({
      path: 'concepts/alpha.md', content: 'new', expectedContent: 'old',
    })).toEqual({ path: 'concepts/alpha.md', ok: true })
    expect(readFileSync(canonical, 'utf8')).toBe('new')

    expect(await service.writePage({ path: '_candidates/manual.md', content: 'candidate' }))
      .toEqual({ path: '_candidates/manual.md', ok: true })
    expect(await service.writePage({ path: '../escape', content: 'x' })).toMatchObject({
      path: '../escape', ok: false, error: 'wiki path traversal is not allowed',
    })
  })

  it('creates human canonical pages with default/explicit content and detects duplicates', async () => {
    expect(await service.createPage({ title: ' Human Page ', content: 'Body' }))
      .toEqual({ path: 'concepts/Human-Page.md', ok: true })
    expect(readFileSync(join(wikiRoot, 'concepts', 'Human-Page.md'), 'utf8')).toContain('origin: human')
    expect(await service.createPage({ title: ' Human Page ' })).toMatchObject({ ok: false, error: 'page already exists' })
    expect(await service.createPage({ title: 'Second Page' })).toEqual({ path: 'concepts/Second-Page.md', ok: true })

    const blockedRoot = join(root, 'blocked-wiki')
    writeFileSync(blockedRoot, 'file', 'utf8')
    const blockedContext = new Context()
    const blocked = new KnowledgeWikiService(blockedContext, {
      wikiRoot: blockedRoot, mainRoot: root,
      credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
    }) as unknown as Surface
    expect(await blocked.createPage({ title: 'Fails' })).toMatchObject({ path: '', ok: false })
    blocked.snapshots.dispose()
    await blockedContext.fiber.dispose()
  })
})

describe('review, insight, lint, and archive surface', () => {
  it('filters and resolves advisory reviews singly and in bulk', async () => {
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    mkdirSync(dirname(reviewFile), { recursive: true })
    const items: WikiReviewItem[] = [
      { id: 'a', title: 'A', type: 'suggestion', reviewKind: 'advisory', resolved: false },
      { id: 'b', title: 'B', type: 'suggestion', reviewKind: 'advisory', resolved: true },
      { id: 'c', title: 'C', type: 'suggestion', reviewKind: 'advisory', resolved: false },
    ]
    writeFileSync(reviewFile, JSON.stringify(items), 'utf8')

    expect((await service.reviews({})).map(item => item.id)).toEqual(['a', 'c'])
    expect((await service.reviews({ status: 'resolved', limit: 1 })).map(item => item.id)).toEqual(['b'])
    expect(await service.reviews({ status: 'all' })).toHaveLength(3)
    expect(await service.resolveReview({ reviewId: 'a' })).toBe(true)
    expect(await service.resolveReview({ reviewId: 'missing', action: 'Skip' })).toBe(false)
    expect(await service.resolveReviews({ ids: ['b', 'c', 'missing'], action: 'Skip' })).toBe(1)
    writeFileSync(reviewFile, JSON.stringify([
      { id: 'd', title: 'D', type: 'suggestion', reviewKind: 'advisory', resolved: false },
    ]), 'utf8')
    expect(await service.resolveReviews({ ids: ['d'] })).toBe(1)
    expect(await service.resolveReviews({ ids: ['d'] })).toBe(0)

    writeFileSync(reviewFile, 'broken', 'utf8')
    await expect(service.reviews({})).rejects.toThrow(SyntaxError)
    await expect(service.resolveReview({ reviewId: 'x' })).rejects.toThrow(SyntaxError)
    await expect(service.resolveReviews({ ids: ['x'] })).rejects.toThrow(SyntaxError)
    writeFileSync(reviewFile, 'null', 'utf8')
    await expect(service.resolveReviews({ ids: ['x'] })).rejects.toThrow('invalid knowledge review state')
  })

  it('derives graph insights and lints empty and broken-link pages', async () => {
    const graph: WikiGraphResult = {
      nodes: [
        { id: 'a', label: 'A', type: 'concept', path: 'a.md', linkCount: 0, community: 0 },
        { id: 'b', label: 'B', type: 'concept', path: 'b.md', linkCount: 2, community: 1 },
        { id: 'c', label: 'C', type: 'concept', path: 'c.md', linkCount: 2, community: 2 },
        { id: 'd', label: 'D', type: 'concept', path: 'd.md', linkCount: 2, community: 3 },
      ],
      edges: [
        { source: 'b', target: 'a', weight: 1 },
        { source: 'b', target: 'c', weight: 1 },
        { source: 'b', target: 'd', weight: 1 },
        { source: 'c', target: 'a', weight: 1 },
        { source: 'missing', target: 'a', weight: 1 },
      ],
      communities: [
        { id: 0, nodeCount: 3, cohesion: 0, topNodes: ['A'] },
        { id: 1, nodeCount: 2, cohesion: 0, topNodes: ['B'] },
      ],
    }
    vi.spyOn(service, 'computeGraph').mockResolvedValue(graph)
    const insights = await service.graphInsights()
    expect(insights.isolated).toHaveLength(1)
    expect(insights.bridges).toEqual([expect.objectContaining({ id: 'b', communities: 3 })])
    expect(insights.sparseCommunities).toHaveLength(1)

    writeFileSync(join(wikiRoot, 'concepts', 'empty.md'), '---\ntitle: Empty\n---\n', 'utf8')
    writeFileSync(join(wikiRoot, 'concepts', 'links.md'), '[[missing]] [[empty]]', 'utf8')
    service.snapshots.invalidate(wikiRoot)
    const lint = await service.lint()
    expect(lint.emptyPages).toContain('concepts/empty.md')
    expect(lint.brokenLinks).toContainEqual({ from: 'concepts/links.md', target: 'missing' })
    expect(lint.totalPages).toBeGreaterThanOrEqual(2)
  })

  it('exports and inspects a minimal project archive and reports invalid imports', async () => {
    writeFileSync(join(wikiRoot, 'index.md'), '# Wiki', 'utf8')
    const exported = await service.exportProject()
    expect(exported.error).toBeUndefined()
    expect(existsSync(exported.path)).toBe(true)
    const imported = await service.importProject({ path: exported.path })
    expect(imported.ok).toBe(true)
    expect(imported.entries).toContain('wiki/index.md')
    expect((await service.importProject({ path: join(root, 'missing.zip') })).ok).toBe(false)
  })
})
