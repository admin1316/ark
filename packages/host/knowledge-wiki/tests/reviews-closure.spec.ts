import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendCandidateReviews,
  applyCandidateReview as applyCandidateReviewWithAuthority,
  recoverCandidateReviewTransactions,
  recordCandidateVerification as recordCandidateVerificationWithAuthority,
} from '../src/reviews.ts'
import {
  canonicalJson,
  sha256,
  type KnowledgeWikiVerifierAuthority,
  type PromotionCheckpoint,
  type VerificationAuthoritySeal,
} from '../src/verifier.ts'
import type { WikiReviewItem } from '../src/types.ts'
import { issueTestReceipt, verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []
const authority = verifierAuthority()
const STOP_AFTER_JOURNAL = new Error('stop after journal persistence')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'wiki-review-closure-'))
  roots.push(value)
  return value
}

function candidate(title = 'Closure candidate'): string {
  return `---
type: concept
status: candidate
origin: ingest
title: ${title}
sources: ["repo:ark/docs/architecture.md"]
related: ["concepts/closure"]
---

# ${title}

## 原则

A stable method, its validation evidence, its boundary, and its rollback point.

## 适用条件

Use this when the independent verification gate has already passed.

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

function fixture(candidatePath = '_candidates/sessions/closure.md', content = candidate()): Fixture {
  const projectRoot = root()
  const wikiRoot = join(projectRoot, 'wiki')
  const candidateFull = join(wikiRoot, candidatePath)
  const reviewFile = join(projectRoot, '.llm-wiki', 'review.json')
  mkdirSync(dirname(candidateFull), { recursive: true })
  writeFileSync(candidateFull, content, 'utf8')
  expect(appendCandidateReviews(reviewFile, projectRoot, 'raw/closure.md', [`wiki/${candidatePath}`])).toBe(1)
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

/** Bind an authentic passing receipt for one candidate under test. */
function verify(item: Fixture, action: 'Promote' | 'Merge' = 'Promote'): void {
  const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, action)
  expect(recordCandidateVerificationWithAuthority(
    authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, action,
  )).toBe(true)
}

function apply(
  item: Fixture,
  acting: KnowledgeWikiVerifierAuthority = authority,
  action = 'Promote',
  actor = 'human',
): boolean | null {
  return applyCandidateReviewWithAuthority(
    acting, item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, action, actor,
  )
}

/** Authority whose promotion checkpoint performs one deterministic external mutation. */
function checkpointAuthority(
  hook: (core: JournalCore, checkpoint: PromotionCheckpoint) => void,
): KnowledgeWikiVerifierAuthority {
  const base = verifierAuthority()
  return {
    ...base,
    checkpointPromotion(payload, checkpoint) {
      hook(JSON.parse(payload) as JournalCore, checkpoint)
    },
  }
}

interface JournalOperation {
  readonly role: string
  readonly path: string
  readonly before?: string
  readonly after?: string
  readonly stagingPath?: string
  readonly tombstonePath?: string
}

interface JournalCore {
  schemaVersion: number
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
  operations: JournalOperation[]
}

interface JournalRecord extends JournalCore {
  state: string
  seal: VerificationAuthoritySeal
}

function journalDirectory(item: Fixture): string {
  return join(dirname(item.reviewFile), 'promotion-journal')
}

function journalFiles(item: Fixture): string[] {
  return readdirSync(journalDirectory(item)).filter(name => name.endsWith('.json')).sort()
}

function readJournal(item: Fixture): JournalRecord {
  const name = journalFiles(item)[0]
  if (name === undefined) throw new Error('no promotion journal was persisted')
  return JSON.parse(readFileSync(join(journalDirectory(item), name), 'utf8')) as JournalRecord
}

function operationOf(journal: { readonly operations: readonly JournalOperation[] }, role: string): JournalOperation {
  const operation = journal.operations.find(value => value.role === role)
  if (operation === undefined) throw new Error(`journal has no ${role} operation`)
  return operation
}

/** Run one real promotion until its journal is durable, then leave it prepared. */
function interruptAtJournalPersistence(item: Fixture): JournalRecord {
  const stopping = checkpointAuthority((_core, checkpoint) => {
    if (checkpoint.phase === 'journal-persisted') throw STOP_AFTER_JOURNAL
  })
  expect(() => apply(item, stopping)).toThrow(STOP_AFTER_JOURNAL)
  const journal = readJournal(item)
  expect(journal.state).toBe('prepared')
  return journal
}

/** Replace the prepared journal with a re-sealed variant, modelling a legacy or damaged WAL. */
function resealJournal(item: Fixture, journal: JournalRecord, mutate: (core: JournalCore) => void): void {
  const { state: _state, seal: _seal, ...fields } = journal
  const core: JournalCore = { ...fields, operations: fields.operations.map(operation => ({ ...operation })) }
  mutate(core)
  core.operationSetHash = sha256(canonicalJson(core.operations))
  const name = journalFiles(item)[0]
  if (name === undefined) throw new Error('no promotion journal was persisted')
  writeFileSync(
    join(journalDirectory(item), name),
    JSON.stringify({ ...core, state: 'prepared', seal: authority.sealPromotion(canonicalJson(core)) }),
    'utf8',
  )
}

/** Every write-ahead staging and tombstone entry still present under one project root. */
function walLeftovers(projectRoot: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.name.includes('.ark-wal-')) found.push(full)
      else if (entry.isDirectory()) walk(full)
    }
  }
  if (existsSync(projectRoot)) walk(projectRoot)
  return found
}

function captureFailure(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the promotion transaction to fail')
}

/** Error messages carried by an aggregate incomplete-rollback failure. */
function aggregateMessages(error: unknown): string[] {
  if (!(error instanceof AggregateError)) throw new Error('expected an aggregate incomplete-rollback failure')
  const values: readonly unknown[] = error.errors
  return values.map((value) => {
    if (value instanceof Error) return value.message
    return typeof value
  })
}

describe('canonical stamping and durable target selection', () => {
  it('stamps canonical frontmatter onto a candidate that carries no status field', () => {
    const withoutStatus = [
      '---',
      'type: concept',
      'origin: ingest',
      'title: Closure stamping',
      'sources: ["repo:ark/docs/architecture.md"]',
      'related: ["concepts/closure"]',
      '---',
      '',
      '# Closure stamping',
      '',
      '## 原则',
      '',
      'Canonical pages carry an explicit status and an approval stamp on admission.',
      '',
      '## 适用条件',
      '',
      'Use this when a candidate is admitted without an explicit status field.',
      '',
      '## 验证证据',
      '',
      'Independent verification supplies the admission evidence and the rollback point.',
      '',
    ].join('\n')
    const item = fixture('_candidates/sessions/closure.md', withoutStatus)
    verify(item)

    expect(apply(item)).toBe(true)

    const target = readItems(item.reviewFile)[0]!.targetPath
    if (target === undefined) throw new Error('promotion recorded no canonical target')
    const promoted = readFileSync(join(item.wikiRoot, target), 'utf8')
    expect(promoted.startsWith('---\napproved_at: ')).toBe(true)
    expect(promoted).toContain(`approved_at: ${new Date().toISOString().slice(0, 10)}`)
    expect(promoted).toContain('approved_by: human')
    expect(promoted).toContain('status: canonical')
    expect(promoted).not.toContain('status: candidate')
    expect(promoted).toContain('title: Closure stamping')
    expect(existsSync(item.candidateFull)).toBe(false)
  })

  it('archives a verified candidate whose durable target resolves inside the candidate namespace', () => {
    const item = fixture()
    const candidateTarget = '_candidates/topics/linked.md'
    mkdirSync(dirname(join(item.wikiRoot, candidateTarget)), { recursive: true })
    writeFileSync(join(item.wikiRoot, candidateTarget), candidate('Linked'), 'utf8')
    const rows = readItems(item.reviewFile)
    writeItems(item.reviewFile, [{ ...rows[0]!, targetPath: candidateTarget }])

    verify(item, 'Merge')

    const row = readItems(item.reviewFile)[0]!
    expect(row.verification?.status).toBe('passed')
    expect(row.options?.map(option => option.action)).toEqual(['Archive'])
    expect(row.resolved).toBe(false)
  })

  it('refuses a canonical action whose durable target resolves inside the candidate namespace', () => {
    const merge = fixture()
    const candidateTarget = '_candidates/topics/linked.md'
    mkdirSync(dirname(join(merge.wikiRoot, candidateTarget)), { recursive: true })
    writeFileSync(join(merge.wikiRoot, candidateTarget), candidate('Linked'), 'utf8')
    const mergeRows = readItems(merge.reviewFile)
    writeItems(merge.reviewFile, [{ ...mergeRows[0]!, targetPath: candidateTarget }])
    verify(merge, 'Merge')
    const mergeReviewBefore = readFileSync(merge.reviewFile, 'utf8')

    expect(apply(merge, authority, 'Merge')).toBe(false)
    expect(readFileSync(merge.reviewFile, 'utf8')).toBe(mergeReviewBefore)
    expect(existsSync(merge.candidateFull)).toBe(true)
    expect(readItems(merge.reviewFile)[0]!.resolved).toBe(false)

    const promote = fixture()
    const promoteRows = readItems(promote.reviewFile)
    writeItems(promote.reviewFile, [{ ...promoteRows[0]!, targetPath: '_candidates/topics/absent.md' }])
    verify(promote, 'Promote')
    const promoteReviewBefore = readFileSync(promote.reviewFile, 'utf8')

    expect(apply(promote)).toBe(false)
    expect(readFileSync(promote.reviewFile, 'utf8')).toBe(promoteReviewBefore)
    expect(existsSync(promote.candidateFull)).toBe(true)
    expect(existsSync(join(promote.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(existsSync(journalDirectory(promote))).toBe(false)
  })
})

describe('candidate verification preconditions', () => {
  it('refuses unavailable, ineligible, unconfined, and stale rows without side effects', () => {
    const missing = join(root(), 'review.json')
    expect(recordCandidateVerificationWithAuthority(
      authority, missing, '/wiki', 'review-unknown', 'verification-unknown', 'Promote',
    )).toBe(false)
    expect(existsSync(join(dirname(missing), 'verification-receipts'))).toBe(false)

    const advisory = fixture()
    const advisoryRows = readItems(advisory.reviewFile)
    writeItems(advisory.reviewFile, [{ ...advisoryRows[0]!, reviewKind: 'advisory' }])
    expect(recordCandidateVerificationWithAuthority(
      authority, advisory.reviewFile, advisory.wikiRoot, advisory.reviewId, 'verification-unknown', 'Promote',
    )).toBe(false)
    expect(readItems(advisory.reviewFile)[0]!.verification?.status).toBe('pending')

    const unconfined = fixture()
    const unconfinedRows = readItems(unconfined.reviewFile)
    writeItems(unconfined.reviewFile, [{ ...unconfinedRows[0]!, candidatePath: 'concepts/not-candidate.md' }])
    expect(recordCandidateVerificationWithAuthority(
      authority, unconfined.reviewFile, unconfined.wikiRoot, unconfined.reviewId, 'verification-unknown', 'Promote',
    )).toBe(false)
    expect(readItems(unconfined.reviewFile)[0]!.verification?.status).toBe('pending')

    const stale = fixture()
    writeFileSync(stale.candidateFull, `${readFileSync(stale.candidateFull, 'utf8')}\nchanged\n`, 'utf8')
    expect(recordCandidateVerificationWithAuthority(
      authority, stale.reviewFile, stale.wikiRoot, stale.reviewId, 'verification-unknown', 'Promote',
    )).toBe(false)
    expect(readItems(stale.reviewFile)[0]!.verification?.status).toBe('pending')
  })
})

describe('promotion authorization seal', () => {
  it('refuses a promotion the authority cannot seal for itself', () => {
    const forgeSeals: Array<[string, KnowledgeWikiVerifierAuthority]> = [
      ['a foreign authority id', {
        ...authority,
        sealPromotion: (): VerificationAuthoritySeal => ({ authorityId: 'foreign-authority', proof: 'forged' }),
      }],
      ['an empty proof', {
        ...authority,
        sealPromotion: (): VerificationAuthoritySeal => ({ authorityId: authority.authorityId, proof: '' }),
      }],
    ]

    for (const [label, sealing] of forgeSeals) {
      const item = fixture()
      verify(item)
      const reviewBefore = readFileSync(item.reviewFile, 'utf8')

      expect(apply(item, sealing), label).toBe(false)
      expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
      expect(existsSync(item.candidateFull)).toBe(true)
      expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
      expect(existsSync(journalDirectory(item))).toBe(false)
    }
  })
})

describe('promotion journal recovery boundaries', () => {
  it('reports no recovery work for an absent or already committed journal', () => {
    const fresh = fixture()
    expect(recoverCandidateReviewTransactions(
      authority, fresh.reviewFile, fresh.wikiRoot, fresh.archiveRoot,
    )).toBe(0)
    expect(existsSync(journalDirectory(fresh))).toBe(false)

    const committed = fixture()
    verify(committed)
    expect(apply(committed)).toBe(true)
    expect(readJournal(committed).state).toBe('committed')
    expect(recoverCandidateReviewTransactions(
      authority, committed.reviewFile, committed.wikiRoot, committed.archiveRoot,
    )).toBe(0)
  })

  it('refuses a promotion journal path that is not an ordinary directory', () => {
    const file = fixture()
    mkdirSync(journalDirectory(file), { recursive: true })
    rmSync(journalDirectory(file), { recursive: true, force: true })
    writeFileSync(journalDirectory(file), 'not a directory', 'utf8')
    expect(() => recoverCandidateReviewTransactions(
      authority, file.reviewFile, file.wikiRoot, file.archiveRoot,
    )).toThrow('unsafe promotion journal directory')
    expect(readFileSync(journalDirectory(file), 'utf8')).toBe('not a directory')

    const linked = fixture()
    const outside = join(linked.root, 'outside-journal')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, journalDirectory(linked), 'dir')
    expect(() => recoverCandidateReviewTransactions(
      authority, linked.reviewFile, linked.wikiRoot, linked.archiveRoot,
    )).toThrow('unsafe promotion journal directory')
    expect(readdirSync(outside)).toEqual([])
  })

  it('propagates a journal directory failure that is not a missing path', () => {
    const item = fixture()
    mkdirSync(journalDirectory(item), { recursive: true })
    chmodSync(journalDirectory(item), 0o000)
    try {
      const failure = captureFailure(() => recoverCandidateReviewTransactions(
        authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
      ))
      expect(failure).toMatchObject({ code: 'EACCES' })
    } finally {
      chmodSync(journalDirectory(item), 0o700)
    }
  })

  it('skips journal records that are not prepared schema-version 1 transactions', () => {
    const item = fixture()
    const directory = journalDirectory(item)
    mkdirSync(directory, { recursive: true })
    const records = [
      '123',
      'null',
      '{"schemaVersion": 2, "id": "legacy", "state": "prepared", "operations": []}',
      '{"schemaVersion": 1, "id": "bad id!", "state": "prepared", "operations": []}',
      '{"schemaVersion": 1, "id": "settled", "state": "committed", "operations": []}',
      '{"schemaVersion": 1, "id": "malformed", "state": "prepared", "operations": "nope"}',
    ]
    for (const [index, record] of records.entries()) {
      writeFileSync(join(directory, `${index}.json`), record, 'utf8')
    }

    expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(0)
    for (const [index, record] of records.entries()) {
      expect(readFileSync(join(directory, `${index}.json`), 'utf8')).toBe(record)
    }
    expect(existsSync(item.candidateFull)).toBe(true)
  })
})

describe('prepared journal revalidation', () => {
  it('fails closed when a prepared journal file diverged from its recorded state', () => {
    const item = fixture()
    verify(item)
    const journal = interruptAtJournalPersistence(item)
    const target = operationOf(journal, 'canonical')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    mkdirSync(dirname(target.path), { recursive: true })
    writeFileSync(target.path, 'divergent canonical bytes', 'utf8')

    expect(() => recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toThrow(/divergent state/u)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(readJournal(item).state).toBe('prepared')
  })

  it('fails closed when a prepared journal stage diverged from its recorded bytes', () => {
    const item = fixture()
    verify(item)
    const journal = interruptAtJournalPersistence(item)
    const review = operationOf(journal, 'review')
    if (review.stagingPath === undefined) throw new Error('review operation has no staging path')
    writeFileSync(review.stagingPath, 'divergent stage bytes', 'utf8')

    expect(() => recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toThrow(/divergent stage/u)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(review.before)
    expect(readJournal(item).state).toBe('prepared')
  })

  it('fails closed when a prepared journal tombstone diverged from its recorded bytes', () => {
    const item = fixture()
    verify(item)
    const journal = interruptAtJournalPersistence(item)
    const candidateOperation = operationOf(journal, 'candidate')
    if (candidateOperation.tombstonePath === undefined) throw new Error('candidate operation has no tombstone path')
    writeFileSync(candidateOperation.tombstonePath, 'divergent tombstone bytes', 'utf8')

    expect(() => recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toThrow(/divergent tombstone/u)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateOperation.before)
    expect(readJournal(item).state).toBe('prepared')
  })

  it('refuses to recover a prepared journal without an authority', () => {
    const item = fixture()
    verify(item)
    const journal = interruptAtJournalPersistence(item)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')

    expect(() => recoverCandidateReviewTransactions(
      undefined, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toThrow('promotion journal authority validation failed')
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(operationOf(journal, 'candidate').before)
    expect(readJournal(item).state).toBe('prepared')
  })

  it('refuses an authentically sealed journal without immutable pre-state', () => {
    const item = fixture()
    verify(item)
    const journal = interruptAtJournalPersistence(item)
    const review = operationOf(journal, 'review')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')

    resealJournal(item, journal, (core) => {
      core.operations = core.operations.map(operation => operation.role === 'review'
        ? { role: operation.role, path: operation.path, after: operation.after, stagingPath: operation.stagingPath }
        : operation)
    })
    expect(() => recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toThrow('promotion journal lacks immutable pre-state')
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(review.before).toBeDefined()
  })

  it('refuses an authentically sealed journal whose review pre-state is not an array', () => {
    const item = fixture()
    verify(item)
    const journal = interruptAtJournalPersistence(item)

    resealJournal(item, journal, (core) => {
      core.operations = core.operations.map(operation =>
        operation.role === 'review' ? { ...operation, before: '{}' } : operation)
    })
    expect(() => recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toThrow('promotion journal review pre-state is invalid')
    expect(readJournal(item).state).toBe('prepared')
  })

  it('refuses an authentically sealed journal whose candidate binding does not hold', () => {
    const missingRow = fixture()
    verify(missingRow)
    const missingJournal = interruptAtJournalPersistence(missingRow)
    resealJournal(missingRow, missingJournal, (core) => {
      core.operations = core.operations.map(operation =>
        operation.role === 'review' ? { ...operation, before: '[]' } : operation)
    })
    expect(() => recoverCandidateReviewTransactions(
      authority, missingRow.reviewFile, missingRow.wikiRoot, missingRow.archiveRoot,
    )).toThrow('promotion journal candidate binding failed')

    const rebind = fixture()
    verify(rebind)
    const rebindJournal = interruptAtJournalPersistence(rebind)
    resealJournal(rebind, rebindJournal, (core) => {
      core.candidateHash = 'f'.repeat(64)
    })
    expect(() => recoverCandidateReviewTransactions(
      authority, rebind.reviewFile, rebind.wikiRoot, rebind.archiveRoot,
    )).toThrow('promotion journal candidate binding failed')
    expect(existsSync(rebind.candidateFull)).toBe(true)
  })

  it('refuses an authentically sealed journal whose receipt binding is incomplete', () => {
    const unbound = fixture()
    verify(unbound)
    const unboundJournal = interruptAtJournalPersistence(unbound)
    resealJournal(unbound, unboundJournal, (core) => {
      core.receiptId = null
    })
    expect(() => recoverCandidateReviewTransactions(
      authority, unbound.reviewFile, unbound.wikiRoot, unbound.archiveRoot,
    )).toThrow('promotion journal receipt binding is incomplete')

    const unlisted = fixture()
    verify(unlisted)
    const unlistedJournal = interruptAtJournalPersistence(unlisted)
    resealJournal(unlisted, unlistedJournal, (core) => {
      core.action = 'Skip'
    })
    expect(() => recoverCandidateReviewTransactions(
      authority, unlisted.reviewFile, unlisted.wikiRoot, unlisted.archiveRoot,
    )).toThrow('promotion journal receipt binding is incomplete')
    expect(readJournal(unlisted).state).toBe('prepared')
  })

  it('refuses a sealed journal whose auxiliary path left its operation parent', () => {
    const item = fixture()
    verify(item)
    const journal = interruptAtJournalPersistence(item)
    resealJournal(item, journal, (core) => {
      core.operations = core.operations.map(operation => operation.role === 'canonical'
        ? { ...operation, stagingPath: join(item.wikiRoot, '.ark-wal-stage-elsewhere') }
        : operation)
    })

    expect(() => recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toThrow('promotion auxiliary path changed parent')
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readJournal(item).state).toBe('prepared')
  })

  it('refuses a sealed journal whose delete operation lost its tombstone path', () => {
    const item = fixture()
    verify(item)
    const journal = interruptAtJournalPersistence(item)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    resealJournal(item, journal, (core) => {
      const candidate = operationOf(core, 'candidate')
      const withoutTombstone: JournalOperation = {
        role: candidate.role,
        path: candidate.path,
        ...(candidate.before === undefined ? {} : { before: candidate.before }),
        ...(candidate.after === undefined ? {} : { after: candidate.after }),
        ...(candidate.stagingPath === undefined ? {} : { stagingPath: candidate.stagingPath }),
      }
      core.operations = [withoutTombstone, ...core.operations.filter(operation => operation.role !== 'candidate')]
    })

    expect(() => recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toThrow('promotion delete lacks a tombstone path')
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
  })

  it('refuses a sealed journal whose write operation lost its staging path', () => {
    const item = fixture()
    verify(item)
    const journal = interruptAtJournalPersistence(item)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    resealJournal(item, journal, (core) => {
      const review = operationOf(core, 'review')
      const withoutStage: JournalOperation = {
        role: review.role,
        path: review.path,
        ...(review.before === undefined ? {} : { before: review.before }),
        ...(review.after === undefined ? {} : { after: review.after }),
        ...(review.tombstonePath === undefined ? {} : { tombstonePath: review.tombstonePath }),
      }
      core.operations = [withoutStage, ...core.operations.filter(operation => operation.role !== 'review')]
    })

    expect(() => recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toThrow('promotion write lacks a staging path')
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
  })
})

describe('promotion transaction interference', () => {
  it('refuses a stage entry that external bytes already occupy and rolls back cleanly', () => {
    const item = fixture()
    verify(item)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'journal-persisted') return
      const review = operationOf(core, 'review')
      if (review.stagingPath === undefined) throw new Error('review operation has no staging path')
      writeFileSync(review.stagingPath, 'conflicting stage bytes', 'utf8')
    })

    expect(() => apply(item, mutating)).toThrow(/promotion stage conflict/u)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(readJournal(item).state).toBe('rolled-back')
    expect(walLeftovers(item.root)).toEqual([])
  })

  it('restores durable state when the candidate reappears before the commit marker', () => {
    const item = fixture()
    verify(item)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'operation-applied' || checkpoint.operationIndex !== core.operations.length - 1) return
      const candidateOperation = operationOf(core, 'candidate')
      if (candidateOperation.before === undefined) throw new Error('candidate operation has no pre-state')
      writeFileSync(candidateOperation.path, candidateOperation.before, 'utf8')
    })

    expect(() => apply(item, mutating)).toThrow(/promotion post-commit mismatch/u)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(readJournal(item).state).toBe('rolled-back')
    expect(walLeftovers(item.root)).toEqual([])
  })

  it('reports an incomplete rollback when a divergent tombstone blocks the delete', () => {
    const item = fixture()
    verify(item)
    const mutating = checkpointAuthority((core, checkpoint) => {
      const candidateOperation = operationOf(core, 'candidate')
      if (checkpoint.phase !== 'operation-applied'
        || checkpoint.operationIndex !== core.operations.findIndex(operation => operation.role === 'governance')) return
      if (candidateOperation.tombstonePath === undefined) throw new Error('candidate operation has no tombstone path')
      unlinkSync(candidateOperation.path)
      writeFileSync(candidateOperation.tombstonePath, 'divergent tombstone bytes', 'utf8')
    })

    const failure = captureFailure(() => { apply(item, mutating) })
    expect(aggregateMessages(failure)).toEqual([
      expect.stringMatching(/promotion tombstone conflict at /u),
      expect.stringMatching(/promotion rollback tombstone conflict at /u),
    ])
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
  })

  it('reports an incomplete rollback when the delete tombstone already exists', () => {
    const item = fixture()
    verify(item)
    const mutating = checkpointAuthority((core, checkpoint) => {
      const candidateOperation = operationOf(core, 'candidate')
      if (checkpoint.phase !== 'operation-applied'
        || checkpoint.operationIndex !== core.operations.findIndex(operation => operation.role === 'governance')) return
      if (candidateOperation.tombstonePath === undefined || candidateOperation.before === undefined) {
        throw new Error('candidate operation has no delete pre-state')
      }
      writeFileSync(candidateOperation.tombstonePath, candidateOperation.before, 'utf8')
    })

    const failure = captureFailure(() => { apply(item, mutating) })
    expect(aggregateMessages(failure)).toEqual([
      expect.stringMatching(/promotion tombstone already exists: /u),
      expect.stringMatching(/promotion rollback tombstone conflict at /u),
    ])
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
  })

  it('reports an incomplete rollback when the tombstone identity changes under the transaction', () => {
    const item = fixture()
    verify(item)
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'entry-renamed'
        || checkpoint.operationIndex !== core.operations.findIndex(operation => operation.role === 'candidate')) return
      const candidateOperation = operationOf(core, 'candidate')
      if (candidateOperation.tombstonePath === undefined) throw new Error('candidate operation has no tombstone path')
      writeFileSync(candidateOperation.tombstonePath, 'tampered tombstone bytes', 'utf8')
    })

    const failure = captureFailure(() => { apply(item, mutating) })
    expect(aggregateMessages(failure)).toEqual([
      expect.stringMatching(/promotion tombstone identity changed: /u),
      expect.stringMatching(/promotion rollback tombstone conflict at /u),
    ])
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
  })

  it('restores a renamed candidate entry when its checkpoint fails', () => {
    const item = fixture()
    verify(item)
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const checkpointFailure = new Error('audit checkpoint unavailable')
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase === 'entry-renamed'
        && checkpoint.operationIndex === core.operations.findIndex(operation => operation.role === 'candidate')) {
        throw checkpointFailure
      }
    })

    expect(() => apply(item, mutating)).toThrow(checkpointFailure)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(readJournal(item).state).toBe('rolled-back')
    expect(walLeftovers(item.root)).toEqual([])
  })

  it('fails closed when the canonical target diverges during the operation set', () => {
    const item = fixture()
    verify(item)
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'journal-persisted') return
      const target = operationOf(core, 'canonical')
      mkdirSync(dirname(target.path), { recursive: true })
      writeFileSync(target.path, 'divergent canonical bytes', 'utf8')
    })

    const failure = captureFailure(() => { apply(item, mutating) })
    expect(aggregateMessages(failure)).toEqual([
      expect.stringMatching(/promotion recovery conflict at /u),
      expect.stringMatching(/promotion rollback conflict at /u),
    ])
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
  })

  it('fails closed when the governance log diverges during the operation set', () => {
    const item = fixture()
    verify(item)
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'journal-persisted') return
      writeFileSync(operationOf(core, 'governance').path, 'divergent governance bytes\n', 'utf8')
    })

    const failure = captureFailure(() => { apply(item, mutating) })
    expect(aggregateMessages(failure)).toEqual([
      expect.stringMatching(/promotion recovery conflict at /u),
      expect.stringMatching(/promotion rollback conflict at /u),
    ])
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
  })

  it('fails closed when staged bytes vanish before their rename', () => {
    const item = fixture()
    verify(item)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'stage-written') return
      const operation = core.operations[checkpoint.operationIndex]
      if (operation?.role !== 'canonical' || operation.stagingPath === undefined) return
      unlinkSync(operation.stagingPath)
    })

    expect(() => apply(item, mutating)).toThrow(/ENOENT/u)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(readJournal(item).state).toBe('rolled-back')
    expect(walLeftovers(item.root)).toEqual([])
  })

  it('fails closed when the review bytes diverge after staging', () => {
    const item = fixture()
    verify(item)
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'stage-written') return
      const operation = core.operations[checkpoint.operationIndex]
      if (operation?.role !== 'review') return
      writeFileSync(operation.path, 'divergent review bytes', 'utf8')
    })

    const failure = captureFailure(() => { apply(item, mutating) })
    expect(aggregateMessages(failure)).toEqual([
      expect.stringMatching(/promotion target changed before rename: /u),
      expect.stringMatching(/promotion rollback conflict at /u),
    ])
    expect(readFileSync(item.reviewFile, 'utf8')).toBe('divergent review bytes')
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('restores the candidate when its bytes diverge before the delete', () => {
    const item = fixture()
    verify(item)
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'operation-applied'
        || checkpoint.operationIndex !== core.operations.findIndex(operation => operation.role === 'governance')) return
      writeFileSync(operationOf(core, 'candidate').path, 'tampered candidate bytes', 'utf8')
    })

    expect(() => apply(item, mutating)).toThrow(/promotion recovery conflict at /u)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(readJournal(item).state).toBe('rolled-back')
    expect(walLeftovers(item.root)).toEqual([])
  })
})
