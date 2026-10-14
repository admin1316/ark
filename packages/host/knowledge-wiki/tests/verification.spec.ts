import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import KnowledgeWikiService from '../src/index.ts'
import {
  appendCandidateReviews,
  applyCandidateReview,
  recordCandidateMeasuredTrial,
  recordCandidateVerification,
  recoverCandidateReviewTransactions,
} from '../src/reviews.ts'
import { buildVerificationRequest, canonicalJson, readTrustedReceipt, readTrustedVerification, sha256, verifyCandidate, type KnowledgeWikiPromotionSealRequest, type KnowledgeWikiVerifierAuthority, type PromotionJournalSigningPayload, type TrustedVerificationReceipt, type VerificationAuthoritySeal } from '../src/verifier.ts'
import { readKnowledgeEventLog } from '../src/knowledge-governance.ts'
import type { KnowledgeWikiMeasuredTrialReader, VerifiedMeasuredTrial } from '../src/measured-trial.ts'
import type { WikiSnapshotStore } from '../src/snapshot-store.ts'
import type { CandidateVerification, WikiReviewItem } from '../src/types.ts'
import { issueTestReceipt, verifierAuthority } from './verifier-authority-fixture.ts'
import { wikiTestConfig } from './config-fixture.ts'
import * as filesystem from '../src/filesystem.ts'
import * as knowledgeGovernance from '../src/knowledge-governance.ts'
import * as wikiVerifier from '../src/verifier.ts'

const roots: string[] = []

function rejectOnAbort(signal: AbortSignal, reject: (reason: Error) => void, fallbackMessage: string): void {
  const rejectAborted = () => {
    const reason: unknown = signal.reason
    reject(reason instanceof Error ? reason : new Error(fallbackMessage))
  }
  if (signal.aborted) rejectAborted()
  else signal.addEventListener('abort', () => { rejectAborted() }, { once: true })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(rootPath?: string) {
  const root = rootPath ?? mkdtempSync(join(tmpdir(), 'wiki-verification-'))
  if (rootPath === undefined) roots.push(root)
  const wikiRoot = join(root, 'wiki')
  const candidatePath = '_candidates/ingest/concepts/git-identity-normalization.md'
  const candidateFull = join(wikiRoot, candidatePath)
  const reviewFile = join(root, '.llm-wiki', 'review.json')
  mkdirSync(dirname(candidateFull), { recursive: true })
  writeFileSync(candidateFull, `---
type: engineering_pattern
status: candidate
origin: ingest
title: Git identity normalization
sources: ["repo:admin1316/ark:test/sha-normalization"]
related: ["concepts/release-validation"]
---

# Git identity normalization

## 原则

Representations of one Git object must be normalized before equality checks.

## 适用条件

Use this for short and full commit identities during release and disaster validation.

## 验证证据

Unit and integration tests resolve both forms to one full commit identity.
`, 'utf8')
  appendCandidateReviews(reviewFile, root, 'raw/evidence/sha-test.json', [`wiki/${candidatePath}`])
  const review = (JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<{ id: string }>)[0]!
  return { root, wikiRoot, candidatePath, candidateFull, reviewFile, reviewId: review.id }
}

function measuredTrialReader(
  options: {
    readonly eligible?: boolean
    readonly utilityScore?: number
    readonly wrongHash?: boolean
    readonly patch?: Partial<VerifiedMeasuredTrial>
    readonly onRead?: () => void
  } = {},
): { readonly reader: KnowledgeWikiMeasuredTrialReader; readonly trialHash: string; readonly targetAfter: Buffer } {
  const authorityId = 'test-independent-measured-trial'
  const trialHash = 'a'.repeat(64)
  const targetAfter = Buffer.from('---\ntype: concept\nstatus: canonical\ntitle: measured candidate\n---\n\nverified paired-trial content\n')
  const reader: KnowledgeWikiMeasuredTrialReader = {
    authorityId,
    read(hash, binding): VerifiedMeasuredTrial | undefined {
      if (hash !== trialHash) return undefined
      options.onRead?.()
      const targetAfterHash = options.wrongHash ? 'b'.repeat(64) : sha256(targetAfter)
      return {
        authorityId,
        trialHash,
        proposalHash: 'c'.repeat(64),
        grantId: 'grant-1',
        candidatePath: binding.candidatePath,
        candidateHash: binding.candidateHash,
        action: binding.action,
        targetPath: binding.targetPath,
        targetBeforeHashOrVerifiedAbsence: binding.targetBeforeHashOrVerifiedAbsence,
        targetAfterHash,
        targetAfterBytes: Buffer.from(targetAfter),
        eligibleForReview: options.eligible ?? true,
        evidenceRefs: ['d'.repeat(64)],
        retrievalHits: 2,
        successfulUses: 1,
        userCorrections: 0,
        utilityScore: options.utilityScore ?? 0.5,
        startedAt: '2026-10-11T10:00:00.000Z',
        endedAt: '2026-10-11T10:02:00.000Z',
        ...options.patch,
      }
    },
  }
  return { reader, trialHash, targetAfter }
}

/** Seed the existing reader contract for refusal/recovery tests, not a real-use attestation. */
async function stagedMeasuredFixture(
  options: Parameters<typeof measuredTrialReader>[0] = {},
  action: 'Promote' | 'Merge' = 'Promote',
) {
  const item = fixture()
  const targetFull = join(item.wikiRoot, 'concepts/git-identity-normalization.md')
  if (action === 'Merge') {
    mkdirSync(dirname(targetFull), { recursive: true })
    writeFileSync(targetFull, '---\ntype: concept\nstatus: canonical\n---\n\nOriginal canonical bytes.\n')
  }
  const authority = verifierAuthority()
  const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, action)
  expect(await recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, action)).toBe(true)
  const measured = measuredTrialReader(options)
  expect(recordCandidateMeasuredTrial(
    authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, action, measured.trialHash,
  ))
    .toMatchObject({ authenticated: true, eligibleForReview: true })
  return { item, authority, measured, targetFull }
}

describe('verification event signing before publication', () => {
  it('rechecks the Candidate after a deferred verified-event signer resumes', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const before = [readFileSync(item.reviewFile), existsSync(eventPath) ? readFileSync(eventPath) : undefined]
    let entered!: () => void
    let release!: () => void
    const signing = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const sealing: KnowledgeWikiVerifierAuthority = {
      ...authority,
      async sealPromotion(request) {
        entered()
        await signing
        return authority.sealPromotion(request)
      },
    }
    const pending = recordCandidateVerification(
      sealing, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote',
    )
    await started
    writeFileSync(item.candidateFull, `${readFileSync(item.candidateFull, 'utf8')}\nChanged during signing\n`)
    const changedCandidate = readFileSync(item.candidateFull)
    release()
    await expect(pending).resolves.toBe(false)
    expect(readFileSync(item.reviewFile)).toEqual(before[0])
    expect(existsSync(eventPath) ? readFileSync(eventPath) : undefined).toEqual(before[1])
    expect(readFileSync(item.candidateFull)).toEqual(changedCandidate)
    const journalDir = join(dirname(item.reviewFile), 'promotion-journal')
    expect(existsSync(journalDir) ? readdirSync(journalDir) : []).toHaveLength(0)
  })

  it('does not publish a verified event when the owning verification is cancelled during signing', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const before = [readFileSync(item.reviewFile), existsSync(eventPath) ? readFileSync(eventPath) : undefined]
    let entered!: () => void
    let release!: () => void
    const signing = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let receivedSignal: AbortSignal | undefined
    const sealing: KnowledgeWikiVerifierAuthority = {
      ...authority,
      async sealPromotion(request, signal) {
        receivedSignal = signal
        entered()
        await signing
        return authority.sealPromotion(request)
      },
    }
    const controller = new AbortController()
    const pending = recordCandidateVerification(
      sealing, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote', controller.signal,
    )
    await started
    controller.abort(new Error('verification cancelled'))
    expect(receivedSignal).toBe(controller.signal)
    release()
    await expect(pending).rejects.toThrow('verification cancelled')
    expect(readFileSync(item.reviewFile)).toEqual(before[0])
    expect(existsSync(eventPath) ? readFileSync(eventPath) : undefined).toEqual(before[1])
    expect(existsSync(join(dirname(item.reviewFile), 'governance.jsonl'))).toBe(false)
  })

  it.each(['before first owner fence', 'before final owner fence'] as const)(
    'does not write verification projections when its project owner is disposed %s', async (when) => {
      const item = fixture()
      const authority = verifierAuthority()
      const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
      const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
      const before = [readFileSync(item.reviewFile), existsSync(eventPath) ? readFileSync(eventPath) : undefined]
      let entered!: () => void
      let release!: () => void
      let validations = 0
      let ownerCurrent = true
      const signing = new Promise<void>((resolve) => { release = resolve })
      const started = new Promise<void>((resolve) => { entered = resolve })
      const sealing: KnowledgeWikiVerifierAuthority = {
        ...authority,
        async sealPromotion(request) {
          entered()
          await signing
          return authority.sealPromotion(request)
        },
        validateCandidateResult(request, result) {
          const valid = authority.validateCandidateResult(request, result)
          if (when === 'before final owner fence' && ++validations === 2) ownerCurrent = false
          return valid
        },
      }
      const pending = recordCandidateVerification(
        sealing, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote', undefined, () => ownerCurrent,
      )
      await started
      if (when === 'before first owner fence') ownerCurrent = false
      release()
      await expect(pending).resolves.toBe(false)
      expect(readFileSync(item.reviewFile)).toEqual(before[0])
      expect(existsSync(eventPath) ? readFileSync(eventPath) : undefined).toEqual(before[1])
      expect(existsSync(join(dirname(item.reviewFile), 'governance.jsonl'))).toBe(false)
    },
  )

  it('rechecks the promotion target after deferred promoted-event signing and leaves no committed marker', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    expect(await recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote',
    )).toBe(true)
    const measured = measuredTrialReader()
    expect(recordCandidateMeasuredTrial(
      authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash,
    )).toMatchObject({ authenticated: true, eligibleForReview: true })
    const target = join(item.wikiRoot, 'concepts/git-identity-normalization.md')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const eventBefore = readFileSync(eventPath)
    let entered!: () => void
    let release!: () => void
    const signing = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let first = true
    const sealing: KnowledgeWikiVerifierAuthority = {
      ...authority,
      async sealPromotion(request) {
        if (first) {
          first = false
          entered()
          await signing
        }
        return authority.sealPromotion(request)
      },
    }
    const pending = applyCandidateReview(
      sealing, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId,
      'Promote', 'human', measured.reader,
    )
    await started
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'externally-created while signing\n')
    const changedTarget = readFileSync(target)
    release()
    await expect(pending).resolves.toBe(false)
    expect(readFileSync(target)).toEqual(changedTarget)
    expect(readFileSync(eventPath)).toEqual(eventBefore)
    const journalDir = join(dirname(item.reviewFile), 'promotion-journal')
    expect(existsSync(journalDir) ? readdirSync(journalDir) : []).toEqual([])
    expect(existsSync(item.candidateFull)).toBe(true)
    const reviewRows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
    expect(reviewRows[0]).toMatchObject({ resolved: false })
    expect(readFileSync(join(dirname(item.reviewFile), 'governance.jsonl'), 'utf8')).not.toContain('"outcome":"applied"')
  })

  it.each(['promoted event seal invalid', 'WAL seal invalid', 'owner generation changed'] as const)(
    'does not commit a canonical promotion when %s', async (failure) => {
      const { item, authority, measured, targetFull } = await stagedMeasuredFixture()
      const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
      const governancePath = join(dirname(item.reviewFile), 'governance.jsonl')
      const before = [
        readFileSync(item.reviewFile), readFileSync(item.candidateFull), readFileSync(eventPath),
        existsSync(governancePath) ? readFileSync(governancePath) : undefined,
      ]
      let ownerCurrent = true
      const sealing: KnowledgeWikiVerifierAuthority = {
        ...authority,
        async sealPromotion(request) {
          if (failure === 'promoted event seal invalid'
            && request.operation === 'seal-knowledge-event' && request.eventType === 'knowledge/promoted') {
            return { authorityId: authority.authorityId, proof: 'invalid-proof' }
          }
          if (failure === 'WAL seal invalid' && request.operation === 'seal-promotion-wal') {
            return { authorityId: authority.authorityId, proof: 'invalid-proof' }
          }
          if (failure === 'owner generation changed' && request.operation === 'seal-promotion-wal') {
            ownerCurrent = false
          }
          return authority.sealPromotion(request)
        },
      }

      await expect(applyCandidateReview(
        sealing, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId,
        'Promote', 'human', measured.reader, () => ownerCurrent,
      )).resolves.toBe(false)
      expect(readFileSync(item.reviewFile)).toEqual(before[0])
      expect(readFileSync(item.candidateFull)).toEqual(before[1])
      expect(readFileSync(eventPath)).toEqual(before[2])
      expect(existsSync(targetFull)).toBe(false)
      expect(existsSync(governancePath) ? readFileSync(governancePath) : undefined).toEqual(before[3])
      expect(existsSync(join(dirname(item.reviewFile), 'promotion-journal'))).toBe(false)
    },
  )

  it.each(['seal-knowledge-event', 'seal-promotion-wal'] as const)(
    'passes cancellation to the %s owner and leaves a valid promotion unpublished', async (operation) => {
      const { item, authority, measured, targetFull } = await stagedMeasuredFixture()
      const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
      const governancePath = join(dirname(item.reviewFile), 'governance.jsonl')
      const journalDir = join(dirname(item.reviewFile), 'promotion-journal')
      const before = {
        review: readFileSync(item.reviewFile),
        candidate: readFileSync(item.candidateFull),
        event: readFileSync(eventPath),
        governance: existsSync(governancePath) ? readFileSync(governancePath) : undefined,
        journals: existsSync(journalDir) ? readdirSync(journalDir) : [],
      }
      let entered!: () => void
      const started = new Promise<void>((resolve) => { entered = resolve })
      const controller = new AbortController()
      let observedSignal: AbortSignal | undefined
      const sealing: KnowledgeWikiVerifierAuthority = {
        ...authority,
        sealPromotion(request, signal) {
          if ((operation === 'seal-knowledge-event'
            && request.operation === 'seal-knowledge-event' && request.eventType === 'knowledge/promoted')
            || (operation === 'seal-promotion-wal' && request.operation === 'seal-promotion-wal')) {
            if (signal === undefined) throw new Error(`${operation} did not receive the operation signal`)
            observedSignal = signal
            entered()
            return new Promise<VerificationAuthoritySeal>((_resolve, reject) => {
              rejectOnAbort(signal, reject, `${operation} signing aborted`)
            })
          }
          return authority.sealPromotion(request)
        },
      }
      const pending = applyCandidateReview(
        sealing, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId,
        'Promote', 'human', measured.reader, () => true, controller.signal,
      )
      await started
      expect(observedSignal).toBe(controller.signal)
      controller.abort(new Error(`${operation} cancelled`))
      await expect(pending).rejects.toThrow(`${operation} cancelled`)
      expect(readFileSync(item.reviewFile)).toEqual(before.review)
      expect(readFileSync(item.candidateFull)).toEqual(before.candidate)
      expect(readFileSync(eventPath)).toEqual(before.event)
      expect(existsSync(governancePath) ? readFileSync(governancePath) : undefined).toEqual(before.governance)
      expect(existsSync(targetFull)).toBe(false)
      expect(existsSync(journalDir) ? readdirSync(journalDir) : []).toEqual(before.journals)
    },
  )

  it('refuses a promotion when measured trial evidence changes at the commit owner boundary', async () => {
    const { item, authority, measured, targetFull } = await stagedMeasuredFixture()
    let reads = 0
    const unstable: KnowledgeWikiMeasuredTrialReader = {
      ...measured.reader,
      read(hash, binding) {
        if (++reads === 3) return undefined
        return measured.reader.read(hash, binding)
      },
    }
    const reviewBefore = readFileSync(item.reviewFile)
    const candidateBefore = readFileSync(item.candidateFull)
    const eventBefore = readFileSync(join(dirname(item.reviewFile), 'knowledge-events.jsonl'))

    await expect(applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId,
      'Promote', 'human', unstable,
    )).rejects.toThrow('promotion journal lacks an authenticated measured-trial receipt')
    expect(readFileSync(item.reviewFile)).toEqual(reviewBefore)
    expect(readFileSync(item.candidateFull)).toEqual(candidateBefore)
    expect(readFileSync(join(dirname(item.reviewFile), 'knowledge-events.jsonl'))).toEqual(eventBefore)
    expect(existsSync(targetFull)).toBe(false)
    expect(existsSync(join(dirname(item.reviewFile), 'promotion-journal'))).toBe(false)
  })

  it.each(['signing refusal', 'validation error', 'foreign authority', 'empty proof', 'invalid proof'] as const)(
    'keeps every verification projection unchanged on %s', async (failure) => {
      const item = fixture()
      const authority = verifierAuthority()
      const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
      const paths = [item.reviewFile, item.candidateFull, join(dirname(item.reviewFile), 'governance.jsonl'),
        join(dirname(item.reviewFile), 'knowledge-events.jsonl')]
      const before = paths.map(path => existsSync(path) ? readFileSync(path) : undefined)
      const refusal = new Error(failure)
      const sealing: KnowledgeWikiVerifierAuthority = {
        ...authority,
        sealPromotion(payload) {
          if (failure === 'signing refusal') throw refusal
          if (failure === 'foreign authority') return { authorityId: 'foreign-verifier', proof: 'forged' }
          if (failure === 'empty proof') return { authorityId: authority.authorityId, proof: '' }
          if (failure === 'invalid proof') return { authorityId: authority.authorityId, proof: 'forged' }
          return authority.sealPromotion(payload)
        },
        validatePromotion(payload, seal) {
          if (failure === 'validation error') throw refusal
          return authority.validatePromotion(payload, seal)
        },
      }
      const record = () => recordCandidateVerification(sealing, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote')
      if (failure === 'signing refusal' || failure === 'validation error') await expect(record()).rejects.toThrow(refusal)
      else expect(await record()).toBe(false)
      expect(paths.map(path => existsSync(path) ? readFileSync(path) : undefined)).toEqual(before)
      expect(readKnowledgeEventLog(paths[3]!, authority).some(event => event.type === 'knowledge/verified')).toBe(false)
    },
  )

  it.each(['other review row', 'resolved review', 'candidate bytes', 'candidate symlink', 'event expiry', 'receipt removal', 'source identity'] as const)(
    'refuses a change to %s during signing without overwriting the changed state', async (change) => {
      const item = fixture()
      const authority = verifierAuthority()
      const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
      rows.push({ ...rows[0]!, id: 'unrelated-review', title: 'Unrelated pending review' })
      writeFileSync(item.reviewFile, JSON.stringify(rows, null, 2))
      const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
      const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
      const paths = [item.reviewFile, item.candidateFull, join(dirname(item.reviewFile), 'governance.jsonl'), eventPath]
      let changedState: Array<Buffer | undefined> = []
      let identityChanged = false
      const sealing: KnowledgeWikiVerifierAuthority = {
        ...authority,
        sourceIdentity() {
          return { ...authority.sourceIdentity(), ...(identityChanged ? { buildDigest: 'f'.repeat(64) } : {}) }
        },
        sealPromotion(payload) {
          if (change === 'other review row' || change === 'resolved review') {
            const latest = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
            if (change === 'other review row') latest[1] = { ...latest[1]!, description: 'External review edit' }
            else latest[0] = { ...latest[0]!, resolved: true }
            writeFileSync(item.reviewFile, JSON.stringify(latest, null, 2))
          } else if (change === 'candidate bytes') {
            writeFileSync(item.candidateFull, `${readFileSync(item.candidateFull, 'utf8')}\nExternal candidate edit\n`)
          } else if (change === 'candidate symlink') {
            const replacement = join(item.root, 'replacement.md')
            writeFileSync(replacement, readFileSync(item.candidateFull))
            unlinkSync(item.candidateFull)
            symlinkSync(replacement, item.candidateFull)
          } else if (change === 'event expiry') {
            const prior = readKnowledgeEventLog(eventPath, authority)
            knowledgeGovernance.appendKnowledgeEvent(eventPath, knowledgeGovernance.createKnowledgeEvent(
              'knowledge/expired', `candidate:${item.reviewId}`, { projectId: item.root, visibility: 'project' },
              { reason: 'External expiry' }, { seq: prior.length, previousEventHash: prior.at(-1)?.eventHash ?? null },
            ))
          } else if (change === 'receipt removal') {
            unlinkSync(join(dirname(item.reviewFile), 'verification-receipts', `${receiptId}.json`))
          } else {
            identityChanged = true
          }
          changedState = paths.map(path => existsSync(path) ? readFileSync(path) : undefined)
          return authority.sealPromotion(payload)
        },
      }
      expect(await recordCandidateVerification(sealing, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote')).toBe(false)
      expect(paths.map(path => existsSync(path) ? readFileSync(path) : undefined)).toEqual(changedState)
      expect(readKnowledgeEventLog(eventPath, authority).some(event => event.type === 'knowledge/verified')).toBe(false)
    },
  )

  it('publishes one verification event whose complete payload authenticates with the same authority', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    const originalCandidate = readFileSync(item.candidateFull)
    expect(await recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote')).toBe(true)
    const events = readKnowledgeEventLog(join(dirname(item.reviewFile), 'knowledge-events.jsonl'), authority)
    const verified = events.filter(event => event.type === 'knowledge/verified')
    expect(verified).toHaveLength(1)
    expect(verified[0]?.payload.record).toMatchObject({ content: originalCandidate.toString('utf8'), lifecycle: 'candidate' })
    expect(knowledgeGovernance.replayKnowledgeEvents(events).records.get(`candidate:${item.reviewId}`))
      .toMatchObject({ verificationStatus: 'verified', lifecycle: 'candidate', authority: authority.authorityId })
    expect(readFileSync(item.candidateFull)).toEqual(originalCandidate)
    const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
    expect(rows[0]?.options?.map(option => option.action)).toEqual(['Archive'])
    expect(existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toBe(false)
  })

  it('signs and publishes one immutable payload snapshot when the authority attempts mutation', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    const originalCandidate = readFileSync(item.candidateFull, 'utf8')
    let nestedMutationRejected = false
    const sealing: KnowledgeWikiVerifierAuthority = {
      ...authority,
      async sealPromotion(request) {
        if (request.operation === 'seal-knowledge-event' && request.eventType === 'knowledge/verified') {
          const record = request.payload.record as Record<string, unknown>
          nestedMutationRejected = !Reflect.set(record, 'content', 'forged after signing bytes were captured')
        }
        return authority.sealPromotion(request)
      },
    }

    expect(await recordCandidateVerification(sealing, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote'))
      .toBe(true)
    expect(nestedMutationRejected).toBe(true)
    const events = readKnowledgeEventLog(join(dirname(item.reviewFile), 'knowledge-events.jsonl'), authority)
    const verified = events.filter(event => event.type === 'knowledge/verified')
    expect(verified).toHaveLength(1)
    expect(verified[0]?.payload.record).toMatchObject({ content: originalCandidate, lifecycle: 'candidate' })
  })

  it('copies and freezes the returned seal before invoking its validation callback', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    let mutationRejected = false
    const sealing: KnowledgeWikiVerifierAuthority = {
      ...authority,
      sealPromotion(request) {
        return { ...authority.sealPromotion(request) }
      },
      validatePromotion(payload, seal) {
        const valid = authority.validatePromotion(payload, seal)
        mutationRejected = !Reflect.set(seal, 'proof', 'tampered after validation')
        return valid
      },
    }

    expect(await recordCandidateVerification(sealing, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote'))
      .toBe(true)
    expect(mutationRejected).toBe(true)
    const verified = readKnowledgeEventLog(join(dirname(item.reviewFile), 'knowledge-events.jsonl'), authority)
      .filter(event => event.type === 'knowledge/verified')
    expect(verified).toHaveLength(1)
  })

  it('rejects a primitive seal returned by the reached authority without publishing projections', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    const projectionPaths = [
      item.reviewFile,
      join(dirname(item.reviewFile), 'governance.jsonl'),
      join(dirname(item.reviewFile), 'knowledge-events.jsonl'),
    ]
    const before = projectionPaths.map(path => existsSync(path) ? readFileSync(path) : undefined)
    const sealPromotion = vi.fn(() => 7 as unknown as VerificationAuthoritySeal)
    const validatePromotion = vi.fn(authority.validatePromotion.bind(authority))
    const invalidSealAuthority: KnowledgeWikiVerifierAuthority = {
      ...authority,
      sealPromotion,
      validatePromotion,
    }

    expect(await recordCandidateVerification(
      invalidSealAuthority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote',
    )).toBe(false)
    expect(sealPromotion).toHaveBeenCalledTimes(1)
    expect(validatePromotion).not.toHaveBeenCalled()
    expect(projectionPaths.map(path => existsSync(path) ? readFileSync(path) : undefined)).toEqual(before)
  })

  it.each(['removed', 'replaced'] as const)('refuses a receipt %s during the final authority validation', async (change) => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    const receiptPath = join(dirname(item.reviewFile), 'verification-receipts', `${receiptId}.json`)
    const paths = [item.reviewFile, item.candidateFull, join(dirname(item.reviewFile), 'governance.jsonl'),
      join(dirname(item.reviewFile), 'knowledge-events.jsonl')]
    const before = paths.map(path => existsSync(path) ? readFileSync(path) : undefined)
    let validations = 0
    const changing: KnowledgeWikiVerifierAuthority = {
      ...authority,
      validateCandidateResult(request, result) {
        const accepted = authority.validateCandidateResult(request, result)
        if (++validations === 2) {
          if (change === 'removed') unlinkSync(receiptPath)
          else writeFileSync(receiptPath, '{"changed":"after validation"}\n')
        }
        return accepted
      },
    }
    expect(await recordCandidateVerification(changing, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote')).toBe(false)
    expect(validations).toBe(2)
    expect(paths.map(path => existsSync(path) ? readFileSync(path) : undefined)).toEqual(before)
    expect(existsSync(receiptPath)).toBe(change === 'replaced')
  })

  it('refuses a receipt removed by its first validation before requesting an event seal', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    const before = readFileSync(item.reviewFile)
    const sealPromotion = vi.fn((request: KnowledgeWikiPromotionSealRequest) => Promise.resolve(authority.sealPromotion(request)))
    const changing: KnowledgeWikiVerifierAuthority = {
      ...authority,
      sealPromotion,
      validateCandidateResult(request, result) {
        const accepted = authority.validateCandidateResult(request, result)
        unlinkSync(join(dirname(item.reviewFile), 'verification-receipts', `${receiptId}.json`))
        return accepted
      },
    }
    expect(await recordCandidateVerification(changing, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote')).toBe(false)
    expect(sealPromotion).not.toHaveBeenCalled()
    expect(readFileSync(item.reviewFile)).toEqual(before)
    expect(existsSync(join(dirname(item.reviewFile), 'governance.jsonl'))).toBe(false)
  })

  it('refuses a symlinked event journal before requesting a verification seal', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const replacement = join(item.root, 'external-events.jsonl')
    const originalEvents = readFileSync(eventPath)
    const originalReview = readFileSync(item.reviewFile)
    writeFileSync(replacement, originalEvents)
    unlinkSync(eventPath)
    symlinkSync(replacement, eventPath)
    const sealPromotion = vi.fn((request: KnowledgeWikiPromotionSealRequest) => Promise.resolve(authority.sealPromotion(request)))
    await expect(recordCandidateVerification({ ...authority, sealPromotion }, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote'))
      .rejects.toThrow('not a unique ordinary file')
    expect(sealPromotion).not.toHaveBeenCalled()
    expect(readFileSync(item.reviewFile)).toEqual(originalReview)
    expect(readFileSync(replacement)).toEqual(originalEvents)
    expect(existsSync(join(dirname(item.reviewFile), 'governance.jsonl'))).toBe(false)
  })

  it.each(['governance', 'event'] as const)('reports a later %s I/O failure without claiming multi-file rollback', async (failure) => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const originalEvents = readFileSync(eventPath)
    const originalCandidate = readFileSync(item.candidateFull)
    const error = new Error(`${failure} write failed`)
    if (failure === 'governance') {
      const original = filesystem.atomicWriteFile
      vi.spyOn(filesystem, 'atomicWriteFile').mockImplementation((path, ...args) => {
        if (path === join(dirname(item.reviewFile), 'governance.jsonl')) throw error
        original(path, ...args)
      })
    } else {
      vi.spyOn(knowledgeGovernance, 'appendKnowledgeEvent').mockImplementation(() => { throw error })
    }
    await expect(recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote')).rejects.toThrow(error)
    const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
    expect(rows[0]?.verification?.status).toBe('passed')
    expect(readFileSync(eventPath)).toEqual(originalEvents)
    expect(knowledgeGovernance.replayKnowledgeEvents(readKnowledgeEventLog(eventPath, authority))
      .records.get(`candidate:${item.reviewId}`)?.verificationStatus).toBe('candidate')
    expect(readFileSync(item.candidateFull)).toEqual(originalCandidate)
    expect(existsSync(join(dirname(item.reviewFile), 'governance.jsonl'))).toBe(failure === 'event')
  })
})

describe('measured review revalidation', () => {
  it('refuses a persisted row with no verification before reading trial evidence', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
    Reflect.deleteProperty(rows[0]!, 'verification')
    writeFileSync(item.reviewFile, JSON.stringify(rows, null, 2))
    let reads = 0
    const measured = measuredTrialReader({ onRead() { reads += 1 } })
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    expect(recordCandidateMeasuredTrial(authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash))
      .toEqual({ authenticated: false, eligibleForReview: false, errorCode: 'semantic-verification-required' })
    expect(reads).toBe(0)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(existsSync(join(dirname(item.reviewFile), 'promotion-journal'))).toBe(false)
  })

  it.each(['candidatePath', 'candidateHash', 'targetPath'] as const)(
    'refuses a persisted review missing %s before deriving measured authorization', async (field) => {
      let reads = 0
      const { item, authority, measured, targetFull } = await stagedMeasuredFixture({ onRead() { reads += 1 } })
      reads = 0
      const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
      Reflect.deleteProperty(rows[0]!, field)
      writeFileSync(item.reviewFile, JSON.stringify(rows, null, 2))
      const reviewBefore = readFileSync(item.reviewFile, 'utf8')
      const candidateBefore = readFileSync(item.candidateFull, 'utf8')
      expect(recordCandidateMeasuredTrial(
        authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash,
      )).toEqual({ authenticated: false, eligibleForReview: false, errorCode: 'semantic-verification-required' })
      expect(await applyCandidateReview(
        authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, 'Promote', 'human', measured.reader,
      )).toBe(false)
      expect(reads).toBe(0)
      expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
      expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
      expect(existsSync(targetFull)).toBe(false)
      expect(existsSync(join(dirname(item.reviewFile), 'promotion-journal'))).toBe(false)
    },
  )

  it('attributes an empty measured-trial actor to the authenticated reader', async () => {
    const { item, authority, measured } = await stagedMeasuredFixture()
    expect(recordCandidateMeasuredTrial(
      authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash, '',
    )).toMatchObject({ authenticated: true, eligibleForReview: true })
    const entries = readFileSync(join(dirname(item.reviewFile), 'governance.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as { action: string; actor: string })
    expect(entries.at(-1)).toMatchObject({ action: 'MeasuredTrial', actor: measured.reader.authorityId })
    expect(existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toBe(false)
  })

  it('keeps expected binding fields immutable across registration, authorization and commit reader calls', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    expect(await recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote')).toBe(true)
    const measured = measuredTrialReader()
    const bindings: Parameters<KnowledgeWikiMeasuredTrialReader['read']>[1][] = []
    const changedExpectedState: boolean[] = []
    const retainingReader: KnowledgeWikiMeasuredTrialReader = {
      ...measured.reader,
      read(hash, binding) {
        bindings.push(binding)
        changedExpectedState.push(Reflect.set(binding, 'targetBeforeHashOrVerifiedAbsence', 'b'.repeat(64)))
        return measured.reader.read(hash, binding)
      },
    }
    expect(recordCandidateMeasuredTrial(
      authority, retainingReader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash,
    )).toMatchObject({ authenticated: true, eligibleForReview: true })
    expect(changedExpectedState).toEqual([false])
    expect(await applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, 'Promote', 'human', retainingReader,
    )).toBe(true)
    expect(bindings).toHaveLength(4)
    expect(changedExpectedState).toEqual([false, false, false, false])
    for (const binding of bindings) {
      expect(Reflect.set(binding, 'targetBeforeHashOrVerifiedAbsence', 'b'.repeat(64))).toBe(false)
      expect(binding.targetBeforeHashOrVerifiedAbsence).toBe('verified-absence')
    }
    expect(readFileSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toEqual(measured.targetAfter)
  })

  it.each(['receipt disappeared', 'journal receipt hash changed'] as const)(
    'refuses prepared recovery when %s without changing its pre-state', async (change) => {
      const { item, authority, measured, targetFull } = await stagedMeasuredFixture()
      const reviewBefore = readFileSync(item.reviewFile, 'utf8')
      const candidateBefore = readFileSync(item.candidateFull, 'utf8')
      const stop = new Error('stop at prepared measured journal')
      const stopping: KnowledgeWikiVerifierAuthority = {
        ...authority,
        checkpointPromotion(_payload, checkpoint) {
          if (checkpoint.phase === 'journal-persisted') throw stop
        },
      }
      await expect(applyCandidateReview(
        stopping, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, 'Promote', 'human', measured.reader,
      )).rejects.toThrow(stop)
      const directory = join(dirname(item.reviewFile), 'promotion-journal')
      const names = readdirSync(directory).filter(name => name.endsWith('.json'))
      expect(names).toHaveLength(1)
      const journalPath = join(directory, names[0]!)
      if (change === 'receipt disappeared') {
        const row = (JSON.parse(reviewBefore) as WikiReviewItem[])[0]!
        const reference = row.verification!.receipts.at(-1)!
        unlinkSync(join(dirname(item.reviewFile), 'verification-receipts', `${reference.id}.json`))
      } else {
        const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>
        const { state: _state, seal: _seal, ...core } = journal
        core.receiptHash = 'b'.repeat(64)
        writeFileSync(journalPath, JSON.stringify({
          ...core,
          state: 'prepared',
          seal: authority.sealPromotion({
            schemaVersion: 1, domain: 'ark.knowledge-wiki', authorityId: authority.authorityId,
            operation: 'seal-promotion-wal', journal: core as unknown as PromotionJournalSigningPayload,
          }),
        }))
      }
      await expect(recoverCandidateReviewTransactions(
        authority, item.reviewFile, item.wikiRoot, join(item.root, 'archive'), measured.reader,
      )).rejects.toThrow('promotion journal verified receipt binding failed')
      expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
      expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
      expect(existsSync(targetFull)).toBe(false)
      expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({ state: 'prepared' })
    },
  )

  it.each([
    'event bytes changed', 'journal bytes changed', 'event signing refused', 'event seal invalid', 'owner generation changed',
  ] as const)(
    'fails recovery without touching a partial prepared WAL when %s during deferred signing', async (change) => {
      const { item, authority, measured, targetFull } = await stagedMeasuredFixture()
      const stop = new Error('stop at prepared measured journal')
      const stopping: KnowledgeWikiVerifierAuthority = {
        ...authority,
        checkpointPromotion(_payload, checkpoint) {
          if (checkpoint.phase === 'journal-persisted') throw stop
        },
      }
      await expect(applyCandidateReview(
        stopping, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId,
        'Promote', 'human', measured.reader,
      )).rejects.toThrow(stop)

      const journalDir = join(dirname(item.reviewFile), 'promotion-journal')
      const journalPath = join(journalDir, readdirSync(journalDir).find(name => name.endsWith('.json'))!)
      const journalBytes = readFileSync(journalPath)
      const journal = JSON.parse(journalBytes.toString('utf8')) as {
        readonly operations: readonly { readonly role: string; readonly path: string; readonly after?: string }[]
      }
      const canonical = journal.operations.find(operation => operation.role === 'canonical')
      if (canonical?.after === undefined) throw new Error('prepared canonical operation lacks after bytes')
      mkdirSync(dirname(targetFull), { recursive: true })
      writeFileSync(targetFull, canonical.after, 'utf8')

      const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
      const originalEventBytes = readFileSync(eventPath)
      let entered!: () => void
      let release!: () => void
      const signing = new Promise<void>((resolve) => { release = resolve })
      const started = new Promise<void>((resolve) => { entered = resolve })
      const signerError = new Error('recovery event signer refused')
      let ownerCurrent = true
      const sealing: KnowledgeWikiVerifierAuthority = {
        ...authority,
        async sealPromotion(request) {
          if (request.operation === 'seal-knowledge-event' && request.eventType === 'knowledge/promoted') {
            entered()
            await signing
            if (change === 'event signing refused') throw signerError
            if (change === 'event seal invalid') return { authorityId: authority.authorityId, proof: 'invalid-proof' }
          }
          return authority.sealPromotion(request)
        },
      }
      const reviewBefore = readFileSync(item.reviewFile)
      const candidateBefore = readFileSync(item.candidateFull)
      const pending = recoverCandidateReviewTransactions(
        sealing, item.reviewFile, item.wikiRoot, join(item.root, 'archive'), measured.reader, () => ownerCurrent,
      )
      await started
      if (change === 'event bytes changed') {
        writeFileSync(eventPath, Buffer.concat([originalEventBytes, Buffer.from('external event update\n')]))
      } else if (change === 'journal bytes changed') {
        writeFileSync(journalPath, Buffer.concat([journalBytes, Buffer.from('external journal update\n')]))
      } else if (change === 'owner generation changed') {
        ownerCurrent = false
      }
      const eventAfterExternalChange = readFileSync(eventPath)
      const journalAfterExternalChange = readFileSync(journalPath)
      release()

      if (change === 'event signing refused') await expect(pending).rejects.toThrow(signerError)
      else if (change === 'event seal invalid') await expect(pending).rejects.toThrow('promotion event signing failed during recovery')
      else if (change === 'owner generation changed') await expect(pending).resolves.toBe(0)
      else await expect(pending).rejects.toThrow(/changed during recovery signing/u)
      expect(readFileSync(item.reviewFile)).toEqual(reviewBefore)
      expect(readFileSync(item.candidateFull)).toEqual(candidateBefore)
      expect(readFileSync(targetFull, 'utf8')).toBe(canonical.after)
      expect(readFileSync(eventPath)).toEqual(eventAfterExternalChange)
      expect(readFileSync(journalPath)).toEqual(journalAfterExternalChange)
      if (change !== 'journal bytes changed') {
        expect(readFileSync(journalPath)).toEqual(journalBytes)
        expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({ state: 'prepared' })
      }
    },
  )

  it('does not register init effects after disposal while recovery signing is paused', async () => {
    const { item, authority, measured, targetFull } = await stagedMeasuredFixture()
    const stop = new Error('stop at prepared measured journal')
    const stopping: KnowledgeWikiVerifierAuthority = {
      ...authority,
      checkpointPromotion(_payload, checkpoint) {
        if (checkpoint.phase === 'journal-persisted') throw stop
      },
    }
    await expect(applyCandidateReview(
      stopping, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'jiuzhang-tarballs', 'archive'), item.reviewId,
      'Promote', 'human', measured.reader,
    )).rejects.toThrow(stop)

    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const sealing: KnowledgeWikiVerifierAuthority = {
      ...authority,
      async sealPromotion(request, signal) {
        if (request.operation === 'seal-knowledge-event' && request.eventType === 'knowledge/promoted') {
          entered()
          if (signal === undefined) throw new Error('recovery event seal omitted generation signal')
          await new Promise<void>((_resolve, reject) => {
            rejectOnAbort(signal, reject, 'recovery event signing aborted')
          })
        }
        return authority.sealPromotion(request)
      },
    }
    const ctx = new Context()
    ctx.provide('knowledgeWikiVerifierAuthority', sealing)
    ctx.provide('knowledgeWikiMeasuredTrialReader', measured.reader)
    const interval = vi.fn(() => vi.fn())
    Object.defineProperty(ctx, 'timer', { configurable: true, value: { interval } })
    const service = new KnowledgeWikiService(ctx, wikiTestConfig({
      wikiRoot: item.wikiRoot,
      mainRoot: item.root,
      credential: 'UNUSED_TEST_REF',
      llmProvider: 'p',
      llmModel: 'm',
    })) as unknown as { [Service.init](): Promise<void> }
    const reviewBefore = readFileSync(item.reviewFile)
    const candidateBefore = readFileSync(item.candidateFull)
    const initializing = service[Service.init]()
    await started
    await ctx.fiber.dispose()
    await initializing

    expect(interval).not.toHaveBeenCalled()
    expect(readFileSync(item.reviewFile)).toEqual(reviewBefore)
    expect(readFileSync(item.candidateFull)).toEqual(candidateBefore)
    expect(existsSync(targetFull)).toBe(false)
    const journalPath = join(dirname(item.reviewFile), 'promotion-journal', readdirSync(join(dirname(item.reviewFile), 'promotion-journal'))[0]!)
    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({ state: 'prepared' })
  })

  it.each(['cancelled', 'refused'] as const)(
    'leaves a committed journal untouched when missing-event recovery signing is %s', async (signingOutcome) => {
      const { item, authority, measured, targetFull } = await stagedMeasuredFixture()
      const archiveRoot = join(item.root, 'archive')
      expect(await applyCandidateReview(
        authority, item.reviewFile, item.root, item.wikiRoot, archiveRoot, item.reviewId,
        'Promote', 'human', measured.reader,
      )).toBe(true)

      const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
      const journalPath = join(dirname(item.reviewFile), 'promotion-journal',
        readdirSync(join(dirname(item.reviewFile), 'promotion-journal')).find(name => name.endsWith('.json'))!)
      expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({ state: 'committed' })
      unlinkSync(eventPath)
      const before = {
        review: readFileSync(item.reviewFile),
        candidateExists: existsSync(item.candidateFull),
        journal: readFileSync(journalPath),
        governance: readFileSync(join(dirname(item.reviewFile), 'governance.jsonl')),
        target: readFileSync(targetFull),
      }
      const controller = new AbortController()
      let entered!: () => void
      const started = new Promise<void>((resolve) => { entered = resolve })
      const signingRefusal = new Error('committed recovery signer refused')
      const sealing: KnowledgeWikiVerifierAuthority = {
        ...authority,
        async sealPromotion(request, signal) {
          if (request.operation === 'seal-knowledge-event' && request.eventType === 'knowledge/promoted') {
            entered()
            if (signingOutcome === 'refused') throw signingRefusal
            if (signal === undefined) throw new Error('recovery event signing omitted cancellation signal')
            await new Promise<void>((_resolve, reject) => {
              rejectOnAbort(signal, reject, 'recovery event signing aborted')
            })
          }
          return authority.sealPromotion(request)
        },
      }
      const recovering = recoverCandidateReviewTransactions(
        sealing, item.reviewFile, item.wikiRoot, archiveRoot, measured.reader, () => true,
        signingOutcome === 'cancelled' ? controller.signal : undefined,
      )
      await started
      if (signingOutcome === 'cancelled') {
        controller.abort(new Error('committed recovery cancelled'))
        await expect(recovering).resolves.toBe(0)
      } else {
        await expect(recovering).rejects.toThrow(signingRefusal)
      }

      expect(existsSync(eventPath)).toBe(false)
      expect(readFileSync(item.reviewFile)).toEqual(before.review)
      expect(existsSync(item.candidateFull)).toBe(before.candidateExists)
      expect(readFileSync(journalPath)).toEqual(before.journal)
      expect(readFileSync(join(dirname(item.reviewFile), 'governance.jsonl'))).toEqual(before.governance)
      expect(readFileSync(targetFull)).toEqual(before.target)
    },
  )

  it('does not sync an already-present lifecycle event after authority validation revokes continuation', async () => {
    const { item, authority, measured, targetFull } = await stagedMeasuredFixture()
    const archiveRoot = join(item.root, 'archive')
    expect(await applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, archiveRoot, item.reviewId,
      'Promote', 'human', measured.reader,
    )).toBe(true)
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const journalPath = join(dirname(item.reviewFile), 'promotion-journal',
      readdirSync(join(dirname(item.reviewFile), 'promotion-journal')).find(name => name.endsWith('.json'))!)
    const before = {
      review: readFileSync(item.reviewFile),
      candidateExists: existsSync(item.candidateFull),
      events: readFileSync(eventPath),
      journal: readFileSync(journalPath),
      governance: readFileSync(join(dirname(item.reviewFile), 'governance.jsonl')),
      target: readFileSync(targetFull),
    }
    let continuation = true
    let eventValidationRevokedContinuation = false
    const syncEvents = vi.spyOn(knowledgeGovernance, 'syncKnowledgeEventLog')
    const reentrantAuthority: KnowledgeWikiVerifierAuthority = {
      ...authority,
      validatePromotion(payload, seal) {
        const valid = authority.validatePromotion(payload, seal)
        const parsed: unknown = JSON.parse(payload)
        if (valid && typeof parsed === 'object' && parsed !== null
          && Reflect.get(parsed, 'type') === 'knowledge/promoted') {
          continuation = false
          eventValidationRevokedContinuation = true
        }
        return valid
      },
    }

    await expect(recoverCandidateReviewTransactions(
      reentrantAuthority, item.reviewFile, item.wikiRoot, archiveRoot, measured.reader, () => continuation,
    )).resolves.toBe(0)

    expect(eventValidationRevokedContinuation).toBe(true)
    expect(syncEvents).not.toHaveBeenCalled()
    expect(readFileSync(item.reviewFile)).toEqual(before.review)
    expect(existsSync(item.candidateFull)).toBe(before.candidateExists)
    expect(readFileSync(eventPath)).toEqual(before.events)
    expect(readFileSync(journalPath)).toEqual(before.journal)
    expect(readFileSync(join(dirname(item.reviewFile), 'governance.jsonl'))).toEqual(before.governance)
    expect(readFileSync(targetFull)).toEqual(before.target)
  })

  it('aborts signing in the old project generation before review transaction writes', async () => {
    const { item, authority, measured, targetFull } = await stagedMeasuredFixture()
    const externalRoot = mkdtempSync(join(tmpdir(), 'wiki-generation-switch-'))
    roots.push(externalRoot)
    mkdirSync(join(externalRoot, 'wiki', 'concepts'), { recursive: true })
    writeFileSync(join(item.root, '.llm-wiki', 'workspaces.json'), JSON.stringify({
      workspaces: [{ path: externalRoot, name: 'external' }],
    }))
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const governancePath = join(dirname(item.reviewFile), 'governance.jsonl')
    const journalDir = join(dirname(item.reviewFile), 'promotion-journal')
    const before = {
      review: readFileSync(item.reviewFile),
      candidate: readFileSync(item.candidateFull),
      event: readFileSync(eventPath),
      governance: existsSync(governancePath) ? readFileSync(governancePath) : undefined,
      journals: existsSync(journalDir) ? readdirSync(journalDir) : [],
    }
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const sealing: KnowledgeWikiVerifierAuthority = {
      ...authority,
      sealPromotion(request, signal) {
        if (request.operation === 'seal-knowledge-event' && request.eventType === 'knowledge/promoted') {
          if (signal === undefined) throw new Error('review seal omitted project-generation signal')
          entered()
          return new Promise<VerificationAuthoritySeal>((_resolve, reject) => {
            rejectOnAbort(signal, reject, 'promotion event signing aborted')
          })
        }
        return authority.sealPromotion(request)
      },
    }
    const ctx = new Context()
    ctx.provide('knowledgeWikiVerifierAuthority', sealing)
    ctx.provide('knowledgeWikiMeasuredTrialReader', measured.reader)
    const service = new KnowledgeWikiService(ctx, wikiTestConfig({
      wikiRoot: item.wikiRoot,
      mainRoot: item.root,
      credential: 'UNUSED_TEST_REF',
      llmProvider: 'p',
      llmModel: 'm',
    })) as unknown as {
      resolveReview(request: { reviewId: string; action?: string }): Promise<boolean>
      setProject(request: { path: string }): Promise<{ current: string }>
    }
    try {
      const pending = service.resolveReview({ reviewId: item.reviewId, action: 'Promote' })
      await started
      await expect(service.setProject({ path: externalRoot })).resolves.toEqual({ current: externalRoot })
      await expect(pending).rejects.toThrow('knowledge-wiki workspace changed')
      expect(readFileSync(item.reviewFile)).toEqual(before.review)
      expect(readFileSync(item.candidateFull)).toEqual(before.candidate)
      expect(readFileSync(eventPath)).toEqual(before.event)
      expect(existsSync(governancePath) ? readFileSync(governancePath) : undefined).toEqual(before.governance)
      expect(existsSync(targetFull)).toBe(false)
      expect(existsSync(journalDir) ? readdirSync(journalDir) : []).toEqual(before.journals)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs the project-generation fence while recovering a registered project', async () => {
    const main = fixture()
    const externalRoot = mkdtempSync(join(tmpdir(), 'wiki-verification-external-'))
    roots.push(externalRoot)
    const external = fixture(externalRoot)
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, external.reviewFile, external.wikiRoot, external.reviewId, 'Archive')
    expect(await recordCandidateVerification(
      authority, external.reviewFile, external.wikiRoot, external.reviewId, receiptId, 'Archive',
    )).toBe(true)
    const stop = new Error('stop at prepared archive journal')
    const archiveRoot = join(main.root, 'jiuzhang-tarballs', 'archive')
    const stopping: KnowledgeWikiVerifierAuthority = {
      ...authority,
      checkpointPromotion(_payload, checkpoint) {
        if (checkpoint.phase === 'journal-persisted') throw stop
      },
    }
    await expect(applyCandidateReview(
      stopping, external.reviewFile, external.root, external.wikiRoot, archiveRoot, external.reviewId,
      'Archive', 'human',
    )).rejects.toThrow(stop)
    const registry = join(main.root, '.llm-wiki', 'workspaces.json')
    mkdirSync(dirname(registry), { recursive: true })
    writeFileSync(registry, JSON.stringify({ workspaces: [{ path: externalRoot, name: 'external' }] }), 'utf8')

    const ctx = new Context()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    const service = new KnowledgeWikiService(ctx, wikiTestConfig({
      wikiRoot: main.wikiRoot,
      mainRoot: main.root,
      credential: 'UNUSED_TEST_REF',
      llmProvider: 'p',
      llmModel: 'm',
    })) as unknown as { setProject(request: { path: string }): Promise<{ current: string }> }
    try {
      await expect(service.setProject({ path: externalRoot })).resolves.toEqual({ current: externalRoot })
      expect(existsSync(external.candidateFull)).toBe(false)
      const reviewRows = JSON.parse(readFileSync(external.reviewFile, 'utf8')) as WikiReviewItem[]
      expect(reviewRows[0]).toMatchObject({ resolved: true })
      const journalDir = join(dirname(external.reviewFile), 'promotion-journal')
      expect(JSON.parse(readFileSync(join(journalDir, readdirSync(journalDir)[0]!), 'utf8')))
        .toMatchObject({ state: 'committed' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['record', 'Promote'], ['apply', 'Promote'], ['record', 'Merge'], ['apply', 'Merge'],
  ] as const)('refuses %s/%s when target presence changes after semantic authorization', async (operation, action) => {
    let reads = 0
    const { item, authority, measured, targetFull } = await stagedMeasuredFixture({ onRead() { reads += 1 } }, action)
    reads = 0
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const readTrusted = wikiVerifier.readTrustedVerification
    let mutations = 0
    vi.spyOn(wikiVerifier, 'readTrustedVerification').mockImplementation((...args) => {
      const trusted = readTrusted(...args)
      if (trusted !== undefined && args[1] === item.reviewFile && mutations === 0) {
        mutations += 1
        if (action === 'Merge') unlinkSync(targetFull)
        else {
          mkdirSync(dirname(targetFull), { recursive: true })
          writeFileSync(targetFull, 'A target created by a concurrent writer.\n')
        }
      }
      return trusted
    })
    if (operation === 'record') {
      expect(recordCandidateMeasuredTrial(
        authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, action, measured.trialHash,
      ))
        .toEqual({ authenticated: false, eligibleForReview: false, errorCode: 'measured-trial-invalid' })
    } else {
      expect(await applyCandidateReview(
        authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, action, 'human', measured.reader,
      )).toBe(false)
    }
    expect(mutations).toBe(1)
    expect(reads).toBe(0)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    if (action === 'Merge') expect(existsSync(targetFull)).toBe(false)
    else expect(readFileSync(targetFull, 'utf8')).toBe('A target created by a concurrent writer.\n')
    expect(existsSync(join(dirname(item.reviewFile), 'promotion-journal'))).toBe(false)
  })

  it.each([
    ['Promote', 'appeared'], ['Merge', 'symlink'], ['Merge', 'edited'],
  ] as const)('refuses planning %s after the canonical target is %s', async (action, change) => {
    const { item, authority, measured, targetFull } = await stagedMeasuredFixture({}, action)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const eventsBefore = readFileSync(eventPath, 'utf8')
    const readEvents = knowledgeGovernance.readKnowledgeEventLog
    let mutations = 0
    vi.spyOn(knowledgeGovernance, 'readKnowledgeEventLog').mockImplementation((...args) => {
      const events = readEvents(...args)
      if (args[0] === eventPath && mutations === 0) {
        mutations += 1
        mkdirSync(dirname(targetFull), { recursive: true })
        if (change === 'symlink') {
          const foreign = join(item.root, 'foreign-canonical.md')
          writeFileSync(foreign, 'Concurrent canonical bytes.\n')
          unlinkSync(targetFull)
          symlinkSync(foreign, targetFull)
        } else writeFileSync(targetFull, 'Concurrent canonical bytes.\n')
      }
      return events
    })
    expect(await applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, action, 'human', measured.reader,
    )).toBe(false)
    expect(mutations).toBe(1)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventsBefore)
    expect(readFileSync(targetFull, 'utf8')).toBe('Concurrent canonical bytes.\n')
    expect(existsSync(join(dirname(item.reviewFile), 'promotion-journal'))).toBe(false)
  })

  it.each([
    ['Promote', 'target symlink', 'canonical target changed during review transaction'],
    ['Promote', 'target appeared', 'canonical target appeared during review transaction'],
    ['Merge', 'target edited', 'canonical target changed during review transaction'],
    ['Promote', 'candidate edited', 'candidate content changed during review transaction'],
    ['Merge', 'canonical archive exists', 'canonical archive already exists'],
  ] as const)('refuses precommit %s when %s without overwriting the external edit', async (action, change, error) => {
    const { item, authority, measured, targetFull } = await stagedMeasuredFixture({}, action)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const targetBefore = action === 'Merge' ? readFileSync(targetFull, 'utf8') : undefined
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const eventsBefore = readFileSync(eventPath, 'utf8')
    const governancePath = join(dirname(item.reviewFile), 'governance.jsonl')
    const governanceBefore = readFileSync(governancePath, 'utf8')
    const readRegular = filesystem.readRegularFileBounded
    let mutations = 0
    let archiveCollision = ''
    vi.spyOn(filesystem, 'readRegularFileBounded').mockImplementation((...args) => {
      const value = readRegular(...args)
      if (args[0] === governancePath && mutations === 0) {
        mutations += 1
        if (change === 'candidate edited') writeFileSync(item.candidateFull, 'Concurrent candidate edit.\n')
        else if (change === 'canonical archive exists') {
          archiveCollision = join(
            item.root, 'archive', 'wiki-governance', new Date().toISOString().slice(0, 10), basename(item.root),
            sha256(readFileSync(targetFull)).slice(0, 12), 'canonical-before-update', 'concepts/git-identity-normalization.md',
          )
          mkdirSync(dirname(archiveCollision), { recursive: true })
          writeFileSync(archiveCollision, 'Existing protected archive.\n')
        } else {
          mkdirSync(dirname(targetFull), { recursive: true })
          if (change === 'target symlink') {
            const foreign = join(item.root, 'foreign-precommit.md')
            writeFileSync(foreign, 'Concurrent target edit.\n')
            symlinkSync(foreign, targetFull)
          } else writeFileSync(targetFull, 'Concurrent target edit.\n')
        }
      }
      return value
    })
    await expect(applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, action, 'human', measured.reader,
    )).rejects.toThrow(error)
    expect(mutations).toBe(1)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventsBefore)
    expect(readFileSync(governancePath, 'utf8')).toBe(governanceBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(change === 'candidate edited' ? 'Concurrent candidate edit.\n' : candidateBefore)
    if (change === 'canonical archive exists') {
      expect(readFileSync(archiveCollision, 'utf8')).toBe('Existing protected archive.\n')
      expect(readFileSync(targetFull, 'utf8')).toBe(targetBefore)
    } else if (change === 'candidate edited') expect(existsSync(targetFull)).toBe(false)
    else expect(readFileSync(targetFull, 'utf8')).toBe('Concurrent target edit.\n')
    expect(existsSync(join(dirname(item.reviewFile), 'promotion-journal'))).toBe(false)
  })
})

describe('Candidate verification gate', () => {
  it('refuses a canonical target inside the Candidate tree before consulting measured-use evidence', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
    rows[0] = { ...rows[0]!, targetPath: '_candidates/ingest/other-target.md' }
    writeFileSync(item.reviewFile, JSON.stringify(rows, null, 2))
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    expect(await recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote')).toBe(true)
    let reads = 0
    const measured = measuredTrialReader({ onRead: () => { reads += 1 } })
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    expect(recordCandidateMeasuredTrial(authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash))
      .toEqual({ authenticated: false, eligibleForReview: false, errorCode: 'measured-trial-invalid' })
    expect(reads).toBe(0)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(existsSync(join(item.wikiRoot, '_candidates/ingest/other-target.md'))).toBe(false)
    expect(existsSync(join(dirname(item.reviewFile), 'promotion-journal'))).toBe(false)
  })

  it('refuses trial eligibility withdrawn after signing and before journal persistence', async () => {
    let reads = 0
    const options: { patch?: Partial<VerifiedMeasuredTrial>; onRead: () => void } = {
      onRead() {
        reads += 1
        if (reads === 3) options.patch = { eligibleForReview: false }
      },
    }
    const { item, authority, measured } = await stagedMeasuredFixture(options)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const eventsBefore = readFileSync(eventPath, 'utf8')
    await expect(applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, 'Promote', 'human', measured.reader,
    )).resolves.toBe(false)
    expect(reads).toBe(3)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventsBefore)
    expect(existsSync(join(dirname(item.reviewFile), 'promotion-journal'))).toBe(false)
    expect(existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toBe(false)
  })

  it.each([
    'failed status', 'different action', 'missing review hash', 'different review hash',
    'empty receipts', 'failed receipt mirror', 'missing receipt', 'different receipt hash',
  ] as const)('refuses %s in a previously verified review before consulting measured evidence', async (change) => {
    let measuredReads = 0
    const { item, authority, measured } = await stagedMeasuredFixture({ onRead() { measuredReads += 1 } })
    measuredReads = 0
    const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
    const row = rows[0]
    const verification = row?.verification
    const reference = verification?.receipts.at(-1)
    if (row === undefined || verification === undefined || reference === undefined) throw new Error('missing seeded verification')
    let edited: CandidateVerification = verification
    switch (change) {
      case 'failed status': edited = { ...verification, status: 'failed' }; break
      case 'different action': edited = { ...verification, action: 'Merge' }; break
      case 'missing review hash': {
        const copy = { ...verification }
        Reflect.deleteProperty(copy, 'reviewHash')
        edited = copy
        break
      }
      case 'different review hash': edited = { ...verification, reviewHash: 'b'.repeat(64) }; break
      case 'empty receipts': edited = { ...verification, receipts: [] }; break
      case 'failed receipt mirror': edited = { ...verification, receipts: [{ ...reference, result: 'fail' }] }; break
      case 'missing receipt': edited = { ...verification, receipts: [{ ...reference, id: 'missing-independent-receipt' }] }; break
      case 'different receipt hash': edited = { ...verification, receipts: [{ ...reference, receiptHash: 'b'.repeat(64) }] }; break
    }
    rows[0] = { ...row, verification: edited }
    writeFileSync(item.reviewFile, JSON.stringify(rows, null, 2))
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const eventsBefore = readFileSync(eventPath, 'utf8')
    expect(recordCandidateMeasuredTrial(authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash))
      .toMatchObject({ authenticated: false, errorCode: 'semantic-verification-required' })
    expect(await applyCandidateReview(authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, 'Promote', 'human', measured.reader))
      .toBe(false)
    expect(measuredReads).toBe(0)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventsBefore)
    expect(existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toBe(false)
    expect(existsSync(join(dirname(item.reviewFile), 'promotion-journal'))).toBe(false)
  })

  it.each([
    ['different authority', { authorityId: 'other-independent-reader' }],
    ['different trial hash', { trialHash: 'b'.repeat(64) }],
    ['different target pre-state', { targetBeforeHashOrVerifiedAbsence: 'b'.repeat(64) }],
    ['withdrawn eligibility', { eligibleForReview: false }],
    ['zero utility', { utilityScore: 0 }],
    ['different trial interval', { startedAt: '2026-10-11T10:01:00.000Z' }],
    ['empty evidence', { evidenceRefs: [] }],
  ])('refuses %s returned after trial registration without creating a promotion journal', async (_name, patch) => {
    const options: { patch?: Partial<VerifiedMeasuredTrial> } = {}
    const { item, authority, measured } = await stagedMeasuredFixture(options)
    options.patch = patch
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const eventsBefore = readFileSync(eventPath, 'utf8')
    expect(await applyCandidateReview(authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, 'Promote', 'human', measured.reader))
      .toBe(false)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventsBefore)
    expect(existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toBe(false)
    expect(existsSync(join(dirname(item.reviewFile), 'promotion-journal'))).toBe(false)
  })

  it.each([
    ['withdrawn eligibility', { eligibleForReview: false }],
    ['zero utility', { utilityScore: 0 }],
    ['different proposal', { proposalHash: 'b'.repeat(64) }],
    ['different trial hash', { trialHash: 'b'.repeat(64) }],
    ['different evidence', { evidenceRefs: ['e'.repeat(64)] }],
    ['different target bytes', {
      targetAfterBytes: Buffer.from('# Different target bytes\n'),
      targetAfterHash: sha256(Buffer.from('# Different target bytes\n')),
    }],
  ])('rolls back a prepared canonical transaction when recovery sees %s', async (_name, patch) => {
    const options: { patch?: Partial<VerifiedMeasuredTrial> } = {}
    const { item, authority, measured } = await stagedMeasuredFixture(options)
    const archiveRoot = join(item.root, 'archive')
    const target = join(item.wikiRoot, 'concepts/git-identity-normalization.md')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    expect(await applyCandidateReview(authority, item.reviewFile, item.root, item.wikiRoot, archiveRoot, item.reviewId, 'Promote', 'human', measured.reader))
      .toBe(true)
    const directory = join(dirname(item.reviewFile), 'promotion-journal')
    const journalName = readdirSync(directory).find(name => name.endsWith('.json'))
    if (journalName === undefined) throw new Error('missing promotion journal')
    const journalPath = join(directory, journalName)
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>
    // All writes reached their after-state, but the mutable completion marker
    // can still be prepared after a crash. Keep the signed core unchanged.
    writeFileSync(journalPath, JSON.stringify({ ...journal, state: 'prepared' }))
    options.patch = patch
    expect(await recoverCandidateReviewTransactions(authority, item.reviewFile, item.wikiRoot, archiveRoot, measured.reader)).toBe(1)
    expect(existsSync(target)).toBe(false)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({ state: 'rolled-back' })
    expect(readKnowledgeEventLog(join(dirname(item.reviewFile), 'knowledge-events.jsonl'), authority).at(-1)?.type)
      .toBe('knowledge/rolled_back')
    expect(await recoverCandidateReviewTransactions(authority, item.reviewFile, item.wikiRoot, archiveRoot, measured.reader)).toBe(0)
  })

  it.each(['Merge', 'Replace', 'Deduplicate'] as const)('commits and recovers exact measured bytes for %s', async (action) => {
    const item = fixture()
    const target = join(item.wikiRoot, 'concepts/git-identity-normalization.md')
    const before = '---\ntype: concept\nstatus: canonical\n---\n\nPreviously verified canonical content.\n'
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, before)
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, action)
    expect(await recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, action)).toBe(true)
    const measured = measuredTrialReader()
    expect(recordCandidateMeasuredTrial(
      authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, action, measured.trialHash,
    ))
      .toMatchObject({ authenticated: true, eligibleForReview: true })
    const archiveRoot = join(item.root, 'archive')
    expect(await applyCandidateReview(authority, item.reviewFile, item.root, item.wikiRoot, archiveRoot, item.reviewId, action, 'human', measured.reader))
      .toBe(true)
    expect(readFileSync(target)).toEqual(measured.targetAfter)
    expect(existsSync(item.candidateFull)).toBe(false)
    const directory = join(dirname(item.reviewFile), 'promotion-journal')
    const journalPath = join(directory, readdirSync(directory)[0]!)
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      state: string
      operations: Array<{ role: string; path: string }>
    }
    const canonicalArchive = journal.operations.find(operation => operation.role === 'canonical-archive')!
    expect(readFileSync(canonicalArchive.path, 'utf8')).toBe(before)
    writeFileSync(journalPath, JSON.stringify({ ...journal, state: 'prepared' }))
    expect(await recoverCandidateReviewTransactions(authority, item.reviewFile, item.wikiRoot, archiveRoot, measured.reader)).toBe(1)
    expect(readFileSync(target)).toEqual(measured.targetAfter)
    expect(readFileSync(canonicalArchive.path, 'utf8')).toBe(before)
  })

  it.each([
    ['wrong authority', { authorityId: 'other' }],
    ['wrong trial', { trialHash: 'b'.repeat(64) }],
    ['malformed proposal', { proposalHash: 'invalid' }],
    ['malformed target hash', { targetAfterHash: 'invalid' }],
    ['non-boolean eligibility', { eligibleForReview: 'true' }],
    ['wrong candidate path', { candidatePath: '_candidates/ingest/concepts/other.md' }],
    ['wrong candidate hash', { candidateHash: 'b'.repeat(64) }],
    ['wrong action', { action: 'Replace' }],
    ['wrong target', { targetPath: 'concepts/other.md' }],
    ['wrong target state', { targetBeforeHashOrVerifiedAbsence: 'b'.repeat(64) }],
    ['non-buffer target', { targetAfterBytes: 'text' }],
    ['oversized target', { targetAfterBytes: Buffer.alloc(5 * 1024 * 1024 + 1) }],
    ['invalid UTF-8 target', { targetAfterBytes: Buffer.from([0xff]) }],
    ['fractional retrievals', { retrievalHits: 0.5 }],
    ['negative retrievals', { retrievalHits: -1 }],
    ['fractional uses', { successfulUses: 0.5 }],
    ['negative uses', { successfulUses: -1 }],
    ['fractional corrections', { userCorrections: 0.5 }],
    ['negative corrections', { userCorrections: -1 }],
    ['nonfinite utility', { utilityScore: Number.NaN }],
    ['invalid start', { startedAt: 'invalid' }],
    ['invalid end', { endedAt: 'invalid' }],
    ['reversed time', { endedAt: '2026-10-11T09:00:00.000Z' }],
    ['non-array evidence', { evidenceRefs: null }],
    ['empty evidence', { evidenceRefs: [] }],
    ['malformed evidence', { evidenceRefs: ['invalid'] }],
  ])('refuses a measured reader result with %s before mutation', async (_name, patch) => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    expect(await recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote')).toBe(true)
    const before = readFileSync(item.reviewFile, 'utf8')
    const measured = measuredTrialReader({ patch: patch as never })
    expect(recordCandidateMeasuredTrial(authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash))
      .toMatchObject({ authenticated: false, errorCode: 'measured-trial-invalid' })
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(before)
    expect(existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toBe(false)
  })

  it('keeps measured trials unavailable without independent authorities and semantic verification', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const measured = measuredTrialReader()
    const record = (
      verifier: KnowledgeWikiVerifierAuthority | undefined,
      reader: KnowledgeWikiMeasuredTrialReader | undefined,
      action: string,
      id = item.reviewId,
    ) =>
      recordCandidateMeasuredTrial(verifier, reader, item.reviewFile, item.wikiRoot, id, action as never, measured.trialHash)
    expect(record(undefined, measured.reader, 'Promote')).toMatchObject({ errorCode: 'verifier-authority-unavailable' })
    expect(record(authority, undefined, 'Promote')).toMatchObject({ errorCode: 'measured-trial-authority-unavailable' })
    expect(record(authority, measured.reader, 'Archive')).toMatchObject({ errorCode: 'measured-trial-invalid' })
    expect(record(authority, measured.reader, 'Promote', 'absent-review')).toMatchObject({ errorCode: 'review-not-found' })
    expect(record(authority, measured.reader, 'Promote')).toMatchObject({ errorCode: 'semantic-verification-required' })
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    expect(await recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote')).toBe(true)
    expect(record(authority, { ...measured.reader, authorityId: authority.authorityId }, 'Promote'))
      .toMatchObject({ errorCode: 'measured-trial-invalid' })
  })

  it.each(['candidate', 'target', 'review'] as const)('rejects a %s changed while reading measured evidence', async (changed) => {
    const item = fixture()
    const authority = verifierAuthority()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    expect(await recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, 'Promote')).toBe(true)
    const measured = measuredTrialReader({ onRead() {
      if (changed === 'candidate') writeFileSync(item.candidateFull, 'Changed candidate.')
      if (changed === 'target') {
        const target = join(item.wikiRoot, 'concepts/git-identity-normalization.md')
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, 'New conflicting target.')
      }
      if (changed === 'review') writeFileSync(item.reviewFile, `${readFileSync(item.reviewFile, 'utf8')}\n`)
    } })
    expect(recordCandidateMeasuredTrial(authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash))
      .toMatchObject({ authenticated: false, errorCode: 'review-changed' })
    expect(existsSync(join(dirname(item.reviewFile), 'promotion-journal'))).toBe(false)
  })

  it('never promotes a newly appended Candidate autonomously', async () => {
    const item = fixture()
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toBe(false)
    expect(await applyCandidateReview(undefined, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, 'Promote', 'human')).toBe(false)
  })

  it('binds source provenance bytes separately from mutable Candidate bytes', async () => {
    const item = fixture()
    const source = join(item.root, 'raw', 'evidence', 'sha-test.json')
    mkdirSync(dirname(source), { recursive: true })
    writeFileSync(source, '{"source":true}', 'utf8')
    const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as Array<Record<string, unknown>>
    rows[0]!.sourcePath = 'raw/evidence/sha-test.json'
    rows[0]!.sourceHash = sha256(readFileSync(source))
    writeFileSync(item.reviewFile, JSON.stringify(rows, null, 2), 'utf8')
    const authority = verifierAuthority()
    await expect(verifyCandidate(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal))
      .resolves.toMatchObject({ ok: true })
    rows[0]!.sourceHash = sha256('tampered-source')
    writeFileSync(item.reviewFile, JSON.stringify(rows, null, 2), 'utf8')
    await expect(verifyCandidate(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal))
      .resolves.toMatchObject({ ok: false, errorCode: 'candidate-invalid' })
  })

  it('preserves verification for legacy candidate rows without source provenance fields', async () => {
    const item = fixture()
    const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as Array<Record<string, unknown>>
    delete rows[0]!.sourcePath
    delete rows[0]!.sourceHash
    delete rows[0]!.createdAt
    writeFileSync(item.reviewFile, JSON.stringify(rows, null, 2), 'utf8')
    const authority = verifierAuthority()

    const result = await verifyCandidate(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: true, result: 'pass' })
    expect(await recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, result.receiptId!, 'Promote',
    )).toBe(true)
    const verified = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
    expect(verified[0]?.sourcePath).toBeUndefined()
    expect(verified[0]?.sourceHash).toBeUndefined()
    expect(verified[0]?.verification?.status).toBe('passed')
  })

  it('rejects receipts after the bound Candidate path or immutable target changes', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const result = await verifyCandidate(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal,
    )
    if (result.receiptId === undefined) throw new Error('missing authenticated receipt')
    const row = (JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[])[0]!

    expect(buildVerificationRequest(authority, item.wikiRoot, {
      ...row,
      candidatePath: 'concepts/not-a-candidate.md',
    }, 'Promote')).toBeUndefined()
    expect(readTrustedVerification(
      authority,
      item.reviewFile,
      item.wikiRoot,
      { ...row, targetPath: 'concepts/changed-after-verification.md' },
      result.receiptId,
      'Promote',
    )).toBeUndefined()
  })

  it('uses the candidate address as a source identity when the legacy row has no source path', async () => {
    const item = fixture()
    const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as Array<Record<string, unknown>>
    delete rows[0]!.sourcePath
    rows[0]!.sourceHash = sha256(item.candidatePath)
    writeFileSync(item.reviewFile, JSON.stringify(rows, null, 2), 'utf8')

    await expect(verifyCandidate(
      verifierAuthority(), item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal,
    )).resolves.toMatchObject({ ok: true, result: 'pass' })
  })

  it('binds out-of-project and symbolic-link source identities without following them', async () => {
    const item = fixture()
    const outsideRoot = mkdtempSync(join(tmpdir(), 'wiki-external-source-'))
    roots.push(outsideRoot)
    const externalSource = join(outsideRoot, 'source.json')
    writeFileSync(externalSource, '{"source":"outside"}', 'utf8')
    const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as Array<Record<string, unknown>>
    rows[0]!.sourcePath = externalSource
    rows[0]!.sourceHash = sha256(externalSource)
    writeFileSync(item.reviewFile, JSON.stringify(rows, null, 2), 'utf8')
    const authority = verifierAuthority()

    await expect(verifyCandidate(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal,
    )).resolves.toMatchObject({ ok: true })

    const linkedSource = join(item.root, 'raw', 'sources', 'linked-source.json')
    mkdirSync(dirname(linkedSource), { recursive: true })
    symlinkSync(externalSource, linkedSource)
    rows[0]!.sourcePath = 'raw/sources/linked-source.json'
    rows[0]!.sourceHash = sha256('raw/sources/linked-source.json')
    writeFileSync(item.reviewFile, JSON.stringify(rows, null, 2), 'utf8')
    await expect(verifyCandidate(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal,
    )).resolves.toMatchObject({ ok: true })
  })

  it('keeps semantic verification separate from measured trial and canonical promotion', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const verification = await verifyCandidate(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal,
    )
    expect(verification).toMatchObject({ ok: true, result: 'pass' })
    expect(existsSync(join(dirname(item.reviewFile), 'verifier.key'))).toBe(false)
    const receipt = JSON.parse(readFileSync(
      join(dirname(item.reviewFile), 'verification-receipts', `${verification.receiptId!}.json`),
      'utf8',
    )) as { request: { targetPath: string; governanceAction: string; sourceIdentity: Record<string, unknown> } }
    expect(receipt.request).toMatchObject({
      targetPath: 'concepts/git-identity-normalization.md',
      governanceAction: 'Promote',
      sourceIdentity: {
        commit: '84ae44c98c94bac19c29cd70516dc10a01af170b',
        sourceDigest: '1'.repeat(64),
        dirty: true,
        dirtyDigest: '2'.repeat(64),
        buildDigest: '3'.repeat(64),
      },
    })
    expect(await recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, verification.receiptId!, 'Promote',
    )).toBe(true)
    expect(await applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'),
      item.reviewId, 'Promote', 'human',
    )).toBe(false)
    const row = (JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[])[0]!
    expect(row.verification?.status).toBe('passed')
    expect(row.verification?.trial).toBeUndefined()
    expect(existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('never promotes a Candidate whose authentic independent receipt records failure', async () => {
    const item = fixture()
    const authority = verifierAuthority('fail')
    const result = await verifyCandidate(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, result: 'fail', errorCode: 'verification-failed' })
    if (result.receiptId === undefined) throw new Error('authenticated failure receipt was not persisted')

    expect(await recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, result.receiptId, 'Promote'))
      .toBe(false)
    const applied = await applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, 'Promote', 'human',
    )

    expect({
      applied,
      canonicalWritten: existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md')),
      candidateStillPresent: existsSync(item.candidateFull),
    }).toEqual({ applied: false, canonicalWritten: false, candidateStillPresent: true })
  })

  it('does not let a project-edited passed mirror upgrade an authentic failed receipt through the service', async () => {
    const item = fixture()
    const ctx = new Context()
    ctx.provide('knowledgeWikiVerifierAuthority', verifierAuthority('fail'))
    const service = new KnowledgeWikiService(ctx, wikiTestConfig({
      wikiRoot: item.wikiRoot, mainRoot: item.root, credential: 'UNUSED_FIXTURE_REF', llmProvider: 'p', llmModel: 'm',
    }))
    try {
      const result = await service.verifyCandidate({ reviewId: item.reviewId, action: 'Promote' }, new AbortController().signal)
      expect(result).toMatchObject({ ok: false, result: 'fail' })
      if (result.receiptId === undefined) throw new Error('missing authentic failure receipt')
      const receiptPath = join(dirname(item.reviewFile), 'verification-receipts', `${result.receiptId}.json`)
      const receiptBytes = readFileSync(receiptPath, 'utf8')
      const receipt = JSON.parse(receiptBytes) as TrustedVerificationReceipt
      const rows = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
      const original = rows[0]!
      // Only the project-writable mirror changes. The failed authority result
      // and its proof remain byte-for-byte intact and must remain authoritative.
      writeFileSync(item.reviewFile, JSON.stringify([{
        ...original,
        verification: {
          status: 'passed', candidateHash: original.candidateHash, action: 'Promote',
          methods: ['integration_test'], evidence: ['forged project assertion'],
          confidence: 1, successCount: 1, failureCount: 0,
          receipts: [{
            id: receipt.id, path: `verification-receipts/${receipt.id}.json`, receiptHash: receipt.receiptHash,
            environmentHash: sha256(canonicalJson(receipt.request.environment)),
            result: 'pass', gitCommit: receipt.request.sourceIdentity.commit,
          }],
        },
      }]))

      const applied = await service.resolveReviews({ ids: [item.reviewId], action: 'Promote' })
      expect(readFileSync(receiptPath, 'utf8')).toBe(receiptBytes)
      expect({
        applied,
        canonicalWritten: existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md')),
        candidateStillPresent: existsSync(item.candidateFull),
      }).toEqual({ applied: 0, canonicalWritten: false, candidateStillPresent: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps authentic failed receipts readable without projecting them as passed', async () => {
    const item = fixture()
    const authority = verifierAuthority('fail')
    const result = await verifyCandidate(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal)
    if (result.receiptId === undefined) throw new Error('missing failed receipt')
    const row = (JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[])[0]!
    const receipt = readTrustedReceipt(authority, item.reviewFile, result.receiptId)
    expect(receipt?.result.result).toBe('fail')
    expect(readTrustedVerification(authority, item.reviewFile, item.wikiRoot, row, result.receiptId, 'Promote'))
      .toBeUndefined()
    expect(readTrustedReceipt(authority, item.reviewFile, result.receiptId)).toEqual(receipt)
  })

  it('does not create a canonical journal from a semantic receipt without a measured trial', async () => {
    const item = fixture()
    const failedAuthority = verifierAuthority('fail')
    const failed = await verifyCandidate(failedAuthority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal)
    if (failed.receiptId === undefined) throw new Error('missing failed receipt')
    const failedReceipt = readTrustedReceipt(failedAuthority, item.reviewFile, failed.receiptId)!
    const authority: KnowledgeWikiVerifierAuthority = {
      ...verifierAuthority(),
    }
    const passed = await verifyCandidate(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal)
    if (passed.receiptId === undefined) throw new Error('missing passing receipt')
    expect(readTrustedReceipt(authority, item.reviewFile, passed.receiptId)?.request).toEqual(failedReceipt.request)
    expect(await recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, passed.receiptId, 'Promote')).toBe(true)
    const archiveRoot = join(item.root, 'archive')
    expect(await applyCandidateReview(authority, item.reviewFile, item.root, item.wikiRoot, archiveRoot, item.reviewId, 'Promote', 'human'))
      .toBe(false)
    const directory = join(dirname(item.reviewFile), 'promotion-journal')
    expect(existsSync(directory)).toBe(false)
    expect(existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(await recoverCandidateReviewTransactions(failedAuthority, item.reviewFile, item.wikiRoot, archiveRoot)).toBe(0)
    expect(readTrustedReceipt(failedAuthority, item.reviewFile, failed.receiptId)?.result.result).toBe('fail')
  })

  it('does not invalidate snapshots when a semantic-only promotion is refused', async () => {
    const item = fixture()
    const ctx = new Context()
    ctx.provide('knowledgeWikiVerifierAuthority', verifierAuthority())
    const service = new KnowledgeWikiService(ctx, wikiTestConfig({
      wikiRoot: item.wikiRoot,
      mainRoot: item.root,
      credential: 'VISION_API_KEY',
      llmProvider: 'p',
      llmModel: 'm',
    })) as unknown as {
      verifyCandidate(
        request: { reviewId: string; action: 'Promote' },
        signal: AbortSignal,
      ): Promise<{ ok: boolean; receiptId?: string }>
      resolveReviews(request: { ids: string[]; action?: string }): Promise<number>
      snapshots: WikiSnapshotStore
    }
    const before = service.snapshots.currentGeneration(item.wikiRoot)

    try {
      await expect(service.verifyCandidate(
        { reviewId: item.reviewId, action: 'Promote' },
        new AbortController().signal,
      )).resolves.toMatchObject({ ok: true })
      await expect(service.resolveReviews({ ids: [item.reviewId], action: 'Promote' })).resolves.toBe(0)
      expect(service.snapshots.currentGeneration(item.wikiRoot)).toBe(before)
      expect(existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toBe(false)
      expect(existsSync(item.candidateFull)).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs the injected measured-trial reader through the host service before resolving a review', async () => {
    const item = fixture()
    const ctx = new Context()
    const authority = verifierAuthority()
    const measured = measuredTrialReader()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    ctx.provide('knowledgeWikiMeasuredTrialReader', measured.reader)
    const service = new KnowledgeWikiService(ctx, wikiTestConfig({
      wikiRoot: item.wikiRoot,
      mainRoot: item.root,
      credential: 'UNUSED_FIXTURE_REF',
      llmProvider: 'p',
      llmModel: 'm',
    }))
    try {
      const semantic = await service.verifyCandidate(
        { reviewId: item.reviewId, action: 'Promote' },
        new AbortController().signal,
      )
      expect(semantic.ok).toBe(true)
      const trial = await service.recordCandidateMeasuredTrial({
        reviewId: item.reviewId,
        action: 'Promote',
        trialHash: measured.trialHash,
      })
      expect(trial).toMatchObject({ authenticated: true, eligibleForReview: true })
      await expect(service.resolveReview({ reviewId: item.reviewId, action: 'Promote' })).resolves.toBe(true)
      expect(readFileSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toEqual(measured.targetAfter)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects verification after Candidate content changes', async () => {
    const item = fixture()
    writeFileSync(item.candidateFull, `${readFileSync(item.candidateFull, 'utf8')}\nchanged\n`, 'utf8')
    await expect(verifyCandidate(
      verifierAuthority(), item.reviewFile, item.wikiRoot, item.reviewId, 'Promote',
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: false })
  })

  it('rejects caller-forged receipt ids and tampered authority receipts', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    expect(await recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, '../outside', 'Promote',
    )).toBe(false)
    const verification = await verifyCandidate(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote',
      new AbortController().signal,
    )
    const receipt = join(dirname(item.reviewFile), 'verification-receipts', `${verification.receiptId!}.json`)
    const value = JSON.parse(readFileSync(receipt, 'utf8')) as { result: Record<string, unknown> }
    writeFileSync(receipt, JSON.stringify({ ...value, result: { ...value.result, result: 'fail' } }))
    expect(await recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, verification.receiptId!, 'Promote',
    )).toBe(false)
  })

  it('fails closed when the injected verifier authority is unavailable', async () => {
    const item = fixture()
    await expect(verifyCandidate(
      undefined, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote',
      new AbortController().signal,
    )).resolves.toEqual({
      ok: false,
      evidence: [],
      errorCode: 'verifier-authority-unavailable',
    })
  })

  it('rejects a short commit or incomplete source/dirty identity from the injected owner', async () => {
    const item = fixture()
    const base = verifierAuthority()
    const invalid = {
      ...base,
      sourceIdentity: () => ({
        ...base.sourceIdentity(),
        commit: 'abc1234',
        dirtyDigest: 'missing',
      }),
    }
    await expect(verifyCandidate(
      invalid, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote',
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: false, errorCode: 'source-identity-invalid' })
  })

  it('refuses a post-hoc edited journal whose authority proof no longer matches', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const verification = await verifyCandidate(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Archive',
      new AbortController().signal,
    )
    expect(await recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, verification.receiptId!, 'Archive',
    )).toBe(true)
    const archiveRoot = join(item.root, 'archive')
    expect(await applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, archiveRoot, item.reviewId, 'Archive', 'human',
    )).toBe(true)

    const journalDirectory = join(dirname(item.reviewFile), 'promotion-journal')
    const journalPath = join(journalDirectory, readdirSync(journalDirectory).find(name => name.endsWith('.json'))!)
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      state: string
      operations: Array<{ role: string; path: string; before?: string; after?: string }>
    }
    const target = journal.operations.find(operation => operation.role === 'candidate-archive')!
    const review = journal.operations.find(operation => operation.role === 'review')!
    unlinkSync(target.path)
    writeFileSync(review.path, review.before!, 'utf8')
    writeFileSync(journalPath, JSON.stringify({ ...journal, state: 'prepared', operationSetHash: '0'.repeat(64) }), 'utf8')

    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, archiveRoot,
    )).rejects.toThrow('authority validation failed')
  })

  it('promotes only the exact canonical bytes authorized by an authenticated utility trial', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const semanticReceiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    expect(await recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, semanticReceiptId, 'Promote',
    )).toBe(true)
    const measured = measuredTrialReader()
    const trial = recordCandidateMeasuredTrial(
      authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash,
    )
    expect(trial).toMatchObject({ authenticated: true, eligibleForReview: true, trial: { status: 'passed' } })

    const target = join(item.wikiRoot, 'concepts/git-identity-normalization.md')
    const archiveRoot = join(item.root, 'archive')
    expect(await applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, archiveRoot, item.reviewId, 'Promote', 'human', measured.reader,
    )).toBe(true)
    expect(readFileSync(target)).toEqual(measured.targetAfter)
    const events = readKnowledgeEventLog(join(dirname(item.reviewFile), 'knowledge-events.jsonl'), authority)
    expect(events.at(-1)).toMatchObject({
      type: 'knowledge/promoted',
      payload: {
        trialHash: measured.trialHash,
        measuredTrialAuthorityId: measured.reader.authorityId,
        utilityScore: 0.5,
        retrievalHits: 2,
      },
    })

    const journalPath = join(dirname(item.reviewFile), 'promotion-journal', readdirSync(join(dirname(item.reviewFile), 'promotion-journal'))[0]!)
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>
    writeFileSync(journalPath, JSON.stringify({ ...journal, state: 'prepared' }), 'utf8')
    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, archiveRoot, measured.reader,
    )).toBe(1)
    expect(readFileSync(target)).toEqual(measured.targetAfter)
  })

  it('records an authenticated trial without unlocking review when utility did not improve', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const semanticReceiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    expect(await recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, semanticReceiptId, 'Promote',
    )).toBe(true)
    const measured = measuredTrialReader({ eligible: false, utilityScore: 0 })
    expect(recordCandidateMeasuredTrial(
      authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash,
    )).toMatchObject({ authenticated: true, eligibleForReview: false, errorCode: 'utility-not-improved' })
    const review = JSON.parse(readFileSync(item.reviewFile, 'utf8')) as WikiReviewItem[]
    expect(review[0]!.verification?.trial?.status).toBe('failed')
    expect(review[0]!.options).toEqual([{ action: 'Archive', label: '归档候选' }])
    expect(await applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, 'Promote', 'human', measured.reader,
    )).toBe(false)
    expect(existsSync(join(item.wikiRoot, review[0]!.targetPath!))).toBe(false)
  })

  it('rejects a measured-trial target artifact whose bytes do not match its signed hash', async () => {
    const item = fixture()
    const authority = verifierAuthority()
    const semanticReceiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    expect(await recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, semanticReceiptId, 'Promote',
    )).toBe(true)
    const measured = measuredTrialReader({ wrongHash: true })
    expect(recordCandidateMeasuredTrial(
      authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash,
    )).toMatchObject({ authenticated: false, eligibleForReview: false, errorCode: 'measured-trial-invalid' })
    expect(await applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, 'Promote', 'human', measured.reader,
    )).toBe(false)
  })
})
