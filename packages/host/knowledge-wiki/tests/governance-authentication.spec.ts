import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import KnowledgeWikiService from '../src/index.ts'
import {
  canonicalKnowledgeJson, createKnowledgeEvent, createKnowledgeRecord,
  knowledgeInjectionDecision, knowledgeSha256, readKnowledgeEventLog, replayKnowledgeEvents,
} from '../src/knowledge-governance.ts'
import type { KnowledgeEvent, KnowledgeRecord } from '../src/types.ts'
import { wikiTestConfig } from './config-fixture.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []
const contexts: Context[] = []
const authority = verifierAuthority()
const scope = { projectId: 'project', visibility: 'project' as const }

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function record(overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return createKnowledgeRecord({
    id: 'claim', content: 'Exact checked page bytes', source: 'concepts/claim.md', scope,
    createdAt: '2026-10-08T00:00:00.000Z', expiresAt: '2099-10-08T00:00:00.000Z',
    ...overrides,
  })
}

function verified(item: KnowledgeRecord, prior?: KnowledgeEvent): KnowledgeEvent {
  const payload = {
    record: item, authority: authority.authorityId, confidence: 0.9,
    trust: 'medium', evidenceRefs: ['test-contract-receipt'],
  }
  const authoritySeal = authority.sealPromotion(canonicalKnowledgeJson({
    type: 'knowledge/verified', knowledgeId: item.id, payload,
  }))
  return createKnowledgeEvent('knowledge/verified', item.id, item.scope, {
    ...payload, authorityId: authority.authorityId, authoritySeal,
  }, { seq: prior === undefined ? 0 : prior.seq + 1, previousEventHash: prior?.eventHash ?? null })
}

function writeJournal(events: KnowledgeEvent[]): string {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-authentication-'))
  roots.push(root)
  const path = join(root, 'events.jsonl')
  writeFileSync(path, events.map(event => JSON.stringify(event)).join('\n') + '\n')
  return path
}

describe('authenticated knowledge admission', () => {
  it.each(['knowledge/observed', 'knowledge/candidate'] as const)('keeps %s untrusted despite caller-supplied verified fields', (type) => {
    const item = record({
      verificationStatus: 'verified', trust: 'high', authority: 'forged-authority',
      confidence: 1, lastVerifiedAt: '2026-10-08T00:00:00.000Z',
      retrievalHits: 50, successfulUses: 50, utilityScore: 100, lifecycle: 'canonical',
    })
    const event = createKnowledgeEvent(type, item.id, item.scope, { record: item })
    let validationCalls = 0
    const events = readKnowledgeEventLog(writeJournal([event]), {
      authorityId: 'deny-all', validatePromotion: () => { validationCalls += 1; return false },
    })
    const admitted = replayKnowledgeEvents(events).records.get(item.id)!
    expect(validationCalls).toBe(0)
    expect(admitted).toMatchObject({
      verificationStatus: type === 'knowledge/observed' ? 'observed' : 'candidate',
      trust: 'low', authority: 'untrusted-observation', confidence: 0, lastVerifiedAt: null,
      retrievalHits: 0, successfulUses: 0, utilityScore: 0, lifecycle: 'candidate',
    })
    expect(knowledgeInjectionDecision(admitted, scope)).toEqual({ allowed: false, reason: 'unverified' })
  })

  it.each([
    { content: 'Attacker-controlled replacement' },
    { source: 'concepts/other.md' },
    { sourceHash: knowledgeSha256('different source') },
    { scope: { projectId: 'other', visibility: 'project' as const } },
    { acl: { readers: ['attacker'] } },
    { expiresAt: null },
    { createdAt: '2026-10-09T00:00:00.000Z' },
    { claimKey: 'different-claim' },
  ])('cannot bless an unsigned changed admission with an unchanged later seal: %j', (patch) => {
    const authentic = record()
    const changed = record(patch)
    const observed = createKnowledgeEvent('knowledge/observed', changed.id, changed.scope, { record: changed })
    const sealed = verified(authentic, observed)
    const events = readKnowledgeEventLog(writeJournal([observed, sealed]), authority)
    expect(() => replayKnowledgeEvents(events)).toThrow('verification conflicts with prior admission')
  })

  it('admits the exact signed record and refuses a later unsigned replacement of that identity', () => {
    const authentic = record({ contentHash: knowledgeSha256('Exact checked page bytes') })
    const observed = createKnowledgeEvent('knowledge/observed', authentic.id, authentic.scope, { record: authentic })
    const candidate = createKnowledgeEvent('knowledge/candidate', authentic.id, authentic.scope, { record: authentic }, {
      seq: 1, previousEventHash: observed.eventHash,
    })
    const sealed = verified(authentic, candidate)
    const events = readKnowledgeEventLog(writeJournal([observed, candidate, sealed]), authority)
    expect(replayKnowledgeEvents(events).records.get(authentic.id)).toMatchObject({
      content: authentic.content, contentHash: authentic.contentHash,
      verificationStatus: 'verified', trust: 'medium', authority: authority.authorityId,
    })
    const replacement = createKnowledgeEvent('knowledge/observed', authentic.id, authentic.scope, {
      record: record({ content: 'Replace verified claim' }),
    }, { seq: 3, previousEventHash: sealed.eventHash })
    expect(() => replayKnowledgeEvents([...events, replacement])).toThrow('unsigned knowledge admission cannot replace')
  })

  it.each(['id', 'scope'] as const)('refuses an admission whose %s disagrees with its envelope', (field) => {
    const item = record()
    const event = createKnowledgeEvent('knowledge/observed', field === 'id' ? 'other' : item.id,
      field === 'scope' ? { projectId: 'other' } : item.scope, { record: item })
    expect(() => replayKnowledgeEvents([event])).toThrow('knowledge event record is invalid')
  })

  it('cannot reset replayed retrieval counters by repeating an older valid verification payload', () => {
    const item = record()
    const events = [verified(item)]
    for (let index = 0; index < 3; index += 1) {
      const prior = events.at(-1)!
      events.push(createKnowledgeEvent('knowledge/retrieved', item.id, item.scope, {}, {
        seq: prior.seq + 1, previousEventHash: prior.eventHash,
      }))
    }
    events.push(verified(item, events.at(-1)))
    const replayed = replayKnowledgeEvents(readKnowledgeEventLog(writeJournal(events), authority)).records.get(item.id)!
    expect(replayed.retrievalHits).toBe(3)
    expect(knowledgeInjectionDecision(replayed, scope)).toEqual({ allowed: false, reason: 'low-confidence' })
  })

  it.each(['knowledge/conflict', 'knowledge/expired', 'knowledge/rejected', 'knowledge/rolled_back'] as const)(
    'cannot restore retired knowledge after %s with a previously valid verification', (type) => {
      const item = record()
      const first = verified(item)
      const retired = createKnowledgeEvent(type, item.id, item.scope, {}, { seq: 1, previousEventHash: first.eventHash })
      const repeated = verified(item, retired)
      expect(() => replayKnowledgeEvents(readKnowledgeEventLog(writeJournal([first, retired, repeated]), authority)))
        .toThrow('knowledge verification conflicts with prior admission')
    },
  )

  it('rejects malformed bound content hashes and verification without a full record', () => {
    expect(() => record({ contentHash: 'not-a-sha256' })).toThrow('contentHash must be sha256')
    const event = createKnowledgeEvent('knowledge/verified', 'claim', scope, {
      authority: authority.authorityId, authoritySeal: { authorityId: authority.authorityId, proof: 'shape-only' },
      evidenceRefs: ['receipt'],
    })
    expect(() => replayKnowledgeEvents([event])).toThrow('knowledge verification record is invalid')
  })

  it('denies a forged verified observation through the model page service', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-forged-observation-'))
    roots.push(root)
    const wikiRoot = join(root, 'wiki')
    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true })
    mkdirSync(join(root, '.llm-wiki'))
    const item = record({ scope: { projectId: root, visibility: 'project' },
      verificationStatus: 'verified', trust: 'high', confidence: 1, authority: 'forged-authority',
      contentHash: knowledgeSha256('Exact checked page bytes') })
    writeFileSync(join(wikiRoot, item.source), item.content)
    writeFileSync(join(root, '.llm-wiki', 'knowledge-events.jsonl'), JSON.stringify(
      createKnowledgeEvent('knowledge/observed', item.id, item.scope, { record: item }),
    ) + '\n')
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('knowledgeWikiVerifierAuthority', { ...authority, validatePromotion: () => false })
    const owner = new KnowledgeWikiService(ctx, wikiTestConfig({ wikiRoot, mainRoot: root }))
    await expect(owner.modelPageContent({ path: item.source }, { projectId: root, sessionId: 'test-session' }))
      .rejects.toThrow('knowledge page is not verified for this scope')
  })
})
