import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendCandidateReviews, applyCandidateReview, recordCandidateVerification } from '../src/reviews.ts'
import { readKnowledgeEventLog, replayKnowledgeEvents } from '../src/knowledge-governance.ts'
import { canonicalJson, readTrustedReceipt, sha256 } from '../src/verifier.ts'
import type { CandidateTrial, WikiReviewItem } from '../src/types.ts'
import { issueTestReceipt, verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []
const actions = ['Promote', 'Merge', 'Replace', 'Deduplicate'] as const
const authority = verifierAuthority()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The existing authority is a deterministic test fixture, not independent trial evidence.
function fixture(action: typeof actions[number]) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-trial-denial-'))
  roots.push(root)
  const wikiRoot = join(root, 'wiki')
  const candidatePath = '_candidates/ingest/concepts/semantic-check.md'
  const candidateFull = join(wikiRoot, candidatePath)
  const reviewFile = join(root, '.llm-wiki', 'review.json')
  mkdirSync(dirname(candidateFull), { recursive: true })
  writeFileSync(candidateFull, [
    '---', 'type: concept', 'status: candidate', 'origin: ingest',
    'title: Semantic check', 'sources: ["fixture:semantic-check-only"]', '---', '',
    '# Semantic check', '', 'A passing check does not measure useful reuse.',
  ].join('\n'))
  if (action !== 'Promote') {
    const target = join(wikiRoot, 'concepts', 'semantic-check.md')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '# Existing canonical bytes\n')
  }
  appendCandidateReviews(reviewFile, root, 'fixture:semantic-check-only', [`wiki/${candidatePath}`])
  const row = (JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[])[0]!
  const receiptId = issueTestReceipt(authority, reviewFile, wikiRoot, row.id, action)
  expect(recordCandidateVerification(authority, reviewFile, wikiRoot, row.id, receiptId, action)).toBe(true)
  return { root, wikiRoot, reviewFile, row, receiptId, action }
}

function files(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)
      return [path, readFileSync(path).toString('base64')]
    }))
}

describe('semantic verification cannot create measured trial evidence', () => {
  it.each(actions)('keeps %s unresolved without utility credit or any canonical mutation', (action) => {
    const item = fixture(action)
    const row = (JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[])[0]!
    expect(row.verification).toMatchObject({ status: 'passed', successCount: 1, failureCount: 0 })
    expect(row.verification?.evidence.length).toBeGreaterThan(0)
    expect(row.verification?.trial).toBeUndefined()
    expect(row.options?.map(option => option.action)).toEqual(['Archive'])
    const eventPath = join(item.root, '.llm-wiki', 'knowledge-events.jsonl')
    const events = readKnowledgeEventLog(eventPath, authority)
    expect(events.every(event => event.payload.trial === undefined)).toBe(true)
    expect(replayKnowledgeEvents(events).records.get(`candidate:${row.id}`)).toMatchObject({
      verificationStatus: 'verified', lifecycle: 'candidate', retrievalHits: 0, successfulUses: 0, utilityScore: 0,
    })
    const before = files(item.root)
    expect(applyCandidateReview(authority, item.reviewFile, item.root, item.wikiRoot,
      join(item.root, 'archive'), row.id, action)).toBe(false)
    expect(files(item.root)).toEqual(before)
  })

  it.each(actions)('rejects a legacy self-consistent synthetic trial for %s without changing evidence', (action) => {
    const item = fixture(action)
    const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
    const row = rows[0]!
    const receipt = readTrustedReceipt(authority, item.reviewFile, item.receiptId)!
    const evidence = receipt.result.outcomes.flatMap(outcome => outcome.evidence)
    const successfulUses = receipt.result.outcomes.filter(outcome => outcome.result === 'pass').length
    const trial: CandidateTrial = {
      status: 'passed',
      trialHash: sha256(canonicalJson({
        candidateHash: row.candidateHash, receiptHash: receipt.receiptHash, successfulUses, userCorrections: 0, evidence,
      })),
      authorityId: authority.authorityId,
      evidence,
      retrievalHits: receipt.result.outcomes.length,
      successfulUses,
      userCorrections: 0,
      utilityScore: 2,
      startedAt: receipt.result.issuedAt,
      endedAt: receipt.result.issuedAt,
    }
    rows[0] = { ...row, verification: { ...row.verification!, trial } }
    writeFileSync(item.reviewFile, JSON.stringify(rows, null, 2))
    const before = files(item.root)
    expect(applyCandidateReview(authority, item.reviewFile, item.root, item.wikiRoot,
      join(item.root, 'archive'), row.id, action)).toBe(false)
    expect(files(item.root)).toEqual(before)

    // Reverification replaces the mirror and cannot carry an old synthetic trial forward.
    expect(recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, row.id, item.receiptId, action)).toBe(true)
    const refreshed = (JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[])[0]!
    expect(refreshed.verification?.trial).toBeUndefined()
  })
})
