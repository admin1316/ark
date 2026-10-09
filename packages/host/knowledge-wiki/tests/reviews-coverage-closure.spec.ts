import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendCandidateReviews, applyCandidateReview, assertPromotionOperationConfined,
  promotionOperation, recordCandidateVerification, recoverCandidateReviewTransactions,
} from '../src/reviews.ts'
import {
  appendKnowledgeEvent, createKnowledgeEvent, createKnowledgeRecord,
  readKnowledgeEventLog,
} from '../src/knowledge-governance.ts'
import { canonicalJson, sha256, type VerificationAuthoritySeal } from '../src/verifier.ts'
import type { KnowledgeRecord, WikiReviewItem } from '../src/types.ts'
import { issueTestReceipt, verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []
const authority = verifierAuthority()
const interrupted = new Error('fixture stopped after durable journal')
const content = '---\ntype: concept\nstatus: candidate\norigin: ingest\ntitle: Coverage closure\nsources: ["fixture:review-closure"]\n---\n\n# Coverage closure\n\nA bounded method with explicit evidence and rollback.\n'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  root: string
  wikiRoot: string
  archiveRoot: string
  reviewFile: string
  candidatePath: string
  candidate: string
  eventPath: string
  reviewId: string
}

interface Journal {
  schemaVersion: 1
  id: string
  reviewId: string
  candidateHash: string
  createdAt: string
  action: string
  targetPath: string | null
  reviewHash: string | null
  receiptId: string | null
  receiptHash: string | null
  operationSetHash: string
  operations: ReturnType<typeof promotionOperation>[]
  state: string
  seal: VerificationAuthoritySeal
}

function rows(item: Fixture): WikiReviewItem[] {
  return JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
}

function writeRows(item: Fixture, values: WikiReviewItem[]): void {
  writeFileSync(item.reviewFile, JSON.stringify(values, null, 2))
}

function fixture(source = 'fixture:review-closure', peerId?: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wiki-reviews-coverage-'))
  roots.push(root)
  const wikiRoot = join(root, 'wiki')
  const candidatePath = '_candidates/sessions/coverage-closure.md'
  const candidate = join(wikiRoot, candidatePath)
  const reviewFile = join(root, '.llm-wiki', 'review.json')
  const eventPath = join(dirname(reviewFile), 'knowledge-events.jsonl')
  mkdirSync(dirname(candidate), { recursive: true })
  mkdirSync(dirname(reviewFile), { recursive: true })
  writeFileSync(candidate, content)
  if (peerId !== undefined) {
    const record = createKnowledgeRecord({
      id: peerId, content: 'A different claim requiring independent review.',
      claimKey: 'coverage closure', source: '_candidates/sessions/prior.md',
      scope: { projectId: root, visibility: 'project' },
    })
    const observed = createKnowledgeEvent('knowledge/observed', record.id, record.scope, { record })
    appendKnowledgeEvent(eventPath, observed)
    appendKnowledgeEvent(eventPath, createKnowledgeEvent('knowledge/candidate', record.id, record.scope, { record }, {
      seq: 1, previousEventHash: observed.eventHash,
    }))
    if (peerId === 'candidate:advisory-peer') {
      writeFileSync(reviewFile, JSON.stringify([{
        id: 'advisory-peer', title: 'Earlier advisory', type: 'suggestion', reviewKind: 'advisory', resolved: false,
      } satisfies WikiReviewItem]))
    }
  }
  expect(appendCandidateReviews(reviewFile, root, source, [`wiki/${candidatePath}`])).toBe(1)
  const item = { root, wikiRoot, archiveRoot: join(root, 'archive'), reviewFile, candidatePath, candidate, eventPath, reviewId: '' }
  const review = rows(item).find(value => value.reviewKind === 'candidate')
  if (review === undefined) throw new Error('fixture failed to register its candidate')
  return { ...item, reviewId: review.id }
}

function apply(item: Fixture): boolean | null {
  return applyCandidateReview(authority, item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive')
}

function verify(item: Fixture): boolean {
  const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Archive')
  return recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Archive')
}

function prepare(item: Fixture): { path: string; journal: Journal } {
  expect(() => applyCandidateReview({
    ...authority,
    checkpointPromotion(_payload, checkpoint) {
      if (checkpoint.phase === 'journal-persisted') throw interrupted
    },
  }, item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive')).toThrow(interrupted)
  const directory = join(dirname(item.reviewFile), 'promotion-journal')
  const names = readdirSync(directory).filter(name => name.endsWith('.json'))
  expect(names).toHaveLength(1)
  const path = join(directory, names[0]!)
  const journal = JSON.parse(readFileSync(path, 'utf8')) as Journal
  expect(journal.state).toBe('prepared')
  return { path, journal }
}

function operation(journal: Journal, role: ReturnType<typeof promotionOperation>['role']): ReturnType<typeof promotionOperation> {
  const found = journal.operations.find(value => value.role === role)
  if (found === undefined) throw new Error(`fixture lacks ${role} operation`)
  return found
}

function reseal(path: string, journal: Journal): void {
  const { state, seal: _seal, ...core } = journal
  const updated = { ...core, operationSetHash: sha256(canonicalJson(core.operations)) }
  writeFileSync(path, JSON.stringify({ ...updated, state, seal: authority.sealPromotion(canonicalJson(updated)) }))
}

function recover(item: Fixture): number {
  return recoverCandidateReviewTransactions(authority, item.reviewFile, item.wikiRoot, item.archiveRoot)
}

function files(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)
      return [path, readFileSync(path).toString('base64')]
    }))
}

function writeVerifiedAdmission(item: Fixture, changes: Partial<KnowledgeRecord>): void {
  const record = createKnowledgeRecord({
    id: `candidate:${item.reviewId}`, content, source: item.candidatePath,
    scope: { projectId: item.root, visibility: 'project' }, confidence: 0.9,
    expiresAt: '2099-10-09T00:00:00.000Z', ...changes,
  })
  const payload = { record, authority: authority.authorityId, confidence: 0.9, evidenceRefs: ['fixture:authenticated-admission'] }
  const authoritySeal = authority.sealPromotion(canonicalJson({ type: 'knowledge/verified', knowledgeId: record.id, payload }))
  writeFileSync(item.eventPath, JSON.stringify(createKnowledgeEvent('knowledge/verified', record.id, record.scope, {
    ...payload, authorityId: authority.authorityId, authoritySeal,
  })) + '\n')
}

describe('review provenance and independent lifecycle fences', () => {
  it('rejects blank provenance before admitting it as independently governed knowledge', () => {
    expect(() => fixture('   ')).toThrow('evidenceRefs are invalid')
    const root = roots.at(-1)!
    expect(existsSync(join(root, '.llm-wiki', 'knowledge-events.jsonl'))).toBe(false)
    expect(readFileSync(join(root, 'wiki', '_candidates/sessions/coverage-closure.md'), 'utf8')).toBe(content)
  })

  it.each(['orphan-claim', 'candidate:advisory-peer'])('retains an unrelated conflicting %s without inventing a candidate review for it', (peerId) => {
    const item = fixture('fixture:review-closure', peerId)
    const events = readKnowledgeEventLog(item.eventPath)
    expect(events.filter(event => event.type === 'knowledge/conflict')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ knowledgeId: `candidate:${item.reviewId}`, payload: { conflictIds: [peerId] } })
    expect(rows(item).filter(value => value.reviewKind === 'candidate')).toHaveLength(1)
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Archive')
    const before = files(item.root)
    expect(recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Archive')).toBe(false)
    expect(files(item.root)).toEqual(before)
    expect(apply(item)).toBe(false)
    expect(readFileSync(item.candidate, 'utf8')).toBe(content)
  })

  it.each(['knowledge/expired', 'knowledge/conflict'] as const)('refuses stale verification and Archive after %s despite an unchanged review row', (type) => {
    const item = fixture()
    const prior = readKnowledgeEventLog(item.eventPath).at(-1)!
    appendKnowledgeEvent(item.eventPath, createKnowledgeEvent(type, `candidate:${item.reviewId}`, prior.scope, {}, {
      seq: prior.seq + 1, previousEventHash: prior.eventHash,
    }))
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Archive')
    const before = files(item.root)
    expect(recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Archive')).toBe(false)
    expect(apply(item)).toBe(false)
    expect(files(item.root)).toEqual(before)
  })

  it.each([
    { name: 'project scope', changes: { scope: { projectId: 'other-project', visibility: 'project' as const } } },
    { name: 'reader ACL', changes: { acl: { readers: ['another-actor'] } } },
    { name: 'expired bytes', changes: { createdAt: '1999-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:00:00.000Z' } },
  ])('denies Archive at the actual mutation entry for an independent $name admission', ({ changes }) => {
    const item = fixture()
    writeVerifiedAdmission(item, changes)
    const before = files(item.root)
    expect(apply(item)).toBe(false)
    expect(files(item.root)).toEqual(before)
  })

  it('verifies a legacy durable row without optional provenance or timestamp fields using the candidate identity', () => {
    const item = fixture()
    const { sourceHash: _hash, sourcePath: _source, createdAt: _created, ...legacy } = rows(item)[0]!
    writeRows(item, [legacy])
    unlinkSync(item.eventPath)
    expect(verify(item)).toBe(true)
    const events = readKnowledgeEventLog(item.eventPath, authority)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'knowledge/verified', seq: 0, previousEventHash: null,
      payload: { source: item.candidatePath, record: { sourceHash: sha256(item.candidatePath), evidenceRefs: [item.candidatePath] } },
    })
    expect(rows(item)[0]?.options?.map(value => value.action)).toEqual(['Archive'])
    expect(readFileSync(item.candidate, 'utf8')).toBe(content)
  })

  it('archives an unchanged legacy row without synthesizing verification or canonical knowledge', () => {
    const item = fixture()
    unlinkSync(item.eventPath)
    expect(apply(item)).toBe(true)
    expect(existsSync(item.candidate)).toBe(false)
    expect(rows(item)[0]).toMatchObject({ resolved: true, resolvedAction: 'Archive' })
    const events = readKnowledgeEventLog(item.eventPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'knowledge/rejected', seq: 0, previousEventHash: null })
    expect(events.some(event => event.type === 'knowledge/promoted' || event.type === 'knowledge/verified')).toBe(false)
  })
})

describe('sealed Archive WAL ownership and recovery', () => {
  it.each(['stagingPath', 'tombstonePath'] as const)('rejects a %s outside its operation parent before writing either path', (auxiliary) => {
    const item = fixture()
    const owned = promotionOperation('fixture-confined', 0, 'candidate', item.candidate, content, auxiliary === 'stagingPath' ? 'replacement' : undefined)
    const escaped = join(item.root, 'other-parent', 'escaped')
    const before = files(item.root)
    expect(() => {
      assertPromotionOperationConfined({ ...owned, [auxiliary]: escaped }, item.reviewFile, item.wikiRoot, item.archiveRoot)
    }).toThrow('promotion auxiliary path changed parent')
    expect(files(item.root)).toEqual(before)
    expect(existsSync(escaped)).toBe(false)
  })

  it.each(['missing append', 'changed prefix'] as const)('rejects an authentically fixture-sealed Archive with %s lifecycle bytes', (mutation) => {
    const item = fixture()
    const prepared = prepare(item)
    prepared.journal.operations = prepared.journal.operations.map((value) => {
      if (value.role !== 'governance') return value
      if (mutation === 'changed prefix') return { ...value, before: 'different prior audit\n' }
      const { after: _after, ...withoutAppend } = value
      return withoutAppend
    })
    reseal(prepared.path, prepared.journal)
    const before = files(item.root)
    expect(() => recover(item)).toThrow('Archive journal lifecycle binding failed')
    expect(files(item.root)).toEqual(before)
  })

  it('rejects a signed WAL pre-state whose review lost its candidate path without mutating live bytes', () => {
    const item = fixture()
    const prepared = prepare(item)
    const review = operation(prepared.journal, 'review')
    const sourceRows = JSON.parse(review.before!) as WikiReviewItem[]
    const { candidatePath: _path, ...missingPath } = sourceRows[0]!
    prepared.journal.operations = prepared.journal.operations.map(value => value.role === 'review'
      ? { ...value, before: JSON.stringify([missingPath]) } : value)
    reseal(prepared.path, prepared.journal)
    const before = files(item.root)
    expect(() => recover(item)).toThrow('Archive journal operation identity mismatch')
    expect(files(item.root)).toEqual(before)
  })

  it('preserves every unrelated advisory row when completing an interrupted Archive', () => {
    const item = fixture()
    const advisory: WikiReviewItem = { id: 'unrelated', title: 'Pending advisory', type: 'suggestion', reviewKind: 'advisory', resolved: false }
    writeRows(item, [...rows(item), advisory])
    prepare(item)
    expect(recover(item)).toBe(1)
    expect(rows(item)[1]).toEqual(advisory)
    expect(rows(item)[0]).toMatchObject({ resolved: true, resolvedAction: 'Archive' })
    expect(readKnowledgeEventLog(item.eventPath).filter(event => event.type === 'knowledge/rejected')).toHaveLength(1)
    const committed = files(item.root)
    expect(recover(item)).toBe(0)
    expect(files(item.root)).toEqual(committed)
  })
})
