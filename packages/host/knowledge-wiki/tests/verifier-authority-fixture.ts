import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  buildVerificationRequest,
  canonicalJson,
  sha256,
  type IndependentVerificationRequest,
  type IndependentVerificationResult,
  type KnowledgeWikiSourceIdentity,
  type KnowledgeWikiVerifierAuthority,
  type KnowledgeWikiPromotionSealRequest,
  type VerificationAuthoritySeal,
  type TrustedVerificationReceipt,
} from '../src/verifier.ts'
import { encodeKnowledgeWikiPromotionSealRequest } from '../src/verifier.ts'
import type { WikiReviewItem } from '../src/types.ts'
import {
  appendKnowledgeEvent, createKnowledgeEvent, createKnowledgeRecord, knowledgeSha256, readKnowledgeEventLog,
} from '../src/knowledge-governance.ts'

const TEST_SECRET = Buffer.from('knowledge-wiki-independent-verifier-fixture-v2')

const TEST_SOURCE_IDENTITY: KnowledgeWikiSourceIdentity = Object.freeze({
  commit: '84ae44c98c94bac19c29cd70516dc10a01af170b',
  sourceDigest: '1'.repeat(64),
  dirty: true,
  dirtyDigest: '2'.repeat(64),
  buildDigest: '3'.repeat(64),
})

type SyncTestVerifierAuthority = Omit<KnowledgeWikiVerifierAuthority, 'sealPromotion'> & {
  sealPromotion(request: KnowledgeWikiPromotionSealRequest): VerificationAuthoritySeal
}

function proof(value: string): string {
  return createHmac('sha256', TEST_SECRET).update(value).digest('hex')
}

function resultPayload(result: IndependentVerificationResult): Omit<IndependentVerificationResult, 'proof'> {
  const { proof: _proof, ...payload } = result
  return payload
}

function makeResult(
  authorityId: string,
  request: IndependentVerificationRequest,
  result: 'pass' | 'fail',
): IndependentVerificationResult {
  const value: Omit<IndependentVerificationResult, 'proof'> = {
    authorityId,
    requestHash: sha256(canonicalJson(request)),
    result,
    methods: ['integration_test'],
    outcomes: [{
      name: 'independent-source-review',
      result,
      evidence: [result === 'pass' ? 'independent verifier accepted exact request bytes' : 'independent verifier rejected'],
    }],
    issuedAt: '2026-09-04T00:00:00.000Z',
  }
  return { ...value, proof: proof(canonicalJson(value)) }
}

/** In-memory independent authority used only by tests; no project-local secret is written. */
export function verifierAuthority(
  result: 'pass' | 'fail' = 'pass',
  crashCheckpoint?: string,
): SyncTestVerifierAuthority {
  const authorityId = 'test-independent-verifier'
  return {
    authorityId,
    sourceIdentity: () => TEST_SOURCE_IDENTITY,
    async verifyCandidate(request, signal) {
      signal.throwIfAborted()
      return makeResult(authorityId, request, result)
    },
    validateCandidateResult(request: IndependentVerificationRequest, value: IndependentVerificationResult): boolean {
      return value.requestHash === sha256(canonicalJson(request))
        && value.proof === proof(canonicalJson(resultPayload(value)))
    },
    sealPromotion(request: KnowledgeWikiPromotionSealRequest): VerificationAuthoritySeal {
      if (request.authorityId !== authorityId) throw new Error('test seal authority context mismatch')
      return { authorityId, proof: proof(encodeKnowledgeWikiPromotionSealRequest(request)) }
    },
    validatePromotion(payload: string, seal: VerificationAuthoritySeal): boolean {
      return seal.authorityId === authorityId && seal.proof === proof(payload)
    },
    ...(crashCheckpoint === undefined ? {} : {
      checkpointPromotion(_payload, checkpoint) {
        const identity = `${checkpoint.phase}:${checkpoint.operationIndex}`
        if (identity === crashCheckpoint) process.kill(process.pid, 'SIGKILL')
      },
    }),
  }
}

/** Synchronously mint one valid external receipt for lower-level transaction tests. */
export function issueTestReceipt(
  authority: KnowledgeWikiVerifierAuthority,
  reviewFile: string,
  wikiRoot: string,
  reviewId: string,
  action: IndependentVerificationRequest['governanceAction'],
): string {
  const items = JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[]
  const item = items.find(value => value.id === reviewId)
  if (item === undefined) throw new Error('test review not found')
  const request = buildVerificationRequest(authority, wikiRoot, item, action)
  if (request === undefined) throw new Error('test verification request invalid')
  const result = makeResult(authority.authorityId, request, 'pass')
  const unsigned = { schemaVersion: 2 as const, request, result }
  const receiptHash = sha256(canonicalJson(unsigned))
  const id = `verification-${receiptHash.slice(0, 32)}`
  const receipt: TrustedVerificationReceipt = { ...unsigned, id, receiptHash }
  const directory = join(dirname(reviewFile), 'verification-receipts')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(receipt, null, 2))
  return id
}

/** Prior authenticated canonical state for boundary tests; not evidence of a real measured trial. */
export function appendVerifiedKnowledgeRecord(
  projectRoot: string,
  path: string,
  content: string,
  authority: ReturnType<typeof verifierAuthority>,
  suffix: string,
  promote = true,
  expiresInMs = 60_000,
) {
  const now = new Date().toISOString()
  const record = createKnowledgeRecord({
    id: `candidate:${suffix}`,
    content,
    source: path,
    sourceHash: knowledgeSha256(path),
    scope: { projectId: projectRoot, visibility: 'project' },
    evidenceRefs: [`receipt:${suffix}`],
    verificationStatus: 'candidate',
    trust: 'low',
    authority: 'untrusted-observation',
    confidence: 0,
    createdAt: now,
    lastVerifiedAt: null,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    lifecycle: 'candidate',
  })
  const eventPath = join(projectRoot, '.llm-wiki', 'knowledge-events.jsonl')
  const append = (type: Parameters<typeof createKnowledgeEvent>[0], payload: Readonly<Record<string, unknown>>) => {
    const prior = readKnowledgeEventLog(eventPath, authority)
    const event = createKnowledgeEvent(type, record.id, record.scope, payload, {
      seq: prior.length,
      previousEventHash: prior.at(-1)?.eventHash ?? null,
    })
    appendKnowledgeEvent(eventPath, event)
    return event
  }
  append('knowledge/observed', { record })
  append('knowledge/candidate', { record })
  const verificationPayload = {
    record,
    trust: 'medium',
    authority: authority.authorityId,
    confidence: 0.9,
    lastVerifiedAt: now,
    evidenceRefs: [`receipt:${suffix}`],
    candidatePath: path,
    candidateHash: knowledgeSha256(content),
    source: path,
  }
  append('knowledge/verified', {
    ...verificationPayload,
    authorityId: authority.authorityId,
    authoritySeal: authority.sealPromotion({
      schemaVersion: 1,
      domain: 'ark.knowledge-wiki',
      authorityId: authority.authorityId,
      operation: 'seal-knowledge-event',
      eventType: 'knowledge/verified',
      knowledgeId: record.id,
      payload: verificationPayload,
    }),
  })
  if (promote) {
    // Model-facing canonical fixtures represent a previously authenticated
    // positive trial; low-level reader validation is covered in review tests.
    const promotionPayload = {
      action: 'Promote', lifecycle: 'canonical', appliedPath: path, candidateHash: knowledgeSha256(content),
      ...testMeasuredTrialPayload(suffix, content, now),
    }
    append('knowledge/promoted', {
      ...promotionPayload,
      authorityId: authority.authorityId,
      authoritySeal: authority.sealPromotion({
        schemaVersion: 1,
        domain: 'ark.knowledge-wiki',
        authorityId: authority.authorityId,
        operation: 'seal-knowledge-event',
        eventType: 'knowledge/promoted',
        knowledgeId: record.id,
        payload: promotionPayload,
      }),
    })
  }
  return record
}

export function testMeasuredTrialPayload(id: string, targetBytes: string, at: string) {
  return {
    trialHash: knowledgeSha256(`test-trial:${id}`),
    proposalHash: knowledgeSha256(`test-proposal:${id}`),
    targetAfterHash: knowledgeSha256(targetBytes),
    measuredTrialAuthorityId: `test-trial-authority:${id}`,
    evidenceRefs: [knowledgeSha256(`test-evidence:${id}`)],
    retrievalHits: 1,
    successfulUses: 1,
    userCorrections: 0,
    utilityScore: 2,
    startedAt: at,
    endedAt: at,
  }
}
