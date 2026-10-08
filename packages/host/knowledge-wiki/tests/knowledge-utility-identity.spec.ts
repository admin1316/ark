import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import KnowledgeWikiService from '../src/index.ts'
import {
  createKnowledgeEvent,
  readKnowledgeEventLog,
  replayKnowledgeEvents,
} from '../src/knowledge-governance.ts'
import {
  appendCandidateReviews,
  applyCandidateReview,
  recordCandidateVerification,
} from '../src/reviews.ts'
import type { KnowledgeEvent, WikiReviewItem } from '../src/types.ts'
import { wikiTestConfig } from './config-fixture.ts'
import { issueTestReceipt, verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(governed = true) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-utility-identity-'))
  roots.push(root)
  const wikiRoot = join(root, 'wiki')
  const path = 'concepts/utility-claim.md'
  const reviewFile = join(root, '.llm-wiki', 'review.json')
  const eventsFile = join(root, '.llm-wiki', 'knowledge-events.jsonl')
  const utilityFile = join(root, '.llm-wiki', 'knowledge-utility.json')
  const authority = verifierAuthority()
  let knowledgeId: string | undefined
  if (governed) {
    const candidatePath = '_candidates/ingest/concepts/utility-claim.md'
    const candidate = join(wikiRoot, candidatePath)
    mkdirSync(dirname(candidate), { recursive: true })
    writeFileSync(candidate, `---
type: concept
status: candidate
title: Utility claim
sources: ["repo:ark/docs/architecture.md"]
related: ["concepts/governance"]
---

# Utility claim

## 原则

${'A reusable utility claim needs source evidence, verification, applicability and rollback. '.repeat(8)}

## 适用条件

Use only when the verification gate passes and the source is unchanged.

## 验证证据

An independent test covers the source, applicability and rollback boundary.
`, 'utf8')
    expect(appendCandidateReviews(reviewFile, root, 'raw/source.md', [`wiki/${candidatePath}`])).toBe(1)
    const item = (JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[])[0]!
    const receipt = issueTestReceipt(authority, reviewFile, wikiRoot, item.id, 'Promote')
    expect(recordCandidateVerification(authority, reviewFile, wikiRoot, item.id, receipt, 'Promote')).toBe(true)
    expect(applyCandidateReview(authority, reviewFile, root, wikiRoot, join(root, 'archive'), item.id, 'Promote')).toBe(true)
    knowledgeId = `candidate:${item.id}`
  } else {
    mkdirSync(dirname(join(wikiRoot, path)), { recursive: true })
    writeFileSync(join(wikiRoot, path), '# Utility claim\n\nA legacy utility claim.', 'utf8')
  }
  const ctx = new Context()
  contexts.push(ctx)
  Object.defineProperty(ctx, 'credentials', {
    configurable: true,
    value: { resolve: vi.fn().mockResolvedValue(undefined) },
  })
  Object.defineProperty(ctx, 'llm', { configurable: true, value: { stream: vi.fn() } })
  if (governed) ctx.provide('knowledgeWikiVerifierAuthority', authority)
  const service = new KnowledgeWikiService(ctx, wikiTestConfig({ wikiRoot, mainRoot: root }))
  const events = () => readKnowledgeEventLog(eventsFile, governed ? authority : undefined)
  const record = () => replayKnowledgeEvents(events()).records.get(knowledgeId!)!
  return { root, path, service, events, record, knowledgeId, eventsFile, utilityFile }
}

describe('governed knowledge utility identity', () => {
  it('replays retrieval, page injection and feedback against the admitted candidate record', async () => {
    const value = fixture()
    const before = value.record()
    const modelPage = await value.service.modelPageContent({ path: value.path }, {
      projectId: value.root, workspaceId: value.root, sessionId: 'utility-reuse-session',
    })
    expect(modelPage.provenance.knowledgeId).toBe(value.knowledgeId)
    expect(value.record().retrievalHits).toBe(before.retrievalHits + 1)
    expect((await value.service.search({ query: 'utility claim', topK: 1 }))[0]?.path).toBe(value.path)
    expect(value.record().retrievalHits).toBe(before.retrievalHits + 2)
    expect((await value.service.pageContent({ path: value.path })).content).toContain('Utility claim')
    expect(await value.service.recordKnowledgeOutcome({
      paths: [value.path, value.path], outcome: 'successful',
    })).toBe(1)
    const feedback = value.events().filter(event => event.payload.outcome === 'successful').at(-1)
    expect(feedback).toMatchObject({
      type: 'knowledge/injected', knowledgeId: value.knowledgeId,
      payload: { outcomeSource: 'user-feedback' },
    })
    expect(feedback?.payload.authoritySeal).toBeUndefined()
    expect(value.record().successfulUses).toBe(before.successfulUses + 1)
    expect(value.events().filter(event => event.type === 'knowledge/retrieved'
      || event.type === 'knowledge/injected').every(event => event.knowledgeId === value.knowledgeId)).toBe(true)
    expect((await value.service.knowledgeUtility())[0]).toMatchObject({
      path: value.path,
      retrievalHits: value.record().retrievalHits,
      successfulUses: value.record().successfulUses,
      utilityScore: value.record().utilityScore,
    })
  })

  it('records a correction on the same identity and prevents subsequent governed reuse', async () => {
    const value = fixture()
    const before = value.record()
    await value.service.search({ query: 'utility claim' })
    expect(await value.service.recordKnowledgeOutcome({ paths: [value.path], outcome: 'corrected' })).toBe(1)
    expect(value.record()).toMatchObject({
      id: value.knowledgeId,
      userCorrections: before.userCorrections + 1,
      verificationStatus: 'rejected',
    })
    expect(value.events().at(-1)).toMatchObject({
      type: 'knowledge/rejected', knowledgeId: value.knowledgeId,
      payload: { repairRule: 'do-not-reuse-until-independent-review' },
    })
    expect(await value.service.search({ query: 'utility claim' })).toEqual([])
    expect(await value.service.pageContent({ path: value.path })).toEqual({ path: value.path, content: '' })
  })

  it('uses journal counters when the utility projection is edited', async () => {
    const value = fixture()
    await value.service.search({ query: 'utility claim' })
    const before = value.record()
    writeFileSync(value.utilityFile, JSON.stringify({
      [value.path]: {
        path: value.path, retrievalHits: 999, successfulUses: 999,
        userCorrections: 0, utilityScore: 999,
      },
    }))
    expect((await value.service.knowledgeUtility())[0]).toMatchObject({
      retrievalHits: before.retrievalHits, successfulUses: before.successfulUses, utilityScore: before.utilityScore,
    })
    await value.service.recordKnowledgeOutcome({ paths: [value.path], outcome: 'successful' })
    expect(value.record().successfulUses).toBe(before.successfulUses + 1)
    expect((await value.service.knowledgeUtility())[0]?.successfulUses).toBe(before.successfulUses + 1)
    await value.service.search({ query: 'utility claim' })
    expect(value.record().retrievalHits).toBe(before.retrievalHits + 1)
  })

  it('rejects a rehashed stream with a forged configured-authority seal', async () => {
    const value = fixture()
    await value.service.search({ query: 'utility claim' })
    const rebuilt: KnowledgeEvent[] = []
    for (const event of value.events()) {
      const payload = event.type === 'knowledge/promoted'
        ? { ...event.payload, authoritySeal: { authorityId: 'test-independent-verifier', proof: 'forged' } }
        : event.payload
      rebuilt.push(createKnowledgeEvent(event.type, event.knowledgeId, event.scope, payload, {
        seq: rebuilt.length, previousEventHash: rebuilt.at(-1)?.eventHash ?? null,
        timestamp: event.timestamp, id: event.id,
        ...(event.sourceHash === undefined ? {} : { sourceHash: event.sourceHash }),
      }))
    }
    writeFileSync(value.eventsFile, rebuilt.map(event => JSON.stringify(event)).join('\n') + '\n')
    await expect(value.service.knowledgeUtility()).rejects.toThrow('knowledge verification event seal failed')
    await expect(value.service.recordKnowledgeOutcome({ paths: [value.path], outcome: 'successful' }))
      .rejects.toThrow('knowledge verification event seal failed')
    expect(await value.service.search({ query: 'utility claim' })).toEqual([])
  })

  it('preserves unconfigured legacy page audit facts without inventing governed records', async () => {
    const value = fixture(false)
    expect((await value.service.search({ query: 'utility claim' }))[0]?.path).toBe(value.path)
    expect((await value.service.pageContent({ path: value.path })).content).toContain('legacy')
    expect(await value.service.recordKnowledgeOutcome({ paths: [value.path], outcome: 'successful' })).toBe(1)
    expect(replayKnowledgeEvents(value.events()).records.size).toBe(0)
    expect(value.events().every(event => event.knowledgeId === `page:${value.path}`)).toBe(true)
    expect((await value.service.knowledgeUtility())[0]).toMatchObject({
      path: value.path, retrievalHits: 1, successfulUses: 1,
    })
  })
})
