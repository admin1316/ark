import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import KnowledgeWikiService from '../src/index.ts'
import {
  appendKnowledgeEvent, createKnowledgeEvent, createKnowledgeRecord,
  readKnowledgeEventLog, replayKnowledgeEvents,
} from '../src/knowledge-governance.ts'
import {
  appendCandidateReviews, applyCandidateReview, recordCandidateVerification,
  recoverCandidateReviewTransactions,
} from '../src/reviews.ts'
import { canonicalJson, sha256, verifyCandidate, type KnowledgeWikiVerifierAuthority } from '../src/verifier.ts'
import type { KnowledgeRecord, WikiReviewItem } from '../src/types.ts'
import { wikiTestConfig } from './config-fixture.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []
const contexts: Context[] = []
const pagePath = 'concepts/repair-contract.md'

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(action: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' = 'Promote') {
  const root = mkdtempSync(join(tmpdir(), 'wiki-content-binding-'))
  roots.push(root)
  const wikiRoot = join(root, 'wiki')
  const candidatePath = `_candidates/ingest/${pagePath}`
  const candidateFull = join(wikiRoot, candidatePath)
  const reviewFile = join(root, '.llm-wiki/review.json')
  mkdirSync(dirname(candidateFull), { recursive: true })
  const content = '---\ntype: concept\nstatus: candidate\norigin: ingest\ntitle: Repair contract\n---\n\n# Repair contract\n\nPreserve exact input paths and validate successful repair artifacts.\n'
  writeFileSync(candidateFull, content)
  mkdirSync(join(root, 'raw/sources'), { recursive: true })
  writeFileSync(join(root, 'raw/sources/evidence.md'), 'Source evidence for the isolated contract test.')
  if (action !== 'Promote') {
    mkdirSync(dirname(join(wikiRoot, pagePath)), { recursive: true })
    writeFileSync(join(wikiRoot, pagePath), '---\ntype: concept\nstatus: canonical\ntitle: Repair contract\n---\n\n# Repair contract\n\nPreserve exact input paths and validate successful repair artifacts.\n')
  }
  appendCandidateReviews(reviewFile, root, 'raw/sources/evidence.md', [`wiki/${candidatePath}`])
  const item = (JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[])[0]!
  return { root, wikiRoot, candidatePath, candidateFull, reviewFile, item, content, action }
}

async function verify(item: ReturnType<typeof fixture>, authority = verifierAuthority()) {
  const result = await verifyCandidate(authority, item.reviewFile, item.wikiRoot, item.item.id,
    item.action, new AbortController().signal)
  expect(result.ok).toBe(true)
  expect(recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.item.id,
    result.receiptId!, item.action)).toBe(true)
  return authority
}

function service(item: ReturnType<typeof fixture>, authority: KnowledgeWikiVerifierAuthority, embedding = false) {
  const context = new Context()
  contexts.push(context)
  context.provide('knowledgeWikiVerifierAuthority', authority)
  context.provide('credentials', { resolve: async () => ({ value: 'isolated-embedding-fixture' }) })
  return new KnowledgeWikiService(context, wikiTestConfig({
    wikiRoot: item.wikiRoot, mainRoot: item.root, credential: embedding ? 'FIXTURE_ONLY' : '',
  }))
}

function scope(item: ReturnType<typeof fixture>) {
  return { projectId: item.root, workspaceId: item.root, sessionId: 'model-session', actor: 'reader' }
}

describe('authenticated canonical content', () => {
  it.each(['Promote', 'Merge', 'Replace', 'Deduplicate'] as const)('binds final %s bytes and rejects later replacements at model reads', async (action) => {
    const item = fixture(action)
    const authority = await verify(item)
    expect(applyCandidateReview(authority, item.reviewFile, item.root, item.wikiRoot,
      join(item.root, 'archive'), item.item.id, action)).toBe(true)
    const canonical = readFileSync(join(item.wikiRoot, pagePath), 'utf8')
    const events = readKnowledgeEventLog(join(item.root, '.llm-wiki/knowledge-events.jsonl'), authority)
    const promoted = events.find(event => event.type === 'knowledge/promoted')!
    expect(promoted.payload.contentHash).toBe(sha256(canonical))
    const record = replayKnowledgeEvents(events).records.get(`candidate:${item.item.id}`)!
    expect(record.contentHash).toBe(sha256(canonical))
    expect(record.contentHash).not.toBe(sha256(item.content))
    const wiki = service(item, authority)
    await expect(wiki.modelPageContent({ path: pagePath }, scope(item)))
      .resolves.toMatchObject({ content: canonical, provenance: { contentHash: sha256(canonical) } })

    writeFileSync(join(item.wikiRoot, pagePath), '---\ntype: concept\nstatus: canonical\ntitle: Poisoned repair\n---\n\nPOISONED_REPAIR instructions.\n')
    await expect(wiki.modelPageContent({ path: pagePath }, scope(item))).rejects.toThrow('bytes do not match')
    await expect(wiki.modelSearch({ query: 'POISONED_REPAIR' }, scope(item))).resolves.toEqual([])
    await expect(wiki.modelList(scope(item))).resolves.toEqual([])
    await expect(wiki.modelGraph(scope(item))).resolves.toEqual({ nodes: [], edges: [], communities: [], provenance: {} })
  })

  it('binds recovered canonical bytes from the authenticated promotion journal', async () => {
    const item = fixture()
    const authority = await verify(item)
    const interrupted: KnowledgeWikiVerifierAuthority = {
      ...authority,
      checkpointPromotion(_payload, checkpoint) {
        if (checkpoint.phase === 'journal-persisted') throw new Error('test interruption')
      },
    }
    expect(() => applyCandidateReview(interrupted, item.reviewFile, item.root, item.wikiRoot,
      join(item.root, 'archive'), item.item.id, 'Promote')).toThrow('test interruption')
    expect(recoverCandidateReviewTransactions(authority, item.reviewFile, item.wikiRoot, join(item.root, 'archive'))).toBe(1)
    const canonical = readFileSync(join(item.wikiRoot, pagePath), 'utf8')
    const events = readKnowledgeEventLog(join(item.root, '.llm-wiki/knowledge-events.jsonl'), authority)
    expect(events.find(event => event.type === 'knowledge/promoted')?.payload.contentHash).toBe(sha256(canonical))
    await expect(service(item, authority).modelPageContent({ path: pagePath }, scope(item)))
      .resolves.toMatchObject({ content: canonical })
  })

  it('rejects modified candidate bytes and review metadata before model review projection', async () => {
    const item = fixture()
    const authority = await verify(item)
    const wiki = service(item, authority)
    await expect(wiki.modelReviews({}, scope(item))).resolves.toEqual([expect.objectContaining({ id: item.item.id })])
    const originalReview = readFileSync(item.reviewFile, 'utf8')
    const reviews = JSON.parse(originalReview) as WikiReviewItem[]
    writeFileSync(item.reviewFile, JSON.stringify(reviews.map(review => ({ ...review, description: 'UNVERIFIED_REVIEW_TEXT' }))))
    await expect(wiki.modelReviews({}, scope(item))).resolves.toEqual([])
    writeFileSync(item.reviewFile, originalReview)
    writeFileSync(item.candidateFull, `${item.content}\nUNVERIFIED_CANDIDATE_TEXT\n`)
    await expect(wiki.modelReviews({}, scope(item))).resolves.toEqual([])
  })

  it('excludes unknown, ACL-denied, unbound, and changed bytes before embedding and graph derivation', async () => {
    const item = fixture()
    const authority = await verify(item)
    expect(applyCandidateReview(authority, item.reviewFile, item.root, item.wikiRoot,
      join(item.root, 'archive'), item.item.id, 'Promote')).toBe(true)
    const eventPath = join(item.root, '.llm-wiki/knowledge-events.jsonl')
    const addSignedRecord = (name: string, fields: Partial<KnowledgeRecord>, omitContentHash = false): void => {
      const path = `concepts/${name}.md`
      const content = `---\ntype: concept\nstatus: canonical\ntitle: ${name}\n---\n\nRepair ${name}.\n`
      writeFileSync(join(item.wikiRoot, path), content)
      const boundRecord = createKnowledgeRecord({ id: `fixture:${name}`, source: path, content,
        contentHash: sha256(content), scope: { projectId: item.root, visibility: 'project' }, ...fields })
      const { contentHash: _contentHash, ...unboundRecord } = boundRecord
      const record = omitContentHash ? unboundRecord : boundRecord
      const payload = { record, authority: authority.authorityId, confidence: 1, evidenceRefs: ['unit-fixture-only'] }
      const seal = authority.sealPromotion(canonicalJson({ type: 'knowledge/verified', knowledgeId: record.id, payload }))
      const prior = readKnowledgeEventLog(eventPath, authority)
      appendKnowledgeEvent(eventPath, createKnowledgeEvent('knowledge/verified', record.id, record.scope,
        { ...payload, authorityId: authority.authorityId, authoritySeal: seal },
        { seq: prior.length, previousEventHash: prior.at(-1)?.eventHash ?? null }))
    }
    addSignedRecord('ACL_CANARY', { acl: { readers: ['different-actor'] } })
    addSignedRecord('UNBOUND_CANARY', {}, true)
    addSignedRecord('CHANGED_CANARY', {})
    writeFileSync(join(item.wikiRoot, 'concepts/CHANGED_CANARY.md'), '---\ntitle: CHANGED_CANARY\n---\nRepair changed bytes.')
    writeFileSync(join(item.wikiRoot, 'concepts/UNKNOWN_CANARY.md'), '---\ntitle: UNKNOWN_CANARY\n---\nRepair unknown bytes.')
    const embeddingInputs: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const bodyText = init.body
      if (typeof bodyText !== 'string') throw new Error('expected JSON embedding request body')
      const body = JSON.parse(bodyText) as { input: string[] }
      embeddingInputs.push(body.input)
      return new Response(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0] })) }), { status: 200 })
    }))
    const wiki = service(item, authority, true)
    await expect(wiki.modelSearch({ query: 'repair' }, scope(item))).resolves.toEqual([expect.objectContaining({ path: pagePath })])
    expect(embeddingInputs).toHaveLength(1)
    expect(JSON.stringify(embeddingInputs)).not.toContain('CANARY')
    const graph = await wiki.modelGraph(scope(item))
    expect(graph.nodes.map(node => node.path)).toEqual([pagePath])
    expect(JSON.stringify(graph)).not.toContain('CANARY')
    expect((await wiki.modelList(scope(item))).filter(entry => !entry.isDir).map(entry => entry.path)).toEqual([pagePath])
  })
})
