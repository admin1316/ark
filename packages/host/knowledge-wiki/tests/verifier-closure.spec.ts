import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendCandidateReviews, recordCandidateVerification } from '../src/reviews.ts'
import {
  canonicalJson,
  immutableReviewRow,
  readTrustedReceipt,
  sha256,
  verifyCandidate,
  type IndependentVerificationRequest,
  type IndependentVerificationResult,
  type KnowledgeWikiSourceIdentity,
  type KnowledgeWikiVerifierAuthority,
} from '../src/verifier.ts'
import type { WikiReviewItem } from '../src/types.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []
const candidatePath = '_candidates/ingest/concepts/git-identity-normalization.md'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function candidatePage(title = 'Git identity normalization'): string {
  return [
    '---',
    'type: engineering_pattern',
    'status: candidate',
    'origin: ingest',
    `title: ${title}`,
    'sources: ["repo:admin1316/ark:test/sha-normalization"]',
    'related: ["concepts/release-validation"]',
    '---',
    '',
    `# ${title}`,
    '',
    '## 原则',
    '',
    'Representations of one Git object must be normalized before equality checks.',
    '',
    '## 适用条件',
    '',
    'Use this for short and full commit identities during release and disaster validation.',
    '',
    '## 验证证据',
    '',
    'Unit and integration tests resolve both forms to one full commit identity.',
    '',
  ].join('\n')
}

interface Fixture {
  root: string
  wikiRoot: string
  candidatePath: string
  candidateFull: string
  reviewFile: string
  reviewId: string
}

function fixture(path = candidatePath, content = candidatePage()): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wiki-verifier-closure-'))
  roots.push(root)
  const wikiRoot = join(root, 'wiki')
  const candidateFull = join(wikiRoot, path)
  const reviewFile = join(root, '.llm-wiki', 'review.json')
  mkdirSync(dirname(candidateFull), { recursive: true })
  writeFileSync(candidateFull, content, 'utf8')
  appendCandidateReviews(reviewFile, root, 'raw/evidence/sha-test.json', [`wiki/${path}`])
  const reviewId = readItems(reviewFile)[0]!.id
  return { root, wikiRoot, candidatePath: path, candidateFull, reviewFile, reviewId }
}

function readItems(reviewFile: string): WikiReviewItem[] {
  return JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[]
}

function writeItems(reviewFile: string, items: WikiReviewItem[]): void {
  writeFileSync(reviewFile, JSON.stringify(items, null, 2), 'utf8')
}

/** Remove one optional proposal field without inventing a value for it. */
function withoutField(item: WikiReviewItem, field: 'candidatePath' | 'candidateHash'): WikiReviewItem {
  const copy: WikiReviewItem = { ...item }
  Reflect.deleteProperty(copy, field)
  return copy
}

/** Independent authority that genuinely signs a request, then perturbs its own result. */
function authorityReturning(
  mutate: (result: IndependentVerificationResult, request: IndependentVerificationRequest) => IndependentVerificationResult,
): KnowledgeWikiVerifierAuthority {
  const base = verifierAuthority()
  return {
    ...base,
    async verifyCandidate(request, signal) {
      const genuine = await base.verifyCandidate(request, signal)
      return mutate(genuine, request)
    },
  }
}

/** Independent authority whose trusted source/build identity cannot be read. */
function authorityWithoutIdentity(failure: unknown): KnowledgeWikiVerifierAuthority {
  const base = verifierAuthority()
  return {
    ...base,
    sourceIdentity(): KnowledgeWikiSourceIdentity {
      throw failure
    },
  }
}

describe('immutable review projection', () => {
  it('projects a minimal proposal with explicit nulls, empty frozen arrays, and resolved fixed to false', () => {
    const minimal: WikiReviewItem = { id: 'review-1', title: '标题', type: 'suggestion', resolved: true }
    const projection = immutableReviewRow(minimal)

    expect(projection).toEqual({
      id: 'review-1',
      title: '标题',
      type: 'suggestion',
      description: null,
      sourcePath: null,
      affectedPages: [],
      resolved: false,
      createdAt: null,
      searchQueries: [],
      reviewKind: null,
      candidatePath: null,
      candidateHash: null,
      targetPath: null,
    })
    expect(Object.isFrozen(projection)).toBe(true)
    expect(Object.isFrozen(projection['affectedPages'])).toBe(true)
    expect(Object.isFrozen(projection['searchQueries'])).toBe(true)

    const affectedPages = ['wiki/queries/输出语言.md']
    const searchQueries = ['输出语言 提示词']
    const full: WikiReviewItem = {
      id: 'review-2',
      title: '完整',
      type: 'candidate-approval',
      description: 'd',
      sourcePath: '/raw/source.md',
      affectedPages,
      searchQueries,
      resolved: true,
      createdAt: 7,
      reviewKind: 'candidate',
      candidatePath,
      candidateHash: 'a'.repeat(64),
      targetPath: 'concepts/git-identity-normalization.md',
    }
    const copy = immutableReviewRow(full)

    affectedPages.push('wiki/queries/归因.md')
    searchQueries.push('多语言 归因')

    expect(copy).toEqual({
      id: 'review-2',
      title: '完整',
      type: 'candidate-approval',
      description: 'd',
      sourcePath: '/raw/source.md',
      affectedPages: ['wiki/queries/输出语言.md'],
      resolved: false,
      createdAt: 7,
      searchQueries: ['输出语言 提示词'],
      reviewKind: 'candidate',
      candidatePath,
      candidateHash: 'a'.repeat(64),
      targetPath: 'concepts/git-identity-normalization.md',
    })
  })
})

describe('verification review loading', () => {
  it('reports an absent review file and an unknown review id as review-not-found', async () => {
    const item = fixture()
    const signal = new AbortController().signal
    const absent = join(item.root, '.llm-wiki', 'absent.json')

    await expect(verifyCandidate(verifierAuthority(), absent, item.wikiRoot, item.reviewId, 'Promote', signal))
      .resolves.toEqual({ ok: false, evidence: [], errorCode: 'review-not-found' })
    await expect(verifyCandidate(verifierAuthority(), item.reviewFile, item.wikiRoot, 'review-unknown', 'Promote', signal))
      .resolves.toEqual({ ok: false, evidence: [], errorCode: 'review-not-found' })
  })

  it('fails loudly on unparseable and structurally invalid persisted review state', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const signal = new AbortController().signal

    writeFileSync(item.reviewFile, '{broken json', 'utf8')
    await expect(verifyCandidate(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', signal))
      .rejects.toThrow(SyntaxError)

    for (const state of ['{}', 'null', '"text"', '["not-a-row"]', '[null]', '[[1, 2]]']) {
      writeFileSync(item.reviewFile, state, 'utf8')
      await expect(verifyCandidate(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', signal))
        .rejects.toThrow('invalid review state')
    }
  })
})

describe('verification request eligibility', () => {
  it('refuses an ineligible row or an action its durable target cannot support', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const signal = new AbortController().signal
    const original = readItems(item.reviewFile)[0]!
    const rejection = { ok: false, evidence: [], errorCode: 'candidate-invalid' }

    const ineligible: Array<[string, WikiReviewItem]> = [
      ['an advisory row', { ...original, reviewKind: 'advisory' }],
      ['an already resolved row', { ...original, resolved: true }],
      ['a row without a candidate path', withoutField(original, 'candidatePath')],
      ['a row without a candidate hash', withoutField(original, 'candidateHash')],
    ]
    for (const [label, row] of ineligible) {
      writeItems(item.reviewFile, [row])
      const verdict = await verifyCandidate(authority, item.reviewFile, item.wikiRoot, row.id, 'Promote', signal)
      expect(verdict, label).toEqual(rejection)
    }

    const autonomous = fixture('_candidates/topics/disposable.md')
    expect(readItems(autonomous.reviewFile)[0]!.targetPath).toBeUndefined()
    await expect(verifyCandidate(
      authority, autonomous.reviewFile, autonomous.wikiRoot, autonomous.reviewId, 'Promote', signal,
    )).resolves.toEqual(rejection)
  })

  it('refuses a candidate or target that is not a unique ordinary file', async () => {
    const signal = new AbortController().signal
    const rejection = { ok: false, evidence: [], errorCode: 'candidate-invalid' }

    const directoryCandidate = fixture()
    rmSync(directoryCandidate.candidateFull, { recursive: true, force: true })
    mkdirSync(directoryCandidate.candidateFull)
    await expect(verifyCandidate(
      verifierAuthority(), directoryCandidate.reviewFile, directoryCandidate.wikiRoot,
      directoryCandidate.reviewId, 'Promote', signal,
    )).resolves.toEqual(rejection)

    const linkedCandidate = fixture()
    linkSync(linkedCandidate.candidateFull, join(linkedCandidate.wikiRoot, '_candidates/ingest/concepts/twin.md'))
    await expect(verifyCandidate(
      verifierAuthority(), linkedCandidate.reviewFile, linkedCandidate.wikiRoot,
      linkedCandidate.reviewId, 'Promote', signal,
    )).resolves.toEqual(rejection)

    const directoryTarget = fixture()
    mkdirSync(join(directoryTarget.wikiRoot, 'concepts'), { recursive: true })
    const rows = readItems(directoryTarget.reviewFile)
    writeItems(directoryTarget.reviewFile, [{ ...rows[0]!, targetPath: 'concepts' }])
    await expect(verifyCandidate(
      verifierAuthority(), directoryTarget.reviewFile, directoryTarget.wikiRoot,
      directoryTarget.reviewId, 'Archive', signal,
    )).resolves.toEqual(rejection)
  })
})

describe('independent verdict authentication', () => {
  it('rejects a result that fails any coherence or authentication check', async () => {
    const item = fixture()
    const signal = new AbortController().signal
    const mutations: Array<[string, (result: IndependentVerificationResult) => IndependentVerificationResult]> = [
      ['a mismatched authority identity', result => ({ ...result, authorityId: 'impostor-authority' })],
      ['a request hash that does not cover the request', result => ({ ...result, requestHash: 'f'.repeat(64) })],
      ['no declared verification method', result => ({ ...result, methods: [] })],
      ['no independent outcome', result => ({ ...result, outcomes: [] })],
      ['an outcome without evidence', result => ({
        ...result,
        outcomes: [{ name: 'independent-source-review', result: 'pass', evidence: [] }],
      })],
      ['a verdict that contradicts its outcomes', result => ({ ...result, result: 'fail' })],
      ['an unparseable issue time', result => ({ ...result, issuedAt: 'yesterday' })],
      ['an empty proof', result => ({ ...result, proof: '' })],
    ]

    for (const [label, mutate] of mutations) {
      const verdict = await verifyCandidate(
        authorityReturning(mutate), item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', signal,
      )
      expect(verdict, label).toEqual({ ok: false, evidence: [], errorCode: 'verification-failed' })
    }

    const receipts = join(dirname(item.reviewFile), 'verification-receipts')
    expect(existsSync(receipts)).toBe(false)
  })

  it('propagates an authority failure that is not a source-identity rejection', async () => {
    const item = fixture()
    const signal = new AbortController().signal
    const offline = new Error('identity backend offline')

    await expect(verifyCandidate(
      authorityWithoutIdentity(offline), item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', signal,
    )).rejects.toBe(offline)

    const nonError: unknown = { reason: 'identity-unavailable' }
    await expect(verifyCandidate(
      authorityWithoutIdentity(nonError), item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', signal,
    )).rejects.toBe(nonError)
  })
})

describe('stored receipt authentication', () => {
  it('rejects unreadable, mislabelled, and incoherent stored receipts', () => {
    const item = fixture()
    const authority = verifierAuthority()
    const receipts = join(dirname(item.reviewFile), 'verification-receipts')
    mkdirSync(receipts, { recursive: true })

    writeFileSync(join(receipts, 'verification-unparseable.json'), '{not json', 'utf8')
    expect(readTrustedReceipt(authority, item.reviewFile, 'verification-unparseable')).toBeUndefined()
    expect(readTrustedReceipt(authority, item.reviewFile, 'verification-absent')).toBeUndefined()

    writeFileSync(join(receipts, 'verification-null.json'), 'null', 'utf8')
    expect(readTrustedReceipt(authority, item.reviewFile, 'verification-null')).toBeUndefined()
    writeFileSync(join(receipts, 'verification-v3.json'), JSON.stringify({ schemaVersion: 3, id: 'verification-v3' }), 'utf8')
    expect(readTrustedReceipt(authority, item.reviewFile, 'verification-v3')).toBeUndefined()

    writeFileSync(
      join(receipts, 'verification-mislabelled.json'),
      JSON.stringify({ schemaVersion: 2, id: 'verification-other' }),
      'utf8',
    )
    expect(readTrustedReceipt(authority, item.reviewFile, 'verification-mislabelled')).toBeUndefined()

    // A receipt whose own bytes hash correctly but whose outcome list is not a
    // list of outcomes must still be rejected when it is read back.
    const request = { schemaVersion: 2 }
    const result = {
      authorityId: 'test-independent-verifier',
      requestHash: sha256(canonicalJson(request)),
      result: 'pass',
      methods: ['integration_test'],
      outcomes: [null],
      issuedAt: '2026-09-04T00:00:00.000Z',
      proof: 'independent-proof',
    }
    const unsigned = { schemaVersion: 2, id: 'verification-null-outcome', request, result }
    writeFileSync(
      join(receipts, 'verification-null-outcome.json'),
      JSON.stringify({ ...unsigned, receiptHash: sha256(canonicalJson(unsigned)) }),
      'utf8',
    )
    expect(readTrustedReceipt(authority, item.reviewFile, 'verification-null-outcome')).toBeUndefined()
    expect(recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'verification-unparseable', 'Promote',
    )).toBe(false)
    expect(recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'verification-null-outcome', 'Promote',
    )).toBe(false)
  })
})
