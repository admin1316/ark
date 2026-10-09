import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import KnowledgeWikiService, { type Config } from '../src/index.ts'
import * as governance from '../src/knowledge-governance.ts'
import * as rustSearch from '../src/rust-search-candidate.ts'
import { appendCandidateReviews, recordCandidateVerification } from '../src/reviews.ts'
import { canonicalJson, readTrustedVerification, sha256, verifyCandidate } from '../src/verifier.ts'
import type { WikiReviewItem } from '../src/types.ts'
import { wikiTestConfig } from './config-fixture.ts'
import { seedHistoricalCanonicalKnowledge } from './historical-governed-fixture.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []
const contexts: Context[] = []
const pagePath = 'concepts/runtime-boundary.md'
const content = '---\ntype: concept\nstatus: canonical\ntitle: Runtime boundary\n---\n\nPreserve runtime boundary evidence.\n'

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function worldBytes(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name))])
}

function fixture(config: Partial<Config> = {}, omitOptional = false) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-runtime-closure-'))
  roots.push(root)
  const wikiRoot = join(root, 'wiki')
  const authority = verifierAuthority()
  const seeded = seedHistoricalCanonicalKnowledge({ projectRoot: root, wikiRoot, path: pagePath, content, authority })
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('knowledgeWikiVerifierAuthority', authority)
  const resolved = wikiTestConfig({ mainRoot: root, wikiRoot, credential: '', ...config })
  if (omitOptional) {
    delete (resolved as { knowledgeSearchCandidateBinary?: string }).knowledgeSearchCandidateBinary
    delete (resolved as { knowledgeSearchCandidateTimeoutMs?: number }).knowledgeSearchCandidateTimeoutMs
    delete (resolved as { knowledgeVerifierConfig?: string }).knowledgeVerifierConfig
  }
  const service = new KnowledgeWikiService(ctx, resolved)
  return { root, wikiRoot, service, ctx, authority, eventPath: seeded.eventPath,
    scope: { projectId: root, workspaceId: root, sessionId: 'synthetic-runtime-reader' } }
}

function fallback(reason?: string): rustSearch.RustKnowledgeSearchResult {
  return { results: [[{ path: 'unverified-poison.md', score: 999 }]], source: 'typescript',
    observation: { attempted: true, matched: false, status: 'fallback', timedOut: false, aborted: false,
      exitCode: 7, signal: null, ...(reason === undefined ? {} : { reason }) } }
}

describe('model-facing Wiki runtime boundaries', () => {
  it('resolves omitted optional direct-constructor configuration without starting a candidate process', async () => {
    const value = fixture({}, true)
    const candidate = vi.spyOn(rustSearch, 'runRustKnowledgeSearchCandidate')
    await expect(value.service.modelSearch({ query: 'boundary' }, value.scope)).resolves.toMatchObject([
      { path: pagePath, provenance: { contentHash: governance.knowledgeSha256(content) } },
    ])
    expect(candidate).not.toHaveBeenCalled()
  })

  it('admits an explicitly registered secondary project and fails closed on corrupt registration', async () => {
    const value = fixture()
    const secondary = join(value.root, 'secondary')
    seedHistoricalCanonicalKnowledge({ projectRoot: secondary, wikiRoot: join(secondary, 'wiki'), path: pagePath, content, authority: value.authority })
    const registry = join(value.root, '.llm-wiki/workspaces.json')
    writeFileSync(registry, JSON.stringify({ workspaces: [{ path: secondary, name: 'Isolated secondary' }] }))
    const scope = { projectId: secondary, workspaceId: secondary, sessionId: 'secondary-reader' }
    await expect(value.service.modelPageContent({ path: pagePath }, scope)).resolves.toMatchObject({ content })
    writeFileSync(registry, '{malformed')
    const before = worldBytes(value.root)
    await expect(value.service.modelPageContent({ path: pagePath }, scope)).rejects.toThrow('knowledge scope is unavailable')
    expect(worldBytes(value.root)).toEqual(before)
  })

  it('keeps enforce mode closed and emits no retrieval credit', async () => {
    const value = fixture({ knowledgeSearchCandidateMode: 'enforce' })
    const candidate = vi.spyOn(rustSearch, 'runRustKnowledgeSearchCandidate')
    const before = worldBytes(value.root)
    await expect(value.service.modelSearch({ query: 'boundary' }, value.scope)).rejects.toThrow('enforce mode is unavailable')
    expect(candidate).not.toHaveBeenCalled()
    expect(worldBytes(value.root)).toEqual(before)
  })

  it.each([undefined, 'synthetic mismatch'])('retains governed TypeScript hits after shadow fallback: %s', async (reason) => {
    const value = fixture({ knowledgeSearchCandidateMode: 'shadow' })
    const candidate = vi.spyOn(rustSearch, 'runRustKnowledgeSearchCandidate').mockResolvedValue(fallback(reason))
    const warn = vi.spyOn(value.ctx.logger, 'warn').mockImplementation(() => {})
    const hits = await value.service.modelSearch({ query: 'boundary', topK: 2 }, value.scope)
    expect(hits.map(hit => hit.path)).toEqual([pagePath])
    expect(warn).toHaveBeenCalledWith(`[knowledge-wiki] Rust search candidate shadow fallback: ${reason ?? 'unknown reason'}`)
    expect(candidate.mock.calls[0]?.[0]).toMatchObject({ budget: 2, sessionId: value.scope.sessionId })
    expect(readFileSync(join(value.wikiRoot, pagePath), 'utf8')).toBe(content)
    const events = governance.readKnowledgeEventLog(value.eventPath, value.authority)
    expect(events.filter(event => event.type === 'knowledge/retrieved').map(event => event.payload['path'])).toEqual([pagePath])
  })

  it('records a matching Rust shadow observation while returning governed TypeScript hits', async () => {
    const value = fixture({ knowledgeSearchCandidateMode: 'shadow' })
    vi.spyOn(rustSearch, 'runRustKnowledgeSearchCandidate').mockResolvedValue({
      results: [[{ path: pagePath, score: 0.5 }]],
      source: 'typescript',
      observation: { attempted: true, matched: true, status: 'matched', timedOut: false, aborted: false, exitCode: 0, signal: null },
    })
    const info = vi.spyOn(value.ctx.logger, 'info').mockImplementation(() => {})

    await expect(value.service.modelSearch({ query: 'boundary' }, value.scope)).resolves.toMatchObject([
      { path: pagePath, provenance: { contentHash: governance.knowledgeSha256(content) } },
    ])
    expect(info).toHaveBeenCalledWith('[knowledge-wiki] Rust search candidate shadow matched TypeScript BM25')
    expect(readFileSync(join(value.wikiRoot, pagePath), 'utf8')).toBe(content)
  })

  it.each([new Error('synthetic shadow failure'), 'primitive shadow failure'])('contains a shadow provider failure without returning its data: %s', async (failure) => {
    const value = fixture({ knowledgeSearchCandidateMode: 'shadow' })
    vi.spyOn(rustSearch, 'runRustKnowledgeSearchCandidate').mockRejectedValue(failure)
    const warn = vi.spyOn(value.ctx.logger, 'warn').mockImplementation(() => {})
    await expect(value.service.modelSearch({ query: 'boundary' }, value.scope)).resolves.toEqual([expect.objectContaining({ path: pagePath })])
    expect(warn).toHaveBeenCalledWith(`[knowledge-wiki] Rust search candidate shadow failed: ${failure instanceof Error ? failure.message : failure}`)
    expect(readFileSync(join(value.wikiRoot, pagePath), 'utf8')).toBe(content)
  })

  it('refuses a page truncated after authentication and leaves its journal unchanged', async () => {
    const value = fixture()
    const path = 'concepts/empty.md'
    seedHistoricalCanonicalKnowledge({ projectRoot: value.root, wikiRoot: value.wikiRoot, path, content, authority: value.authority })
    writeFileSync(join(value.wikiRoot, path), '')
    const before = worldBytes(value.root)
    await expect(value.service.modelPageContent({ path }, value.scope)).rejects.toThrow('knowledge page not found')
    expect(worldBytes(value.root)).toEqual(before)
  })

  it('filters advisory review status and rejects malformed persisted review state', async () => {
    const value = fixture()
    const path = join(value.root, '.llm-wiki/review.json')
    const open: WikiReviewItem = { id: 'open', type: 'suggestion', title: 'Open', reviewKind: 'advisory', resolved: false }
    const resolved: WikiReviewItem = { ...open, id: 'resolved', resolved: true }
    const unknown: WikiReviewItem = { ...open, id: 'unknown', reviewKind: 'candidate', candidatePath: '_candidates/unknown.md' }
    const absent: WikiReviewItem = { ...open, id: 'absent', reviewKind: 'candidate' }
    writeFileSync(path, JSON.stringify([open, resolved, unknown, absent]))
    await expect(value.service.modelReviews({}, value.scope)).resolves.toEqual([open])
    await expect(value.service.modelReviews({ status: 'resolved' }, value.scope)).resolves.toEqual([resolved])
    await expect(value.service.modelReviews({ status: 'all', limit: 1 }, value.scope)).resolves.toEqual([open])
    writeFileSync(path, '{}')
    await expect(value.service.modelReviews({}, value.scope)).rejects.toThrow('invalid knowledge review state')
  })

  it.each(['missing-verification', 'missing-action', 'missing-receipt', 'mismatched-record'] as const)(
    'hides candidate review with %s without changing its canonical target', async (fault) => {
      const value = fixture()
      const candidatePath = '_candidates/ingest/concepts/other-boundary.md'
      const full = join(value.wikiRoot, candidatePath)
      const reviewFile = join(value.root, '.llm-wiki/review.json')
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content.replace('status: canonical', 'status: candidate'))
      appendCandidateReviews(reviewFile, value.root, 'synthetic-source-label', [`wiki/${candidatePath}`])
      const item = (JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[])[0]!
      const verified = await verifyCandidate(value.authority, reviewFile, value.wikiRoot, item.id, 'Promote', new AbortController().signal)
      expect(verified.ok).toBe(true)
      expect(recordCandidateVerification(value.authority, reviewFile, value.wikiRoot, item.id, verified.receiptId!, 'Promote')).toBe(true)
      const row = (JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[])[0]!
      const changed = fault === 'mismatched-record' ? row : fault === 'missing-verification' ? { ...row, verification: undefined }
        : { ...row, verification: { ...row.verification!, ...(fault === 'missing-action' ? { action: undefined } : { receipts: [] }) } }
      writeFileSync(reviewFile, JSON.stringify([changed]))
      if (fault === 'mismatched-record') {
        const events = governance.readKnowledgeEventLog(value.eventPath, value.authority)
        const record = [...governance.replayKnowledgeEvents(events).records.values()].find(item => item.source === candidatePath)!
        const payload = { record: { ...record, contentHash: sha256('unrelated signed record bytes') },
          authority: value.authority.authorityId, confidence: 1, evidenceRefs: ['synthetic signed-record mismatch regression'] }
        const seal = value.authority.sealPromotion(canonicalJson({ type: 'knowledge/verified', knowledgeId: record.id, payload }))
        governance.appendKnowledgeEvent(value.eventPath, governance.createKnowledgeEvent('knowledge/verified', record.id, record.scope,
          { ...payload, authorityId: value.authority.authorityId, authoritySeal: seal },
          { seq: events.length, previousEventHash: events.at(-1)!.eventHash }))
        expect(governance.knowledgeInjectionDecision(payload.record, value.scope).allowed).toBe(true)
        expect(readTrustedVerification(value.authority, reviewFile, value.wikiRoot, row, verified.receiptId!, 'Promote')).toBeDefined()
      }
      const before = worldBytes(value.root)
      await expect(value.service.modelReviews({}, value.scope)).resolves.toEqual([])
      expect(worldBytes(value.root)).toEqual(before)
    },
  )

  it('does not award correction credit to an unobserved page', async () => {
    const value = fixture()
    const before = worldBytes(value.root)
    await expect(value.service.recordKnowledgeOutcome({ paths: [pagePath, 'concepts/unobserved.md'], outcome: 'corrected' })).resolves.toBe(0)
    expect(worldBytes(value.root)).toEqual(before)
  })

  it.each([new Error('journal became unreadable'), 'primitive journal failure'])('rejects a search when its second journal read fails: %s', async (failure) => {
    const value = fixture()
    const original = governance.readKnowledgeEventLog
    vi.spyOn(governance, 'readKnowledgeEventLog').mockImplementationOnce(original).mockImplementationOnce(() => { throw failure })
    const warn = vi.spyOn(value.ctx.logger, 'warn').mockImplementation(() => {})
    const before = worldBytes(value.root)
    await expect(value.service.search({ query: 'boundary' })).resolves.toEqual([])
    expect(warn).toHaveBeenCalledWith(`[knowledge-wiki] knowledge replay rejected search: ${failure instanceof Error ? failure.message : failure}`)
    expect(worldBytes(value.root)).toEqual(before)
  })

  it('contains primitive journal failures on the initial search and page-read boundary', async () => {
    const value = fixture()
    vi.spyOn(governance, 'readKnowledgeEventLog').mockImplementation(() => { throw 'primitive journal failure' })
    const warn = vi.spyOn(value.ctx.logger, 'warn').mockImplementation(() => {})
    const before = worldBytes(value.root)
    await expect(value.service.search({ query: 'boundary' })).resolves.toEqual([])
    await expect(value.service.pageContent({ path: pagePath })).resolves.toEqual({ path: pagePath, content: '' })
    expect(warn).toHaveBeenCalledWith('[knowledge-wiki] knowledge replay rejected page read: primitive journal failure')
    expect(worldBytes(value.root)).toEqual(before)
  })
})
