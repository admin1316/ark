import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({
  failRenameTo: '',
  failRenameCount: 0,
  failSecondaryRenameTo: '',
  failSecondaryRenameCount: 0,
  failDescriptorWritePath: '',
  failDescriptorWriteCount: 0,
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
  openCounts: {} as Record<string, number>,
  descriptorPaths: {} as Record<number, string>,
  tamperReadPath: '',
  tamperReadAt: 0,
  tamperReadValue: '',
  tamperReadFired: false,
  armOnOpenPath: '',
  armOnOpenAt: 0,
  armOnOpenRun: '',
  armOnOpenTarget: '',
  armOnOpenContent: '',
  armOnOpenFired: false,
  armLstatSymlink: false,
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
      if (path === faults.lstatSymlinkPath
        && (faults.armLstatSymlink || faults.lstatCounts[path] === faults.lstatSymlinkAt)) {
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
    openSync: (...args: Parameters<typeof actual.openSync>): ReturnType<typeof actual.openSync> => {
      const path = String(args[0])
      const descriptor = actual.openSync(...args)
      faults.descriptorPaths[descriptor] = path
      faults.openCounts[path] = (faults.openCounts[path] ?? 0) + 1
      if (path === faults.armOnOpenPath && faults.openCounts[path] === faults.armOnOpenAt && !faults.armOnOpenFired) {
        faults.armOnOpenFired = true
        if (faults.armOnOpenRun === 'create-target') {
          actual.writeFileSync(faults.armOnOpenTarget, faults.armOnOpenContent, 'utf8')
        }
        if (faults.armOnOpenRun === 'symlink-target') faults.armLstatSymlink = true
        if (faults.armOnOpenRun === 'symlink-entry') {
          actual.symlinkSync(faults.armOnOpenContent, faults.armOnOpenTarget)
        }
      }
      return descriptor
    },
    readSync: (...args: Parameters<typeof actual.readSync>): ReturnType<typeof actual.readSync> => {
      const count = actual.readSync(...args)
      const path = faults.descriptorPaths[args[0]]
      if (path === faults.tamperReadPath && faults.openCounts[path] === faults.tamperReadAt
        && !faults.tamperReadFired && count > 0) {
        faults.tamperReadFired = true
        const view = args[1]
        Buffer.from(view.buffer, view.byteOffset, count).write(faults.tamperReadValue.slice(0, count))
      }
      return count
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
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>): ReturnType<typeof actual.writeFileSync> => {
      const path = typeof args[0] === 'number' ? faults.descriptorPaths[args[0]] : undefined
      if (path === faults.failDescriptorWritePath && faults.failDescriptorWriteCount > 0) {
        faults.failDescriptorWriteCount -= 1
        throw Object.assign(new Error(`injected descriptor write failure: ${path}`), { code: 'EIO' })
      }
      actual.writeFileSync(...args)
    },
  }
})

import {
  appendCandidateReviews,
  applyCandidateReview as applyCandidateReviewWithAuthority,
  recoverCandidateReviewTransactions,
  recordCandidateVerification as recordCandidateVerificationWithAuthority,
} from '../src/reviews.ts'
import { verifyCandidate } from '../src/verifier.ts'
import { issueTestReceipt, verifierAuthority } from './verifier-authority-fixture.ts'
import type { WikiReviewItem } from '../src/types.ts'

const roots: string[] = []
const authority = verifierAuthority()

beforeEach(() => {
  faults.failRenameTo = ''
  faults.failRenameCount = 0
  faults.failSecondaryRenameTo = ''
  faults.failSecondaryRenameCount = 0
  faults.failDescriptorWritePath = ''
  faults.failDescriptorWriteCount = 0
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
  faults.openCounts = {}
  faults.descriptorPaths = {}
  faults.tamperReadPath = ''
  faults.tamperReadAt = 0
  faults.tamperReadValue = ''
  faults.tamperReadFired = false
  faults.armOnOpenPath = ''
  faults.armOnOpenAt = 0
  faults.armOnOpenRun = ''
  faults.armOnOpenTarget = ''
  faults.armOnOpenContent = ''
  faults.armOnOpenFired = false
  faults.armLstatSymlink = false
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

async function verifyFixture(
  item: Fixture,
  action: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' = 'Promote',
): Promise<boolean> {
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
): Promise<boolean | null> {
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

function writeItems(reviewFile: string, items: WikiReviewItem[]): void {
  writeFileSync(reviewFile, JSON.stringify(items, null, 2), 'utf8')
}

function governanceLog(item: Fixture): string {
  return join(dirname(item.reviewFile), 'governance.jsonl')
}

function resetOperationCounters(): void {
  faults.lstatCounts = {}
  faults.readCounts = {}
  faults.openCounts = {}
  faults.descriptorPaths = {}
  faults.tamperReadFired = false
  faults.armOnOpenFired = false
  faults.armLstatSymlink = false
  faults.resolveCount = 0
  faults.resolveOverrideAt = 0
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
  it('restores Archive when the governance-log commit fails', async () => {
    const item = fixture('_candidates/topics/disposable.md')
    const archived = candidateArchivePath(item)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const logBefore = existsSync(governanceLog(item)) ? readFileSync(governanceLog(item), 'utf8') : ''
    faults.failRenameTo = governanceLog(item)
    faults.failRenameCount = 1

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).rejects.toThrow(/injected rename failure/u)
    expect(existsSync(archived)).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(existsSync(governanceLog(item))).toBe(false)
    expect(logBefore).toBe('')
  })

  it('rolls back Archive when the storage layer rejects the review commit', async () => {
    const item = fixture('_candidates/topics/disposable.md')
    const archived = candidateArchivePath(item)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const logBefore = existsSync(governanceLog(item)) ? readFileSync(governanceLog(item), 'utf8') : ''
    faults.failRenameTo = item.reviewFile
    faults.failRenameCount = 1

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).rejects.toThrow(/injected rename failure/u)
    expect(existsSync(archived)).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(existsSync(governanceLog(item))).toBe(false)
    expect(logBefore).toBe('')
  })

  it('propagates non-missing archive inspection failures before mutation', async () => {
    const item = fixture('_candidates/topics/disposable.md')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    faults.lstatErrorPath = candidateArchivePath(item)
    faults.lstatErrorCount = 1

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).rejects.toThrow(/injected lstat failure/u)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
  })

  it('handles a staged file that an external actor removes before cleanup', async () => {
    const item = fixture('_candidates/topics/disposable.md')
    faults.lstatDeleteStageCount = 1
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).toBe(true)
    expect(existsSync(item.candidateFull)).toBe(false)
  })

  it('denies a semantically verified candidate from canonical promotion without a measured trial', async () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(await verifyFixture(item)).toBe(true)
    const target = readItems(item.reviewFile)[0]!.targetPath!
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Promote', 'human',
    )).toBe(false)
    expect(existsSync(join(item.wikiRoot, target))).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('leaves current canonical content unchanged when measured-trial authority is absent', async () => {
    const item = fixture()
    const target = readItems(item.reviewFile)[0]!.targetPath!
    const targetFull = join(item.wikiRoot, target)
    mkdirSync(dirname(targetFull), { recursive: true })
    const canonicalBefore = candidate('Canonical')
    writeFileSync(targetFull, canonicalBefore, 'utf8')
    expect(await verifyFixture(item, 'Replace')).toBe(true)
    writeFileSync(targetFull, candidate('Changed canonical'), 'utf8')
    const changedCanonical = readFileSync(targetFull, 'utf8')
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Replace', 'human',
    )).toBe(false)
    expect(readFileSync(targetFull, 'utf8')).toBe(changedCanonical)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('rejects a candidate whose resolved identity changes during staging', async () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(await verifyFixture(item)).toBe(true)
    const changedRoot = `${item.wikiRoot}-changed`
    const changedCandidate = join(changedRoot, item.candidatePath)
    mkdirSync(dirname(changedCandidate), { recursive: true })
    writeFileSync(changedCandidate, readFileSync(item.candidateFull, 'utf8'), 'utf8')
    resetOperationCounters()
    faults.resolveOverrideAt = 1

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).rejects.toThrow(/candidate path changed/u)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('rejects a candidate that becomes a symlink during staging', async () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(await verifyFixture(item)).toBe(true)
    resetOperationCounters()
    faults.lstatSymlinkPath = item.candidateFull
    faults.lstatSymlinkAt = 2

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).rejects.toThrow(/unique ordinary file/u)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('rejects candidate bytes changed after independent verification', async () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(await verifyFixture(item)).toBe(true)
    writeFileSync(item.candidateFull, 'changed candidate', 'utf8')
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('archives a semantically verified candidate after a safe review-row edit', async () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(await verifyFixture(item)).toBe(true)
    const items = readItems(item.reviewFile)
    items[0] = { ...items[0]!, title: 'changed review' }
    writeFileSync(item.reviewFile, JSON.stringify(items, null, 2), 'utf8')
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).toBe(true)
    expect(existsSync(item.candidateFull)).toBe(false)
  })

  it('preserves and appends external audit entries to current governance-log bytes', async () => {
    const item = fixture('_candidates/topics/disposable.md')
    writeFileSync(governanceLog(item), 'external audit line\n', 'utf8')
    expect(await applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).toBe(true)
    expect(readFileSync(governanceLog(item), 'utf8')).toContain('external audit line')
  })

  it('leaves a committed Archive without its lifecycle event when only event append fails', async () => {
    const item = fixture('_candidates/topics/disposable.md')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const journalDirectory = join(dirname(item.reviewFile), 'promotion-journal')
    const archived = candidateArchivePath(item)
    const candidateBytesBefore = readFileSync(item.candidateFull, 'utf8')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const governanceBefore = existsSync(governanceLog(item)) ? readFileSync(governanceLog(item), 'utf8') : undefined
    const eventBytesBefore = existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : undefined
    const eventTypesBefore = (eventBytesBefore ?? '').trim().split('\n').filter(Boolean)
      .map(line => (JSON.parse(line) as { type: string }).type)
    faults.failDescriptorWritePath = eventPath
    faults.failDescriptorWriteCount = 1

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).rejects.toThrow(/injected descriptor write failure/u)

    expect(existsSync(item.candidateFull)).toBe(false)
    expect(existsSync(archived)).toBe(true)
    expect(readFileSync(archived, 'utf8')).toBe(candidateBytesBefore)
    expect(readFileSync(item.reviewFile, 'utf8')).not.toBe(reviewBefore)
    const governanceAfterCommit = readFileSync(governanceLog(item), 'utf8')
    expect(governanceAfterCommit).not.toBe(governanceBefore)
    const journalName = readdirSync(journalDirectory).find(name => name.endsWith('.json'))
    expect(journalName).toBeDefined()
    const journalPath = join(journalDirectory, journalName!)
    const journalAfterCommit = readFileSync(journalPath, 'utf8')
    const journalAtFailure = JSON.parse(journalAfterCommit) as Record<string, unknown>
    const journalStateAtFailure = journalAtFailure.state
    expect(journalAtFailure).toMatchObject({ action: 'Archive' })
    expect(existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : undefined).toBe(eventBytesBefore)
    const reviewAfterCommit = readFileSync(item.reviewFile, 'utf8')
    const archivedBytesAfterCommit = readFileSync(archived, 'utf8')

    const firstRecovery = await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )
    const secondRecovery = await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )
    const events = existsSync(eventPath)
      ? readFileSync(eventPath, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { type: string })
      : []
    const observed = {
      firstRecovery,
      secondRecovery,
      journalStateAtFailure,
      eventTypes: events.map(event => event.type),
      eventBytes: existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : undefined,
      journalAfterRecovery: JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>,
      reviewAfterRecovery: readFileSync(item.reviewFile, 'utf8'),
      governanceAfterRecovery: readFileSync(governanceLog(item), 'utf8'),
      archivedBytesAfterRecovery: readFileSync(archived, 'utf8'),
      archivedStillPresent: existsSync(archived),
      candidateStillAbsent: !existsSync(item.candidateFull),
    }

    expect(typeof observed.eventBytes).toBe('string')
    expect(observed).toMatchObject({
      journalStateAtFailure: 'prepared',
      firstRecovery: 1,
      secondRecovery: 0,
      eventTypes: [...eventTypesBefore, 'knowledge/rejected'],
      journalAfterRecovery: { ...journalAtFailure, state: 'committed' },
      reviewAfterRecovery: reviewAfterCommit,
      governanceAfterRecovery: governanceAfterCommit,
      archivedBytesAfterRecovery: archivedBytesAfterCommit,
      archivedStillPresent: true,
      candidateStillAbsent: true,
    })
  })

  it('repairs a missing Archive event from a legacy committed journal without replaying file changes', async () => {
    const item = fixture('_candidates/topics/disposable.md')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const journalDirectory = join(dirname(item.reviewFile), 'promotion-journal')
    const archived = candidateArchivePath(item)
    const candidateBytesBefore = readFileSync(item.candidateFull, 'utf8')
    const eventBytesBefore = readFileSync(eventPath, 'utf8')
    const eventTypesBefore = eventBytesBefore.trim().split('\n').filter(Boolean)
      .map(line => (JSON.parse(line) as { type: string }).type)
    faults.failDescriptorWritePath = eventPath
    faults.failDescriptorWriteCount = 1

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).rejects.toThrow(/injected descriptor write failure/u)

    const journalName = readdirSync(journalDirectory).find(name => name.endsWith('.json'))
    expect(journalName).toBeDefined()
    const journalPath = join(journalDirectory, journalName!)
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>
    expect(existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : undefined).toBe(eventBytesBefore)
    expect(existsSync(archived)).toBe(true)
    expect(readFileSync(archived, 'utf8')).toBe(candidateBytesBefore)

    // Simulate the already-written committed marker from older versions whose
    // event append ran after commitPromotionJournal.
    writeFileSync(journalPath, `${JSON.stringify({ ...journal, state: 'committed' }, null, 2)}\n`, 'utf8')
    const reviewAtRecovery = readFileSync(item.reviewFile, 'utf8')
    const governanceAtRecovery = readFileSync(governanceLog(item), 'utf8')
    const firstRecovery = await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )
    const eventBytesAfterFirstRecovery = existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : undefined
    const secondRecovery = await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )
    const eventTypesAfterRecovery = (eventBytesAfterFirstRecovery ?? '').trim().split('\n').filter(Boolean)
      .map(line => (JSON.parse(line) as { type: string }).type)

    expect({
      firstRecovery,
      secondRecovery,
      eventTypesAfterRecovery,
      reviewAfterRecovery: readFileSync(item.reviewFile, 'utf8'),
      governanceAfterRecovery: readFileSync(governanceLog(item), 'utf8'),
      archivedBytesAfterRecovery: readFileSync(archived, 'utf8'),
      journalStateAfterRecovery: (JSON.parse(readFileSync(journalPath, 'utf8')) as { state: string }).state,
    }).toMatchObject({
      firstRecovery: 1,
      secondRecovery: 0,
      eventTypesAfterRecovery: [...eventTypesBefore, 'knowledge/rejected'],
      reviewAfterRecovery: reviewAtRecovery,
      governanceAfterRecovery: governanceAtRecovery,
      archivedBytesAfterRecovery: candidateBytesBefore,
      journalStateAfterRecovery: 'committed',
    })
  })
})
describe('concurrent mutation guards during a review transaction', () => {
  it('denies Merge and Deduplicate without measured-trial authority', async () => {
    for (const action of ['Merge', 'Deduplicate'] as const) {
      const item = fixture()
      const target = readItems(item.reviewFile)[0]!.targetPath!
      const targetFull = join(item.wikiRoot, target)
      mkdirSync(dirname(targetFull), { recursive: true })
      const canonicalBefore = candidate('Canonical')
      writeFileSync(targetFull, canonicalBefore, 'utf8')
      expect(await verifyFixture(item, action)).toBe(true)

      expect(await applyCandidateReview(
        item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, action, 'human',
      )).toBe(false)
      expect(readFileSync(targetFull, 'utf8')).toBe(canonicalBefore)
      expect(existsSync(item.candidateFull)).toBe(true)
    }
  })

  it('refuses candidate bytes that change during staging', async () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(await verifyFixture(item)).toBe(true)
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    resetOperationCounters()
    faults.tamperReadPath = item.candidateFull
    faults.tamperReadAt = 3
    faults.tamperReadValue = 'candidate bytes replaced by a concurrent writer'

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).resolves.toBe(false)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(existsSync(candidateArchivePath(item))).toBe(false)
  })

  it('refuses review state that changes during staging', async () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(await verifyFixture(item)).toBe(true)
    resetOperationCounters()
    faults.tamperReadPath = item.reviewFile
    faults.tamperReadAt = 3
    faults.tamperReadValue = 'review bytes replaced by a concurrent writer'

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).rejects.toThrow('review state changed during review transaction')
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(candidateArchivePath(item))).toBe(false)
  })

  it('refuses a governance log that changes during staging', async () => {
    const item = fixture('_candidates/sessions/candidate.md')
    expect(await verifyFixture(item)).toBe(true)
    resetOperationCounters()
    faults.tamperReadPath = governanceLog(item)
    faults.tamperReadAt = 2
    faults.tamperReadValue = 'governance bytes replaced by a concurrent writer\n'

    await expect(applyCandidateReview(
      item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive', 'human',
    )).rejects.toThrow('governance log changed during review transaction')
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(candidateArchivePath(item))).toBe(false)
  })

  it('propagates a non-missing failure while inspecting a canonical target', async () => {
    const item = fixture()
    const targetPath = 'concepts/missing-dir/leaf.md'
    const rows = readItems(item.reviewFile)
    writeItems(item.reviewFile, [{ ...rows[0]!, targetPath }])
    faults.lstatErrorPath = join(item.wikiRoot, targetPath)
    faults.lstatErrorCount = 1

    await expect(verifyCandidate(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal,
    )).rejects.toThrow(/injected lstat failure/u)
  })
})
