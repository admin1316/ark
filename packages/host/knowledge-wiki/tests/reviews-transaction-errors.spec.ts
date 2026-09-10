import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({
  failRenameTo: '',
  failRenameCount: 0,
  failSecondaryRenameTo: '',
  failSecondaryRenameCount: 0,
  armCorruptionAfterRenameTo: '',
  armCorruptionCount: 0,
  corruptionPath: '',
  corruptionCount: 0,
  lstatCounts: {} as Record<string, number>,
  lstatSymlinkPath: '',
  lstatSymlinkAt: 0,
  lstatErrorPath: '',
  lstatErrorCount: 0,
  lstatDeleteStageCount: 0,
  mkdirMutationPath: '',
  mkdirCreateFile: '',
  mkdirMutationCount: 0,
  readCounts: {} as Record<string, number>,
  readOverridePath: '',
  readOverrideAt: 0,
  readOverrideValue: '',
  resolveCount: 0,
  resolveOverrideAt: 0,
}))

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  return {
    ...actual,
    resolve: (...args: Parameters<typeof actual.resolve>): string => {
      faults.resolveCount += 1
      const resolved = actual.resolve(...args)
      return faults.resolveCount === faults.resolveOverrideAt ? `${resolved}-changed` : resolved
    },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>): void => {
      const destination = String(args[1])
      if (destination === faults.failRenameTo && faults.failRenameCount > 0) {
        faults.failRenameCount -= 1
        throw Object.assign(new Error(`injected rename failure: ${destination}`), { code: 'EIO' })
      }
      if (destination === faults.failSecondaryRenameTo && faults.failSecondaryRenameCount > 0) {
        faults.failSecondaryRenameCount -= 1
        throw Object.assign(new Error(`injected rollback failure: ${destination}`), { code: 'EIO' })
      }
      actual.renameSync(...args)
      if (destination === faults.armCorruptionAfterRenameTo && faults.armCorruptionCount > 0) {
        faults.armCorruptionCount -= 1
        faults.corruptionCount = 1
      }
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>): ReturnType<typeof actual.lstatSync> => {
      const path = String(args[0])
      faults.lstatCounts[path] = (faults.lstatCounts[path] ?? 0) + 1
      if (path === faults.lstatErrorPath && faults.lstatErrorCount > 0) {
        faults.lstatErrorCount -= 1
        throw Object.assign(new Error(`injected lstat failure: ${path}`), { code: 'EIO' })
      }
      if (path.includes('.ark-stage-') && faults.lstatDeleteStageCount > 0) {
        faults.lstatDeleteStageCount -= 1
        actual.unlinkSync(path)
        throw Object.assign(new Error(`injected missing staged file: ${path}`), { code: 'ENOENT' })
      }
      const result = actual.lstatSync(...args)
      if (result === undefined) return result
      if (path === faults.lstatSymlinkPath && faults.lstatCounts[path] === faults.lstatSymlinkAt) {
        return new Proxy(result, {
          get(target, property, receiver) {
            if (property === 'isSymbolicLink') return () => true
            const value: unknown = Reflect.get(target, property, receiver)
            return value
          },
        })
      }
      return result
    },
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>): ReturnType<typeof actual.mkdirSync> => {
      const result = actual.mkdirSync(...args)
      if (String(args[0]) === faults.mkdirMutationPath && faults.mkdirMutationCount > 0) {
        faults.mkdirMutationCount -= 1
        actual.writeFileSync(faults.mkdirCreateFile, 'concurrent target', 'utf8')
      }
      return result
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>): ReturnType<typeof actual.readFileSync> => {
      const result = actual.readFileSync(...args)
      const path = String(args[0])
      faults.readCounts[path] = (faults.readCounts[path] ?? 0) + 1
      if (path === faults.readOverridePath && faults.readCounts[path] === faults.readOverrideAt && typeof result === 'string') {
        return faults.readOverrideValue
      }
      if (path === faults.corruptionPath && faults.corruptionCount > 0 && typeof result === 'string') {
        faults.corruptionCount -= 1
        return `${result}\ncorrupted-read`
      }
      return result
    },
  }
})

import {
  appendCandidateReviews,
  applyCandidateReview as applyCandidateReviewWithAuthority,
  recordCandidateVerification as recordCandidateVerificationWithAuthority,
} from '../src/reviews.ts'
import { issueTestReceipt, verifierAuthority } from './verifier-authority-fixture.ts'
import type { WikiReviewItem } from '../src/types.ts'

const roots: string[] = []
const authority = verifierAuthority()

beforeEach(() => {
  faults.failRenameTo = ''
  faults.failRenameCount = 0
  faults.failSecondaryRenameTo = ''
  faults.failSecondaryRenameCount = 0
  faults.armCorruptionAfterRenameTo = ''
  faults.armCorruptionCount = 0
  faults.corruptionPath = ''
  faults.corruptionCount = 0
  faults.lstatCounts = {}
  faults.lstatSymlinkPath = ''
  faults.lstatSymlinkAt = 0
  faults.lstatErrorPath = ''
  faults.lstatErrorCount = 0
  faults.lstatDeleteStageCount = 0
  faults.mkdirMutationPath = ''
  faults.mkdirCreateFile = ''
  faults.mkdirMutationCount = 0
  faults.readCounts = {}
  faults.readOverridePath = ''
  faults.readOverrideAt = 0
  faults.readOverrideValue = ''
  faults.resolveCount = 0
  faults.resolveOverrideAt = 0
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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

function verifyFixture(
  item: Fixture,
  action: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' = 'Promote',
): boolean {
  const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, action)
  return recordCandidateVerificationWithAuthority(
    authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, action,
  )
}

function applyCandidateReview(
  reviewFile: string,
  projectRoot: string,
  wikiRoot: string,
  archiveRoot: string,
  reviewId: string,
  action: string,
  actor?: string,
): boolean | null {
  return applyCandidateReviewWithAuthority(
    authority, reviewFile, projectRoot, wikiRoot, archiveRoot, reviewId, action, actor,
  )
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

function fixture(candidatePath = '_candidates/ingest/concepts/candidate.md', content = candidate()): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wiki-review-transaction-'))
  roots.push(root)
  const wikiRoot = join(root, 'wiki')
  const candidateFull = join(wikiRoot, candidatePath)
  const reviewFile = join(root, '.llm-wiki', 'review.json')
  mkdirSync(dirname(candidateFull), { recursive: true })
  writeFileSync(candidateFull, content, 'utf8')
  expect(appendCandidateReviews(reviewFile, root, 'raw/source.md', [`wiki/${candidatePath}`])).toBe(1)
  const reviewId = readItems(reviewFile)[0]!.id
  return { root, wikiRoot, archiveRoot: join(root, 'archive'), reviewFile, candidatePath, candidateFull, reviewId }
}

function readItems(reviewFile: string): WikiReviewItem[] {
  return JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[]
}

function governanceLog(item: Fixture): string {
  return join(dirname(item.reviewFile), 'governance.jsonl')
}

function resetOperationCounters(): void {
  faults.lstatCounts = {}
  faults.readCounts = {}
  faults.resolveCount = 0
}

function candidateArchivePath(item: Fixture): string {
  return join(
    item.archiveRoot,
    'wiki-governance',
    new Date().toISOString().slice(0, 10),
    basename(item.root),
    createHash('sha256').update(readFileSync(item.candidateFull, 'utf8')).digest('hex').slice(0, 12),
    item.candidatePath,
  )
}

describe('candidate review transaction rollback', () => {
  it('restores Promote when the governance-log commit fails', () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(verifyFixture(item)).toBe(true)
    const target = readItems(item.reviewFile)[0]!.targetPath!
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const logBefore = readFileSync(governanceLog(item), 'utf8')
    faults.failRenameTo = governanceLog(item)
    faults.failRenameCount = 1

    expect(() => applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toThrow(/injected rename failure/u)
    expect(existsSync(join(item.wikiRoot, target))).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(governanceLog(item), 'utf8')).toBe(logBefore)
  })

  it('restores canonical, archive, candidate, review, and log after a failed post-commit check', () => {
    const canonicalBefore = candidate('Canonical', 'stable canonical body')
    const item = fixture('_candidates/ingest/concepts/candidate.md', candidate('Candidate', 'replacement body'))
    const target = readItems(item.reviewFile)[0]!.targetPath!
    const targetFull = join(item.wikiRoot, target)
    mkdirSync(dirname(targetFull), { recursive: true })
    writeFileSync(targetFull, canonicalBefore, 'utf8')
    expect(verifyFixture(item, 'Replace')).toBe(true)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const logBefore = readFileSync(governanceLog(item), 'utf8')
    const archivedCanonical = join(
      item.archiveRoot,
      'wiki-governance',
      new Date().toISOString().slice(0, 10),
      basename(item.root),
      createHash('sha256').update(canonicalBefore).digest('hex').slice(0, 12),
      'canonical-before-update',
      target,
    )
    faults.failRenameTo = governanceLog(item)
    faults.failRenameCount = 1

    expect(() => applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Replace', 'human',
    )).toThrow(/injected rename failure/u)
    expect(readFileSync(targetFull, 'utf8')).toBe(canonicalBefore)
    expect(existsSync(archivedCanonical)).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(governanceLog(item), 'utf8')).toBe(logBefore)
  })

  it('restores the verifier governance log while rolling back Promote', () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(verifyFixture(item)).toBe(true)
    const row = readItems(item.reviewFile)[0]!
    const target = row.targetPath
    if (target === undefined) throw new Error('fixture did not derive a canonical target')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const logBefore = readFileSync(governanceLog(item), 'utf8')
    faults.failRenameTo = governanceLog(item)
    faults.failRenameCount = 1

    expect(() => applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toThrow(/injected rename failure/u)
    expect(readFileSync(governanceLog(item), 'utf8')).toBe(logBefore)
    expect(existsSync(join(item.wikiRoot, target))).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
  })

  it('fails before mutation when the storage layer rejects the review commit', () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(verifyFixture(item)).toBe(true)
    faults.failRenameTo = item.reviewFile
    faults.failRenameCount = 1
    faults.failSecondaryRenameCount = 1

    expect(() => applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toThrow(/injected rename failure/u)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('propagates non-missing archive inspection failures before mutation', () => {
    const item = fixture('_candidates/topics/disposable.md')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    faults.lstatErrorPath = candidateArchivePath(item)
    faults.lstatErrorCount = 1

    expect(() => applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).toThrow(/injected lstat failure/u)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
  })

  it('handles a staged file that an external actor removes before cleanup', () => {
    const item = fixture('_candidates/topics/disposable.md')
    faults.lstatDeleteStageCount = 1
    expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).toBe(true)
    expect(existsSync(item.candidateFull)).toBe(false)
  })

  it('rejects a canonical target whose resolved identity changes during staging', () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(verifyFixture(item)).toBe(true)
    const target = readItems(item.reviewFile)[0]!.targetPath!
    resetOperationCounters()
    faults.resolveOverrideAt = 2

    expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toBe(false)
    expect(existsSync(join(item.wikiRoot, target))).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('rejects a canonical target that becomes a symlink during staging', () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(verifyFixture(item)).toBe(true)
    const targetDirectory = join(item.wikiRoot, 'concepts')
    rmSync(targetDirectory, { recursive: true, force: true })
    symlinkSync(join(item.root, 'outside'), targetDirectory)

    expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('rejects a canonical target that appears while the transaction is staging', () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(verifyFixture(item)).toBe(true)
    const target = readItems(item.reviewFile)[0]!.targetPath!
    const targetFull = join(item.wikiRoot, target)
    mkdirSync(dirname(targetFull), { recursive: true })
    writeFileSync(targetFull, 'concurrent target')

    expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toBe(false)
    expect(readFileSync(targetFull, 'utf8')).toBe('concurrent target')
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('binds the current canonical bytes into the authority-sealed operation set', () => {
    const item = fixture()
    const target = readItems(item.reviewFile)[0]!.targetPath!
    const targetFull = join(item.wikiRoot, target)
    mkdirSync(dirname(targetFull), { recursive: true })
    writeFileSync(targetFull, candidate('Canonical'), 'utf8')
    expect(verifyFixture(item, 'Replace')).toBe(true)
    writeFileSync(targetFull, candidate('Changed canonical'), 'utf8')
    expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Replace', 'human',
    )).toBe(true)
    expect(existsSync(item.candidateFull)).toBe(false)
  })

  it('rejects a candidate whose resolved identity changes during staging', () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(verifyFixture(item)).toBe(true)
    const changedRoot = `${item.wikiRoot}-changed`
    const changedCandidate = join(changedRoot, item.candidatePath)
    mkdirSync(dirname(changedCandidate), { recursive: true })
    writeFileSync(changedCandidate, readFileSync(item.candidateFull, 'utf8'), 'utf8')
    resetOperationCounters()
    faults.resolveOverrideAt = 1

    expect(() => applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toThrow(/candidate path changed/u)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('rejects a candidate that becomes a symlink during staging', () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(verifyFixture(item)).toBe(true)
    resetOperationCounters()
    faults.lstatSymlinkPath = item.candidateFull
    faults.lstatSymlinkAt = 2

    expect(() => applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toThrow(/unique ordinary file/u)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('rejects candidate bytes changed after independent verification', () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(verifyFixture(item)).toBe(true)
    writeFileSync(item.candidateFull, 'changed candidate', 'utf8')
    expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('rejects immutable Review bytes changed after independent verification', () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(verifyFixture(item)).toBe(true)
    const items = readItems(item.reviewFile)
    items[0] = { ...items[0]!, title: 'changed review' }
    writeFileSync(item.reviewFile, JSON.stringify(items, null, 2), 'utf8')
    expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('binds current governance-log bytes into the authority-sealed operation set', () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(verifyFixture(item)).toBe(true)
    writeFileSync(governanceLog(item), 'external audit line\n', 'utf8')
    expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toBe(true)
    expect(readFileSync(governanceLog(item), 'utf8')).toContain('external audit line')
  })
})
