import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import KnowledgeWikiService from '../src/index.ts'
import {
  appendCandidateReviews,
  applyCandidateReview,
  recordCandidateVerification,
  recoverCandidateReviewTransactions,
} from '../src/reviews.ts'
import { canonicalJson, readTrustedReceipt, readTrustedVerification, sha256, verifyCandidate, type KnowledgeWikiVerifierAuthority, type TrustedVerificationReceipt, type VerificationAuthoritySeal } from '../src/verifier.ts'
import type { WikiSnapshotStore } from '../src/snapshot-store.ts'
import type { WikiReviewItem } from '../src/types.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-verification-'))
  roots.push(root)
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

describe('Candidate verification gate', () => {
  it('never promotes a newly appended Candidate autonomously', () => {
    const item = fixture()
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toBe(false)
    expect(applyCandidateReview(undefined, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'), item.reviewId, 'Promote', 'human')).toBe(false)
  })

  it('promotes only after an authority-bound independent verification', async () => {
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
    expect(recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, verification.receiptId!, 'Promote',
    )).toBe(true)
    expect(applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, join(item.root, 'archive'),
      item.reviewId, 'Promote', 'human',
    )).toBe(true)
    expect(existsSync(join(item.wikiRoot, 'concepts/git-identity-normalization.md'))).toBe(true)
  })

  it('never promotes a Candidate whose authentic independent receipt records failure', async () => {
    const item = fixture()
    const authority = verifierAuthority('fail')
    const result = await verifyCandidate(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, result: 'fail', errorCode: 'verification-failed' })
    if (result.receiptId === undefined) throw new Error('authenticated failure receipt was not persisted')

    expect(recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, result.receiptId, 'Promote'))
      .toBe(false)
    const applied = applyCandidateReview(
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
    const service = new KnowledgeWikiService(ctx, {
      wikiRoot: item.wikiRoot, mainRoot: item.root, credential: 'UNUSED_FIXTURE_REF', llmProvider: 'p', llmModel: 'm',
    })
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

  it('rejects an authentically sealed prepared journal backed by a failed receipt before mutating files', async () => {
    const item = fixture()
    const failedAuthority = verifierAuthority('fail')
    const failed = await verifyCandidate(failedAuthority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal)
    if (failed.receiptId === undefined) throw new Error('missing failed receipt')
    const failedReceipt = readTrustedReceipt(failedAuthority, item.reviewFile, failed.receiptId)!
    const stop = new Error('stop after journal persistence')
    const authority: KnowledgeWikiVerifierAuthority = {
      ...verifierAuthority(),
      checkpointPromotion(_payload, checkpoint) {
        if (checkpoint.phase === 'journal-persisted') throw stop
      },
    }
    const passed = await verifyCandidate(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', new AbortController().signal)
    if (passed.receiptId === undefined) throw new Error('missing passing receipt')
    expect(readTrustedReceipt(authority, item.reviewFile, passed.receiptId)?.request).toEqual(failedReceipt.request)
    expect(recordCandidateVerification(authority, item.reviewFile, item.wikiRoot, item.reviewId, passed.receiptId, 'Promote')).toBe(true)
    const archiveRoot = join(item.root, 'archive')
    expect(() => applyCandidateReview(authority, item.reviewFile, item.root, item.wikiRoot, archiveRoot, item.reviewId, 'Promote', 'human'))
      .toThrow(stop)
    const directory = join(dirname(item.reviewFile), 'promotion-journal')
    const journalPath = join(directory, readdirSync(directory).find(name => name.endsWith('.json'))!)
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      state: string
      seal: VerificationAuthoritySeal
      receiptId: string
      receiptHash: string
      operationSetHash: string
      operations: Array<{ path: string; before?: string; after?: string }>
    }
    expect(journal.state).toBe('prepared')
    const { state: _state, seal: _seal, ...originalCore } = journal
    expect(authority.validatePromotion(canonicalJson(originalCore), journal.seal)).toBe(true)
    // Model a legacy, authentically sealed WAL whose admission ignored a
    // failed verdict. Keep real producer operations and immutable pre-state.
    const core = { ...originalCore, receiptId: failedReceipt.id, receiptHash: failedReceipt.receiptHash }
    expect(core.operationSetHash).toBe(sha256(canonicalJson(core.operations)))
    const seal = failedAuthority.sealPromotion(canonicalJson(core))
    expect(failedAuthority.validatePromotion(canonicalJson(core), seal)).toBe(true)
    writeFileSync(journalPath, JSON.stringify({ ...core, state: 'prepared', seal }), 'utf8')
    const before = core.operations.map(operation => ({
      path: operation.path,
      bytes: existsSync(operation.path) ? readFileSync(operation.path, 'utf8') : undefined,
    }))
    expect(before.map(value => value.bytes)).toEqual(core.operations.map(operation => operation.before))
    expect(() => recoverCandidateReviewTransactions(failedAuthority, item.reviewFile, item.wikiRoot, archiveRoot))
      .toThrow('promotion journal verified receipt binding failed')
    expect(before.map(value => ({
      path: value.path,
      bytes: existsSync(value.path) ? readFileSync(value.path, 'utf8') : undefined,
    }))).toEqual(before)
    expect(readTrustedReceipt(failedAuthority, item.reviewFile, failed.receiptId)?.result.result).toBe('fail')
  })

  it('invalidates snapshots after a bulk verified promotion', async () => {
    const item = fixture()
    const ctx = new Context()
    ctx.provide('knowledgeWikiVerifierAuthority', verifierAuthority())
    const service = new KnowledgeWikiService(ctx, {
      wikiRoot: item.wikiRoot,
      mainRoot: item.root,
      credential: 'VISION_API_KEY',
      llmProvider: 'p',
      llmModel: 'm',
    }) as unknown as {
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
      await expect(service.resolveReviews({ ids: [item.reviewId], action: 'Promote' })).resolves.toBe(1)
      expect(service.snapshots.currentGeneration(item.wikiRoot)).toBe(before + 1)
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
    expect(recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, '../outside', 'Promote',
    )).toBe(false)
    const verification = await verifyCandidate(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote',
      new AbortController().signal,
    )
    const receipt = join(dirname(item.reviewFile), 'verification-receipts', `${verification.receiptId!}.json`)
    const value = JSON.parse(readFileSync(receipt, 'utf8')) as { result: Record<string, unknown> }
    writeFileSync(receipt, JSON.stringify({ ...value, result: { ...value.result, result: 'fail' } }))
    expect(recordCandidateVerification(
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
      authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote',
      new AbortController().signal,
    )
    expect(recordCandidateVerification(
      authority, item.reviewFile, item.wikiRoot, item.reviewId, verification.receiptId!, 'Promote',
    )).toBe(true)
    const archiveRoot = join(item.root, 'archive')
    expect(applyCandidateReview(
      authority, item.reviewFile, item.root, item.wikiRoot, archiveRoot, item.reviewId, 'Promote', 'human',
    )).toBe(true)

    const journalDirectory = join(dirname(item.reviewFile), 'promotion-journal')
    const journalPath = join(journalDirectory, readdirSync(journalDirectory).find(name => name.endsWith('.json'))!)
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      state: string
      operations: Array<{ role: string; path: string; before?: string; after?: string }>
    }
    const target = journal.operations.find(operation => operation.role === 'canonical')!
    const review = journal.operations.find(operation => operation.role === 'review')!
    unlinkSync(target.path)
    writeFileSync(review.path, review.before!, 'utf8')
    writeFileSync(journalPath, JSON.stringify({ ...journal, state: 'prepared', operationSetHash: '0'.repeat(64) }), 'utf8')

    expect(() => recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, archiveRoot,
    )).toThrow('authority validation failed')
  })
})
