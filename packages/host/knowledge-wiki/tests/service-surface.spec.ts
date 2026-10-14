import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import KnowledgeWikiService from '../src/index.ts'
import { MAX_WIKI_PAGE_BYTES } from '../src/filesystem.ts'
import { REVIEW_STORE_MAX_BYTES } from '../src/review-store.ts'
import type { CandidateVerificationResult, KnowledgeRecord, KnowledgeRepairProposalResult, KnowledgeUtilityRecord, WikiGraphResult, WikiReviewItem } from '../src/types.ts'
import {
  appendKnowledgeEvent,
  createKnowledgeEvent,
  createKnowledgeRecord,
  knowledgeSha256,
  readKnowledgeEventLog,
  replayKnowledgeEvents,
  type KnowledgeAccessContext,
} from '../src/knowledge-governance.ts'
import * as knowledgeGovernance from '../src/knowledge-governance.ts'
import * as wikiGraph from '../src/graph.ts'
import * as wikiReviews from '../src/reviews.ts'
import type { KnowledgeWikiStageExecutor } from '../src/stage-executor.ts'
import { wikiTestConfig } from './config-fixture.ts'
import { encodeKnowledgeWikiPromotionSealRequest, type KnowledgeWikiPromotionSealRequest } from '../src/verifier.ts'
import { appendVerifiedKnowledgeRecord, testMeasuredTrialPayload, verifierAuthority } from './verifier-authority-fixture.ts'

interface Surface {
  snapshots: { invalidate(root: string): void; dispose(): void }
  graph(): Promise<WikiGraphResult>
  fullGraph(): Promise<WikiGraphResult>
  list(): Promise<Array<{ path: string }>>
  search(request: { query: string; topK?: number }): Promise<Array<{ path: string; score: number }>>
  knowledgeUtility(): Promise<Array<{ path: string; utilityScore: number; retrievalHits: number }>>
  recordKnowledgeRetrieval(paths: string[], projectRoot?: string): void
  serializeUtility(records: Record<string, KnowledgeUtilityRecord>): string
  recordKnowledgeOutcome(request: { paths: string[]; outcome: 'successful' | 'corrected' | 'neutral' }): Promise<number>
  proposeKnowledgeRepair(
    request: { sourcePath: string; title: string; correctedRule: string; expectedSourceContentHash: string },
    scope: KnowledgeAccessContext,
  ): Promise<KnowledgeRepairProposalResult>
  pageContent(request: { path: string }): Promise<{ path: string; content: string }>
  writePage(request: { path: string; content: string; expectedContent?: string }): Promise<Record<string, unknown>>
  createPage(request: { title: string; content?: string }): Promise<Record<string, unknown>>
  ingestSource(request: { path: string }): Promise<{ written: string[]; warnings: string[] }>
  reviews(request: { status?: string; limit?: number }): Promise<WikiReviewItem[]>
  verifyCandidate(
    request: { reviewId: string; action: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' | 'Archive' },
    signal: AbortSignal,
  ): Promise<CandidateVerificationResult>
  resolveReview(request: { reviewId: string; action?: string }): Promise<boolean>
  resolveReviews(request: { ids: string[]; action?: string }): Promise<number>
  graphInsights(): Promise<Record<string, unknown[]>>
  computeGraph(): Promise<WikiGraphResult>
  modelPageContent(
    request: { path: string },
    scope: KnowledgeAccessContext,
  ): Promise<{ path: string; content: string }>
  modelSearch(
    request: { query: string; topK?: number },
    scope: KnowledgeAccessContext,
    signal?: AbortSignal,
  ): Promise<Array<{ path: string; score: number }>>
  modelList(scope: KnowledgeAccessContext): Promise<Array<{ path: string; isDir: boolean; provenance?: object }>>
  modelGraph(scope: KnowledgeAccessContext): Promise<{
    nodes: Array<{ id: string; path: string }>
    edges: Array<{ source: string; target: string }>
    provenance: Record<string, object>
  }>
  modelReviews(request: { status?: string; limit?: number }, scope: KnowledgeAccessContext): Promise<WikiReviewItem[]>
  lint(): Promise<{ brokenLinks: Array<{ from: string; target: string }>; emptyPages: string[]; totalPages: number }>
  exportProject(): Promise<{ path: string; error?: string }>
  importProject(request: { path: string }): Promise<{ ok: boolean; error?: string; entries?: string[] }>
}

let root: string
let wikiRoot: string
let ctx: Context
let service: Surface

function repairFixture() {
  const path = 'concepts/repair-boundary.md'
  const content = '---\ntype: concept\nstatus: canonical\ntitle: Repair boundary\n---\n\nOriginal verified rule.\n'
  const request = {
    sourcePath: path,
    title: 'Repair boundary',
    correctedRule: 'Use the current verified rule.',
    expectedSourceContentHash: knowledgeSha256(content),
  }
  const scope = { projectId: root, workspaceId: root, sessionId: 'repair-boundary-session' }
  const events: unknown[] = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: request.correctedRule }] } },
    { type: 'tool/call', data: { turn: 1, name: 'wiki_propose_repair', arguments: JSON.stringify(request) } },
  ]
  writeFileSync(join(wikiRoot, path), content)
  const authority = verifierAuthority()
  ctx.provide('knowledgeWikiVerifierAuthority', authority)
  appendVerifiedKnowledgeRecord(root, path, content, authority, 'repair-boundary')
  return { path, content, request, scope, events, authority }
}

function configureVisionExecutor(execute: KnowledgeWikiStageExecutor['execute']): void {
  Object.defineProperty(ctx, 'credentials', {
    configurable: true,
    value: { resolve: vi.fn().mockResolvedValue({ value: 'fixture-vision-key' }) },
  })
  ctx.provide('knowledgeWikiStageExecutor', { isolation: 'owned-worker-v1', execute })
}

function appendSealedVerificationForExistingRecord(
  projectRoot: string,
  authority: ReturnType<typeof verifierAuthority>,
  record: KnowledgeRecord,
): void {
  const eventPath = join(projectRoot, '.llm-wiki', 'knowledge-events.jsonl')
  const prior = readKnowledgeEventLog(eventPath, authority)
  const verificationPayload = {
    record,
    trust: 'medium',
    authority: authority.authorityId,
    confidence: 0.9,
    lastVerifiedAt: new Date().toISOString(),
    evidenceRefs: ['receipt:concurrent-reverification'],
    candidatePath: record.source,
    candidateHash: knowledgeSha256(readFileSync(join(wikiRoot, record.source), 'utf8')),
    source: record.source,
  }
  const event = createKnowledgeEvent('knowledge/verified', record.id, record.scope, {
    ...verificationPayload,
    authorityId: authority.authorityId,
    authoritySeal: authority.sealPromotion({
      schemaVersion: 1,
      domain: 'ark.knowledge-wiki',
      authorityId: authority.authorityId,
      operation: 'seal-knowledge-event',
      eventType: 'knowledge/verified',
      knowledgeId: record.id,
      payload: verificationPayload,
    }),
  }, {
    seq: prior.length,
    previousEventHash: prior.at(-1)?.eventHash ?? null,
  })
  appendKnowledgeEvent(eventPath, event)
}

function utilityRecordsNearLimit(): Record<string, KnowledgeUtilityRecord> {
  const stamp = '2026-10-13T00:00:00.000Z'
  const build = (count: number): { records: Record<string, KnowledgeUtilityRecord>; bytes: number } => {
    const records: Record<string, KnowledgeUtilityRecord> = {}
    for (let index = 0; index < count; index += 1) {
      const path = `concepts/${String(index).padStart(6, '0')}-${'x'.repeat(100)}.md`
      records[path] = { path, retrievalHits: 1, successfulUses: 0, userCorrections: 0, utilityScore: 0, lastRetrievedAt: stamp }
    }
    return { records, bytes: Buffer.byteLength(`${JSON.stringify(records, null, 2)}\n`, 'utf8') }
  }
  const result = build(12_633)
  if (result.bytes > MAX_WIKI_PAGE_BYTES || MAX_WIKI_PAGE_BYTES - result.bytes > 300) {
    throw new Error(`utility fixture is not close to the page-size bound: ${result.bytes}`)
  }
  return result.records
}

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
  service = new KnowledgeWikiService(ctx, wikiTestConfig({
    wikiRoot,
    mainRoot: root,
    credential: 'VISION_API_KEY',
    llmProvider: 'p',
    llmModel: 'm',
  })) as unknown as Surface
})

afterEach(async () => {
  service.snapshots.dispose()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('empty-library graph, search, and utility surface', () => {
  it('enforces the image bound before vision and publishes the exact captured bytes only', async () => {
    const execute = vi.fn(async (_request: Parameters<KnowledgeWikiStageExecutor['execute']>[0]) => ({ text: 'caption from captured image' }))
    configureVisionExecutor(execute)
    const oversizedPath = 'raw/sources/oversized.png'
    writeFileSync(join(root, oversizedPath), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61))
    const oversized = await service.ingestSource({ path: oversizedPath })
    expect(oversized.written).toEqual([])
    expect(oversized.warnings.join(' ')).toContain('file exceeds 16777216 bytes')
    expect(execute).not.toHaveBeenCalled()
    expect(existsSync(join(wikiRoot, '_candidates/ingest/media/oversized.png'))).toBe(false)
    expect(existsSync(join(wikiRoot, '_candidates/ingest/sources/oversized.md'))).toBe(false)
    expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(false)

    const imagePath = 'raw/sources/normal.png'
    const capturedBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])
    writeFileSync(join(root, imagePath), capturedBytes)
    const normal = await service.ingestSource({ path: imagePath })
    expect(normal.warnings).toEqual([])
    expect(normal.written).toEqual([
      '_candidates/ingest/sources/normal.md', '_candidates/ingest/media/normal.png',
    ])
    expect(readFileSync(join(wikiRoot, '_candidates/ingest/media/normal.png')).equals(capturedBytes)).toBe(true)
    expect(readFileSync(join(wikiRoot, '_candidates/ingest/sources/normal.md'), 'utf8'))
      .toContain('caption from captured image')
    expect(JSON.parse(readFileSync(join(root, '.llm-wiki', 'review.json'), 'utf8')))
      .toEqual([expect.objectContaining({ candidatePath: '_candidates/ingest/sources/normal.md' })])
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('refuses an image changed during vision before publishing page, media, or review', async () => {
    const imagePath = 'raw/sources/changed.png'
    const capturedBytes = Buffer.from('captured image bytes')
    const replacementBytes = Buffer.from('different image bytes')
    writeFileSync(join(root, imagePath), capturedBytes)
    const execute = vi.fn(async (request: Parameters<KnowledgeWikiStageExecutor['execute']>[0]) => {
      if (request.kind !== 'vision-describe') throw new Error('unexpected stage')
      writeFileSync(request.path, replacementBytes)
      return { text: 'caption for prior image bytes' }
    })
    configureVisionExecutor(execute)

    const outcome = await service.ingestSource({ path: imagePath })
    expect(outcome.written).toEqual([])
    expect(outcome.warnings.join(' ')).toContain('image source changed during captioning')
    expect(execute).toHaveBeenCalledOnce()
    expect(readFileSync(join(root, imagePath)).equals(replacementBytes)).toBe(true)
    expect(existsSync(join(wikiRoot, '_candidates/ingest/media/changed.png'))).toBe(false)
    expect(existsSync(join(wikiRoot, '_candidates/ingest/sources/changed.md'))).toBe(false)
    expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(false)
  })

  it('refuses an image changed during review preflight before publishing page, media, or review', async () => {
    const imagePath = 'raw/sources/changed-after-review-preflight.png'
    const capturedBytes = Buffer.from('image captioned before review preflight')
    const replacementBytes = Buffer.from('replacement after review preflight')
    writeFileSync(join(root, imagePath), capturedBytes)
    const execute = vi.fn(async (_request: Parameters<KnowledgeWikiStageExecutor['execute']>[0]) => ({
      text: 'caption for captured bytes',
    }))
    configureVisionExecutor(execute)
    const prepare = wikiReviews.prepareReviewAppend.bind(wikiReviews)
    let prepared = false
    vi.spyOn(wikiReviews, 'prepareReviewAppend').mockImplementation((...args) => {
      const plan = prepare(...args)
      prepared = true
      writeFileSync(join(root, imagePath), replacementBytes)
      return plan
    })

    const outcome = await service.ingestSource({ path: imagePath })
    expect(prepared).toBe(true)
    expect(execute).toHaveBeenCalledOnce()
    expect(outcome.written).toEqual([])
    expect(outcome.warnings.join(' ')).toContain('image source changed during review preflight')
    expect(readFileSync(join(root, imagePath)).equals(replacementBytes)).toBe(true)
    expect(existsSync(join(wikiRoot, '_candidates/ingest/media/changed-after-review-preflight.png'))).toBe(false)
    expect(existsSync(join(wikiRoot, '_candidates/ingest/sources/changed-after-review-preflight.md'))).toBe(false)
    expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(false)
  })

  it('preflights the encoded retrieval projection before writing an event and keeps ordinary updates readable', async () => {
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const governanceFile = join(root, '.llm-wiki', 'governance.jsonl')
    const candidateRoot = join(wikiRoot, '_candidates')
    const records = utilityRecordsNearLimit()
    const triggerPath = 'concepts/probe-trigger.md'
    const triggerRecord: KnowledgeUtilityRecord = {
      path: triggerPath, retrievalHits: 1, successfulUses: 0, userCorrections: 0, utilityScore: 0,
      lastRetrievedAt: '2026-10-13T00:00:00.000Z',
    }
    const before = Buffer.from(`${JSON.stringify(records, null, 2)}\n`, 'utf8')
    const projected = Buffer.from(`${JSON.stringify({ ...records, [triggerPath]: triggerRecord }, null, 2)}\n`, 'utf8')
    expect(before.byteLength).toBeLessThanOrEqual(MAX_WIKI_PAGE_BYTES)
    expect(projected.byteLength).toBeGreaterThan(MAX_WIKI_PAGE_BYTES)
    mkdirSync(join(root, '.llm-wiki'), { recursive: true })
    writeFileSync(utilityFile, before)
    const utilityBefore = readFileSync(utilityFile)

    expect(() => { service.recordKnowledgeRetrieval([triggerPath], root) })
      .toThrow(`knowledge utility exceeds ${MAX_WIKI_PAGE_BYTES} byte limit`)

    expect(readFileSync(utilityFile).equals(utilityBefore)).toBe(true)
    expect(existsSync(eventFile)).toBe(false)
    expect(existsSync(reviewFile)).toBe(false)
    expect(existsSync(governanceFile)).toBe(false)
    expect(existsSync(candidateRoot)).toBe(false)

    writeFileSync(utilityFile, '{}\n', 'utf8')
    service.recordKnowledgeRetrieval([triggerPath], root)
    expect(readFileSync(utilityFile).byteLength).toBeLessThanOrEqual(MAX_WIKI_PAGE_BYTES)
    expect(readKnowledgeEventLog(eventFile)).toHaveLength(1)
    expect(JSON.parse(readFileSync(utilityFile, 'utf8'))).toHaveProperty(triggerPath)
    writeFileSync(join(wikiRoot, triggerPath), 'retrievable utility boundary page\n', 'utf8')

    const outcomeRecords = utilityRecordsNearLimit()
    const outcomeRecord: KnowledgeUtilityRecord = {
      path: triggerPath, retrievalHits: 1, successfulUses: 0, userCorrections: 1, utilityScore: -3,
      lastOutcomeAt: '2026-10-13T00:00:00.000Z',
    }
    const outcomeBefore = Buffer.from(`${JSON.stringify(outcomeRecords, null, 2)}\n`, 'utf8')
    const outcomeProjected = Buffer.from(`${JSON.stringify({ ...outcomeRecords, [triggerPath]: outcomeRecord }, null, 2)}\n`, 'utf8')
    expect(outcomeProjected.byteLength).toBeGreaterThan(MAX_WIKI_PAGE_BYTES)
    writeFileSync(utilityFile, outcomeBefore)
    const eventBeforeOutcome = readFileSync(eventFile)
    await expect(service.recordKnowledgeOutcome({ paths: [triggerPath], outcome: 'corrected' }))
      .rejects.toThrow(`knowledge utility exceeds ${MAX_WIKI_PAGE_BYTES} byte limit`)
    expect(readFileSync(utilityFile).equals(outcomeBefore)).toBe(true)
    expect(readFileSync(eventFile)).toEqual(eventBeforeOutcome)
  }, 30_000)

  it('preflights correction utility before revocation events or Candidate publication', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const governanceFile = join(root, '.llm-wiki', 'governance.jsonl')
    const candidatePath = `_candidates/ingest/${item.path}`
    const candidateFile = join(wikiRoot, candidatePath)
    const records = utilityRecordsNearLimit()
    const before = Buffer.from(`${JSON.stringify(records, null, 2)}\n`, 'utf8')
    const corrected: KnowledgeUtilityRecord = {
      path: item.path, retrievalHits: 2, successfulUses: 1, userCorrections: 1, utilityScore: -0.5,
      lastOutcomeAt: '2026-10-13T00:00:00.000Z',
    }
    const projected = Buffer.from(`${JSON.stringify({ ...records, [item.path]: corrected }, null, 2)}\n`, 'utf8')
    expect(before.byteLength).toBeLessThanOrEqual(MAX_WIKI_PAGE_BYTES)
    expect(projected.byteLength).toBeGreaterThan(MAX_WIKI_PAGE_BYTES)
    writeFileSync(utilityFile, before)
    const utilityBefore = readFileSync(utilityFile)
    const eventBefore = readFileSync(eventFile)
    ctx.provide('sessionQuery', {
      readSession: async () => ({ session: { cwd: root }, events: item.events }),
    } as never)

    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .rejects.toThrow(`knowledge utility exceeds ${MAX_WIKI_PAGE_BYTES} byte limit`)

    expect(readFileSync(utilityFile).equals(utilityBefore)).toBe(true)
    expect(readFileSync(eventFile)).toEqual(eventBefore)
    expect(existsSync(candidateFile)).toBe(false)
    expect(existsSync(reviewFile)).toBe(false)
    expect(existsSync(governanceFile)).toBe(false)
  }, 30_000)

  it('does not append unrelated expiry events before an oversized correction is rejected', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    const expiredPath = 'concepts/expiry-side-effect.md'
    const expiredContent = '# Expiry side effect\n\nPreviously verified.\n'
    writeFileSync(join(wikiRoot, expiredPath), expiredContent)
    appendVerifiedKnowledgeRecord(root, expiredPath, expiredContent, item.authority, 'expiry-side-effect')

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 60_001)
      // Replace only the repair source with a fresh authenticated owner. The
      // unrelated page remains expired and would normally be appended by the
      // service's modelRecords() replay while this operation checks authority.
      appendVerifiedKnowledgeRecord(root, item.path, item.content, item.authority, 'repair-boundary-refreshed')
      const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
      const utility = utilityRecordsNearLimit()
      writeFileSync(utilityFile, `${JSON.stringify(utility, null, 2)}\n`)
      const utilityBefore = readFileSync(utilityFile)
      const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
      const eventBefore = readFileSync(eventFile)
      ctx.provide('sessionQuery', {
        readSession: async () => ({ session: { cwd: root }, events: item.events }),
      } as never)

      await expect(service.proposeKnowledgeRepair(item.request, item.scope))
        .rejects.toThrow(`knowledge utility exceeds ${MAX_WIKI_PAGE_BYTES} byte limit`)
      expect(readFileSync(utilityFile).equals(utilityBefore)).toBe(true)
      expect(readFileSync(eventFile)).toEqual(eventBefore)
      expect(readKnowledgeEventLog(eventFile, item.authority).some(event => event.type === 'knowledge/expired')).toBe(false)
      expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
      expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(false)
      expect(existsSync(join(root, '.llm-wiki', 'governance.jsonl'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('flushes unrelated expiries after a fitting correction projection and revalidates the source', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    const expiredPath = 'concepts/expiry-after-preflight.md'
    const expiredContent = '# Expiry after preflight\n\nPreviously verified.\n'
    writeFileSync(join(wikiRoot, expiredPath), expiredContent)
    appendVerifiedKnowledgeRecord(root, expiredPath, expiredContent, item.authority, 'expiry-after-preflight')

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 60_001)
      appendVerifiedKnowledgeRecord(root, item.path, item.content, item.authority, 'repair-after-preflight')
      ctx.provide('sessionQuery', {
        readSession: async () => ({ session: { cwd: root }, events: item.events }),
      } as never)

      await expect(service.proposeKnowledgeRepair(item.request, item.scope)).resolves.toMatchObject({ ok: true })
      const events = readKnowledgeEventLog(join(root, '.llm-wiki', 'knowledge-events.jsonl'), item.authority)
      const expired = events.filter(event => event.type === 'knowledge/expired')
      expect(expired).toHaveLength(2)
      expect(expired.map(event => event.knowledgeId)).toEqual(expect.arrayContaining([
        'candidate:repair-boundary', 'candidate:expiry-after-preflight',
      ]))
      expect(expired.every(event => event.payload.reason === 'deadline')).toBe(true)
      expect(events.some(event => event.type === 'knowledge/rejected' && event.knowledgeId === 'candidate:repair-after-preflight')).toBe(true)
      expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('replays a valid source revocation after utility preflight before proposing correction feedback', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const utilityBefore = readFileSync(utilityFile)
    const serialize = service.serializeUtility.bind(service)
    let interleaved = false
    vi.spyOn(service, 'serializeUtility').mockImplementation((records) => {
      const bytes = serialize(records)
      if (!interleaved) {
        const prior = readKnowledgeEventLog(eventFile, item.authority)
        appendKnowledgeEvent(eventFile, createKnowledgeEvent(
          'knowledge/rejected', 'candidate:repair-boundary', { projectId: root, visibility: 'project' },
          { path: item.path, reason: 'concurrent-authority-revocation' },
          { seq: prior.length, previousEventHash: prior.at(-1)?.eventHash ?? null },
        ))
        interleaved = true
      }
      return bytes
    })

    await expect(service.proposeKnowledgeRepair(item.request, item.scope)).resolves.toEqual({
      ok: false, errorCode: 'source-not-verified',
    })
    expect(interleaved).toBe(true)
    expect(readKnowledgeEventLog(eventFile, item.authority).at(-1)).toMatchObject({
      type: 'knowledge/rejected', knowledgeId: 'candidate:repair-boundary',
    })
    expect(readFileSync(utilityFile).equals(utilityBefore)).toBe(true)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(false)
    expect(existsSync(join(root, '.llm-wiki', 'governance.jsonl'))).toBe(false)
  })

  it('rehashes the source after the durable admission read before publishing a repair Candidate', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const utilityBefore = readFileSync(utilityFile)
    const eventBefore = readFileSync(eventFile)
    const changed = `${item.content}\nConcurrent source replacement after admission read.\n`
    const admissionOwner = service as unknown as Surface & {
      modelRecordContentAllowed(
        record: (KnowledgeRecord & { readonly promotedContentHash: string | undefined }) | undefined,
        scope: KnowledgeAccessContext,
        contentRoot: string,
      ): boolean
    }
    const original = admissionOwner.modelRecordContentAllowed.bind(service)
    let readsForSource = 0
    vi.spyOn(admissionOwner, 'modelRecordContentAllowed').mockImplementation((record, scope, contentRoot) => {
      const allowed = original(record, scope, contentRoot)
      if (allowed && record?.source === item.path && ++readsForSource === 3) {
        writeFileSync(join(wikiRoot, item.path), changed)
      }
      return allowed
    })

    await expect(service.proposeKnowledgeRepair(item.request, item.scope)).resolves.toMatchObject({
      ok: false, errorCode: 'source-changed',
    })
    expect(readsForSource).toBe(3)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(changed)
    expect(readFileSync(utilityFile).equals(utilityBefore)).toBe(true)
    expect(readFileSync(eventFile)).toEqual(eventBefore)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(false)
    expect(existsSync(join(root, '.llm-wiki', 'governance.jsonl'))).toBe(false)
  })

  it('defers source expiry during rejected repair but persists it on the next normal model read', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const beforeExpiry = readFileSync(eventFile)
    ctx.provide('sessionQuery', {
      readSession: async () => ({ session: { cwd: root }, events: item.events }),
    } as never)

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 60_001)
      await expect(service.proposeKnowledgeRepair(item.request, item.scope)).resolves.toEqual({
        ok: false, errorCode: 'source-not-verified',
      })
      expect(readFileSync(eventFile)).toEqual(beforeExpiry)
      await expect(service.modelPageContent({ path: item.path }, item.scope))
        .rejects.toThrow('knowledge page is not verified for this scope')
      const events = readKnowledgeEventLog(eventFile, item.authority)
      expect(events.filter(event => event.type === 'knowledge/expired')).toMatchObject([{
        knowledgeId: 'candidate:repair-boundary', payload: { reason: 'deadline' },
      }])
      expect(replayKnowledgeEvents(events).records.get('candidate:repair-boundary'))
        .toMatchObject({ verificationStatus: 'expired' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts exact UTF-8 bytes of complete JSON utility output, including multibyte and escaped text', () => {
    const basePath = 'concepts/.md'
    const baseRecord: KnowledgeUtilityRecord = {
      path: basePath, retrievalHits: 1, successfulUses: 0, userCorrections: 0, utilityScore: 0,
      lastRetrievedAt: '2026-10-13T00:00:00.000Z',
    }
    const baseOutput = service.serializeUtility({ [basePath]: baseRecord })
    const paddingBytes = MAX_WIKI_PAGE_BYTES - Buffer.byteLength(baseOutput, 'utf8')
    expect(paddingBytes % 2).toBe(0)
    const exactPath = `concepts/${'x'.repeat(paddingBytes / 2)}.md`
    const exactRecord = { ...baseRecord, path: exactPath }
    expect(Buffer.byteLength(service.serializeUtility({ [exactPath]: exactRecord }), 'utf8'))
      .toBe(MAX_WIKI_PAGE_BYTES)

    const multibyteEscapedPath = `concepts/${'雪"\\'.repeat(400_000)}.md`
    const multibyteRecord = { ...baseRecord, path: multibyteEscapedPath }
    const oversized = { [multibyteEscapedPath]: multibyteRecord }
    const encodedCharacters = `${JSON.stringify(oversized, null, 2)}\n`
    expect(encodedCharacters.length).toBeLessThan(MAX_WIKI_PAGE_BYTES)
    expect(Buffer.byteLength(encodedCharacters, 'utf8')).toBeGreaterThan(MAX_WIKI_PAGE_BYTES)
    expect(() => service.serializeUtility(oversized))
      .toThrow(`knowledge utility exceeds ${MAX_WIKI_PAGE_BYTES} byte limit`)
  })

  it('builds measured-trial trust only from an exact launcher config and keeps the default disabled', async () => {
    const defaultReader: unknown = Reflect.get(service, 'measuredTrialReader')
    expect(defaultReader).toBeUndefined()

    const evaluator = generateKeyPairSync('ed25519')
    const journal = generateKeyPairSync('ed25519')
    const artifactRoot = join(root, 'measured-trial-artifacts')
    mkdirSync(artifactRoot)
    const publicPem = (key: typeof evaluator.publicKey): string => key.export({ type: 'spki', format: 'pem' }).toString()
    const config = wikiTestConfig({
      wikiRoot,
      mainRoot: root,
      credential: '',
      llmProvider: 'p',
      llmModel: 'm',
      knowledgeMeasuredTrialConfig: JSON.stringify({
        authorityId: 'independent-evaluator',
        publicKey: publicPem(evaluator.publicKey),
        journalSignerAuthorityId: 'promotion-journal-signer',
        journalSignerPublicKey: publicPem(journal.publicKey),
        artifactRoot,
      }),
    })
    const configuredContext = new Context()
    const configured = new KnowledgeWikiService(configuredContext, config)
    expect(Reflect.get(configured, 'measuredTrialReader')).toMatchObject({ authorityId: 'independent-evaluator' })
    const configuredSnapshots = Reflect.get(configured, 'snapshots') as { dispose: () => void }
    configuredSnapshots.dispose()
    await configuredContext.fiber.dispose()

    const invalidContext = new Context()
    expect(() => new KnowledgeWikiService(invalidContext, {
      ...config,
      knowledgeMeasuredTrialConfig: JSON.stringify({
        authorityId: 'independent-evaluator',
        publicKey: publicPem(evaluator.publicKey),
        journalSignerAuthorityId: 'promotion-journal-signer',
        journalSignerPublicKey: publicPem(journal.publicKey),
        artifactRoot,
        privateKey: 'must-not-be-accepted',
      }),
    })).toThrow(/exactly the two public authorities/u)
    await invalidContext.fiber.dispose()

    const privateKeyContext = new Context()
    expect(() => new KnowledgeWikiService(privateKeyContext, {
      ...config,
      knowledgeMeasuredTrialConfig: JSON.stringify({
        authorityId: 'independent-evaluator',
        publicKey: evaluator.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        journalSignerAuthorityId: 'promotion-journal-signer',
        journalSignerPublicKey: publicPem(journal.publicKey),
        artifactRoot,
      }),
    })).toThrow(/SPKI public key; private keys are not accepted/u)
    await privateKeyContext.fiber.dispose()
  })

  it.each([
    ['oversized JSON', 'x'.repeat(32 * 1024 + 1), /exceeds/u],
    ['invalid JSON', '{', /valid JSON/u],
    ['null JSON', 'null', /must be an object/u],
    ['array JSON', '[]', /must be an object/u],
    ['primitive JSON', 'false', /must be an object/u],
  ])('rejects measured-trial launcher configuration with %s', async (_label, raw, error) => {
    const invalidContext = new Context()
    try {
      expect(() => new KnowledgeWikiService(invalidContext, wikiTestConfig({
        wikiRoot, mainRoot: root, knowledgeMeasuredTrialConfig: raw,
      }))).toThrow(error)
    } finally {
      await invalidContext.fiber.dispose()
    }
  })

  it('refuses measured-use registration when the optional launcher config is omitted', async () => {
    const isolated = new Context()
    isolated.provide('knowledgeWikiVerifierAuthority', verifierAuthority())
    const { knowledgeMeasuredTrialConfig: _omitted, ...withoutTrialConfig } = wikiTestConfig({ wikiRoot, mainRoot: root })
    const configured = new KnowledgeWikiService(isolated, withoutTrialConfig)
    try {
      const reviewFile = join(root, '.llm-wiki', 'review.json')
      expect(existsSync(reviewFile)).toBe(false)
      await expect(configured.recordCandidateMeasuredTrial({
        reviewId: 'absent', action: 'Promote', trialHash: 'a'.repeat(64),
      })).resolves.toEqual({ authenticated: false, eligibleForReview: false, errorCode: 'measured-trial-authority-unavailable' })
      expect(existsSync(reviewFile)).toBe(false)
      expect(existsSync(join(root, '.llm-wiki', 'promotion-journal'))).toBe(false)
    } finally {
      ;(configured as unknown as Surface).snapshots.dispose()
      await isolated.fiber.dispose()
    }
  })

  it.each([
    ['numeric authority', 'authorityId', 1],
    ['blank authority', 'authorityId', ' '],
    ['padded authority', 'authorityId', 'independent-evaluator '],
    ['oversized authority', 'authorityId', 'a'.repeat(16 * 1024 + 1)],
    ['numeric key', 'publicKey', 1],
    ['blank key', 'journalSignerPublicKey', ''],
    ['relative artifact root', 'artifactRoot', 'relative/artifacts'],
  ])('rejects a measured-trial trust field: %s', async (_label, key, value) => {
    const artifactRoot = join(root, 'measured-trial-invalid-config')
    mkdirSync(artifactRoot)
    const publicKey = (): string => generateKeyPairSync('ed25519').publicKey
      .export({ type: 'spki', format: 'pem' }).toString()
    const payload = {
      authorityId: 'independent-evaluator', publicKey: publicKey(),
      journalSignerAuthorityId: 'promotion-journal-signer', journalSignerPublicKey: publicKey(),
      artifactRoot, [key]: value,
    }
    const invalidContext = new Context()
    try {
      expect(() => new KnowledgeWikiService(invalidContext, wikiTestConfig({
        wikiRoot, mainRoot: root, knowledgeMeasuredTrialConfig: JSON.stringify(payload),
      }))).toThrow()
    } finally {
      await invalidContext.fiber.dispose()
    }
  })

  it('validates launcher-owned verifier JSON before exposing the configured authority', async () => {
    const keys = generateKeyPairSync('ed25519')
    const authorityId = 'launcher-verifier'
    const owner = {
      ...verifierAuthority(),
      authorityId,
      async sealPromotion(request: KnowledgeWikiPromotionSealRequest) {
        if (request.authorityId !== authorityId) throw new Error('fixture sealer authority mismatch')
        return {
          authorityId,
          proof: sign(null, Buffer.from(encodeKnowledgeWikiPromotionSealRequest(request), 'utf8'), keys.privateKey).toString('base64'),
        }
      },
    }
    const base = {
      authorityId,
      executable: process.execPath,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sourceIdentity: {
        commit: 'a'.repeat(40),
        sourceDigest: '1'.repeat(64),
        dirty: false,
        dirtyDigest: '2'.repeat(64),
        buildDigest: '3'.repeat(64),
      },
    }
    const createContext = async (serviceOwner = owner) => {
      const isolated = new Context()
      isolated.provide('knowledgeWikiVerifierAuthority', serviceOwner)
      Object.defineProperty(isolated, 'credentials', {
        configurable: true,
        value: { resolve: vi.fn().mockResolvedValue(undefined) },
      })
      Object.defineProperty(isolated, 'llm', { configurable: true, value: { stream: vi.fn() } })
      await isolated.plugin(LocalSubprocessRuntime)
      return isolated
    }
    const create = async (raw: string | undefined, serviceOwner = owner) => {
      const isolated = await createContext(serviceOwner)
      const resolved = wikiTestConfig({
        wikiRoot,
        mainRoot: root,
        credential: '',
        llmProvider: 'p',
        llmModel: 'm',
      })
      Reflect.set(resolved, 'knowledgeVerifierConfig', raw)
      const configured = new KnowledgeWikiService(isolated, resolved) as unknown as Surface
      return { context: isolated, service: configured }
    }

    const empty = await create(undefined)
    empty.service.snapshots.dispose()
    await empty.context.fiber.dispose()

    const malformed: unknown[] = [
      'not-json', 'null', '[]', '"string"', '{}',
      { ...base, authorityId: 42 },
      { ...base, executable: 42 },
      { ...base, publicKey: 42 },
      { ...base, privateKey: 42 },
      { ...base, sourceIdentity: null },
      { ...base, sourceIdentity: [] },
      { ...base, args: 'not-an-array' },
      { ...base, args: ['--version', 7] },
    ]
    for (const value of malformed) {
      const isolated = await createContext()
      const resolved = wikiTestConfig({
        wikiRoot,
        mainRoot: root,
        credential: '',
        llmProvider: 'p',
        llmModel: 'm',
      })
      expect(() => new KnowledgeWikiService(isolated, {
        ...resolved,
        knowledgeVerifierConfig: typeof value === 'string' ? value : JSON.stringify(value),
      })).toThrow()
      await isolated.fiber.dispose()
    }

    const missingProvider = new Context()
    missingProvider.provide('knowledgeWikiVerifierAuthority', owner)
    Object.defineProperty(missingProvider, 'credentials', {
      configurable: true,
      value: { resolve: vi.fn().mockResolvedValue(undefined) },
    })
    Object.defineProperty(missingProvider, 'llm', { configurable: true, value: { stream: vi.fn() } })
    const missingProviderConfig = wikiTestConfig({
      wikiRoot,
      mainRoot: root,
      credential: '',
      llmProvider: 'p',
      llmModel: 'm',
    })
    expect(() => new KnowledgeWikiService(missingProvider, {
      ...missingProviderConfig,
      knowledgeVerifierConfig: JSON.stringify(base),
    })).toThrow('requires the managed ctx.subprocess service')
    await missingProvider.fiber.dispose()

    const missingOwner = new Context()
    Object.defineProperty(missingOwner, 'credentials', {
      configurable: true,
      value: { resolve: vi.fn().mockResolvedValue(undefined) },
    })
    Object.defineProperty(missingOwner, 'llm', { configurable: true, value: { stream: vi.fn() } })
    await missingOwner.plugin(LocalSubprocessRuntime)
    const missingOwnerConfig = wikiTestConfig({
      wikiRoot,
      mainRoot: root,
      credential: '',
      llmProvider: 'p',
      llmModel: 'm',
    })
    expect(() => new KnowledgeWikiService(missingOwner, {
      ...missingOwnerConfig,
      knowledgeVerifierConfig: JSON.stringify(base),
    })).toThrow('requires the typed promotion sealer owner')
    await missingOwner.fiber.dispose()

    const mismatchedOwner = await createContext({
      ...owner,
      authorityId: 'different-owner',
    })
    const mismatchedOwnerConfig = wikiTestConfig({
      wikiRoot,
      mainRoot: root,
      credential: '',
      llmProvider: 'p',
      llmModel: 'm',
    })
    expect(() => new KnowledgeWikiService(mismatchedOwner, {
      ...mismatchedOwnerConfig,
      knowledgeVerifierConfig: JSON.stringify(base),
    })).toThrow('knowledge promotion sealer authority is missing or does not match')
    await mismatchedOwner.fiber.dispose()

    const configured = await create(JSON.stringify(base))
    try {
      await expect(configured.service.modelSearch({ query: 'empty' }, {
        projectId: root, workspaceId: root, sessionId: 'configured-verifier-session',
      })).resolves.toEqual([])
    } finally {
      configured.service.snapshots.dispose()
      await configured.context.fiber.dispose()
    }
    const configuredOptions = await create(JSON.stringify({ ...base, args: ['--unused'], timeoutMs: 1_000 }))
    configuredOptions.service.snapshots.dispose()
    await configuredOptions.context.fiber.dispose()
    const ignoredTimeout = await create(JSON.stringify({ ...base, timeoutMs: 'not-a-number' }))
    ignoredTimeout.service.snapshots.dispose()
    await ignoredTimeout.context.fiber.dispose()
  })

  it('rejects a valid but non-matching sealer before review, governance, event, or WAL writes', async () => {
    const verifierKeys = generateKeyPairSync('ed25519')
    const foreignSealerKeys = generateKeyPairSync('ed25519')
    const authorityId = 'launcher-verifier'
    const sourceIdentity = {
      commit: 'a'.repeat(40),
      sourceDigest: '1'.repeat(64),
      dirty: false,
      dirtyDigest: '2'.repeat(64),
      buildDigest: '3'.repeat(64),
    }
    const resultProgram = `
      const { createPrivateKey, sign } = require('node:crypto')
      const { createHash } = require('node:crypto')
      const privateKey = createPrivateKey(${JSON.stringify(verifierKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())})
      const canonical = value => value === null || typeof value !== 'object'
        ? JSON.stringify(value)
        : Array.isArray(value)
          ? '[' + value.map(canonical).join(',') + ']'
          : '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
            .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
      let input = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => { input += chunk })
      process.stdin.on('end', () => {
        const request = JSON.parse(input).request
        const unsigned = {
          authorityId: ${JSON.stringify(authorityId)},
          requestHash: createHash('sha256').update(canonical(request)).digest('hex'),
          result: 'pass',
          methods: ['integration_test'],
          outcomes: [{ name: 'candidate-check', result: 'pass', evidence: ['verified exact request'] }],
          issuedAt: '2026-10-13T00:00:00.000Z',
        }
        const proof = sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64')
        process.stdout.write(JSON.stringify({ ...unsigned, proof }))
      })
    `
    const launcherConfig = JSON.stringify({
      authorityId,
      executable: process.execPath,
      args: ['-e', resultProgram],
      publicKey: verifierKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sourceIdentity,
    })
    const makeOwner = (
      key: ReturnType<typeof generateKeyPairSync>['privateKey'],
      onSeal: (signal: AbortSignal | undefined) => void | Promise<void> = () => undefined,
    ) => ({
      authorityId,
      async sealPromotion(request: KnowledgeWikiPromotionSealRequest, signal?: AbortSignal) {
        await onSeal(signal)
        return {
          authorityId,
          proof: sign(null, Buffer.from(encodeKnowledgeWikiPromotionSealRequest(request), 'utf8'), key).toString('base64'),
        }
      },
    })
    const createConfigured = async (
      key: ReturnType<typeof generateKeyPairSync>['privateKey'],
      onSeal?: (signal: AbortSignal | undefined) => void | Promise<void>,
    ) => {
      const isolated = new Context()
      isolated.provide('knowledgeWikiVerifierAuthority', makeOwner(key, onSeal))
      Object.defineProperty(isolated, 'credentials', {
        configurable: true,
        value: { resolve: vi.fn().mockResolvedValue(undefined) },
      })
      Object.defineProperty(isolated, 'llm', { configurable: true, value: { stream: vi.fn() } })
      await isolated.plugin(LocalSubprocessRuntime)
      const config = wikiTestConfig({
        wikiRoot,
        mainRoot: root,
        credential: '',
        llmProvider: 'p',
        llmModel: 'm',
      })
      const configured = new KnowledgeWikiService(isolated, {
        ...config,
        knowledgeVerifierConfig: launcherConfig,
      }) as unknown as Surface
      return { context: isolated, service: configured }
    }

    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const governanceFile = join(root, '.llm-wiki', 'governance.jsonl')
    const journalDirectory = join(root, '.llm-wiki', 'promotion-journal')
    const candidatePath = '_candidates/typed-seal-boundary.md'
    const candidateContent = '---\ntype: concept\nstatus: candidate\ntitle: Typed seal boundary\n---\n\n# Typed seal boundary\n'
    const candidateFile = join(wikiRoot, candidatePath)
    mkdirSync(dirname(candidateFile), { recursive: true })
    writeFileSync(candidateFile, candidateContent, 'utf8')
    wikiReviews.appendCandidateReviews(reviewFile, root, 'virtual:typed-seal-boundary', [`wiki/${candidatePath}`])
    const reviewBefore = readFileSync(reviewFile)
    const candidateBefore = readFileSync(candidateFile)
    const optionalBytes = (path: string) => existsSync(path) ? readFileSync(path) : undefined
    const initialEvent = optionalBytes(eventFile)
    const initialGovernance = optionalBytes(governanceFile)

    const restoreBytes = (path: string, bytes: Buffer | undefined) => {
      if (bytes === undefined) rmSync(path, { force: true })
      else writeFileSync(path, bytes)
    }
    let configuredOwnerSignal: AbortSignal | undefined
    const matched = await createConfigured(verifierKeys.privateKey, (signal) => { configuredOwnerSignal = signal })
    let mismatchedSealCalls = 0
    const rejected = await createConfigured(foreignSealerKeys.privateKey, () => { mismatchedSealCalls += 1 })
    let blockedSignal: AbortSignal | undefined
    let enterBlockedSeal!: () => void
    const blockedSealStarted = new Promise<void>((resolve) => { enterBlockedSeal = resolve })
    const blocked = await createConfigured(verifierKeys.privateKey, signal => new Promise<void>((_resolve, reject) => {
      if (signal === undefined) throw new Error('configured promotion sealer did not receive caller signal')
      blockedSignal = signal
      enterBlockedSeal()
      if (signal.aborted) {
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new Error('configured promotion signing aborted'))
      } else {
        signal.addEventListener('abort', () => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error ? reason : new Error('configured promotion signing aborted'))
        }, { once: true })
      }
    }))
    try {
      const initialEventBytes = optionalBytes(eventFile)
      const initialGovernanceBytes = optionalBytes(governanceFile)
      const cancelController = new AbortController()
      const cancelled = blocked.service.verifyCandidate(
        { reviewId: (JSON.parse(reviewBefore.toString('utf8')) as WikiReviewItem[])[0]?.id ?? '', action: 'Archive' },
        cancelController.signal,
      )
      await blockedSealStarted
      expect(blockedSignal).toBeInstanceOf(AbortSignal)
      cancelController.abort(new Error('configured verifier call cancelled during event signing'))
      await expect(cancelled).rejects.toThrow('configured verifier call cancelled during event signing')
      expect(blockedSignal?.aborted).toBe(true)
      expect(readFileSync(reviewFile)).toEqual(reviewBefore)
      expect(readFileSync(candidateFile)).toEqual(candidateBefore)
      expect(optionalBytes(eventFile)).toEqual(initialEventBytes)
      expect(optionalBytes(governanceFile)).toEqual(initialGovernanceBytes)
      expect(existsSync(journalDirectory)).toBe(false)

      const seed = await matched.service.verifyCandidate(
        { reviewId: (JSON.parse(reviewBefore.toString('utf8')) as WikiReviewItem[])[0]?.id ?? '', action: 'Archive' },
        new AbortController().signal,
      )
      expect(seed.ok).toBe(true)
      expect(configuredOwnerSignal).toBeInstanceOf(AbortSignal)
      expect(configuredOwnerSignal?.aborted).toBe(false)
      if (!seed.receiptId) throw new Error('matched fixture failed to create its valid receipt')
      const receiptFile = join(root, '.llm-wiki', 'verification-receipts', `${seed.receiptId}.json`)
      const receiptBefore = readFileSync(receiptFile)

      restoreBytes(reviewFile, reviewBefore)
      restoreBytes(eventFile, initialEvent)
      restoreBytes(governanceFile, initialGovernance)
      expect(existsSync(journalDirectory)).toBe(false)

      await expect(rejected.service.verifyCandidate(
        { reviewId: (JSON.parse(reviewBefore.toString('utf8')) as WikiReviewItem[])[0]?.id ?? '', action: 'Archive' },
        new AbortController().signal,
      )).rejects.toThrow('promotion sealer returned an invalid authority signature')
      expect(mismatchedSealCalls).toBe(1)

      expect(readFileSync(reviewFile).equals(reviewBefore)).toBe(true)
      expect(readFileSync(candidateFile).equals(candidateBefore)).toBe(true)
      expect(optionalBytes(eventFile)).toEqual(initialEvent)
      expect(optionalBytes(governanceFile)).toEqual(initialGovernance)
      expect(readFileSync(receiptFile).equals(receiptBefore)).toBe(true)
      expect(existsSync(journalDirectory)).toBe(false)
    } finally {
      matched.service.snapshots.dispose()
      await matched.context.fiber.dispose()
      rejected.service.snapshots.dispose()
      await rejected.context.fiber.dispose()
      blocked.service.snapshots.dispose()
      await blocked.context.fiber.dispose()
    }
  })

  it('treats an empty semantic credential as disabled without resolving a credential', async () => {
    writeFileSync(join(wikiRoot, 'concepts', 'alpha.md'), '# Alpha\n\nalpha method\n', 'utf8')
    const isolatedContext = new Context()
    const resolveCredential = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(isolatedContext, 'credentials', {
      configurable: true,
      value: { resolve: resolveCredential },
    })
    const isolated = new KnowledgeWikiService(isolatedContext, wikiTestConfig({
      wikiRoot,
      mainRoot: root,
      credential: '',
      llmProvider: 'p',
      llmModel: 'm',
    })) as unknown as Surface
    try {
      expect((await isolated.search({ query: 'alpha' }))[0]?.path).toBe('concepts/alpha.md')
      expect(resolveCredential).not.toHaveBeenCalled()
    } finally {
      isolated.snapshots.dispose()
      await isolatedContext.fiber.dispose()
    }
  })

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
    })).toBe(0)
    expect(await service.recordKnowledgeOutcome({
      paths: ['concepts/alpha.md'], outcome: 'corrected',
    })).toBe(1)
    const staleProjection = JSON.parse(readFileSync(utilityFile, 'utf8')) as Record<string, Record<string, unknown>>
    staleProjection['concepts/alpha.md'] = {
      path: 'concepts/alpha.md', retrievalHits: 2, successfulUses: 1,
      userCorrections: 0, utilityScore: 1,
    }
    writeFileSync(utilityFile, JSON.stringify(staleProjection), 'utf8')
    expect(await service.recordKnowledgeOutcome({
      paths: ['concepts/alpha.md'], outcome: 'successful',
    })).toBe(0)
    expect((await service.search({ query: 'alpha' }))[0]?.path).toBe('concepts/alpha.md')
    expect(await service.recordKnowledgeOutcome({
      paths: ['concepts/alpha.md'], outcome: 'successful',
    })).toBe(0)
    writeFileSync(join(wikiRoot, 'concepts', 'unseen.md'), 'unseen', 'utf8')
    expect(await service.recordKnowledgeOutcome({
      paths: ['concepts/unseen.md'], outcome: 'neutral',
    })).toBe(1)
    expect(await service.recordKnowledgeOutcome({ paths: [], outcome: 'neutral' })).toBe(0)
    expect((await service.knowledgeUtility()).find(item => item.path === 'concepts/alpha.md'))
      .toMatchObject({ retrievalHits: 3, successfulUses: 0, userCorrections: 1, utilityScore: -1 })
  })

  it('keeps an absent Wiki empty but reports credential failures instead of hiding them', async () => {
    const missingWiki = join(root, 'missing-wiki')
    const isolatedContext = new Context()
    Object.defineProperty(isolatedContext, 'credentials', {
      configurable: true,
      value: { resolve: vi.fn().mockRejectedValue(new Error('credentials unavailable')) },
    })
    const isolated = new KnowledgeWikiService(isolatedContext, wikiTestConfig({
      wikiRoot: missingWiki,
      mainRoot: root,
      credential: 'VISION_API_KEY',
      llmProvider: 'p', llmModel: 'm',
    })) as unknown as Surface
    expect(await isolated.graph()).toEqual({ nodes: [], edges: [], communities: [] })
    expect(await isolated.list()).toEqual([])
    await expect(isolated.search({ query: 'none' })).rejects.toThrow('credentials unavailable')
    expect(await isolated.knowledgeUtility()).toEqual([])
    isolated.snapshots.dispose()
    await isolatedContext.fiber.dispose()
  })

  it('fails closed for model reads without a verifier or a governed record', async () => {
    writeFileSync(join(wikiRoot, 'concepts', 'alpha.md'), '# Alpha', 'utf8')
    await expect(service.modelPageContent({ path: 'concepts/alpha.md' }, {
      projectId: root,
      workspaceId: root,
      sessionId: 'session-a',
    })).rejects.toThrow('knowledge verifier authority is unavailable')
    await expect(service.modelSearch({ query: 'alpha' }, {
      projectId: root,
      workspaceId: root,
      sessionId: 'session-a',
    })).rejects.toThrow('knowledge verifier authority is unavailable')
  })

  it('refuses an unsigned observation that labels itself verified and canonical', async () => {
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    const path = 'concepts/self-certified.md'
    const content = '# Self-certified\n\nUnverified project-authored instruction.\n'
    writeFileSync(join(wikiRoot, path), content)
    const record = createKnowledgeRecord({
      id: 'claim:self-certified', content, source: path,
      scope: { projectId: root, visibility: 'project' },
      authority: authority.authorityId, trust: 'high', confidence: 1,
      evidenceRefs: ['self-written-receipt'], verificationStatus: 'verified',
      lifecycle: 'canonical', lastVerifiedAt: new Date().toISOString(),
    })
    const eventPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const observation = createKnowledgeEvent('knowledge/observed', record.id, record.scope, { record })
    // A project writer can compute ordinary hashes; no authority key is used.
    mkdirSync(dirname(eventPath), { recursive: true })
    writeFileSync(eventPath, `${JSON.stringify(observation)}\n`)
    const scope = { projectId: root, workspaceId: root, sessionId: 'self-certified-session' }
    await expect(service.modelPageContent({ path }, scope)).rejects.toThrow()
    await expect(service.modelList(scope)).rejects.toThrow()
    await expect(service.modelSearch({ query: 'self-certified' }, scope)).rejects.toThrow()
    expect(await service.pageContent({ path })).toEqual({ path, content: '' })
    expect(readFileSync(join(wikiRoot, path), 'utf8')).toBe(content)
    expect(readFileSync(eventPath, 'utf8')).toBe(`${JSON.stringify(observation)}\n`)
  })

  it('withholds canonical content changed after its authenticated promotion', async () => {
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    const path = 'concepts/content-binding.md'
    const original = '---\ntitle: Bound page\n---\n\nAuthenticated original rule.\n'
    writeFileSync(join(wikiRoot, path), original)
    appendVerifiedKnowledgeRecord(root, path, original, authority, 'content-binding')
    const scope = { projectId: root, workspaceId: root, sessionId: 'content-binding-session' }
    await expect(service.modelPageContent({ path }, scope)).resolves.toMatchObject({ content: original })
    const changed = '---\ntitle: Bound page\n---\n\nUnverified replacement rule.\n'
    writeFileSync(join(wikiRoot, path), changed)
    await expect(service.modelPageContent({ path }, scope)).rejects.toThrow()
    expect(await service.modelList(scope)).toEqual([])
    expect(await service.modelSearch({ query: 'Unverified replacement rule' }, scope)).toEqual([])
    expect((await service.modelGraph(scope)).nodes).toEqual([])
    expect(readFileSync(join(wikiRoot, path), 'utf8')).toBe(changed)
  })

  it.each([
    ['replacement', '# Concurrent unverified replacement\n', 'knowledge page content changed since verified promotion'],
    ['empty file', '', 'knowledge page not found'],
  ])('refuses %s between its promotion check and the final page read', async (_change, changed, error) => {
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    const path = 'concepts/content-read-race.md'
    const original = '# Authenticated content\n'
    writeFileSync(join(wikiRoot, path), original)
    appendVerifiedKnowledgeRecord(root, path, original, authority, 'content-read-race')
    const read = wikiGraph.readPage
    let reads = 0
    vi.spyOn(wikiGraph, 'readPage').mockImplementation((base, relativePath) => {
      const content = read(base, relativePath)
      if (base === wikiRoot && relativePath === path && ++reads === 1) {
        writeFileSync(join(wikiRoot, path), changed)
      }
      return content
    })
    await expect(service.modelPageContent({ path }, {
      projectId: root, workspaceId: root, sessionId: 'content-read-race-session',
    })).rejects.toThrow(error)
    expect(reads).toBe(2)
    expect(readFileSync(join(wikiRoot, path), 'utf8')).toBe(changed)
    expect(readKnowledgeEventLog(join(root, '.llm-wiki', 'knowledge-events.jsonl'), authority)
      .some(event => event.type === 'knowledge/retrieved')).toBe(false)
  })

  it('fails closed on search and page reads when a persisted verifier is unavailable', async () => {
    const path = 'concepts/authority-unavailable.md'
    const content = '# Authority unavailable\n\nA formerly verified rule.\n'
    const authority = verifierAuthority()
    writeFileSync(join(wikiRoot, path), content, 'utf8')
    appendVerifiedKnowledgeRecord(root, path, content, authority, 'authority-unavailable')

    expect(await service.pageContent({ path })).toEqual({ path, content: '' })
    expect(await service.search({ query: 'formerly verified rule' })).toEqual([])
  })

  it('limits model files, graph edges, and review candidates to verified knowledge', async () => {
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    const alphaPath = 'concepts/alpha.md'
    const betaPath = 'concepts/beta.md'
    const gammaPath = 'concepts/gamma.md'
    const alpha = '---\ntype: concept\ntitle: Alpha\n---\n\n# Alpha\n\n[[Beta]] [[Gamma]]\n'
    const beta = '---\ntype: concept\ntitle: Beta\n---\n\n# Beta\n'
    const gamma = '---\ntype: concept\ntitle: Gamma\n---\n\n# Gamma\n'
    writeFileSync(join(wikiRoot, alphaPath), alpha, 'utf8')
    writeFileSync(join(wikiRoot, betaPath), beta, 'utf8')
    writeFileSync(join(wikiRoot, gammaPath), gamma, 'utf8')
    appendVerifiedKnowledgeRecord(root, alphaPath, alpha, authority, 'alpha')
    appendVerifiedKnowledgeRecord(root, betaPath, beta, authority, 'beta')
    const scope: KnowledgeAccessContext = { projectId: root, workspaceId: root, sessionId: 'model-view-session' }

    const files = await service.modelList(scope)
    expect(files.map(entry => entry.path)).toEqual([alphaPath, betaPath])
    expect(files.every(entry => !entry.isDir && entry.provenance !== undefined)).toBe(true)

    const graph = await service.modelGraph(scope)
    expect(graph.nodes.map(node => node.path)).toEqual([alphaPath, betaPath])
    expect(graph.edges).toEqual([{ source: alphaPath, target: betaPath, weight: 1 }])
    expect(Object.keys(graph.provenance).sort()).toEqual([alphaPath, betaPath])

    const reviewFile = join(root, '.llm-wiki', 'review.json')
    mkdirSync(dirname(reviewFile), { recursive: true })
    const rows: WikiReviewItem[] = [
      { id: 'candidate-visible', title: 'Visible', type: 'proposal', reviewKind: 'candidate', candidatePath: alphaPath, resolved: false },
      { id: 'candidate-hidden', title: 'Hidden', type: 'proposal', reviewKind: 'candidate', candidatePath: gammaPath, resolved: false },
      { id: 'candidate-no-path', title: 'No path', type: 'proposal', reviewKind: 'candidate', resolved: false },
      { id: 'advisory', title: 'Advisory', type: 'suggestion', reviewKind: 'advisory', resolved: false },
      { id: 'resolved', title: 'Resolved', type: 'suggestion', reviewKind: 'advisory', resolved: true },
    ]
    writeFileSync(reviewFile, JSON.stringify(rows), 'utf8')
    const all = await service.modelReviews({ status: 'all' }, scope)
    expect(all.map(review => review.id)).toEqual(['candidate-visible', 'advisory', 'resolved'])
    expect((all[0] as WikiReviewItem & { provenance?: { knowledgeId: string } }).provenance?.knowledgeId)
      .toBe('candidate:alpha')
    expect(all[1]).not.toHaveProperty('provenance')
    expect((await service.modelReviews({ status: 'resolved' }, scope)).map(review => review.id)).toEqual(['resolved'])
    expect((await service.modelReviews({}, scope)).map(review => review.id)).toEqual(['candidate-visible', 'advisory'])
    expect((await service.modelReviews({ status: 'pending' }, scope)).map(review => review.id))
      .toEqual(['candidate-visible', 'advisory'])
    expect((await service.modelReviews({ status: 'all', limit: 1 }, scope)).map(review => review.id))
      .toEqual(['candidate-visible'])
    writeFileSync(reviewFile, 'null', 'utf8')
    await expect(service.modelReviews({}, scope)).rejects.toThrow('invalid knowledge review state')
  })

  it('reads and verifies a Candidate from one review store between the 5 and 8 MiB bounds', async () => {
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    mkdirSync(dirname(reviewFile), { recursive: true })
    const candidatePath = '_candidates/ingest/review-capacity.md'
    const candidateContent = '---\ntype: concept\nstatus: candidate\norigin: test\ntitle: Review capacity\n---\n\n# Review capacity\n'
    const candidateFile = join(wikiRoot, candidatePath)
    mkdirSync(dirname(candidateFile), { recursive: true })
    writeFileSync(candidateFile, candidateContent, 'utf8')
    wikiReviews.appendCandidateReviews(reviewFile, root, 'virtual:review-capacity-source', [`wiki/${candidatePath}`])

    const rows = JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[]
    const advisoryBase: WikiReviewItem = {
      id: 'large-advisory', title: 'Large advisory', type: 'suggestion', reviewKind: 'advisory',
      resolved: false, description: '',
    }
    const emptyDescription = `${JSON.stringify([...rows, advisoryBase], null, 2)}\n`
    const advisory: WikiReviewItem = {
      ...advisoryBase,
      description: 'x'.repeat(5 * 1024 * 1024 + 64 * 1024 - Buffer.byteLength(emptyDescription, 'utf8')),
    }
    rows.push(advisory)
    const reviewBytes = Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, 'utf8')
    expect(reviewBytes.byteLength).toBeGreaterThan(MAX_WIKI_PAGE_BYTES)
    expect(reviewBytes.byteLength).toBeLessThan(REVIEW_STORE_MAX_BYTES)
    expect(rows[0]).toMatchObject({
      reviewKind: 'candidate', candidatePath, candidateHash: knowledgeSha256(candidateContent), resolved: false,
    })
    writeFileSync(reviewFile, reviewBytes)

    const scope: KnowledgeAccessContext = { projectId: root, workspaceId: root, sessionId: 'large-review-reader' }
    await expect(service.modelReviews({ status: 'all' }, scope)).resolves.toContainEqual(
      expect.objectContaining({ id: 'large-advisory', description: advisory.description }),
    )
    await expect(service.reviews({ status: 'all' })).resolves.toContainEqual(
      expect.objectContaining({ id: 'large-advisory' }),
    )
    const verification = await service.verifyCandidate(
      { reviewId: rows[0]?.id ?? '', action: 'Archive' }, new AbortController().signal,
    )
    if (!verification.ok) throw new Error(`candidate verifier rejected row: ${JSON.stringify(rows[0])}`)
    expect(verification.errorCode).toBeUndefined()
    expect(verification.ok).toBe(true)
  })

  it('rejects repair review overflow before lifecycle effects and preserves the read capability', async () => {
    const fixture = repairFixture()
    const { path, content, request, scope } = fixture
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const sessionEvents: unknown[] = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: request.correctedRule }] } },
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'review-overflow-repair', name: 'wiki_propose_repair', arguments: JSON.stringify(request) } },
    ]
    ctx.provide('sessionQuery', {
      readSession: async () => ({ session: { cwd: root }, events: sessionEvents }),
    } as never)

    await expect(service.modelPageContent({ path }, scope)).resolves.toMatchObject({ path, content })
    const advisoryBase: WikiReviewItem = {
      id: 'near-limit-advisory', title: 'Near limit', type: 'suggestion', reviewKind: 'advisory',
      resolved: false, description: '',
    }
    const emptyDescription = `${JSON.stringify([advisoryBase], null, 2)}\n`
    const advisory: WikiReviewItem = {
      ...advisoryBase,
      description: 'x'.repeat(REVIEW_STORE_MAX_BYTES - 64 - Buffer.byteLength(emptyDescription, 'utf8')),
    }
    const reviewBefore = Buffer.from(`${JSON.stringify([advisory], null, 2)}\n`, 'utf8')
    expect(reviewBefore.byteLength).toBeLessThanOrEqual(REVIEW_STORE_MAX_BYTES)
    writeFileSync(reviewFile, reviewBefore)

    const eventBefore = readFileSync(eventFile)
    const utilityBefore = readFileSync(utilityFile)
    await expect(service.proposeKnowledgeRepair(request, scope))
      .rejects.toThrow(`review store exceeds ${REVIEW_STORE_MAX_BYTES} bytes`)
    expect(readFileSync(reviewFile).equals(reviewBefore)).toBe(true)
    expect(readFileSync(eventFile).equals(eventBefore)).toBe(true)
    expect(readFileSync(utilityFile).equals(utilityBefore)).toBe(true)
    expect(existsSync(join(wikiRoot, '_candidates', 'ingest', path))).toBe(false)

    writeFileSync(reviewFile, '[]\n', 'utf8')
    const retry = await service.proposeKnowledgeRepair(request, scope)
    expect(retry).toMatchObject({ ok: true, candidatePath: `_candidates/ingest/${path}` })
  })

  it('keeps verifier-passed candidate content out of ordinary model reads until canonical promotion', async () => {
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    const path = 'concepts/unpromoted-candidate.md'
    const content = '# Candidate only\n\nA verifier-signed rule that has not passed review or trial.\n'
    writeFileSync(join(wikiRoot, path), content, 'utf8')
    appendVerifiedKnowledgeRecord(root, path, content, authority, 'unpromoted-candidate', false)
    const scope: KnowledgeAccessContext = { projectId: root, workspaceId: root, sessionId: 'ordinary-session' }

    await expect(service.modelSearch({ query: 'verifier-signed rule review trial' }, scope)).resolves.toEqual([])
    await expect(service.modelPageContent({ path }, scope))
      .rejects.toThrow('knowledge page is not verified for this scope')
    expect((await service.modelList(scope)).some(entry => entry.path === path)).toBe(false)
    expect((await service.modelGraph(scope)).nodes.some(node => node.path === path)).toBe(false)

    const reviewFile = join(root, '.llm-wiki', 'review.json')
    mkdirSync(dirname(reviewFile), { recursive: true })
    writeFileSync(reviewFile, JSON.stringify([{
      id: 'review-unpromoted-candidate',
      title: 'Pending candidate review',
      type: 'proposal',
      reviewKind: 'candidate',
      candidatePath: path,
      resolved: false,
    }]), 'utf8')
    await expect(service.modelReviews({}, scope)).resolves.toMatchObject([{
      id: 'review-unpromoted-candidate',
      title: 'Pending candidate review',
    }])

    const events = readKnowledgeEventLog(join(root, '.llm-wiki', 'knowledge-events.jsonl'), authority)
    expect(events.some(event => event.type === 'knowledge/retrieved' || event.type === 'knowledge/injected')).toBe(false)
  })

  it('defaults optional Rust candidate paths and deadlines safely', async () => {
    const candidateContext = new Context()
    const resolved = wikiTestConfig({
      wikiRoot,
      mainRoot: root,
      credential: '',
      llmProvider: 'p',
      llmModel: 'm',
      knowledgeSearchCandidateMode: 'shadow',
    })
    const candidate = new KnowledgeWikiService(candidateContext, {
      ...resolved,
      knowledgeSearchCandidateBinary: undefined,
      knowledgeSearchCandidateTimeoutMs: undefined,
    } as unknown as ConstructorParameters<typeof KnowledgeWikiService>[1]) as unknown as {
      knowledgeSearchCandidateBinary: string
      knowledgeSearchCandidateTimeoutMs: number
      snapshots: { dispose(): void }
    }
    try {
      expect(candidate.knowledgeSearchCandidateBinary).toBe('')
      expect(candidate.knowledgeSearchCandidateTimeoutMs).toBe(30_000)
    } finally {
      candidate.snapshots.dispose()
      await candidateContext.fiber.dispose()
    }
  })

  it('rejects an emptied file whose promotion bound different content', async () => {
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    const path = 'concepts/empty-after-verification.md'
    const verifiedBytes = '# Alpha\n\nVerified before the underlying file was emptied.\n'
    writeFileSync(join(wikiRoot, path), verifiedBytes, 'utf8')
    appendVerifiedKnowledgeRecord(root, path, verifiedBytes, authority, 'empty-after-verification')
    writeFileSync(join(wikiRoot, path), '', 'utf8')

    await expect(service.modelPageContent({ path }, {
      projectId: root, workspaceId: root, sessionId: 'empty-page-session',
    })).rejects.toThrow('knowledge page is not verified for this scope')
  })

  it('rejects unregistered or mismatched model scopes and resolves registered workspace roots', async () => {
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    await expect(service.modelList({ sessionId: 's' })).rejects.toThrow('knowledge scope is unavailable')
    await expect(service.modelGraph({ projectId: ' ', sessionId: 's' })).rejects.toThrow('knowledge scope is unavailable')
    await expect(service.modelReviews({}, { projectId: root, workspaceId: join(root, 'other'), sessionId: 's' }))
      .rejects.toThrow('knowledge scope is unavailable')
    await expect(service.modelSearch({ query: 'alpha' }, { projectId: root, workspaceId: root }))
      .rejects.toThrow('knowledge scope is unavailable')

    const workspace = join(root, 'registered-workspace')
    const workspaceWiki = join(workspace, 'wiki')
    mkdirSync(join(workspaceWiki, 'concepts'), { recursive: true })
    const content = '# Workspace Alpha\n\nverified workspace knowledge\n'
    writeFileSync(join(workspaceWiki, 'concepts', 'alpha.md'), content, 'utf8')
    appendVerifiedKnowledgeRecord(workspace, 'concepts/alpha.md', content, authority, 'workspace-alpha')
    const registry = join(root, '.llm-wiki', 'workspaces.json')
    mkdirSync(dirname(registry), { recursive: true })
    writeFileSync(registry, JSON.stringify({ workspaces: [{ path: workspace, name: 'Workspace' }] }), 'utf8')
    await expect(service.modelList({ projectId: workspace, workspaceId: workspace, sessionId: 'workspace-session' }))
      .resolves.toMatchObject([{ path: 'concepts/alpha.md' }])

    writeFileSync(registry, JSON.stringify({ workspaces: [] }), 'utf8')
    await expect(service.modelList({ projectId: workspace, workspaceId: workspace, sessionId: 'workspace-session' }))
      .rejects.toThrow('knowledge scope is unavailable')
    writeFileSync(registry, '{', 'utf8')
    await expect(service.modelList({ projectId: workspace, workspaceId: workspace, sessionId: 'workspace-session' }))
      .rejects.toThrow('knowledge scope is unavailable')
  })

  it('uses durable retrieval before feedback and fails closed on rejected or corrupt records', async () => {
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    const path = 'concepts/alpha.md'
    const content = '# Alpha\n\nA verified method for alpha tasks.\n'
    writeFileSync(join(wikiRoot, path), content, 'utf8')
    appendVerifiedKnowledgeRecord(root, path, content, authority, 'alpha-feedback')
    const scope: KnowledgeAccessContext = { projectId: root, workspaceId: root, sessionId: 'feedback-session' }
    expect((await service.search({ query: 'alpha' })).map(hit => hit.path)).toContain(path)
    await expect(service.modelPageContent({ path }, scope)).resolves.toMatchObject({ path, content })
    expect(await service.pageContent({ path })).toEqual({ path, content })

    writeFileSync(join(wikiRoot, 'concepts', 'unretrieved.md'), '# Unretrieved', 'utf8')
    expect(await service.recordKnowledgeOutcome({ paths: ['concepts/unretrieved.md'], outcome: 'successful' })).toBe(0)
    expect(await service.recordKnowledgeOutcome({ paths: ['concepts/unretrieved.md'], outcome: 'neutral' })).toBe(1)
    expect(await service.recordKnowledgeOutcome({ paths: [path], outcome: 'corrected' })).toBe(1)
    const eventPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    expect(replayKnowledgeEvents(readKnowledgeEventLog(eventPath, authority)).records.get('candidate:alpha-feedback'))
      .toMatchObject({ verificationStatus: 'rejected' })
    await expect(service.modelPageContent({ path }, scope)).rejects.toThrow('knowledge page is not verified for this scope')
    expect(await service.pageContent({ path })).toEqual({ path, content: '' })
    service.snapshots.invalidate(wikiRoot)
    expect(await service.search({ query: 'alpha' })).toEqual([])

    writeFileSync(eventPath, '{not-json}\n', 'utf8')
    expect(await service.pageContent({ path })).toEqual({ path, content: '' })
    service.snapshots.invalidate(wikiRoot)
    expect(await service.search({ query: 'alpha' })).toEqual([])
    await expect(service.modelPageContent({ path }, { projectId: '', sessionId: 'feedback-session' }))
      .rejects.toThrow('knowledge scope is unavailable')
  })

  it('retains canonical knowledge with authenticated positive utility across repeated reads', async () => {
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    const path = 'concepts/paired-utility.md'
    const content = '# Paired utility\n\nA verified page supported by a positive paired utility trial.\n'
    writeFileSync(join(wikiRoot, path), content, 'utf8')
    appendVerifiedKnowledgeRecord(root, path, content, authority, 'paired-utility')
    const scope: KnowledgeAccessContext = { projectId: root, workspaceId: root, sessionId: 'paired-utility-session' }

    for (let index = 0; index < 3; index += 1) {
      await expect(service.modelPageContent({ path }, scope)).resolves.toMatchObject({ path, content })
    }
    const eventPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const state = replayKnowledgeEvents(readKnowledgeEventLog(eventPath, authority))
    expect(state.records.get('candidate:paired-utility')).toMatchObject({
      verificationStatus: 'verified', lifecycle: 'canonical', retrievalHits: 4,
      successfulUses: 1, utilityScore: 2,
    })
    expect(readKnowledgeEventLog(eventPath, authority).some(event => event.type === 'knowledge/expired')).toBe(false)
    await expect(service.modelPageContent({ path }, scope)).resolves.toMatchObject({ path, content })
  })

  it('persists deadline expiry before exposing a previously cached model search result', async () => {
    const item = repairFixture()
    await expect(service.modelSearch({ query: 'repair boundary' }, item.scope))
      .resolves.toMatchObject([{ path: item.path }])
    const journalPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const before = readFileSync(journalPath, 'utf8')
    const deadline = Date.now() + 60_001
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(deadline)
      await expect(service.modelSearch({ query: 'repair boundary' }, item.scope)).resolves.toEqual([])
      await expect(service.modelPageContent({ path: item.path }, item.scope))
        .rejects.toThrow('knowledge page is not verified for this scope')
      const expired = readFileSync(journalPath, 'utf8')
      expect(expired.startsWith(before)).toBe(true)
      const events = readKnowledgeEventLog(journalPath, item.authority)
      expect(events.filter(event => event.type === 'knowledge/expired')).toMatchObject([{
        knowledgeId: 'candidate:repair-boundary', payload: { reason: 'deadline' },
      }])
      expect(replayKnowledgeEvents(events).records.get('candidate:repair-boundary'))
        .toMatchObject({ verificationStatus: 'expired' })
      await expect(service.modelSearch({ query: 'repair boundary' }, item.scope)).resolves.toEqual([])
      expect(readFileSync(journalPath, 'utf8')).toBe(expired)
      expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps enforce mode closed and shadow mode advisory when the Rust binary is unavailable', async () => {
    const candidateRoot = join(root, 'rust-search-mode')
    const candidateWiki = join(candidateRoot, 'wiki')
    mkdirSync(join(candidateWiki, 'concepts'), { recursive: true })
    writeFileSync(join(candidateWiki, 'concepts', 'alpha.md'), '# Alpha\n\nsearchable alpha\n', 'utf8')
    const authority = verifierAuthority()
    const makeService = (mode: string, timeoutMs: number) => {
      const candidateContext = new Context()
      Object.defineProperty(candidateContext, 'credentials', {
        configurable: true,
        value: { resolve: vi.fn().mockResolvedValue(undefined) },
      })
      Object.defineProperty(candidateContext, 'llm', { configurable: true, value: { stream: vi.fn() } })
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
      Object.defineProperty(candidateContext, 'logger', { configurable: true, value: logger })
      candidateContext.provide('knowledgeWikiVerifierAuthority', authority)
      const resolvedConfig = wikiTestConfig({
        wikiRoot: candidateWiki,
        mainRoot: candidateRoot,
        credential: '',
        llmProvider: 'p',
        llmModel: 'm',
        knowledgeSearchCandidateMode: mode,
        knowledgeSearchCandidateBinary: join(candidateRoot, 'missing-rust-binary'),
        knowledgeSearchCandidateTimeoutMs: 5000,
      })
      const candidate = new KnowledgeWikiService(candidateContext, {
        ...resolvedConfig,
        knowledgeSearchCandidateTimeoutMs: timeoutMs,
      }) as unknown as Surface
      return { candidate, candidateContext, logger }
    }

    const enforced = makeService('enforce', 5000)
    try {
      await expect(enforced.candidate.modelSearch({ query: 'alpha' }, {
        projectId: candidateRoot, workspaceId: candidateRoot, sessionId: 'enforce-session',
      })).rejects.toThrow('Rust knowledge-search enforce mode is unavailable')
    } finally {
      enforced.candidate.snapshots.dispose()
      await enforced.candidateContext.fiber.dispose()
    }

    const shadow = makeService('shadow', -1)
    try {
      await expect(shadow.candidate.modelSearch({ query: 'alpha' }, {
        projectId: candidateRoot, workspaceId: candidateRoot, sessionId: 'shadow-session',
      })).resolves.toEqual([])
      expect(shadow.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Rust search candidate shadow'))

      const throwingSignal = Object.defineProperty({}, 'aborted', {
        get() { throw 'non-error cancellation failure' },
      }) as AbortSignal
      await expect(shadow.candidate.modelSearch({ query: 'alpha' }, {
        projectId: candidateRoot, workspaceId: candidateRoot, sessionId: 'shadow-session-raw-error',
      }, throwingSignal)).resolves.toEqual([])
      expect(shadow.logger.warn).toHaveBeenCalledWith(expect.stringContaining('non-error cancellation failure'))

      const throwingErrorSignal = Object.defineProperty({}, 'aborted', {
        get() { throw new Error('typed cancellation failure') },
      }) as AbortSignal
      await expect(shadow.candidate.modelSearch({ query: 'alpha' }, {
        projectId: candidateRoot, workspaceId: candidateRoot, sessionId: 'shadow-session-typed-error',
      }, throwingErrorSignal)).resolves.toEqual([])
      expect(shadow.logger.warn).toHaveBeenCalledWith(expect.stringContaining('typed cancellation failure'))
    } finally {
      shadow.candidate.snapshots.dispose()
      await shadow.candidateContext.fiber.dispose()
    }
  })

  it('fails closed and normalizes both Error and non-Error replay failures', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    Object.defineProperty(ctx, 'logger', { configurable: true, value: logger })
    const path = 'concepts/replay-failure.md'
    writeFileSync(join(wikiRoot, path), '# Replay failure\n', 'utf8')
    const replay = vi.spyOn(knowledgeGovernance, 'replayKnowledgeEvents')
    replay.mockImplementationOnce(() => { throw new Error('page replay failed') })
    expect(await service.pageContent({ path })).toEqual({ path, content: '' })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('page replay failed'))

    replay.mockImplementationOnce(() => { throw 'search replay failed' })
    expect(await service.search({ query: 'replay' })).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('search replay failed'))
  })

  it('updates the durable knowledge record counters for model retrieval and user outcomes', async () => {
    const path = 'concepts/alpha.md'
    const content = '# Alpha\n\nA verified reusable method.\n'
    writeFileSync(join(wikiRoot, path), content, 'utf8')
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    const now = new Date().toISOString()
    const record = createKnowledgeRecord({
      id: 'candidate:alpha',
      content,
      source: path,
      sourceHash: knowledgeSha256('raw/sources/alpha.md'),
      scope: { projectId: root, visibility: 'project' },
      evidenceRefs: ['raw/sources/alpha.md'],
      verificationStatus: 'candidate',
      trust: 'low',
      authority: 'untrusted-observation',
      confidence: 0,
      createdAt: now,
      lastVerifiedAt: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      lifecycle: 'candidate',
    })
    const eventPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const observed = createKnowledgeEvent('knowledge/observed', record.id, record.scope, { record }, { seq: 0 })
    appendKnowledgeEvent(eventPath, observed)
    const candidate = createKnowledgeEvent('knowledge/candidate', record.id, record.scope, { record }, {
      seq: 1,
      previousEventHash: observed.eventHash,
    })
    appendKnowledgeEvent(eventPath, candidate)
    const verificationPayload = {
      record,
      trust: 'medium',
      authority: authority.authorityId,
      confidence: 0.9,
      lastVerifiedAt: now,
      evidenceRefs: ['receipt:alpha'],
      candidatePath: record.source,
      candidateHash: knowledgeSha256(content),
      source: record.source,
    }
    const authoritySeal = authority.sealPromotion({
      schemaVersion: 1,
      domain: 'ark.knowledge-wiki',
      authorityId: authority.authorityId,
      operation: 'seal-knowledge-event',
      eventType: 'knowledge/verified',
      knowledgeId: record.id,
      payload: verificationPayload,
    })
    const verified = createKnowledgeEvent('knowledge/verified', record.id, record.scope, {
      ...verificationPayload,
      authorityId: authority.authorityId,
      authoritySeal,
    }, {
      seq: 2,
      previousEventHash: candidate.eventHash,
    })
    appendKnowledgeEvent(eventPath, verified)
    const promotionPayload = {
      action: 'Promote', lifecycle: 'canonical', appliedPath: path,
      candidateHash: knowledgeSha256(content),
      ...testMeasuredTrialPayload('alpha', content, now),
    }
    const promoted = createKnowledgeEvent('knowledge/promoted', record.id, record.scope, {
      ...promotionPayload,
      authorityId: authority.authorityId,
      authoritySeal: authority.sealPromotion({
        schemaVersion: 1,
        domain: 'ark.knowledge-wiki',
        authorityId: authority.authorityId,
        operation: 'seal-knowledge-event',
        eventType: 'knowledge/promoted',
        knowledgeId: record.id,
        payload: promotionPayload,
      }),
    }, { seq: 3, previousEventHash: verified.eventHash })
    appendKnowledgeEvent(eventPath, promoted)

    const scope = { projectId: root, workspaceId: root, sessionId: 'session-alpha' }
    const modelSearchResults = await service.modelSearch({ query: 'alpha' }, scope)
    expect(modelSearchResults).toHaveLength(1)
    expect(modelSearchResults[0]?.path).toBe(path)
    expect(typeof modelSearchResults[0]?.score).toBe('number')
    await expect(service.modelPageContent({ path }, scope)).resolves.toMatchObject({ path, content })
    expect(await service.recordKnowledgeOutcome({ paths: [path], outcome: 'successful' })).toBe(0)

    const final = replayKnowledgeEvents(readKnowledgeEventLog(eventPath, authority)).records.get(record.id)
    expect(final).toMatchObject({
      verificationStatus: 'verified',
      retrievalHits: 3,
      successfulUses: 1,
      userCorrections: 0,
      utilityScore: 2,
    })
  })

  it.each([
    ['null request', null],
    ['array request', []],
    ['missing fields', { correctedRule: undefined }],
    ['non-string path', { sourcePath: 7 }],
    ['invalid hash', { expectedSourceContentHash: 'invalid' }],
    ['empty title', { title: ' ' }],
    ['long title', { title: 'x'.repeat(161) }],
    ['control title', { title: 'unsafe\nrule' }],
    ['empty rule', { correctedRule: ' ' }],
    ['oversized UTF-8 rule', { correctedRule: '界'.repeat(5500) }],
    ['NUL rule', { correctedRule: 'unsafe\0rule' }],
  ])('rejects %s before publishing a correction', async (_name, override) => {
    const item = repairFixture()
    const request = override === null || Array.isArray(override) ? override : { ...item.request, ...override }
    await expect(service.proposeKnowledgeRepair(request as never, item.scope))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid-proposal' })
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
  })

  it.each([
    ['null scope', null],
    ['array scope', []],
    ['non-string project', { projectId: 7 }],
    ['non-string workspace', { workspaceId: 7 }],
    ['non-string session', { sessionId: 7 }],
    ['empty session', { sessionId: '' }],
  ])('rejects %s at the correction RPC boundary', async (_name, override) => {
    const item = repairFixture()
    const scope = override === null || Array.isArray(override) ? override : { ...item.scope, ...override }
    await expect(service.proposeKnowledgeRepair(item.request, scope as never))
      .resolves.toMatchObject({ ok: false, errorCode: override === null || Array.isArray(override) ? 'invalid-proposal' : 'scope-unavailable' })
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
  })

  it.each([
    ['malformed surface', () => null],
    ['missing session', () => ({ events: [] })],
    ['non-string cwd', () => ({ session: { cwd: 7 }, events: [] })],
    ['reader failure', () => { throw new Error('session store unavailable') }],
  ])('refuses a correction with %s', async (_name, readSession) => {
    const item = repairFixture()
    ctx.provide('sessionQuery', { readSession } as never)
    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .resolves.toMatchObject({ ok: false, errorCode: 'session-log-unavailable' })
  })

  it.each([
    ['missing call', []],
    ['non-string arguments', { turn: 1, arguments: {} }],
    ['invalid JSON arguments', { turn: 1, arguments: '{' }],
    ['array arguments', { turn: 1, arguments: '[]' }],
    ['missing call turn', { arguments: '{}' }],
    ['different turn', { turn: 2, arguments: '{}' }],
  ])('refuses human correction evidence with %s', async (_name, call) => {
    const item = repairFixture()
    const events = Array.isArray(call)
      ? [null, { type: 'tool/call' }, { type: 'tool/call', data: { name: 'unrelated' } }]
      : [...item.events.slice(0, 2), { type: 'tool/call', data: { name: 'wiki_propose_repair', ...call } }]
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events }) } as never)
    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .resolves.toMatchObject({ ok: false, errorCode: 'user-correction-unconfirmed' })
  })

  it('does not reuse a human correction from an earlier turn or an earlier user message', async () => {
    const item = repairFixture()
    let events = [item.events[1], item.events[2]]
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events }) } as never)
    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .resolves.toMatchObject({ errorCode: 'user-correction-unconfirmed' })
    events = [...item.events.slice(0, 2), {
      type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image' }, { type: 'text', text: 'A different instruction.' }] },
    }, item.events[2]]
    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .resolves.toMatchObject({ errorCode: 'user-correction-unconfirmed' })
  })

  it.each(['not-an-array', undefined])('does not borrow an earlier rule through a malformed latest human message %s', async (content) => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    let events = [...item.events.slice(0, 2), {
      type: 'user/message', data: { source: { kind: 'user' }, content },
    }, item.events[2]]
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events }) } as never)
    const journalPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const before = readFileSync(journalPath, 'utf8')

    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .resolves.toMatchObject({ ok: false, errorCode: 'user-correction-unconfirmed' })
    expect(readFileSync(journalPath, 'utf8')).toBe(before)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    events = item.events
    await expect(service.proposeKnowledgeRepair(item.request, item.scope)).resolves.toMatchObject({ ok: true })
  })

  it.each([2, 1])('does not authorize a repair from a completed call before the latest turn %s', async (latestTurn) => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    const events = [...item.events,
      { type: 'turn/end', data: { turn: 1 } },
      { type: 'turn/start', data: { turn: latestTurn } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the current result; do not change the rule.' }] } },
    ]
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events }) } as never)
    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .resolves.toMatchObject({ ok: false, errorCode: 'user-correction-unconfirmed' })
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    await expect(service.modelPageContent({ path: item.path }, item.scope))
      .resolves.toMatchObject({ content: item.content })
  })

  it('does not borrow a completed call through a malformed later turn header', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    const events = [...item.events, { type: 'turn/start', data: null }]
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events }) } as never)
    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .resolves.toMatchObject({ ok: false, errorCode: 'user-correction-unconfirmed' })
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
  })

  it('requires another full read after an independently verified source replacement', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    const replacement = item.content.replace('Original verified rule.', 'A newly verified replacement rule.')
    writeFileSync(join(wikiRoot, item.path), replacement)
    appendVerifiedKnowledgeRecord(root, item.path, replacement, item.authority, 'replacement-repair-boundary')
    const request = { ...item.request, expectedSourceContentHash: knowledgeSha256(replacement) }
    const events = [...item.events.slice(0, 2), {
      type: 'tool/call', data: { turn: 1, name: 'wiki_propose_repair', arguments: JSON.stringify(request) },
    }]
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events }) } as never)
    await expect(service.proposeKnowledgeRepair(request, item.scope))
      .resolves.toMatchObject({ ok: false, errorCode: 'source-not-read' })
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(replacement)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    await service.modelPageContent({ path: item.path }, item.scope)
    await expect(service.proposeKnowledgeRepair(request, item.scope)).resolves.toMatchObject({ ok: true })
  })

  it.each(['session scope', 'proposal text'] as const)('binds a repair to its submitted %s while authorization is pending', async (change) => {
    const item = repairFixture()
    const submittedScope = { ...item.scope }
    const submittedRequest = { ...item.request }
    const otherSessionId = 'different-session-with-no-human-correction'
    await service.modelPageContent({ path: item.path }, submittedScope)
    await service.modelPageContent({ path: item.path }, { ...item.scope, sessionId: otherSessionId })
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const readSession = vi.fn(async (sessionId: string) => {
      expect(sessionId).toBe(item.scope.sessionId)
      started.resolve(undefined)
      await release.promise
      return { session: { cwd: root }, events: item.events }
    })
    ctx.provide('sessionQuery', { readSession } as never)

    const pending = service.proposeKnowledgeRepair(submittedRequest, submittedScope)
    await started.promise
    if (change === 'session scope') submittedScope.sessionId = otherSessionId
    else {
      submittedRequest.title = 'A later caller-owned title'
      submittedRequest.correctedRule = 'A later rule absent from the authorizing human message.'
    }
    release.resolve(undefined)

    const result = await pending
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected the original authorized proposal to be staged')
    expect(readSession).toHaveBeenCalledTimes(1)
    const correction = readKnowledgeEventLog(join(root, '.llm-wiki', 'knowledge-events.jsonl'), item.authority)
      .filter(event => event.type === 'knowledge/rejected' && event.payload.reason === 'user-correction')
    expect(correction).toHaveLength(1)
    expect(correction[0]?.payload.sessionId).toBe(item.scope.sessionId)
    const candidate = readFileSync(join(wikiRoot, result.candidatePath), 'utf8')
    expect(candidate).toContain(item.request.correctedRule)
    expect(candidate).not.toContain('A later caller-owned title')
    expect(candidate).not.toContain('A later rule absent')
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    await expect(service.modelPageContent({ path: result.candidatePath }, item.scope)).rejects.toThrow()
  })

  it('refuses an altered source even after a reread or a changed repair hash', async () => {
    const item = repairFixture()
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    await service.modelPageContent({ path: item.path }, item.scope)
    writeFileSync(join(wikiRoot, item.path), `${item.content}\nChanged after full read.\n`)
    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .resolves.toMatchObject({ errorCode: 'source-not-verified' })
    const changedRequest = { ...item.request, expectedSourceContentHash: knowledgeSha256(readFileSync(join(wikiRoot, item.path))) }
    item.events[2] = { type: 'tool/call', data: { turn: 1, name: 'wiki_propose_repair', arguments: JSON.stringify(changedRequest) } }
    await expect(service.proposeKnowledgeRepair(changedRequest, item.scope))
      .resolves.toMatchObject({ errorCode: 'source-not-verified' })
    await expect(service.modelPageContent({ path: item.path }, item.scope)).rejects.toThrow('knowledge page is not verified for this scope')
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
  })

  it.each([
    ['file replacement', 'source-not-verified'],
    ['feedback revocation', 'source-not-verified'],
    ['signed replacement', 'source-changed'],
    ['same-record revalidation', 'source-changed'],
    ['file deletion', 'unsupported-source'],
  ] as const)('refuses %s while the session authorization read is pending', async (change, errorCode) => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    const journalPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    let journalAtAuthorization = ''
    ctx.provide('sessionQuery', {
      readSession: async () => {
        if (change === 'feedback revocation') {
          expect(await service.recordKnowledgeOutcome({ paths: [item.path], outcome: 'corrected' })).toBe(1)
        } else if (change === 'file deletion') {
          unlinkSync(join(wikiRoot, item.path))
        } else {
          const replacement = `${item.content}\nReplacement during the authorization read.\n`
          writeFileSync(join(wikiRoot, item.path), replacement)
          if (change === 'signed replacement') {
            appendVerifiedKnowledgeRecord(root, item.path, replacement, item.authority, 'pending-authorization-replacement')
          } else if (change === 'same-record revalidation') {
            appendVerifiedKnowledgeRecord(root, item.path, replacement, item.authority, 'repair-boundary')
          }
        }
        journalAtAuthorization = readFileSync(journalPath, 'utf8')
        return { session: { cwd: root }, events: item.events }
      },
    } as never)
    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .resolves.toMatchObject({ ok: false, errorCode })
    expect(readFileSync(journalPath, 'utf8')).toBe(journalAtAuthorization)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
  })

  it('refuses a workspace removed while the session authorization read is pending', async () => {
    const item = repairFixture()
    const workspace = join(root, 'pending-repair-workspace')
    const workspaceWiki = join(workspace, 'wiki')
    mkdirSync(join(workspaceWiki, 'concepts'), { recursive: true })
    writeFileSync(join(workspaceWiki, item.path), item.content)
    appendVerifiedKnowledgeRecord(workspace, item.path, item.content, item.authority, 'pending-workspace-repair')
    const registry = join(root, '.llm-wiki', 'workspaces.json')
    writeFileSync(registry, JSON.stringify({ workspaces: [{ path: workspace, name: 'Pending repair' }] }))
    const scope = { ...item.scope, projectId: workspace, workspaceId: workspace }
    await service.modelPageContent({ path: item.path }, scope)
    const journalPath = join(workspace, '.llm-wiki', 'knowledge-events.jsonl')
    const journalBefore = readFileSync(journalPath, 'utf8')
    ctx.provide('sessionQuery', {
      readSession: async () => {
        writeFileSync(registry, JSON.stringify({ workspaces: [] }))
        return { session: { cwd: workspace }, events: item.events }
      },
    } as never)
    await expect(service.proposeKnowledgeRepair(item.request, scope))
      .resolves.toEqual({ ok: false, errorCode: 'scope-unavailable' })
    expect(readFileSync(journalPath, 'utf8')).toBe(journalBefore)
    expect(readFileSync(join(workspaceWiki, item.path), 'utf8')).toBe(item.content)
    expect(existsSync(join(workspaceWiki, '_candidates/ingest', item.path))).toBe(false)
  })

  it('expires a full-read capability while keeping its unchanged source verified', async () => {
    const item = repairFixture()
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    await service.modelPageContent({ path: item.path }, item.scope)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60_000)
    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .resolves.toMatchObject({ errorCode: 'source-not-read' })
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
  })

  it('expires a consumed read capability at the post-preflight boundary while the source remains valid', async () => {
    const item = repairFixture()
    appendVerifiedKnowledgeRecord(root, item.path, item.content, item.authority, 'repair-long-cap-window', true, 20 * 60_000)
    await service.modelPageContent({ path: item.path }, item.scope)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const utilityBefore = readFileSync(utilityFile)
    const eventBefore = readFileSync(eventFile)
    const priorEvents = readKnowledgeEventLog(eventFile, item.authority)
    const baseline = Date.now()
    const serialize = service.serializeUtility.bind(service)
    let utilityPreflighted = false
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(baseline)
    vi.spyOn(service, 'serializeUtility').mockImplementation((records) => {
      const bytes = serialize(records)
      utilityPreflighted = true
      vi.setSystemTime(baseline + 16 * 60_000)
      return bytes
    })
    try {
      await expect(service.proposeKnowledgeRepair(item.request, item.scope)).resolves.toEqual({
        ok: false, errorCode: 'source-not-read',
      })
      expect(utilityPreflighted).toBe(true)
      expect(readFileSync(utilityFile).equals(utilityBefore)).toBe(true)
      const eventAfter = readFileSync(eventFile)
      expect(eventAfter.subarray(0, eventBefore.length).equals(eventBefore)).toBe(true)
      expect(readKnowledgeEventLog(eventFile, item.authority).slice(priorEvents.length).map(event => ({
        type: event.type,
        knowledgeId: event.knowledgeId,
      }))).toEqual([{ type: 'knowledge/expired', knowledgeId: 'candidate:repair-boundary' }])
      expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
      expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(false)
      expect(existsSync(join(root, '.llm-wiki', 'governance.jsonl'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('purges old read capabilities when another session performs a fresh full read', async () => {
    const item = repairFixture()
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    await service.modelPageContent({ path: item.path }, item.scope)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000)
    const freshScope = { ...item.scope, sessionId: 'fresh-repair-read' }
    await service.modelPageContent({ path: item.path }, freshScope)
    const journalPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const before = readFileSync(journalPath, 'utf8')

    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .resolves.toMatchObject({ ok: false, errorCode: 'source-not-read' })
    expect(readFileSync(journalPath, 'utf8')).toBe(before)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    await expect(service.proposeKnowledgeRepair(item.request, freshScope)).resolves.toMatchObject({ ok: true })
  })

  it('evicts the oldest read permission at capacity and retains a refreshed session permission', async () => {
    const item = repairFixture()
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    await service.modelPageContent({ path: item.path }, item.scope)
    for (let index = 1; index < 256; index += 1) {
      await service.modelPageContent({ path: item.path }, { ...item.scope, sessionId: `repair-read-${index}` })
    }
    await service.modelPageContent({ path: item.path }, item.scope)
    await service.modelPageContent({ path: item.path }, { ...item.scope, sessionId: 'repair-read-overflow' })
    const journalPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const before = readFileSync(journalPath, 'utf8')

    await expect(service.proposeKnowledgeRepair(item.request, { ...item.scope, sessionId: 'repair-read-1' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'source-not-read' })
    expect(readFileSync(journalPath, 'utf8')).toBe(before)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    await expect(service.proposeKnowledgeRepair(item.request, item.scope)).resolves.toMatchObject({ ok: true })
  }, 30_000)

  it.each(['original', 'replacement'] as const)('refuses a repair read race even with the %s content hash', async (hashOf) => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    const changed = `${item.content}\nConcurrent unverified replacement.\n`
    const request = {
      ...item.request,
      expectedSourceContentHash: knowledgeSha256(hashOf === 'original' ? item.content : changed),
    }
    const events = [...item.events.slice(0, 2), {
      type: 'tool/call', data: { turn: 1, name: 'wiki_propose_repair', arguments: JSON.stringify(request) },
    }]
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events }) } as never)
    const read = wikiGraph.readPage
    let reads = 0
    vi.spyOn(wikiGraph, 'readPage').mockImplementation((base, relativePath) => {
      const content = read(base, relativePath)
      if (base === wikiRoot && relativePath === item.path && ++reads === 1) {
        writeFileSync(join(wikiRoot, item.path), changed)
      }
      return content
    })
    await expect(service.proposeKnowledgeRepair(request, item.scope))
      .resolves.toMatchObject({ errorCode: 'source-changed' })
    expect(reads).toBe(2)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(changed)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
  })

  it.each(['../outside.md', 'index.md', 'concepts/absent.md'])('refuses unsupported or unverified correction source %s', async (sourcePath) => {
    const item = repairFixture()
    if (sourcePath.startsWith('concepts/')) writeFileSync(join(wikiRoot, sourcePath), 'Unverified page.')
    await expect(service.proposeKnowledgeRepair({ ...item.request, sourcePath }, item.scope))
      .resolves.toMatchObject({ errorCode: sourcePath.startsWith('concepts/') ? 'source-not-verified' : 'unsupported-source' })
  })

  it('refuses a well-typed unregistered project before reading its session', async () => {
    const item = repairFixture()
    const readSession = vi.fn(async () => ({ session: { cwd: root }, events: item.events }))
    ctx.provide('sessionQuery', { readSession } as never)
    const unregistered = join(root, 'unregistered-project')
    const journalPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const before = readFileSync(journalPath, 'utf8')
    await expect(service.proposeKnowledgeRepair(item.request, {
      ...item.scope, projectId: unregistered, workspaceId: unregistered,
    })).resolves.toEqual({ ok: false, errorCode: 'scope-unavailable' })
    expect(readSession).not.toHaveBeenCalled()
    expect(readFileSync(journalPath, 'utf8')).toBe(before)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
  })

  it('refuses an existing confined page outside the canonical repair categories before reading its session', async () => {
    const item = repairFixture()
    const sourcePath = 'index.md'
    writeFileSync(join(wikiRoot, sourcePath), '# Project index\n')
    const readSession = vi.fn(async () => ({ session: { cwd: root }, events: item.events }))
    ctx.provide('sessionQuery', { readSession } as never)
    const journalPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const before = readFileSync(journalPath, 'utf8')
    await expect(service.proposeKnowledgeRepair({ ...item.request, sourcePath }, item.scope))
      .resolves.toEqual({ ok: false, errorCode: 'unsupported-source' })
    expect(readSession).not.toHaveBeenCalled()
    expect(readFileSync(journalPath, 'utf8')).toBe(before)
    expect(readFileSync(join(wikiRoot, sourcePath), 'utf8')).toBe('# Project index\n')
    expect(existsSync(join(wikiRoot, '_candidates/ingest', sourcePath))).toBe(false)
  })

  it('uses the current human rule through an unrelated intervening tool call', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    const events = [...item.events.slice(0, 2), {
      type: 'tool/call', data: { turn: 1, step: 1, callId: 'unrelated-search', name: 'wiki_search', arguments: '{"query":"original rule"}' },
    }, item.events[2]]
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events }) } as never)
    const result = await service.proposeKnowledgeRepair(item.request, item.scope)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected the exact current-turn human rule')
    expect(readFileSync(join(wikiRoot, result.candidatePath), 'utf8')).toContain(item.request.correctedRule)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    await expect(service.modelPageContent({ path: result.candidatePath }, item.scope)).rejects.toThrow()
  })

  it('normalizes the captured correction for authorization while preserving its original Candidate text', async () => {
    const item = repairFixture()
    const correctedRule = '  Use cafe\u0301 after two\nchecks.  '
    const request = { ...item.request, correctedRule }
    const events = [
      item.events[0],
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Use café after two checks.' }] } },
      { type: 'tool/call', data: { turn: 1, name: 'wiki_propose_repair', arguments: JSON.stringify(request) } },
    ]
    await service.modelPageContent({ path: item.path }, item.scope)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events }) } as never)
    const result = await service.proposeKnowledgeRepair(request, item.scope)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected the normalized current-turn human rule')
    expect(readFileSync(join(wikiRoot, result.candidatePath), 'utf8')).toContain(correctedRule.trim())
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    await expect(service.modelPageContent({ path: result.candidatePath }, item.scope)).rejects.toThrow()
  })

  it('does not publish when a valid concurrent promotion changes the source identity after correction replay', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const utilityBefore = readFileSync(utilityFile)
    const append = knowledgeGovernance.appendKnowledgeEvent
    let interleavedRecordId: string | undefined
    vi.spyOn(knowledgeGovernance, 'appendKnowledgeEvent').mockImplementation((path, event) => {
      append(path, event)
      if (path === eventFile && event.type === 'knowledge/injected' && interleavedRecordId === undefined) {
        const current = appendVerifiedKnowledgeRecord(root, item.path, item.content, item.authority, 'repair-concurrent-promotion')
        interleavedRecordId = current.id
      }
    })

    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .rejects.toThrow('corrected knowledge record identity changed during replay')
    expect(interleavedRecordId).toBe('candidate:repair-concurrent-promotion')
    expect(readKnowledgeEventLog(eventFile, item.authority).at(-1)?.type).toBe('knowledge/promoted')
    expect(readFileSync(utilityFile).equals(utilityBefore)).toBe(true)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(false)
    expect(existsSync(join(root, '.llm-wiki', 'governance.jsonl'))).toBe(false)
  })

  it('does not publish when a same-record authenticated re-verification changes correction replay status', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const utilityBefore = readFileSync(utilityFile)
    const initial = readKnowledgeEventLog(eventFile, item.authority)
    const observed = initial.find(event => event.type === 'knowledge/observed'
      && event.knowledgeId === 'candidate:repair-boundary')
    if (observed === undefined || !('record' in observed.payload)) throw new Error('verified fixture record is missing')
    const record = observed.payload.record as KnowledgeRecord
    const append = knowledgeGovernance.appendKnowledgeEvent
    let reverified = false
    vi.spyOn(knowledgeGovernance, 'appendKnowledgeEvent').mockImplementation((path, event) => {
      append(path, event)
      if (path === eventFile && event.type === 'knowledge/injected' && !reverified) {
        appendSealedVerificationForExistingRecord(root, item.authority, record)
        reverified = true
      }
    })

    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .rejects.toThrow('corrected knowledge record was not rejected during replay')
    expect(reverified).toBe(true)
    const events = readKnowledgeEventLog(eventFile, item.authority)
    expect(events.at(-1)?.type).toBe('knowledge/verified')
    expect(replayKnowledgeEvents(events).records.get(record.id))
      .toMatchObject({ verificationStatus: 'verified', lifecycle: 'candidate' })
    expect(readFileSync(utilityFile).equals(utilityBefore)).toBe(true)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    expect(existsSync(join(root, '.llm-wiki', 'review.json'))).toBe(false)
    expect(existsSync(join(root, '.llm-wiki', 'governance.jsonl'))).toBe(false)
  })

  it('reports a lost lifecycle journal after revocation without publishing a repair Candidate', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    const journalPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const append = knowledgeGovernance.appendKnowledgeEvent
    let faulted = false
    vi.spyOn(knowledgeGovernance, 'appendKnowledgeEvent').mockImplementation((path, event) => {
      append(path, event)
      if (path === journalPath && event.type === 'knowledge/rejected') {
        writeFileSync(path, '')
        faulted = true
      }
    })
    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .rejects.toThrow('corrected knowledge record disappeared during replay')
    expect(faulted).toBe(true)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    await expect(service.modelPageContent({ path: item.path }, item.scope)).rejects.toThrow()
  })

  it('refuses repair publication when replay sees revocation without matching correction counters', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const governanceFile = join(root, '.llm-wiki', 'governance.jsonl')
    const eventBefore = readFileSync(eventFile)
    const utilityBefore = readFileSync(utilityFile)
    const append = knowledgeGovernance.appendKnowledgeEvent
    let faulted = false
    vi.spyOn(knowledgeGovernance, 'appendKnowledgeEvent').mockImplementation((path, event) => {
      append(path, event)
      if (path === eventFile && event.type === 'knowledge/injected') {
        const lines = readFileSync(path, 'utf8').split('\n')
        expect(lines.at(-1)).toBe('')
        lines.pop()
        lines.pop()
        writeFileSync(path, `${lines.join('\n')}\n`)
        faulted = true
      }
    })

    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .rejects.toThrow('corrected knowledge utility changed during replay')
    expect(faulted).toBe(true)
    expect(readFileSync(eventFile)).not.toEqual(eventBefore)
    expect(readKnowledgeEventLog(eventFile, item.authority).at(-1)).toMatchObject({
      type: 'knowledge/rejected', knowledgeId: 'candidate:repair-boundary', payload: { reason: 'user-correction' },
    })
    expect(readFileSync(utilityFile).equals(utilityBefore)).toBe(true)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    expect(existsSync(reviewFile)).toBe(false)
    expect(existsSync(governanceFile)).toBe(false)
  })

  it('does not write correction feedback or publish when the first revocation append fails', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const governanceFile = join(root, '.llm-wiki', 'governance.jsonl')
    const eventBefore = readFileSync(eventFile)
    const utilityBefore = readFileSync(utilityFile)
    const append = knowledgeGovernance.appendKnowledgeEvent
    let faulted = false
    vi.spyOn(knowledgeGovernance, 'appendKnowledgeEvent').mockImplementation((path, event) => {
      if (path === eventFile && event.type === 'knowledge/rejected') {
        faulted = true
        throw new Error('simulated first revocation append I/O failure')
      }
      append(path, event)
    })

    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .rejects.toThrow('simulated first revocation append I/O failure')
    expect(faulted).toBe(true)
    expect(readFileSync(eventFile)).toEqual(eventBefore)
    expect(readFileSync(utilityFile).equals(utilityBefore)).toBe(true)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    expect(existsSync(reviewFile)).toBe(false)
    expect(existsSync(governanceFile)).toBe(false)
  })

  it('keeps a source rejected when the later correction-feedback append fails', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    const eventFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const governanceFile = join(root, '.llm-wiki', 'governance.jsonl')
    const eventBefore = readFileSync(eventFile)
    const utilityBefore = readFileSync(utilityFile)
    const append = knowledgeGovernance.appendKnowledgeEvent
    let faulted = false
    vi.spyOn(knowledgeGovernance, 'appendKnowledgeEvent').mockImplementation((path, event) => {
      if (path === eventFile && event.type === 'knowledge/injected') {
        faulted = true
        throw new Error('simulated correction-feedback append I/O failure')
      }
      append(path, event)
    })

    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .rejects.toThrow('simulated correction-feedback append I/O failure')
    expect(faulted).toBe(true)
    expect(readFileSync(eventFile)).not.toEqual(eventBefore)
    const events = readKnowledgeEventLog(eventFile, item.authority)
    expect(events.at(-1)).toMatchObject({
      type: 'knowledge/rejected', knowledgeId: 'candidate:repair-boundary', payload: { reason: 'user-correction' },
    })
    expect(replayKnowledgeEvents(events).records.get('candidate:repair-boundary'))
      .toMatchObject({ verificationStatus: 'rejected', lifecycle: 'downgraded' })
    expect(readFileSync(utilityFile).equals(utilityBefore)).toBe(true)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
    expect(existsSync(reviewFile)).toBe(false)
    expect(existsSync(governanceFile)).toBe(false)
    await expect(service.modelPageContent({ path: item.path }, item.scope))
      .rejects.toThrow('knowledge page is not verified for this scope')
  })

  it('reports a lost repair registration without claiming completion or restoring source reuse', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    const commit = wikiReviews.commitReviewAppend
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    let faulted = false
    vi.spyOn(wikiReviews, 'commitReviewAppend').mockImplementation((...args) => {
      const result = commit(...args)
      writeFileSync(reviewFile, '[]')
      faulted = true
      return result
    })
    await expect(service.proposeKnowledgeRepair(item.request, item.scope))
      .rejects.toThrow('repair Candidate was not registered for independent review')
    expect(faulted).toBe(true)
    const candidatePath = `_candidates/ingest/${item.path}`
    expect(readFileSync(join(wikiRoot, candidatePath), 'utf8')).toContain(item.request.correctedRule)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    await expect(service.modelPageContent({ path: item.path }, item.scope)).rejects.toThrow()
    await expect(service.modelPageContent({ path: candidatePath }, item.scope)).rejects.toThrow()
  })

  it('archives one repair Candidate through the bulk service without counting duplicate ids or promoting it', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { cwd: root }, events: item.events }) } as never)
    const result = await service.proposeKnowledgeRepair(item.request, item.scope)
    if (!result.ok) throw new Error('expected an untrusted repair Candidate')
    expect(await service.resolveReviews({ ids: [result.reviewId, result.reviewId, 'absent'] })).toBe(1)
    expect(existsSync(join(wikiRoot, result.candidatePath))).toBe(false)
    expect((await service.reviews({ status: 'all' })).find(item => item.id === result.reviewId))
      .toMatchObject({ resolved: true, resolvedAction: 'Archive' })
    expect(await service.resolveReviews({ ids: [result.reviewId] })).toBe(0)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    await expect(service.modelPageContent({ path: item.path }, item.scope)).rejects.toThrow()
  })

  it.each(['mismatched requested hash', 'empty final source'] as const)('refuses a repair with %s before session authorization', async (change) => {
    const item = repairFixture()
    const readSession = vi.fn(async () => ({ session: { cwd: root }, events: item.events }))
    ctx.provide('sessionQuery', { readSession } as never)
    const request = { ...item.request }
    if (change === 'mismatched requested hash') request.expectedSourceContentHash = 'b'.repeat(64)
    else {
      const read = wikiGraph.readPage
      let reads = 0
      vi.spyOn(wikiGraph, 'readPage').mockImplementation((base, relativePath) => {
        const content = read(base, relativePath)
        if (base === wikiRoot && relativePath === item.path && ++reads === 1) writeFileSync(join(wikiRoot, item.path), '')
        return content
      })
    }
    const journalPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const before = readFileSync(journalPath, 'utf8')
    await expect(service.proposeKnowledgeRepair(request, item.scope)).resolves.toEqual({
      ok: false, errorCode: 'source-changed',
    })
    expect(readSession).not.toHaveBeenCalled()
    expect(readFileSync(journalPath, 'utf8')).toBe(before)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
  })

  it('refuses an authenticated source without supported frontmatter before session authorization', async () => {
    const item = repairFixture()
    const plain = '# Authenticated plain source without frontmatter\n'
    writeFileSync(join(wikiRoot, item.path), plain)
    appendVerifiedKnowledgeRecord(root, item.path, plain, item.authority, 'plain-repair-source')
    const request = { ...item.request, expectedSourceContentHash: knowledgeSha256(plain) }
    const readSession = vi.fn(async () => ({ session: { cwd: root }, events: item.events }))
    ctx.provide('sessionQuery', { readSession } as never)
    const journalPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const before = readFileSync(journalPath, 'utf8')
    await expect(service.proposeKnowledgeRepair(request, item.scope)).resolves.toEqual({
      ok: false, errorCode: 'unsupported-source',
    })
    expect(readSession).not.toHaveBeenCalled()
    expect(readFileSync(journalPath, 'utf8')).toBe(before)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(plain)
    expect(existsSync(join(wikiRoot, '_candidates/ingest', item.path))).toBe(false)
  })

  it('rebuilds a missing utility projection from its journal during an authorized repair', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    ctx.provide('sessionQuery', {
      readSession: async () => {
        unlinkSync(utilityFile)
        return { session: { cwd: root }, events: item.events }
      },
    } as never)
    await expect(service.proposeKnowledgeRepair(item.request, item.scope)).resolves.toMatchObject({ ok: true })
    const utility = JSON.parse(readFileSync(utilityFile, 'utf8')) as Record<string, Record<string, unknown>>
    // The prior authenticated fixture contributes one retrieval and one use;
    // this session's full read adds one retrieval, and the repair one correction.
    expect(utility[item.path]).toMatchObject({ retrievalHits: 2, successfulUses: 1, userCorrections: 1 })
    expect(utility[item.path]).not.toHaveProperty('lastRetrievedAt')
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
    await expect(service.modelPageContent({ path: `_candidates/ingest/${item.path}` }, item.scope)).rejects.toThrow()
  })

  it('does not count one retrieved page correction twice or write unsafe feedback paths', async () => {
    const item = repairFixture()
    await service.modelPageContent({ path: item.path }, item.scope)
    expect(await service.recordKnowledgeOutcome({ paths: [item.path], outcome: 'corrected' })).toBe(1)
    const journalPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
    const journalBefore = readFileSync(journalPath, 'utf8')
    const utilityBefore = readFileSync(utilityFile, 'utf8')
    expect(await service.recordKnowledgeOutcome({ paths: [item.path, '../outside.md'], outcome: 'corrected' })).toBe(0)
    expect(readFileSync(journalPath, 'utf8')).toBe(journalBefore)
    expect(readFileSync(utilityFile, 'utf8')).toBe(utilityBefore)
    expect(readFileSync(join(wikiRoot, item.path), 'utf8')).toBe(item.content)
  })

  it('requires a verifier authority before replaying model-facing knowledge', async () => {
    await expect(service.modelList({ projectId: root, workspaceId: root, sessionId: 'unverified-session' }))
      .rejects.toThrow('knowledge verifier authority is unavailable')
  })

  it('blocks corrected knowledge and promotes only its independently verified repair for a fresh session', async () => {
    const path = 'concepts/alpha.md'
    const original = [
      '---',
      'type: concept',
      'status: canonical',
      'title: Alpha',
      'sources: ["raw/sources/alpha.md"]',
      '---',
      '',
      '# Alpha',
      '',
      'Use the old threshold for alpha tasks.',
      '',
    ].join('\n')
    const correctedRule = 'Use the exact current threshold from the signed policy table; never estimate it from prior examples.'
    writeFileSync(join(wikiRoot, path), original, 'utf8')
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    appendVerifiedKnowledgeRecord(root, path, original, authority, 'alpha-repair-source')

    const originalScope = { projectId: root, workspaceId: root, sessionId: 'repair-source-session' }
    const repairRequest = {
      sourcePath: path,
      title: 'Alpha threshold rule',
      correctedRule,
      expectedSourceContentHash: knowledgeSha256(original),
    }
    const repairToolArguments = JSON.stringify({
      sourcePath: repairRequest.sourcePath,
      title: repairRequest.title,
      correctedRule: repairRequest.correctedRule,
    })
    await expect(service.proposeKnowledgeRepair(repairRequest, originalScope)).resolves.toMatchObject({
      ok: false,
      errorCode: 'session-log-unavailable',
    })
    let sessionCwd = root
    let sessionEvents: unknown[] = [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'user/message',
        data: { source: { kind: 'agent' }, role: 'assistant', content: [{ type: 'text', text: correctedRule }] },
      },
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'repair-call', name: 'wiki_propose_repair', arguments: repairToolArguments } },
    ]
    ctx.provide('sessionQuery', {
      readSession: async () => ({ session: { cwd: sessionCwd }, events: sessionEvents }),
    } as never)
    await expect(service.proposeKnowledgeRepair(repairRequest, originalScope)).resolves.toMatchObject({
      ok: false,
      errorCode: 'user-correction-unconfirmed',
    })
    expect(existsSync(join(wikiRoot, '_candidates', 'ingest', path))).toBe(false)

    sessionEvents = [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'user/message',
        data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: correctedRule }] },
      },
      {
        type: 'tool/call',
        data: {
          turn: 1,
          step: 1,
          callId: 'altered-repair-call',
          name: 'wiki_propose_repair',
          arguments: JSON.stringify({
            sourcePath: path,
            title: 'Alpha threshold rule',
            correctedRule: `${correctedRule} Fabricated`,
          }),
        },
      },
    ]
    await expect(service.proposeKnowledgeRepair(repairRequest, originalScope)).resolves.toMatchObject({
      ok: false,
      errorCode: 'user-correction-unconfirmed',
    })

    sessionEvents = [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'user/message',
        data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: correctedRule }] },
      },
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'repair-call', name: 'wiki_propose_repair', arguments: repairToolArguments } },
    ]
    sessionCwd = join(root, 'other-workspace')
    await expect(service.proposeKnowledgeRepair(repairRequest, originalScope)).resolves.toMatchObject({
      ok: false,
      errorCode: 'session-log-unavailable',
    })
    sessionCwd = root
    await expect(service.proposeKnowledgeRepair(repairRequest, originalScope)).resolves.toMatchObject({
      ok: false,
      errorCode: 'source-not-read',
    })
    expect(existsSync(join(wikiRoot, '_candidates', 'ingest', path))).toBe(false)
    await expect(service.modelPageContent({ path }, originalScope)).resolves.toMatchObject({ path, content: original })
    const proposal = await service.proposeKnowledgeRepair(repairRequest, originalScope)
    expect(proposal).toMatchObject({ ok: true, candidatePath: `_candidates/ingest/${path}` })
    if (!proposal.ok) throw new Error('expected the correction candidate to be staged')

    await expect(service.modelPageContent({ path }, { ...originalScope, sessionId: 'after-correction' }))
      .rejects.toThrow('knowledge page is not verified for this scope')
    const candidateBytes = readFileSync(join(wikiRoot, proposal.candidatePath), 'utf8')
    expect(candidateBytes).toContain(correctedRule)
    expect(candidateBytes).toContain('must pass independent verification')
    expect(await service.pageContent({ path: proposal.candidatePath })).toEqual({ path: proposal.candidatePath, content: '' })
    const eventPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
    const lifecycleEvents = readKnowledgeEventLog(eventPath, authority)
    const repairEvents = lifecycleEvents.filter(event => event.knowledgeId === 'candidate:alpha-repair-source')
    expect(repairEvents.slice(-2).map(event => event.type)).toEqual(['knowledge/rejected', 'knowledge/injected'])
    const rejectedSource = replayKnowledgeEvents(lifecycleEvents).records.get('candidate:alpha-repair-source')
    expect(rejectedSource).toMatchObject({ verificationStatus: 'rejected', lifecycle: 'downgraded', userCorrections: 1 })
    const utility = await service.knowledgeUtility()
    expect(utility.find(item => item.path === path)).toMatchObject({ userCorrections: 1, retrievalHits: 1 })

    const verified = await (service as unknown as {
      verifyCandidate(request: { reviewId: string; action: 'Replace' }, signal: AbortSignal): Promise<{ ok: boolean }>
    }).verifyCandidate({ reviewId: proposal.reviewId, action: 'Replace' }, new AbortController().signal)
    expect(verified.ok).toBe(true)
    await expect(service.resolveReview({ reviewId: proposal.reviewId, action: 'Replace' })).resolves.toBe(false)

    const freshScope = { projectId: root, workspaceId: root, sessionId: 'fresh-repair-session' }
    const hits = await service.modelSearch({ query: 'current threshold signed policy table', topK: 5 }, freshScope)
    expect(hits.map(hit => hit.path)).not.toContain(path)
    await expect(service.modelPageContent({ path }, freshScope)).rejects.toThrow('knowledge page is not verified for this scope')
    const repairState = replayKnowledgeEvents(readKnowledgeEventLog(eventPath, authority))
    expect(repairState.records.get(`candidate:${proposal.reviewId}`))
      .toMatchObject({ verificationStatus: 'verified', lifecycle: 'candidate', authority: authority.authorityId })
  })

  it('does not authorize a repair from a page that the model-facing read would truncate', async () => {
    const path = 'concepts/oversized.md'
    const content = [
      '---',
      'type: concept',
      'status: canonical',
      'title: Oversized',
      'sources: ["raw/sources/oversized.md"]',
      '---',
      '',
      '# Oversized',
      '',
      'x'.repeat(8200),
      '',
    ].join('\n')
    writeFileSync(join(wikiRoot, path), content, 'utf8')
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    appendVerifiedKnowledgeRecord(root, path, content, authority, 'oversized-repair-source')
    const scope = { projectId: root, workspaceId: root, sessionId: 'oversized-repair-session' }
    ctx.provide('sessionQuery', {
      readSession: async () => ({
        session: { cwd: root },
        events: [
          { type: 'turn/start', data: { turn: 1 } },
          {
            type: 'user/message',
            data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: 'This rule must remain untrusted.' }] },
          },
          {
            type: 'tool/call',
            data: {
              turn: 1,
              step: 1,
              callId: 'oversized-repair',
              name: 'wiki_propose_repair',
              arguments: JSON.stringify({
                sourcePath: path,
                title: 'Oversized repair',
                correctedRule: 'This rule must remain untrusted.',
              }),
            },
          },
        ],
      }),
    } as never)
    await expect(service.modelPageContent({ path }, scope)).resolves.toMatchObject({ path, content })
    await expect(service.proposeKnowledgeRepair({
      sourcePath: path,
      title: 'Oversized repair',
      correctedRule: 'This rule must remain untrusted.',
      expectedSourceContentHash: knowledgeSha256(content),
    }, scope)).resolves.toMatchObject({ ok: false, errorCode: 'source-not-read' })
  })

  const rustShadowBinary = resolve(`rust/knowledge-search-shadow/target/release/knowledge-search-shadow${process.platform === 'win32' ? '.exe' : ''}`)
  it.skipIf(!existsSync(rustShadowBinary))(
    'exercises the service Rust shadow seam with the real release binary',
    async () => {
      const candidateRoot = mkdtempSync(join(tmpdir(), 'wiki-service-rust-candidate-'))
      const candidateWiki = join(candidateRoot, 'wiki')
      mkdirSync(candidateWiki, { recursive: true })
      const candidateCtx = new Context()
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
      Object.defineProperty(candidateCtx, 'logger', { configurable: true, value: logger })
      Object.defineProperty(candidateCtx, 'credentials', {
        configurable: true,
        value: { resolve: vi.fn().mockResolvedValue(undefined) },
      })
      Object.defineProperty(candidateCtx, 'llm', {
        configurable: true,
        value: { stream: vi.fn() },
      })
      Object.defineProperty(candidateCtx, 'timer', {
        configurable: true,
        value: { interval: () => () => {} },
      })
      candidateCtx.provide('knowledgeWikiVerifierAuthority', verifierAuthority())
      const candidate = new KnowledgeWikiService(candidateCtx, wikiTestConfig({
        wikiRoot: candidateWiki,
        mainRoot: candidateRoot,
        credential: 'VISION_API_KEY',
        llmProvider: 'p',
        llmModel: 'm',
        knowledgeSearchCandidateMode: 'shadow',
        knowledgeSearchCandidateBinary: rustShadowBinary,
        knowledgeSearchCandidateTimeoutMs: 5000,
      }))
      try {
        await expect(candidate.modelSearch({ query: 'runtime' }, {
          projectId: candidateRoot,
          workspaceId: candidateRoot,
          sessionId: 'service-rust-candidate-session',
        })).resolves.toEqual([])
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Rust search candidate shadow matched'))
      } finally {
        (candidate as unknown as Surface).snapshots.dispose()
        await candidateCtx.fiber.dispose()
        rmSync(candidateRoot, { recursive: true, force: true })
      }
    },
  )
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

  it('rebuilds the shared search index after a canonical page write', async () => {
    const canonical = join(wikiRoot, 'concepts', 'cache-invalidation.md')
    const previous = '# Cache invalidation\n\nLegacyneedle belongs only to this version.'
    writeFileSync(canonical, previous, 'utf8')

    expect((await service.search({ query: 'legacyneedle' })).map(hit => hit.path))
      .toContain('concepts/cache-invalidation.md')

    expect(await service.writePage({
      path: 'concepts/cache-invalidation.md',
      content: '# Cache invalidation\n\nCurrentbeacon belongs only to the replacement.',
      expectedContent: previous,
    })).toMatchObject({ ok: true })

    expect((await service.search({ query: 'legacyneedle' })).map(hit => hit.path))
      .not.toContain('concepts/cache-invalidation.md')
    expect((await service.search({ query: 'currentbeacon' })).map(hit => hit.path))
      .toContain('concepts/cache-invalidation.md')
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
    const blocked = new KnowledgeWikiService(blockedContext, wikiTestConfig({
      wikiRoot: blockedRoot, mainRoot: root,
      credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
    })) as unknown as Surface
    expect(await blocked.createPage({ title: 'Fails' })).toMatchObject({ path: '', ok: false })
    blocked.snapshots.dispose()
    await blockedContext.fiber.dispose()
  })
})

describe('review, insight, lint, and archive surface', () => {
  it('returns an empty review list before the review store has been created', async () => {
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    expect(existsSync(reviewFile)).toBe(false)
    await expect(service.reviews({ status: 'all' })).resolves.toEqual([])
    expect(existsSync(reviewFile)).toBe(false)
  })

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
    writeFileSync(reviewFile, '{}', 'utf8')
    await expect(service.reviews({ status: 'all' })).rejects.toThrow('invalid knowledge review state')
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
  }, process.platform === 'win32' ? 90_000 : 30_000)
})
