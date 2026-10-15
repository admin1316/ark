/** Typed consumers of the one launch-owned channel; no private keys enter Node. */

import { verify, type KeyObject } from 'node:crypto'
import {
  canonicalJson,
  sha256,
  encodeKnowledgeWikiPromotionSealRequest,
  createFileMeasuredTrialArtifactResolver,
  createKnowledgeWikiMeasuredTrialReader,
  type IndependentVerificationRequest,
  type KnowledgeWikiPromotionSealRequest,
  type IndependentVerificationResult,
  type KnowledgeWikiVerifierAuthority,
  type VerificationAuthoritySeal,
} from '@deepseek-ai/dsh-knowledge-wiki'
import { NativeKnowledgeOwnerChannel, NativeKnowledgeOwnerError } from './native-owner-channel.ts'

/** The existing v1 journal attestation; no caller-selected bytes are accepted. */
export interface NativeKnowledgeUseJournalRequest {
  readonly schemaVersion: 1
  readonly kind: 'knowledge-use-journal-v1'
  readonly useFactsHash: string
  readonly journalArtifactHash: string
  readonly journalSignerAuthorityId: string
}

/** Registered fixed-task references resolved by the protected owner at fixed roots. */
export interface NativeRegisteredFixedTaskRequest {
  readonly schemaVersion: 1
  readonly operation: 'verify-registered-knowledge-task-v1'
  readonly sessionId: string
  readonly sessionSnapshotHash: string
  readonly captureFactsHash: string
  readonly registeredManifestHash: string
  readonly registeredRequestHash: string
  readonly taskKind: 'invoice-v1' | 'single-line-v1' | 'pagination-v1'
  readonly finalOutputHash: string
  readonly capturedProviderRequestHash: string
}

/** The use evaluator accepts immutable references and independently computes the metrics. */
export interface NativeEvaluateCapturedUseRequest extends Omit<NativeRegisteredFixedTaskRequest, 'operation'> {
  readonly operation: 'evaluate-captured-knowledge-use-v1'
  readonly journalAttestationHash: string
  readonly fixedTaskOracleHash: string
  readonly costWitnessHash: string
}

/** Exact existing trial input references; neither grants nor metric counts are accepted. */
export interface NativeFinalizeMeasuredTrialRequest {
  readonly schemaVersion: 1
  readonly operation: 'finalize-knowledge-measured-trial-v1'
  readonly proposalHash: string
  readonly grantHash: string
  readonly preRegistrationHash: string
  readonly measurementDefinitionHash: string
  readonly orderedUseReceiptHashes: readonly string[]
}

/** In-memory adapter observation; only hashes and fixed routing metadata cross the channel. */
export interface NativeProviderRequestObservation {
  readonly sessionId: string
  readonly endpoint: string
  readonly provider: string
  readonly configuredModel: string
  readonly wireModel: string
  readonly requestBodyHash: string
  readonly maxTokens: number | null
  readonly request: unknown
}

/** Every complete captured request is required when resolving settled use cost. */
export interface NativeSettledUseCostRequest {
  readonly schemaVersion: 1
  readonly operation: 'resolve-settled-use-cost-v1'
  readonly sessionId: string
  readonly sessionSnapshotHash: string
  readonly capturedRequestHashes: readonly string[]
}

/** A verified private-owner artifact or an explicit incomplete/ambiguous result. */
export type NativeSettledUseCostResolution =
  | { readonly status: 'verified'; readonly artifactBytesBase64: string; readonly artifactHash: string }
  | { readonly status: 'unknown'; readonly reason: string }

/**
 * Bind immutable provider methods and public identities to one connected owner.
 * @param channel - Authenticated launch channel whose disposer belongs to Native startup.
 * @returns Existing Wiki authority/reader and fixed journal/evaluator consumers of that same owner.
 */
export function createNativeKnowledgeOwnerProviders(channel: NativeKnowledgeOwnerChannel): Readonly<{
  authority: KnowledgeWikiVerifierAuthority
  journalAuthority: Readonly<{
    authorityId: string
    publicKey: KeyObject
    signKnowledgeUseJournal: (request: NativeKnowledgeUseJournalRequest, signal: AbortSignal) => Promise<Uint8Array>
  }>
  measuredUseEvaluator: Readonly<{
    authorityId: string
    verifyRegisteredFixedTask: (request: NativeRegisteredFixedTaskRequest, signal: AbortSignal) => Promise<IndependentVerificationResult>
    evaluateCapturedUse: (request: NativeEvaluateCapturedUseRequest, signal: AbortSignal) => Promise<Uint8Array>
    finalizeMeasuredTrial: (request: NativeFinalizeMeasuredTrialRequest, signal: AbortSignal) => Promise<Uint8Array>
  }>
  measuredTrialReader: ReturnType<typeof createKnowledgeWikiMeasuredTrialReader>
  adapterClient: Readonly<{
    observeProviderRequest: (observation: NativeProviderRequestObservation, signal?: AbortSignal) => Promise<
      { readonly status: 'untracked' } | { readonly status: 'registered'; readonly dispatchId: string }
    >
  }>
  costOwner: Readonly<{
    authorityId: string
    resolveUniqueSettledUse: (request: NativeSettledUseCostRequest, signal: AbortSignal) => Promise<NativeSettledUseCostResolution>
  }>
}> {
  const call = channel.call.bind(channel)
  const identity = channel.identity
  const promotion = identity.authorities.promotion
  const journal = identity.authorities.journal
  const evaluator = identity.authorities.evaluator
  const authority: KnowledgeWikiVerifierAuthority = Object.freeze({
    authorityId: promotion.authorityId,
    sourceIdentity: () => identity.sourceIdentity,
    async verifyCandidate(request: IndependentVerificationRequest, signal: AbortSignal) {
      const result = parseVerificationResult(await call('verifyCandidate', { ...request }, signal))
      if (!verifyResult(promotion.authorityId, promotion.publicKey, request, result)) {
        throw invalidResult('Candidate verification signature or request binding does not match')
      }
      return result
    },
    validateCandidateResult: (request: IndependentVerificationRequest, result: IndependentVerificationResult) =>
      verifyResult(promotion.authorityId, promotion.publicKey, request, result),
    async sealPromotion(request: KnowledgeWikiPromotionSealRequest, signal?: AbortSignal) {
      const payload = encodeKnowledgeWikiPromotionSealRequest(request)
      if (request.authorityId !== promotion.authorityId) throw invalidResult('Promotion authority does not match')
      const result = await call('sealPromotion', { ...request }, signal)
      if (!exactKeys(result, ['authorityId', 'proof']) || typeof result.authorityId !== 'string'
        || typeof result.proof !== 'string') throw invalidResult('Promotion seal is malformed')
      const seal = result as unknown as VerificationAuthoritySeal
      if (!verifySeal(payload, seal)) throw invalidResult('Promotion signature does not match')
      return Object.freeze({ ...seal })
    },
    validatePromotion: verifySeal,
  })
  function verifySeal(payload: string, seal: VerificationAuthoritySeal): boolean {
    return seal.authorityId === promotion.authorityId
      && validSignature(seal.proof) && verify(null, Buffer.from(payload, 'utf8'), promotion.publicKey, Buffer.from(seal.proof, 'base64'))
  }
  const journalAuthority = Object.freeze({
    authorityId: journal.authorityId,
    publicKey: journal.publicKey,
    async signKnowledgeUseJournal(request: NativeKnowledgeUseJournalRequest, signal: AbortSignal): Promise<Uint8Array> {
      const result = await call('signKnowledgeUseJournal', { ...request }, signal)
      if (!exactKeys(result, ['signature']) || typeof result.signature !== 'string' || !validSignature(result.signature)) {
        throw invalidResult('Journal signature is malformed')
      }
      const signature = Buffer.from(result.signature, 'base64')
      if (request.journalSignerAuthorityId !== journal.authorityId
        || !verify(null, Buffer.from(canonicalJson(request), 'utf8'), journal.publicKey, signature)) {
        throw invalidResult('Journal signature does not match')
      }
      return signature
    },
  })
  const measuredUseEvaluator = Object.freeze({
    authorityId: evaluator.authorityId,
    async verifyRegisteredFixedTask(
      request: NativeRegisteredFixedTaskRequest, signal: AbortSignal,
    ): Promise<IndependentVerificationResult> {
      const result = parseVerificationResult(await call('verifyCandidate', { ...request }, signal))
      if (!verifyResultSignature(evaluator.authorityId, evaluator.publicKey, request.registeredRequestHash, result)) {
        throw invalidResult('Fixed task signature or request binding does not match')
      }
      return result
    },
    async evaluateCapturedUse(request: NativeEvaluateCapturedUseRequest, signal: AbortSignal): Promise<Uint8Array> {
      return parseArtifact(await call('evaluateCapturedUse', { ...request }, signal))
    },
    async finalizeMeasuredTrial(request: NativeFinalizeMeasuredTrialRequest, signal: AbortSignal): Promise<Uint8Array> {
      return parseArtifact(await call('finalizeMeasuredTrial', { ...request }, signal))
    },
  })
  const measuredTrialReader = createKnowledgeWikiMeasuredTrialReader({
    authorityId: evaluator.authorityId,
    publicKey: evaluator.publicKey,
    journalSignerAuthorityId: journal.authorityId,
    journalSignerPublicKey: journal.publicKey,
    artifacts: createFileMeasuredTrialArtifactResolver(identity.artifactRoot),
  })
  const adapterClient = Object.freeze({
    async observeProviderRequest(observation: NativeProviderRequestObservation, signal?: AbortSignal): Promise<
      { readonly status: 'untracked' } | { readonly status: 'registered'; readonly dispatchId: string }
    > {
      const { request, ...metadata } = observation
      const result = await call('registerProviderDispatch', {
        schemaVersion: 1, kind: 'adapter', ...metadata, capturedRequestHash: sha256(canonicalJson(request)),
      }, signal)
      if (exactKeys(result, ['status']) && result.status === 'untracked') return { status: 'untracked' }
      if (!exactKeys(result, ['status', 'dispatchId']) || result.status !== 'registered'
        || typeof result.dispatchId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(result.dispatchId)) {
        throw invalidResult('Provider registration response is malformed')
      }
      return Object.freeze({ status: 'registered', dispatchId: result.dispatchId })
    },
  })
  const costOwner = Object.freeze({
    authorityId: evaluator.authorityId,
    async resolveUniqueSettledUse(request: NativeSettledUseCostRequest, signal: AbortSignal): Promise<NativeSettledUseCostResolution> {
      const result = await call('resolveSettledUseCost', { ...request }, signal)
      if (exactKeys(result, ['status', 'reason']) && result.status === 'unknown' && typeof result.reason === 'string') {
        return Object.freeze({ status: 'unknown', reason: result.reason })
      }
      if (!exactKeys(result, ['status', 'artifactBytesBase64', 'artifactHash']) || result.status !== 'verified'
        || typeof result.artifactBytesBase64 !== 'string' || typeof result.artifactHash !== 'string') {
        throw invalidResult('Settled use cost response is malformed')
      }
      const bytes = parseArtifact({ artifactBase64: result.artifactBytesBase64 })
      if (sha256(Buffer.from(bytes)) !== result.artifactHash) throw invalidResult('Cost artifact hash does not match')
      return Object.freeze({ status: 'verified', artifactBytesBase64: result.artifactBytesBase64, artifactHash: result.artifactHash })
    },
  })
  return Object.freeze({ authority, journalAuthority, measuredUseEvaluator, measuredTrialReader, adapterClient, costOwner })
}

function verifyResult(authorityId: string, key: KeyObject, request: unknown, result: IndependentVerificationResult): boolean {
  return verifyResultSignature(authorityId, key, sha256(canonicalJson(request)), result)
}

function verifyResultSignature(authorityId: string, key: KeyObject, requestHash: string, result: IndependentVerificationResult): boolean {
  const { proof, ...unsigned } = result
  return result.authorityId === authorityId && result.requestHash === requestHash
    && validSignature(proof) && verify(null, Buffer.from(canonicalJson(unsigned), 'utf8'), key, Buffer.from(proof, 'base64'))
}

function parseVerificationResult(value: unknown): IndependentVerificationResult {
  if (!exactKeys(value, ['authorityId', 'requestHash', 'result', 'methods', 'outcomes', 'issuedAt', 'proof'])
    || typeof value.authorityId !== 'string' || typeof value.requestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.requestHash)
    || (value.result !== 'pass' && value.result !== 'fail')
    || !Array.isArray(value.methods) || value.methods.length === 0
    || !value.methods.every(method => ['unit_test', 'integration_test', 'production_observation', 'manual_review'].includes(method as string))
    || !Array.isArray(value.outcomes) || value.outcomes.length === 0
    || !value.outcomes.every(outcome => exactKeys(outcome, ['name', 'result', 'evidence'])
      && typeof outcome.name === 'string' && (outcome.result === 'pass' || outcome.result === 'fail')
      && Array.isArray(outcome.evidence) && outcome.evidence.every(item => typeof item === 'string'))
    || typeof value.issuedAt !== 'string' || !Number.isFinite(Date.parse(value.issuedAt))
    || typeof value.proof !== 'string' || !validSignature(value.proof)) throw invalidResult('Verifier response is malformed')
  return value as unknown as IndependentVerificationResult
}

function parseArtifact(value: unknown): Uint8Array {
  if (!exactKeys(value, ['artifactBase64']) || typeof value.artifactBase64 !== 'string') throw invalidResult('Receipt response is malformed')
  const bytes = Buffer.from(value.artifactBase64, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== value.artifactBase64) throw invalidResult('Receipt encoding is malformed')
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (!Buffer.from(canonicalJson(parsed), 'utf8').equals(bytes)) throw invalidResult('Receipt must be canonical UTF-8 JSON')
  return bytes
}

function validSignature(proof: string): boolean {
  return /^[A-Za-z0-9+/]{86}==$/u.test(proof) && Buffer.from(proof, 'base64').toString('base64') === proof
}

function exactKeys(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}

function invalidResult(message: string): NativeKnowledgeOwnerError {
  return new NativeKnowledgeOwnerError('invalid-result', message)
}
