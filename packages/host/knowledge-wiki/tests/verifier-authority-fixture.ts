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
  type VerificationAuthoritySeal,
  type TrustedVerificationReceipt,
} from '../src/verifier.ts'
import type { WikiReviewItem } from '../src/types.ts'

const TEST_SECRET = Buffer.from('knowledge-wiki-independent-verifier-fixture-v2')

const TEST_SOURCE_IDENTITY: KnowledgeWikiSourceIdentity = Object.freeze({
  commit: '84ae44c98c94bac19c29cd70516dc10a01af170b',
  sourceDigest: '1'.repeat(64),
  dirty: true,
  dirtyDigest: '2'.repeat(64),
  buildDigest: '3'.repeat(64),
})

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
): KnowledgeWikiVerifierAuthority {
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
    sealPromotion(payload: string): VerificationAuthoritySeal {
      return { authorityId, proof: proof(payload) }
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
