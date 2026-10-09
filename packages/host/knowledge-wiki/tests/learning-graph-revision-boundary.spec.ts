/** Two complete test-authenticated historical revisions retain original WAL bytes and never invoke a real writer. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArtifactRef } from '../src/learning-artifacts.ts'
import { createReadOnlyLearningVerifier } from '../src/external-verifier-adapter.ts'
import { admissionFor } from '../src/learning-graph-journal.ts'
import { digest } from '../src/learning-graph-context.ts'
import * as S from '../src/learning-graph-schema.ts'
import { governancePolicyVersion } from '../src/governance-policy.ts'
import { governanceArchivePath, promotionOperation, promotionTransactionId } from '../src/reviews.ts'
import { validateLearningReceiptChain } from '../src/verifier.ts'
import type { KnowledgeRecord } from '../src/types.ts'
import { createHistoricalUpdateFixture, createLearningGraphFixture } from './learning-graph-fixture.ts'

type Fixture = ReturnType<typeof createLearningGraphFixture>
type Historical = ReturnType<typeof createHistoricalUpdateFixture>
type Json = Record<string, unknown>
const fixtures: Fixture[] = []
afterEach(() => { for (const value of fixtures.splice(0)) value.artifacts.dispose() })
function consume(value: Fixture) {
  const authority = createReadOnlyLearningVerifier({ descriptor: value.descriptor,
    captureContext: value.captureContext, reducerSourceHash: value.reducerSourceHash })
  return validateLearningReceiptChain(authority, value.trial)
}

/** Larger, explicit synthetic ancestry budget; existing shared fixtures and production limits are unchanged. */
function createExtendedHistoricalUpdateFixture() {
  const historical = createLearningGraphFixture({ definition: (definition) => { definition['maxArtifacts'] = 10_000 } })
  try {
    const { artifacts, signers, journal, semantic, proposalPayload } = historical
    const roots = historical.captureContext()
    const auditTime = historical.times.measured
    const reviewBefore = readFileSync(roots.reviewFile, 'utf8')
    const reviews = JSON.parse(reviewBefore) as Json[]
    const reviewAfter = JSON.stringify(reviews.map(row => row['id'] === semantic.review.id
      ? { ...row, resolved: true, resolvedAction: 'Promote', appliedPath: semantic.targetPath, resolvedAt: Date.parse(auditTime) } : row), null, 2)
    const governanceAfter = `${JSON.stringify({ timestamp: auditTime, policyVersion: governancePolicyVersion(), reviewId: semantic.review.id,
      action: 'Promote', actor: 'synthetic-approved-principal', outcome: 'applied', candidateHash: semantic.candidate.digest,
      previousCanonicalHash: '', targetPath: semantic.targetPath, appliedPath: semantic.targetPath })}\n`
    const transactionId = promotionTransactionId(semantic.review.id, semantic.candidate.digest, auditTime)
    const archivedCandidate = governanceArchivePath(roots.archiveRoot, dirname(roots.wikiRoot), auditTime, semantic.candidate.digest, semantic.candidatePath, 'candidate')
    const targetAbsolute = join(roots.wikiRoot, semantic.targetPath)
    const candidateAbsolute = join(roots.wikiRoot, semantic.candidatePath)
    const tuples = [
      { role: 'candidate-archive' as const, path: archivedCandidate, before: undefined, after: semantic.verifiedRecord.content },
      { role: 'canonical' as const, path: targetAbsolute, before: undefined, after: semantic.targetAfter },
      { role: 'review' as const, path: roots.reviewFile, before: reviewBefore, after: reviewAfter },
      { role: 'governance' as const, path: join(dirname(roots.reviewFile), 'governance.jsonl'), before: undefined, after: governanceAfter },
      { role: 'candidate' as const, path: candidateAbsolute, before: semantic.verifiedRecord.content, after: undefined },
    ]
    const operations = tuples.map((value, index) => {
      const actual = promotionOperation(transactionId, index, value.role, value.path, value.before, value.after)
      return { role: actual.role, path: actual.path, before: actual.before ?? null, after: actual.after ?? null,
        stagingPath: actual.stagingPath ?? null, tombstonePath: actual.tombstonePath ?? null }
    })
    const core: Json = { schemaVersion: 2, id: transactionId, createdAt: auditTime, proposal: historical.proposal,
      semanticReceipt: semantic.semanticReceipt, measuredTrial: historical.trial, journalHeadBefore: journal.watermark(),
      operationSetHash: digest(operations), action: 'Promote', operations }
    const wal = artifacts.put({ ...core, seal: signers.journalEnvelope('promotion-wal', { walCoreHash: digest(core) }) })
    const transition = proposalPayload['canonicalIdentityTransition'] as Json
    const baseCanonical: KnowledgeRecord = { ...semantic.verifiedRecord, source: semantic.targetPath, content: semantic.targetAfter,
      contentHash: String(proposalPayload['evaluatedContentHash']), sourceHash: (transition['canonicalProvenance'] as ArtifactRef).digest,
      lifecycle: 'canonical', retrievalHits: 1, successfulUses: 1, utilityScore: 1, lastVerifiedAt: historical.times.measured,
      evidenceRefs: [...semantic.verifiedRecord.evidenceRefs, `sha256:${historical.proposal.digest}`, `sha256:${historical.trial.digest}`, `sha256:${wal.digest}`] }
    const canonical = baseCanonical
    const canonicalRecord = artifacts.put(canonical)
    const projection: Json = { transition, revisionId: digest({ kind: 'ark.knowledge.canonical-revision', canonicalKnowledgeId: canonical.id,
      proposalHash: historical.proposal.digest, targetAfterHash: proposalPayload['evaluatedContentHash'] }), canonicalRecordAfter: canonicalRecord,
    candidateDisposition: 'same-id-promoted', candidateRecordAfter: canonicalRecord, newlyCreditedUseIds: ['synthetic-use-candidate'] }
    journal.append(canonical.id, { type: 'knowledge/promoted', proposal: historical.proposal, trial: historical.trial, wal, projection }, auditTime)
    const admissionIdentity = admissionFor(canonical)
    const targetSnapshot = { record: canonicalRecord, admissionIdentity,
      admissionIdentityHash: digest(admissionIdentity), watermark: journal.watermark() }
    // These are isolated fixture setup bytes, not application writes or proof of fsync/power loss.
    for (const value of tuples) {
      if (value.after === undefined) rmSync(value.path)
      else { mkdirSync(dirname(value.path), { recursive: true, mode: 0o700 }); writeFileSync(value.path, value.after, { mode: 0o600 }) }
    }
    const update = createLearningGraphFixture({ definition: (definition) => { definition['maxArtifacts'] = 10_000 } }, {
      artifacts, signers, journal, tag: 'synthetic-update', timeOffsetMs: 10_000,
      target: { bytes: semantic.targetAfter, record: canonical, snapshot: targetSnapshot },
      allowedDefinitions: historical.descriptor.evaluator.allowedDefinitions,
      allowedInitiationCapabilities: historical.descriptor.evaluator.allowedInitiationCapabilities,
      sessionContexts: historical.sessionContexts,
    })
    return { ...update, historical, wal, projection, historicalCanonical: canonical, targetSnapshot }
  } catch (error) { historical.artifacts.dispose(); throw error }
}


/** Encode one synthetic historical Replace using the existing operation/path owners, then retain its original bytes. */
function replaceHistory(value: Historical, tamper?: 'archive-before' | 'archive-after' | 'candidate-disposition' | 'candidate-record') {
  const roots = value.captureContext()
  const proposal = S.proposal.parse(value.proposalPayload)
  const at = value.times.measured
  const before = readFileSync(value.artifacts.path(proposal.targetBefore!), 'utf8')
  const candidate = readFileSync(value.artifacts.path(proposal.candidate), 'utf8')
  const after = readFileSync(value.artifacts.path(proposal.targetAfter), 'utf8')
  const reviewBefore = readFileSync(roots.reviewFile, 'utf8')
  const reviews = JSON.parse(reviewBefore) as Json[]
  const reviewAfter = JSON.stringify(reviews.map(row => row['id'] === value.semantic.review.id
    ? { ...row, resolved: true, resolvedAction: 'Replace', appliedPath: proposal.targetPath, resolvedAt: Date.parse(at) } : row), null, 2)
  const governancePath = join(dirname(roots.reviewFile), 'governance.jsonl')
  const governanceBefore = existsSync(governancePath) ? readFileSync(governancePath, 'utf8') : undefined
  const governanceAfter = `${governanceBefore ?? ''}${JSON.stringify({ timestamp: at,
    policyVersion: governancePolicyVersion(), reviewId: value.semantic.review.id, action: 'Replace',
    actor: proposal.decision.actorPrincipalId, outcome: 'applied', candidateHash: proposal.candidateHash,
    previousCanonicalHash: proposal.targetBefore!.digest, targetPath: proposal.targetPath, appliedPath: proposal.targetPath })}\n`
  const transactionId = promotionTransactionId(value.semantic.review.id, proposal.candidateHash, at)
  const tuples = [
    { role: 'canonical-archive' as const, path: governanceArchivePath(roots.archiveRoot, dirname(roots.wikiRoot), at,
      proposal.targetBefore!.digest, proposal.targetPath, 'canonical-before-update'), before: undefined, after: before },
    { role: 'candidate-archive' as const, path: governanceArchivePath(roots.archiveRoot, dirname(roots.wikiRoot), at,
      proposal.candidateHash, proposal.candidatePath, 'candidate'), before: undefined, after: candidate },
    { role: 'canonical' as const, path: join(roots.wikiRoot, proposal.targetPath), before, after },
    { role: 'review' as const, path: roots.reviewFile, before: reviewBefore, after: reviewAfter },
    { role: 'governance' as const, path: governancePath, before: governanceBefore, after: governanceAfter },
    { role: 'candidate' as const, path: join(roots.wikiRoot, proposal.candidatePath), before: candidate, after: undefined },
  ]
  const operations = tuples.map((tuple, index) => {
    const operationBefore = index === 0 && tamper === 'archive-before' ? 'different retained archive pre-state' : tuple.before
    const operationAfter = index === 0 && tamper === 'archive-after' ? 'different retained canonical bytes' : tuple.after
    const operation = promotionOperation(transactionId, index, tuple.role, tuple.path, operationBefore, operationAfter)
    return { role: operation.role, path: operation.path, before: operation.before ?? null, after: operation.after ?? null,
      stagingPath: operation.stagingPath ?? null, tombstonePath: operation.tombstonePath ?? null }
  })
  const core = { schemaVersion: 2, id: transactionId, createdAt: at, proposal: value.proposal,
    semanticReceipt: proposal.semanticReceipt, measuredTrial: value.trial, journalHeadBefore: value.journal.watermark(),
    operationSetHash: digest(operations), action: 'Replace', operations }
  const wal = value.artifacts.put({ ...core, seal: value.signers.journalEnvelope('promotion-wal', { walCoreHash: digest(core) }) })
  const base = value.historicalCanonical
  const canonical = { ...base, content: after, contentHash: proposal.evaluatedContentHash,
    sourceHash: proposal.canonicalIdentityTransition.canonicalProvenance.digest,
    lastVerifiedAt: at, successfulUses: base.successfulUses + 1,
    evidenceRefs: [...new Set([...value.semantic.verifiedRecord.evidenceRefs, ...base.evidenceRefs])], utilityScore: 1 }
  const currentCandidate = { ...value.semantic.verifiedRecord, retrievalHits: 1,
    verificationStatus: 'rejected' as const, lifecycle: 'downgraded' as const }
  const canonicalRef = value.artifacts.put(canonical)
  const projection = { transition: proposal.canonicalIdentityTransition,
    revisionId: digest({ kind: 'ark.knowledge.canonical-revision', canonicalKnowledgeId: canonical.id,
      proposalHash: value.proposal.digest, targetAfterHash: proposal.targetAfter.digest }),
    canonicalRecordAfter: canonicalRef,
    candidateDisposition: tamper === 'candidate-disposition' ? 'same-id-promoted' : 'absorbed-by-canonical-revision',
    candidateRecordAfter: value.artifacts.put(tamper === 'candidate-record' ? value.semantic.verifiedRecord : currentCandidate),
    newlyCreditedUseIds: ['synthetic-update-use-candidate'] }
  value.journal.append(canonical.id, { type: 'knowledge/promoted', proposal: value.proposal, trial: value.trial, wal, projection }, at)
  const identity = admissionFor(canonical)
  const snapshot = { record: canonicalRef, admissionIdentity: identity, admissionIdentityHash: digest(identity),
    watermark: value.journal.watermark() }
  // These are only isolated fixture setup files. Production projection, promotion and signing are never called.
  for (const tuple of tuples) {
    if (tuple.after === undefined) rmSync(tuple.path)
    else { mkdirSync(dirname(tuple.path), { recursive: true, mode: 0o700 }); writeFileSync(tuple.path, tuple.after, { mode: 0o600 }) }
  }
  const successor = createLearningGraphFixture({ definition: (definition) => { definition['maxArtifacts'] = 10_000 } }, { artifacts: value.artifacts, signers: value.signers, journal: value.journal,
    tag: 'synthetic-successor', timeOffsetMs: 20_000, target: { bytes: after, record: canonical, snapshot },
    allowedDefinitions: value.descriptor.evaluator.allowedDefinitions,
    allowedInitiationCapabilities: value.descriptor.evaluator.allowedInitiationCapabilities,
    sessionContexts: value.sessionContexts })
  return { successor, canonical, currentCandidate, wal }
}

describe('stable canonical identity across a complete historical Replace', { timeout: 120_000 }, () => {
  it('validates the original canonical archive and absorbed candidate before accepting the fresh successor graph', () => {
    const original = createExtendedHistoricalUpdateFixture()
    fixtures.push(original)
    const history = replaceHistory(original)
    expect(history.canonical.id).toBe(original.historicalCanonical.id)
    expect(history.canonical.successfulUses).toBe(2)
    expect(history.currentCandidate).toMatchObject({ verificationStatus: 'rejected', lifecycle: 'downgraded', successfulUses: 0 })
    expect(consume(history.successor)).toMatchObject({ status: 'validated', canonicalKnowledgeId: history.canonical.id,
      candidateKnowledgeId: 'synthetic-successor-candidate', creditCommitted: false, activationAllowed: false })
  })

  it('refuses three-generation ancestry that exceeds the original 5000-artifact definition budget', () => {
    const original = createHistoricalUpdateFixture()
    fixtures.push(original)
    expect(original.historical.definitionPayload['maxArtifacts']).toBe(5000)
    const history = replaceHistory(original)
    expect(consume(history.successor)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
  })

  it.each(['archive-before', 'archive-after', 'candidate-disposition', 'candidate-record'] as const)(
    'rejects a separately sealed historical revision with altered %s', (tamper) => {
      const original = createExtendedHistoricalUpdateFixture()
      fixtures.push(original)
      const history = replaceHistory(original, tamper)
      expect(consume(history.successor)).toEqual({ status: 'invalid', errorCode: 'invalid-learning-graph' })
    },
  )
})
