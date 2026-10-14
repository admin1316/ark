import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendCandidateReviews,
  appendReviews,
  applyCandidateReview as applyCandidateReviewWithAuthority,
  parseReviewBlocks,
  recordCandidateVerification as recordCandidateVerificationWithAuthority,
} from '../src/reviews.ts'
import {
  appendKnowledgeEvent,
  createKnowledgeEvent,
  createKnowledgeRecord,
  knowledgeSha256,
  readKnowledgeEventLog,
} from '../src/knowledge-governance.ts'
import { issueTestReceipt, verifierAuthority } from './verifier-authority-fixture.ts'
import type { CandidateVerification, WikiReviewItem } from '../src/types.ts'

const roots: string[] = []
const authority = verifierAuthority()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'wiki-review-lifecycle-'))
  roots.push(value)
  return value
}

function candidate(title = 'Candidate', body = 'stable method, validation evidence, boundary, and rollback '.repeat(8)): string {
  return `---
type: concept
status: candidate
origin: ingest
title: ${title}
sources: ["repo:ark/docs/architecture.md"]
related: ["concepts/governance"]
---

# ${title}

## 原则

${body}

## 适用条件

Use when the verification gate passes.

## 验证证据

测试通过并完成实际请求验收和回滚点检查。
`
}

interface Fixture {
  root: string
  wikiRoot: string
  archiveRoot: string
  reviewFile: string
  candidatePath: string
  candidateFull: string
  reviewId: string
}

function fixture(
  candidatePath = '_candidates/ingest/concepts/candidate.md',
  content = candidate(),
): Fixture {
  const projectRoot = root()
  const wikiRoot = join(projectRoot, 'wiki')
  const candidateFull = join(wikiRoot, candidatePath)
  const reviewFile = join(projectRoot, '.llm-wiki', 'review.json')
  mkdirSync(dirname(candidateFull), { recursive: true })
  writeFileSync(candidateFull, content, 'utf8')
  expect(appendCandidateReviews(reviewFile, projectRoot, 'raw/source.md', [`wiki/${candidatePath}`])).toBe(1)
  const reviewId = readItems(reviewFile)[0]!.id
  return {
    root: projectRoot,
    wikiRoot,
    archiveRoot: join(projectRoot, 'archive'),
    reviewFile,
    candidatePath,
    candidateFull,
    reviewId,
  }
}

function readItems(reviewFile: string): WikiReviewItem[] {
  return JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[]
}

function writeItems(reviewFile: string, items: WikiReviewItem[]): void {
  writeFileSync(reviewFile, JSON.stringify(items, null, 2), 'utf8')
}

function verification(overrides: Partial<Omit<CandidateVerification, 'candidateHash'>> = {}): Omit<CandidateVerification, 'candidateHash'> {
  return {
    status: 'passed',
    methods: ['unit_test'],
    evidence: ['test:wiki-review'],
    receipts: [{
      id: 'receipt-wiki-review',
      path: 'output/wiki-review.json',
      receiptHash: 'a'.repeat(64),
      environmentHash: 'b'.repeat(64),
      result: 'pass',
      gitCommit: 'abc1234',
    }],
    confidence: 1,
    successCount: 1,
    failureCount: 0,
    verifiedBy: 'deterministic-executor',
    ...overrides,
  }
}

async function recordCandidateVerification(
  reviewFile: string,
  wikiRoot: string,
  reviewId: string,
  receipt: unknown,
  action: CandidateVerification['action'] = 'Promote',
): Promise<boolean> {
  return recordCandidateVerificationWithAuthority(authority, reviewFile, wikiRoot, reviewId, receipt, action)
}

async function applyCandidateReview(
  reviewFile: string,
  projectRoot: string,
  wikiRoot: string,
  archiveRoot: string,
  reviewId: string,
  action: string,
  actor?: string,
): Promise<boolean | null> {
  return applyCandidateReviewWithAuthority(
    authority, reviewFile, projectRoot, wikiRoot, archiveRoot, reviewId, action, actor,
  )
}

async function verifyReview(
  reviewFile: string,
  wikiRoot: string,
  reviewId: string,
  requestedAction?: NonNullable<CandidateVerification['action']>,
): Promise<boolean> {
  const item = readItems(reviewFile).find(value => value.id === reviewId)
  if (item === undefined) return false
  const action = requestedAction ?? (item.targetPath === undefined
    ? 'Archive'
    : existsSync(join(wikiRoot, item.targetPath)) ? 'Merge' : 'Promote')
  try {
    const receiptId = issueTestReceipt(authority, reviewFile, wikiRoot, reviewId, action)
    return await recordCandidateVerification(reviewFile, wikiRoot, reviewId, receiptId, action)
  } catch {
    return false
  }
}

function withoutReviewField(item: WikiReviewItem, field: 'candidatePath' | 'candidateHash'): WikiReviewItem {
  const copy: WikiReviewItem = { ...item }
  Reflect.deleteProperty(copy, field)
  return copy
}

function withoutVerifiedBy<T extends { verifiedBy?: unknown }>(value: T): Omit<T, 'verifiedBy'> {
  const { verifiedBy: _verifiedBy, ...rest } = value
  return rest
}

describe('review parsing and advisory persistence edges', () => {
  it('uses safe defaults for blank fields and ignores unrelated lines', async () => {
    const reviews = parseReviewBlocks([
      'unrelated',
      '---REVIEW:   |   ---',
      'body without fields',
      '---END REVIEW---',
    ].join('\r\n'))
    expect(reviews).toEqual([{
      type: 'suggestion',
      title: 'Review',
      description: '',
      affectedPages: [],
      searchQueries: [],
    }])
  })

  it('fails loudly on corrupt review state and omits empty descriptions for a fresh store', async () => {
    const projectRoot = root()
    const reviewFile = join(projectRoot, 'review.json')
    writeFileSync(reviewFile, '{}', 'utf8')
    const parsed = parseReviewBlocks('---REVIEW: suggestion | T---\n---END REVIEW---')
    expect(() => appendReviews(reviewFile, '/source', parsed)).toThrow('invalid knowledge review state')

    writeFileSync(reviewFile, 'broken', 'utf8')
    expect(() => appendReviews(reviewFile, '/source', parsed)).toThrow(SyntaxError)
    rmSync(reviewFile)
    expect(appendReviews(reviewFile, '/source', parsed)).toBe(1)
    expect(readItems(reviewFile)[0]?.description).toBeUndefined()
  })
})

describe('candidate provenance and conflict event replay', () => {
  it('binds candidates without a usable source to a stable unknown identity', async () => {
    const projectRoot = root()
    const candidatePath = '_candidates/ingest/concepts/source-fallback.md'
    const candidateFull = join(projectRoot, 'wiki', candidatePath)
    const reviewFile = join(projectRoot, '.llm-wiki', 'review.json')
    mkdirSync(dirname(candidateFull), { recursive: true })

    for (const [index, sourcePath] of ([undefined, ''] as const).entries()) {
      const content = candidate(`Source fallback ${index}`)
      writeFileSync(candidateFull, content, 'utf8')
      expect(appendCandidateReviews(reviewFile, projectRoot, sourcePath, [`wiki/${candidatePath}`])).toBe(1)
      const item = readItems(reviewFile).at(-1)!
      expect(item.sourcePath).toBeUndefined()
      expect(item.sourceHash).toBe(createHash('sha256').update('unknown-source').digest('hex'))
    }

    const events = readFileSync(join(dirname(reviewFile), 'knowledge-events.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as { payload: { record?: { source?: string } } })
    expect(events.every(event => event.payload.record?.source === candidatePath)).toBe(true)
  })

  it('keeps a conflict event stable when an already-conflicted candidate changes', async () => {
    const projectRoot = root()
    const reviewFile = join(projectRoot, '.llm-wiki', 'review.json')
    const firstPath = '_candidates/ingest/concepts/shared-a.md'
    const secondPath = '_candidates/ingest/concepts/shared-b.md'
    const firstFull = join(projectRoot, 'wiki', firstPath)
    const secondFull = join(projectRoot, 'wiki', secondPath)
    mkdirSync(dirname(firstFull), { recursive: true })
    writeFileSync(firstFull, candidate('Shared claim'), 'utf8')
    writeFileSync(secondFull, candidate('Shared claim', 'A conflicting conclusion has distinct evidence. '.repeat(8)), 'utf8')
    expect(appendCandidateReviews(reviewFile, projectRoot, 'raw/source.md', [`wiki/${firstPath}`, `wiki/${secondPath}`]))
      .toBe(2)

    const readConflictEvents = () => readFileSync(join(dirname(reviewFile), 'knowledge-events.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as {
        type: string
        knowledgeId: string
        payload: { candidateHash?: string }
      }).filter(event => event.type === 'knowledge/conflict')
    const before = readConflictEvents()
    const firstId = readItems(reviewFile).find(item => item.candidatePath === firstPath)!.id
    expect(before.filter(event => event.knowledgeId === `candidate:${firstId}`)).toHaveLength(1)

    writeFileSync(secondFull, candidate('Shared claim', 'Competing evidence changed after initial review. '.repeat(8)), 'utf8')
    expect(appendCandidateReviews(reviewFile, projectRoot, 'raw/source.md', [`wiki/${secondPath}`])).toBe(1)
    const after = readConflictEvents()
    expect(after).toEqual(before)
    expect(after.filter(event => event.knowledgeId === `candidate:${firstId}`)).toHaveLength(1)
  })

  it('refuses independent verification while a governed candidate claim is in conflict', async () => {
    const item = fixture()
    const conflictingPath = '_candidates/ingest/concepts/conflicting-candidate.md'
    const conflictingFull = join(item.wikiRoot, conflictingPath)
    mkdirSync(dirname(conflictingFull), { recursive: true })
    writeFileSync(conflictingFull, candidate('Candidate', 'Conflicting evidence changes the conclusion. '.repeat(8)), 'utf8')
    expect(appendCandidateReviews(item.reviewFile, item.root, 'raw/conflict.md', [`wiki/${conflictingPath}`])).toBe(1)

    expect(await recordCandidateVerification(
      item.reviewFile, item.wikiRoot, item.reviewId, 'receipt-not-needed-before-governance-gate',
    )).toBe(false)
  })

  it('skips conflict events when prior candidate events have no review projection or hash', async () => {
    const projectRoot = root()
    const wikiRoot = join(projectRoot, 'wiki')
    const reviewFile = join(projectRoot, '.llm-wiki', 'review.json')
    mkdirSync(join(wikiRoot, '_candidates', 'legacy'), { recursive: true })
    mkdirSync(join(wikiRoot, '_candidates', 'ingest', 'concepts'), { recursive: true })
    mkdirSync(dirname(reviewFile), { recursive: true })
    const orphanPath = '_candidates/legacy/orphan.md'
    const hashlessPath = '_candidates/legacy/hashless.md'
    const newPath = '_candidates/ingest/concepts/new.md'
    const orphanContent = candidate('Shared claim', 'Orphaned review projection content. '.repeat(8))
    const hashlessContent = candidate('Shared claim', 'Hashless review projection content. '.repeat(8))
    const newContent = candidate('Shared claim', 'New review projection content. '.repeat(8))
    writeFileSync(join(wikiRoot, orphanPath), orphanContent, 'utf8')
    writeFileSync(join(wikiRoot, hashlessPath), hashlessContent, 'utf8')
    writeFileSync(join(wikiRoot, newPath), newContent, 'utf8')
    const idFor = (path: string) => `candidate-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`
    const appendCandidateRecord = (path: string, content: string) => {
      const id = idFor(path)
      const now = new Date().toISOString()
      const record = createKnowledgeRecord({
        id: `candidate:${id}`,
        content,
        claimKey: 'shared claim',
        source: path,
        sourceHash: knowledgeSha256(path),
        scope: { projectId: projectRoot, visibility: 'project' },
        evidenceRefs: [`source:${id}`],
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        lifecycle: 'candidate',
      })
      const eventPath = join(dirname(reviewFile), 'knowledge-events.jsonl')
      for (const type of ['knowledge/observed', 'knowledge/candidate'] as const) {
        const prior = readKnowledgeEventLog(eventPath)
        const event = createKnowledgeEvent(type, record.id, record.scope, { record }, {
          seq: prior.length,
          previousEventHash: prior.at(-1)?.eventHash ?? null,
        })
        appendKnowledgeEvent(eventPath, event)
      }
      return id
    }
    const orphanId = appendCandidateRecord(orphanPath, orphanContent)
    const hashlessId = appendCandidateRecord(hashlessPath, hashlessContent)
    writeItems(reviewFile, [{
      id: hashlessId,
      title: 'Shared claim',
      type: 'candidate-approval',
      reviewKind: 'candidate',
      candidatePath: hashlessPath,
      resolved: false,
    }])

    expect(appendCandidateReviews(reviewFile, projectRoot, 'raw/new-source.md', [`wiki/${newPath}`])).toBe(1)
    const events = readFileSync(join(dirname(reviewFile), 'knowledge-events.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as { type: string; knowledgeId: string })
    expect(events.some(event => event.type === 'knowledge/conflict' && event.knowledgeId === `candidate:${orphanId}`))
      .toBe(false)
    expect(events.some(event => event.type === 'knowledge/conflict' && event.knowledgeId === `candidate:${hashlessId}`))
      .toBe(false)
  })
})

describe('candidate review registration', () => {
  it('classifies candidate namespaces, skips missing/non-candidates, and refreshes resolved rows', async () => {
    const projectRoot = root()
    const wikiRoot = join(projectRoot, 'wiki')
    const reviewFile = join(projectRoot, '.llm-wiki', 'review.json')
    const paths = [
      '_candidates/sessions/session.md',
      '_candidates/research/research.md',
      '_candidates/ingest/concepts/ingest.md',
      '_candidates/ingest/other/isolated.md',
      '_candidates/topics/topic.md',
    ]
    for (const [index, path] of paths.entries()) {
      const full = join(wikiRoot, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, index === 4 ? candidate().replace(/^title:.*\n/mu, '') : candidate(`C${index}`), 'utf8')
    }

    expect(appendCandidateReviews(reviewFile, projectRoot, '/source', [
      'wiki/concepts/not-candidate.md',
      'wiki/_candidates/missing.md',
      ...paths.map(path => `wiki/${path}`),
    ])).toBe(5)
    const items = readItems(reviewFile)
    expect(items.map(item => item.targetPath)).toEqual([
      'concepts/session.md',
      '_evidence/research/research.md',
      'concepts/ingest.md',
      undefined,
      undefined,
    ])
    expect(items[4]?.title).toBe('topic')
    expect(appendCandidateReviews(reviewFile, projectRoot, '/source', paths.map(path => `wiki/${path}`))).toBe(0)

    writeItems(reviewFile, items.map((item, index) => index === 0 ? { ...item, resolved: true } : item))
    expect(appendCandidateReviews(reviewFile, projectRoot, '/source', [`wiki/${paths[0]}`])).toBe(1)
  })

  it('does not replace malformed or non-array review state with an empty array', async () => {
    const item = fixture()
    writeFileSync(item.reviewFile, 'broken', 'utf8')
    expect(() => appendCandidateReviews(item.reviewFile, item.root, '/source', [`wiki/${item.candidatePath}`]))
      .toThrow(SyntaxError)
    writeFileSync(item.reviewFile, '{}', 'utf8')
    expect(() => appendCandidateReviews(item.reviewFile, item.root, '/source', [`wiki/${item.candidatePath}`]))
      .toThrow('invalid knowledge review state')
  })

  it('does not let a canonical-directory symlink influence candidate registration', async () => {
    const projectRoot = root()
    const wikiRoot = join(projectRoot, 'wiki')
    const candidatePath = '_candidates/ingest/concepts/candidate.md'
    const candidateFull = join(wikiRoot, candidatePath)
    const outside = join(projectRoot, 'outside-canonical')
    const reviewFile = join(projectRoot, '.llm-wiki', 'review.json')
    mkdirSync(dirname(candidateFull), { recursive: true })
    mkdirSync(outside)
    const content = candidate()
    writeFileSync(candidateFull, content, 'utf8')
    writeFileSync(join(outside, 'candidate.md'), content, 'utf8')
    symlinkSync(outside, join(wikiRoot, 'concepts'), 'dir')

    expect(appendCandidateReviews(reviewFile, projectRoot, '/source', [`wiki/${candidatePath}`])).toBe(1)
    const item = readItems(reviewFile)[0]!
    expect(item.targetPath).toBeUndefined()
    expect(item.description).not.toContain('Deduplicate')
    expect(readFileSync(join(outside, 'candidate.md'), 'utf8')).toBe(content)
  })

  it.each(['leaf', 'intermediate'] as const)('rejects a dangling canonical %s symlink throughout registration and promotion', async (kind) => {
    const projectRoot = root()
    const wikiRoot = join(projectRoot, 'wiki')
    const candidatePath = '_candidates/ingest/concepts/candidate.md'
    const candidateFull = join(wikiRoot, candidatePath)
    const reviewFile = join(projectRoot, '.llm-wiki', 'review.json')
    const outside = join(projectRoot, `missing-outside-${kind}`)
    mkdirSync(dirname(candidateFull), { recursive: true })
    writeFileSync(candidateFull, candidate(), 'utf8')
    if (kind === 'leaf') {
      mkdirSync(join(wikiRoot, 'concepts'), { recursive: true })
      symlinkSync(join(outside, 'candidate.md'), join(wikiRoot, 'concepts', 'candidate.md'))
    } else {
      symlinkSync(outside, join(wikiRoot, 'concepts'), 'dir')
    }

    expect(appendCandidateReviews(reviewFile, projectRoot, '/source', [`wiki/${candidatePath}`])).toBe(1)
    const item = readItems(reviewFile)[0]!
    expect(item.targetPath).toBeUndefined()
    expect(await verifyReview(reviewFile, wikiRoot, item.id)).toBe(true)
    expect(readItems(reviewFile)[0]!.options?.map(option => option.action)).toEqual(['Archive'])
    expect(await applyCandidateReview(
      reviewFile, projectRoot, wikiRoot, join(projectRoot, 'archive'), item.id, 'Promote', 'human',
    )).toBe(false)
    expect(existsSync(outside)).toBe(false)
    expect(existsSync(candidateFull)).toBe(true)
    const symlink = kind === 'leaf' ? join(wikiRoot, 'concepts', 'candidate.md') : join(wikiRoot, 'concepts')
    expect(lstatSync(symlink).isSymbolicLink()).toBe(true)
    expect(readItems(reviewFile)[0]!.resolved).toBe(false)
  })
})

describe('candidate verification validation', () => {
  it('rejects missing, advisory, resolved, malformed, unsafe, absent, and stale review targets', async () => {
    const missing = join(root(), 'missing.json')
    expect(await recordCandidateVerification(missing, '/wiki', 'missing', verification())).toBe(false)

    const mutations: Array<(item: WikiReviewItem) => WikiReviewItem> = [
      (item: WikiReviewItem) => ({ ...item, reviewKind: 'advisory' as const }),
      (item: WikiReviewItem) => ({ ...item, resolved: true }),
      (item: WikiReviewItem) => withoutReviewField(item, 'candidatePath'),
      (item: WikiReviewItem) => withoutReviewField(item, 'candidateHash'),
      (item: WikiReviewItem) => ({ ...item, candidatePath: 'concepts/not-candidate.md' }),
    ]
    for (const mutate of mutations) {
      const item = fixture()
      writeItems(item.reviewFile, [mutate(readItems(item.reviewFile)[0]!)])
      expect(await recordCandidateVerification(item.reviewFile, item.wikiRoot, item.reviewId, verification())).toBe(false)
    }

    const absent = fixture()
    rmSync(absent.candidateFull)
    expect(await recordCandidateVerification(absent.reviewFile, absent.wikiRoot, absent.reviewId, verification())).toBe(false)

    const stale = fixture()
    writeFileSync(stale.candidateFull, candidate('Changed'), 'utf8')
    expect(await recordCandidateVerification(stale.reviewFile, stale.wikiRoot, stale.reviewId, verification())).toBe(false)
  })

  it('rejects every incomplete passed verification field', async () => {
    const cases: Array<(value: Omit<CandidateVerification, 'candidateHash'>) => Omit<CandidateVerification, 'candidateHash'>> = [
      value => ({ ...value, methods: [] }),
      value => ({ ...value, evidence: [] }),
      value => withoutVerifiedBy(value),
      value => ({ ...value, confidence: -0.1 }),
      value => ({ ...value, confidence: 1.1 }),
      value => ({ ...value, receipts: [] }),
      value => ({ ...value, receipts: [{ ...value.receipts[0]!, result: 'fail' }] }),
      value => ({ ...value, receipts: [{ ...value.receipts[0]!, receiptHash: 'bad' }] }),
      value => ({ ...value, receipts: [{ ...value.receipts[0]!, environmentHash: 'bad' }] }),
      value => ({ ...value, receipts: [{ ...value.receipts[0]!, id: 'bad id' }] }),
      value => ({ ...value, receipts: [{ ...value.receipts[0]!, path: '' }] }),
      value => ({ ...value, receipts: [{ ...value.receipts[0]!, path: '/absolute' }] }),
      value => ({ ...value, receipts: [{ ...value.receipts[0]!, path: '../escape' }] }),
      value => ({ ...value, receipts: [{ ...value.receipts[0]!, gitCommit: 'bad' }] }),
    ]
    for (const mutate of cases) {
      const item = fixture()
      expect(await recordCandidateVerification(
        item.reviewFile,
        item.wikiRoot,
        item.reviewId,
        mutate(verification()),
      )).toBe(false)
    }
  })

  it.each([
    '',
    '_candidates//outside.md',
    '_candidates/./outside.md',
    '_candidates/../outside.md',
    '_candidates/../../outside.md',
    '/absolute.md',
    'C:/absolute.md',
    '_candidates\\outside.md',
    '_candidates/\0outside.md',
    'concepts/not-candidate.md',
  ])('rejects malformed durable candidate path %j before reading or moving it', async (candidatePath) => {
    const item = fixture()
    const rows = readItems(item.reviewFile)
    rows[0] = { ...rows[0]!, candidatePath }
    writeItems(item.reviewFile, rows)
    expect(await recordCandidateVerification(item.reviewFile, item.wikiRoot, item.reviewId, verification())).toBe(false)
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive',
    )).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('rejects a candidate path whose existing component is a symbolic link', async () => {
    const item = fixture()
    const outside = join(item.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'candidate.md'), readFileSync(item.candidateFull, 'utf8'), 'utf8')
    symlinkSync(outside, join(item.wikiRoot, '_candidates', 'linked'), 'dir')
    const rows = readItems(item.reviewFile)
    rows[0] = { ...rows[0]!, candidatePath: '_candidates/linked/candidate.md' }
    writeItems(item.reviewFile, rows)
    expect(await recordCandidateVerification(item.reviewFile, item.wikiRoot, item.reviewId, verification())).toBe(false)
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive',
    )).toBe(false)
    expect(existsSync(join(outside, 'candidate.md'))).toBe(true)
  })

  it('fails deterministic verification for an invalid durable target', async () => {
    const item = fixture()
    const rows = readItems(item.reviewFile)
    rows[0] = { ...rows[0]!, targetPath: '../promoted-outside.md' }
    writeItems(item.reviewFile, rows)
    expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId)).toBe(false)
    expect(readItems(item.reviewFile)[0]!.options?.map(option => option.action)).toEqual(['Archive'])
  })

  it('sets action options for existing, missing, and autonomous targets and records failed checks', async () => {
    const existing = fixture()
    const target = readItems(existing.reviewFile)[0]!.targetPath!
    mkdirSync(dirname(join(existing.wikiRoot, target)), { recursive: true })
    writeFileSync(join(existing.wikiRoot, target), candidate('Canonical'), 'utf8')
    expect(await verifyReview(existing.reviewFile, existing.wikiRoot, existing.reviewId)).toBe(true)
    expect(readItems(existing.reviewFile)[0]!.options?.map(option => option.action))
      .toEqual(['Archive'])

    const missingTarget = fixture()
    expect(await verifyReview(missingTarget.reviewFile, missingTarget.wikiRoot, missingTarget.reviewId)).toBe(true)
    expect(readItems(missingTarget.reviewFile)[0]!.options?.map(option => option.action))
      .toEqual(['Archive'])

    const autonomous = fixture('_candidates/topics/no-target.md')
    expect(await verifyReview(autonomous.reviewFile, autonomous.wikiRoot, autonomous.reviewId)).toBe(true)
    expect(readItems(autonomous.reviewFile)[0]!.options?.map(option => option.action)).toEqual(['Archive'])

    const failed = fixture()
    const failedVerification = withoutVerifiedBy(verification({
      status: 'failed',
      methods: [],
      evidence: [],
      receipts: [],
      confidence: 0,
      successCount: 0,
      failureCount: 1,
    }))
    expect(await recordCandidateVerification(
      failed.reviewFile, failed.wikiRoot, failed.reviewId, failedVerification,
    )).toBe(false)
    expect(existsSync(join(failed.root, '.llm-wiki', 'governance.jsonl'))).toBe(false)
  })
})

describe('candidate decision application', () => {
  it('distinguishes advisory, invalid, unauthorized, missing-target, and unknown actions', async () => {
    const missingReview = join(root(), 'missing-review.json')
    expect(await applyCandidateReview(
      missingReview, '/project', '/wiki', '/archive', 'missing', 'Archive',
    )).toBe(false)

    const advisory = fixture()
    const advisoryItems = readItems(advisory.reviewFile)
    writeItems(advisory.reviewFile, [{ ...advisoryItems[0]!, reviewKind: 'advisory' }])
    expect(await applyCandidateReview(
      advisory.reviewFile, advisory.root, advisory.wikiRoot, advisory.archiveRoot, advisory.reviewId, 'Archive',
    )).toBeNull()

    const denied = fixture()
    expect(await applyCandidateReview(
      denied.reviewFile, denied.root, denied.wikiRoot, denied.archiveRoot, 'unknown-review', 'Archive',
    )).toBe(false)
    expect(await applyCandidateReview(
      denied.reviewFile, denied.root, denied.wikiRoot, denied.archiveRoot, denied.reviewId, 'Promote', 'governance-agent',
    )).toBe(false)
    expect(await applyCandidateReview(
      denied.reviewFile, denied.root, denied.wikiRoot, denied.archiveRoot, denied.reviewId, 'Unknown',
    )).toBe(false)

    const invalidMutations: Array<(item: WikiReviewItem) => WikiReviewItem> = [
      (item: WikiReviewItem) => ({ ...item, resolved: true }),
      (item: WikiReviewItem) => withoutReviewField(item, 'candidatePath'),
      (item: WikiReviewItem) => withoutReviewField(item, 'candidateHash'),
      (item: WikiReviewItem) => ({ ...item, candidatePath: 'concepts/unsafe.md' }),
    ]
    for (const mutate of invalidMutations) {
      const invalid = fixture()
      writeItems(invalid.reviewFile, [mutate(readItems(invalid.reviewFile)[0]!)])
      expect(await applyCandidateReview(
        invalid.reviewFile, invalid.root, invalid.wikiRoot, invalid.archiveRoot, invalid.reviewId, 'Archive',
      )).toBe(false)
    }

    const absent = fixture()
    rmSync(absent.candidateFull)
    expect(await applyCandidateReview(
      absent.reviewFile, absent.root, absent.wikiRoot, absent.archiveRoot, absent.reviewId, 'Archive',
    )).toBe(false)

    const stale = fixture()
    writeFileSync(stale.candidateFull, candidate('Changed'), 'utf8')
    expect(await applyCandidateReview(
      stale.reviewFile, stale.root, stale.wikiRoot, stale.archiveRoot, stale.reviewId, 'Archive',
    )).toBe(false)

    const noTarget = fixture('_candidates/topics/no-target.md')
    expect(await verifyReview(noTarget.reviewFile, noTarget.wikiRoot, noTarget.reviewId)).toBe(true)
    expect(await applyCandidateReview(
      noTarget.reviewFile, noTarget.root, noTarget.wikiRoot, noTarget.archiveRoot, noTarget.reviewId, 'Promote',
    )).toBe(false)
    expect(await applyCandidateReview(
      noTarget.reviewFile, noTarget.root, noTarget.wikiRoot, noTarget.archiveRoot, noTarget.reviewId, 'Merge',
    )).toBe(false)

    const missingTarget = fixture()
    expect(await verifyReview(missingTarget.reviewFile, missingTarget.wikiRoot, missingTarget.reviewId)).toBe(true)
    expect(await applyCandidateReview(
      missingTarget.reviewFile, missingTarget.root, missingTarget.wikiRoot, missingTarget.archiveRoot,
      missingTarget.reviewId, 'Merge',
    )).toBe(false)

    const existingPromote = fixture()
    const target = readItems(existingPromote.reviewFile)[0]!.targetPath!
    mkdirSync(dirname(join(existingPromote.wikiRoot, target)), { recursive: true })
    writeFileSync(join(existingPromote.wikiRoot, target), candidate('Existing'), 'utf8')
    expect(await verifyReview(existingPromote.reviewFile, existingPromote.wikiRoot, existingPromote.reviewId)).toBe(true)
    expect(await applyCandidateReview(
      existingPromote.reviewFile, existingPromote.root, existingPromote.wikiRoot, existingPromote.archiveRoot,
      existingPromote.reviewId, 'Promote',
    )).toBe(false)
  })

  it('blocks candidate actions when replayed governance marks the candidate conflicted', async () => {
    const item = fixture()
    const conflictingPath = '_candidates/ingest/concepts/conflicting-candidate.md'
    const conflictingFull = join(item.wikiRoot, conflictingPath)
    mkdirSync(dirname(conflictingFull), { recursive: true })
    writeFileSync(conflictingFull, candidate('Candidate', 'A distinct conflicting method. '.repeat(8)), 'utf8')
    expect(appendCandidateReviews(item.reviewFile, item.root, 'raw/conflict.md', [`wiki/${conflictingPath}`])).toBe(1)

    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).toBe(false)
  })

  it('does not derive trial credit from semantic verification or trust legacy trial mirrors', async () => {
    const item = fixture()
    expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')).toBe(true)
    const rows = readItems(item.reviewFile)
    const verified = rows[0]!
    expect(verified.verification?.status).toBe('passed')
    expect(verified.verification?.trial).toBeUndefined()

    rows[0] = {
      ...verified,
      verification: {
        ...verified.verification!,
        trial: {
          status: 'passed',
          trialHash: 'a'.repeat(64),
          authorityId: 'project-forged',
          evidence: ['semantic verifier passed'],
          retrievalHits: 1,
          successfulUses: 1,
          userCorrections: 0,
          utilityScore: 2,
          startedAt: new Date(0).toISOString(),
          endedAt: new Date(0).toISOString(),
        },
      },
    }
    writeItems(item.reviewFile, rows)
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toBe(false)
    expect(existsSync(join(item.wikiRoot, rows[0].targetPath!))).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it.each([
    '',
    '../promoted-outside.md',
    'concepts//outside.md',
    'concepts/./outside.md',
    '/absolute.md',
    'C:/absolute.md',
    'concepts\\outside.md',
    'concepts/\0outside.md',
    '_candidates/ingest/concepts/other.md',
  ])('rejects malformed durable target path %j before canonical mutation', async (targetPath) => {
    const item = fixture()
    expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId)).toBe(true)
    const rows = readItems(item.reviewFile)
    rows[0] = { ...rows[0]!, targetPath }
    writeItems(item.reviewFile, rows)
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toBe(false)
    expect(existsSync(join(item.root, 'promoted-outside.md'))).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('rejects a target path whose existing component is a symbolic link', async () => {
    const item = fixture()
    expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId)).toBe(true)
    const outside = join(item.root, 'canonical-outside')
    mkdirSync(outside)
    symlinkSync(outside, join(item.wikiRoot, 'linked-target'), 'dir')
    const rows = readItems(item.reviewFile)
    rows[0] = { ...rows[0]!, targetPath: 'linked-target/promoted.md' }
    writeItems(item.reviewFile, rows)
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toBe(false)
    expect(existsSync(join(outside, 'promoted.md'))).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('rejects a dangling canonical leaf introduced after verification', async () => {
    const item = fixture()
    expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId)).toBe(true)
    const target = readItems(item.reviewFile)[0]!.targetPath!
    const targetFull = join(item.wikiRoot, target)
    const outside = join(item.root, 'missing-promoted-outside.md')
    mkdirSync(dirname(targetFull), { recursive: true })
    symlinkSync(outside, targetFull)

    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toBe(false)
    expect(existsSync(outside)).toBe(false)
    expect(lstatSync(targetFull).isSymbolicLink()).toBe(true)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
  })

  it('preflights archive destinations before Archive can mutate candidate or review state', async () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId, 'Archive')).toBe(true)
    const target = readItems(item.reviewFile)[0]!.targetPath!
    const targetFull = join(item.wikiRoot, target)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const logFile = join(item.root, '.llm-wiki', 'governance.jsonl')
    const logBefore = readFileSync(logFile, 'utf8')
    mkdirSync(item.archiveRoot, { recursive: true })
    writeFileSync(join(item.archiveRoot, 'wiki-governance'), 'not a directory', 'utf8')

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).rejects.toThrow()
    expect(existsSync(targetFull)).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(logFile, 'utf8')).toBe(logBefore)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
  })

  it('rejects a pre-existing candidate archive before any live mutation', async () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId)).toBe(true)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const target = readItems(item.reviewFile)[0]!.targetPath!
    const archived = join(
      item.archiveRoot,
      'wiki-governance',
      new Date().toISOString().slice(0, 10),
      basename(item.root),
      createHash('sha256').update(readFileSync(item.candidateFull, 'utf8')).digest('hex').slice(0, 12),
      item.candidatePath,
    )
    mkdirSync(dirname(archived), { recursive: true })
    writeFileSync(archived, 'existing archive', 'utf8')

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).rejects.toThrow(/candidate archive already exists/u)
    expect(existsSync(join(item.wikiRoot, target))).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
  })

  it('leaves an existing canonical target unchanged without a measured trial', async () => {
    const item = fixture()
    const target = readItems(item.reviewFile)[0]!.targetPath!
    const targetFull = join(item.wikiRoot, target)
    const canonicalBefore = candidate('Canonical', 'stable method')
    mkdirSync(dirname(targetFull), { recursive: true })
    writeFileSync(targetFull, canonicalBefore, 'utf8')
    expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId, 'Replace')).toBe(true)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Replace', 'human',
    )).toBe(false)
    expect(readFileSync(targetFull, 'utf8')).toBe(canonicalBefore)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
  })

  it('rejects a non-regular governance log before staging any mutation', async () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId)).toBe(true)
    const logFile = join(item.root, '.llm-wiki', 'governance.jsonl')
    rmSync(logFile)
    mkdirSync(logFile)
    const target = readItems(item.reviewFile)[0]!.targetPath!
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).rejects.toThrow(/unsafe review transaction file/u)
    expect(existsSync(join(item.wikiRoot, target))).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
  })

  it('does not let mutable verification mirrors authorize canonical mutation', async () => {
    const nonAuthorityMutations: Array<(value: CandidateVerification) => CandidateVerification> = [
      (value: CandidateVerification) => ({ ...value, methods: [] }),
      (value: CandidateVerification) => ({ ...value, evidence: [] }),
      (value: CandidateVerification) => withoutVerifiedBy(value),
    ]
    for (const verificationMutation of nonAuthorityMutations) {
      const item = fixture()
      expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId)).toBe(true)
      const items = readItems(item.reviewFile)
      items[0] = { ...items[0]!, verification: verificationMutation(items[0]!.verification!) }
      writeItems(item.reviewFile, items)
      expect(await applyCandidateReview(
        item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
      )).toBe(false)
      expect(existsSync(item.candidateFull)).toBe(true)
    }
    const missingReceipt = fixture()
    expect(await verifyReview(missingReceipt.reviewFile, missingReceipt.wikiRoot, missingReceipt.reviewId)).toBe(true)
    const rows = readItems(missingReceipt.reviewFile)
    rows[0] = { ...rows[0]!, verification: { ...rows[0]!.verification!, receipts: [] } }
    writeItems(missingReceipt.reviewFile, rows)
    expect(await applyCandidateReview(
      missingReceipt.reviewFile, missingReceipt.root, missingReceipt.wikiRoot, missingReceipt.archiveRoot,
      missingReceipt.reviewId, 'Promote', 'human',
    )).toBe(false)
  })

  it.each(['Merge', 'Replace', 'Deduplicate'] as const)('blocks %s until an authenticated measured trial exists', async (action) => {
    const canonicalBody = 'stable method'
    const candidateBody = action === 'Merge' ? canonicalBody : 'replacement body'
    const item = fixture('_candidates/ingest/concepts/candidate.md', candidate('Candidate', candidateBody))
    const target = readItems(item.reviewFile)[0]!.targetPath!
    const targetFull = join(item.wikiRoot, target)
    mkdirSync(dirname(targetFull), { recursive: true })
    writeFileSync(targetFull, candidate('Canonical', canonicalBody), 'utf8')
    expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId, action)).toBe(true)

    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, action, 'human',
    )).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(targetFull, 'utf8')).toBe(candidate('Canonical', canonicalBody))
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
  })

  it('blocks canonical promotion and keeps disposable Candidate Archive available', async () => {
    for (const [candidatePath, expectedStatus] of [
      ['_candidates/sessions/session.md', 'status: canonical'],
      ['_candidates/research/research.md', 'status: evidence'],
    ] as const) {
      const item = fixture(candidatePath, candidate().replace(
        'status: candidate',
        'status: candidate\napproved_at: old\napproved_by: old',
      ))
      expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId)).toBe(true)
      expect(await applyCandidateReview(
        item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
      )).toBe(false)
      const target = readItems(item.reviewFile)[0]!.targetPath!
      expect(existsSync(join(item.wikiRoot, target))).toBe(false)
      expect(existsSync(item.candidateFull)).toBe(true)
      expect(expectedStatus).toMatch(/^status:/u)
    }

    for (const action of ['Archive', 'Skip'] as const) {
      const item = fixture('_candidates/topics/disposable.md')
      expect(await applyCandidateReview(
        item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, action,
      )).toBe(true)
      expect(readItems(item.reviewFile)[0]!.resolvedAction).toBe('Archive')
    }
  })

  it('keeps an existing evidence page unchanged when a research merge lacks a measured trial', async () => {
    const item = fixture('_candidates/research/research.md')
    const target = readItems(item.reviewFile)[0]!.targetPath!
    const targetFull = join(item.wikiRoot, target)
    mkdirSync(dirname(targetFull), { recursive: true })
    writeFileSync(targetFull, candidate(), 'utf8')
    expect(await verifyReview(item.reviewFile, item.wikiRoot, item.reviewId)).toBe(true)
    const canonicalBefore = readFileSync(targetFull, 'utf8')
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Merge', 'human',
    )).toBe(false)
    expect(readFileSync(targetFull, 'utf8')).toBe(canonicalBefore)
    expect(existsSync(item.candidateFull)).toBe(true)
  })
})
