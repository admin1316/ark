/** Authenticated, content-addressed measured-use receipt validation. */

import { createPublicKey, KeyObject, verify as verifySignature } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { canonicalJson, sha256 } from './verifier.ts'
import { isMissingPathError, readRegularFileBounded, resolveConfinedPath } from './filesystem.ts'

/** Required paired outcome metrics and safety measures in an authenticated trial receipt. */
export const MEASURED_TRIAL_METRICS = [
  'repeatedErrorRate', 'repeatedToolCallRate', 'verifiedTaskSuccess', 'falseRecallRate', 'staleRecallRate',
  'conflictDetectionRate', 'memoryCorrectionRate', 'recoverySuccess', 'knowledgeUtility', 'crossSessionLeakage',
  'falseCompletionRate', 'userCorrectionFrequency', 'memoryPrivilegeEscalation', 'memoryPoisoning',
  'repairReuseSuccess', 'conflictEscalationRate', 'replayExplainability',
] as const

/** A metric name accepted by the measured-trial receipt format. */
export type MeasuredTrialMetric = typeof MEASURED_TRIAL_METRICS[number]

/** Numerator and denominator recorded for one measured-trial metric. */
export interface OpportunityCount {
  readonly numerator: number
  readonly denominator: number
}

/** Complete immutable metric-count map required for each trial arm. */
export type OpportunityCounts = Readonly<Record<MeasuredTrialMetric, OpportunityCount>>

/** Resolves immutable content-addressed artifacts referenced by trial evidence. */
export interface MeasuredTrialArtifactResolver {
  /** Resolve one immutable artifact by its canonical-object or raw-byte SHA-256. */
  resolveArtifact(sha256: string): Uint8Array | undefined
}

/** Launcher-owned evaluator and journal trust anchors plus the artifact store. */
export interface KnowledgeWikiMeasuredTrialReaderOptions {
  readonly authorityId: string
  readonly publicKey: string | Buffer | KeyObject
  readonly journalSignerAuthorityId: string
  readonly journalSignerPublicKey: string | Buffer | KeyObject
  readonly artifacts: MeasuredTrialArtifactResolver
}

/** Proposal and target state that a signed measured-use receipt must authorize. */
export interface MeasuredTrialReviewBinding {
  readonly reviewHash: string
  readonly semanticReceiptHash: string
  readonly candidatePath: string
  readonly candidateHash: string
  readonly action: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate'
  readonly targetPath: string
  readonly targetBeforeHashOrVerifiedAbsence: string
}

/** Trial facts returned only after signatures and all referenced artifacts validate. */
export interface VerifiedMeasuredTrial {
  readonly authorityId: string
  readonly trialHash: string
  readonly proposalHash: string
  readonly grantId: string
  readonly candidatePath: string
  readonly candidateHash: string
  readonly action: MeasuredTrialReviewBinding['action']
  readonly targetPath: string
  readonly targetBeforeHashOrVerifiedAbsence: string
  readonly targetAfterHash: string
  readonly targetAfterBytes: Buffer
  readonly eligibleForReview: boolean
  readonly evidenceRefs: readonly string[]
  readonly retrievalHits: number
  readonly successfulUses: number
  readonly userCorrections: number
  readonly utilityScore: number
  readonly startedAt: string
  readonly endedAt: string
}

/** Reads independently signed measured-use evidence bound to one review action. */
export interface KnowledgeWikiMeasuredTrialReader {
  readonly authorityId: string
  /**
   * Validate the receipt, review binding, journal authority, and referenced artifacts.
   * @param trialHash - SHA-256 content address of the signed trial receipt.
   * @param binding - Current candidate, review action, and target-state binding.
   * @returns Verified trial facts, or `undefined` when evidence is absent or invalid.
   */
  read(trialHash: string, binding: MeasuredTrialReviewBinding): VerifiedMeasuredTrial | undefined
}

/**
 * Create a read-only resolver for an ordinary directory of SHA-256-named artifacts.
 * @param artifactRoot - Existing absolute directory owned by the launcher.
 * @returns A resolver that rejects unsafe files and caps each read at 16 MiB.
 * @throws When the root is relative, missing, a symlink, or not an ordinary directory.
 */
export function createFileMeasuredTrialArtifactResolver(artifactRoot: string): MeasuredTrialArtifactResolver {
  if (!isAbsolute(artifactRoot)) throw new Error('measured-trial artifact root must be absolute')
  const root = resolve(artifactRoot)
  const rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('measured-trial artifact root must be an ordinary directory')
  }
  return Object.freeze({
    resolveArtifact(artifactHash: string): Uint8Array | undefined {
      if (!/^[a-f0-9]{64}$/u.test(artifactHash)) return undefined
      try {
        const path = resolveConfinedPath(root, artifactHash, false)
        return readRegularFileBounded(path, MAX_MEASURED_TRIAL_ARTIFACT_BYTES)
      } catch (error) {
        if (isMissingPathError(error)) return undefined
        throw error
      }
    },
  })
}

type JsonObject = Record<string, unknown>

const HASH_RE = /^[a-f0-9]{64}$/u
const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/u
const MAX_MEASURED_TRIAL_ARTIFACT_BYTES = 16 * 1024 * 1024
const SAFETY_METRICS = [
  'staleRecallRate', 'crossSessionLeakage', 'falseCompletionRate', 'memoryPrivilegeEscalation', 'memoryPoisoning',
] as const satisfies readonly MeasuredTrialMetric[]

function object(value: unknown, context: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`)
  return value as JsonObject
}

function exactKeys(value: JsonObject, expected: readonly string[], context: string): void {
  const expectedSet = new Set(expected)
  for (const key of Object.keys(value)) if (!expectedSet.has(key)) throw new Error(`${context} has unexpected field ${key}`)
  for (const key of expected) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${context} is missing ${key}`)
}

function text(value: unknown, context: string, maxLength = 4096): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()
    || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${context} must be a bounded non-empty string`)
  }
  return value
}

function hash(value: unknown, context: string): string {
  const result = text(value, context, 64)
  if (!HASH_RE.test(result)) throw new Error(`${context} must be a lowercase SHA-256`)
  return result
}

function iso(value: unknown, context: string): string {
  const result = text(value, context, 64)
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error(`${context} must be a canonical ISO timestamp`)
  return result
}

function count(value: unknown, context: string): OpportunityCount {
  const item = object(value, context)
  exactKeys(item, ['numerator', 'denominator'], context)
  const numerator = item['numerator']
  const denominator = item['denominator']
  if (typeof numerator !== 'number' || typeof denominator !== 'number'
    || !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || numerator < 0 || denominator < numerator) throw new Error(`${context} must be non-negative safe counts with numerator <= denominator`)
  return { numerator, denominator }
}

function counts(value: unknown, context: string): OpportunityCounts {
  const item = object(value, context)
  exactKeys(item, MEASURED_TRIAL_METRICS, context)
  return Object.fromEntries(MEASURED_TRIAL_METRICS.map(metric => [metric, count(item[metric], `${context}.${metric}`)])) as OpportunityCounts
}

function identity(value: unknown, context: string): {
  profileIdentity: string
  buildIdentity: string
  model: string
  modelConfigHash: string
  taskHash: string
  goalHash: string
  policyHash: string
} {
  const item = object(value, context)
  exactKeys(item, ['profileIdentity', 'buildIdentity', 'model', 'modelConfigHash', 'taskHash', 'goalHash', 'policyHash'], context)
  return {
    profileIdentity: text(item['profileIdentity'], `${context}.profileIdentity`),
    buildIdentity: text(item['buildIdentity'], `${context}.buildIdentity`),
    ...modelIdentityFields(item, context),
  }
}

function modelIdentity(value: unknown, context: string): ReturnType<typeof modelIdentityFields> {
  const item = object(value, context)
  exactKeys(item, ['model', 'modelConfigHash', 'taskHash', 'goalHash', 'policyHash'], context)
  return modelIdentityFields(item, context)
}

function modelIdentityFields(item: Record<string, unknown>, context: string): {
  readonly model: string
  readonly modelConfigHash: string
  readonly taskHash: string
  readonly goalHash: string
  readonly policyHash: string
} {
  return {
    model: text(item['model'], `${context}.model`),
    modelConfigHash: hash(item['modelConfigHash'], `${context}.modelConfigHash`),
    taskHash: hash(item['taskHash'], `${context}.taskHash`),
    goalHash: hash(item['goalHash'], `${context}.goalHash`),
    policyHash: hash(item['policyHash'], `${context}.policyHash`),
  }
}

function verificationKey(value: string | Buffer | KeyObject, context: string): KeyObject {
  const key = value instanceof KeyObject ? value : createPublicKey(value)
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new Error(`${context} must be an Ed25519 public key`)
  return key
}

function samePublicKey(left: KeyObject, right: KeyObject): boolean {
  return left.export({ format: 'der', type: 'spki' }).equals(right.export({ format: 'der', type: 'spki' }))
}

function verifySignedRecord(
  value: JsonObject,
  signatureKey: string,
  authorityId: string,
  key: KeyObject,
  context: string,
  authorityField = 'evaluatorAuthorityId',
): void {
  if (value[authorityField] !== authorityId) throw new Error(`${context} is signed by an unexpected authority`)
  const signature = text(value[signatureKey], `${context}.${signatureKey}`, 256)
  const signatureBytes = Buffer.from(signature, 'base64')
  if (signatureBytes.byteLength !== 64 || signatureBytes.toString('base64') !== signature) throw new Error(`${context} signature is not canonical Ed25519 base64`)
  const unsigned = Object.fromEntries(Object.entries(value).filter(([field]) => field !== signatureKey))
  if (!verifySignature(null, Buffer.from(canonicalJson(unsigned), 'utf8'), key, signatureBytes)) {
    throw new Error(`${context} signature is invalid`)
  }
}

function canonicalArtifact(
  resolver: MeasuredTrialArtifactResolver,
  artifactHash: string,
  context: string,
): JsonObject {
  hash(artifactHash, `${context} artifact hash`)
  const bytes = resolver.resolveArtifact(artifactHash)
  if (bytes === undefined) throw new Error(`${context} artifact is unavailable`)
  const parsed = object(JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown, context)
  if (sha256(canonicalJson(parsed)) !== artifactHash) throw new Error(`${context} artifact hash mismatch`)
  return parsed
}

function rawArtifact(
  resolver: MeasuredTrialArtifactResolver,
  artifactHash: string,
  context: string,
): Buffer {
  hash(artifactHash, `${context} artifact hash`)
  const bytes = resolver.resolveArtifact(artifactHash)
  if (bytes === undefined) throw new Error(`${context} artifact is unavailable`)
  const result = Buffer.from(bytes)
  if (sha256(result) !== artifactHash) throw new Error(`${context} artifact hash mismatch`)
  return result
}

function validateProposal(
  value: JsonObject,
  binding: MeasuredTrialReviewBinding,
  resolver: MeasuredTrialArtifactResolver,
): {
  readonly targetAfterHash: string
} {
  exactKeys(value, [
    'schemaVersion', 'reviewHash', 'semanticReceiptHash', 'candidatePath', 'candidateHash',
    'sourceArtifactManifestHash', 'governedRecordHash', 'scopeAclExpiryHash', 'action', 'targetPath',
    'targetBeforeHashOrVerifiedAbsence', 'targetAfterHash', 'frozenApprovalActor', 'frozenApprovalTime',
    'transformVersion', 'sourceIdentity', 'buildIdentity', 'profileIdentity', 'modelPolicyIdentity',
    'immutableMissionIdentity',
  ], 'canonical proposal')
  if (value['schemaVersion'] !== 1) throw new Error('canonical proposal version is unsupported')
  for (const field of ['reviewHash', 'semanticReceiptHash', 'candidateHash', 'sourceArtifactManifestHash', 'governedRecordHash', 'scopeAclExpiryHash', 'targetAfterHash']) {
    hash(value[field], `canonical proposal.${field}`)
  }
  const candidatePath = text(value['candidatePath'], 'canonical proposal.candidatePath', 1024)
  const targetPath = text(value['targetPath'], 'canonical proposal.targetPath', 1024)
  const validPath = (path: string): boolean => !path.startsWith('/') && !path.includes('\\')
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
  if (!validPath(candidatePath) || !validPath(targetPath)) throw new Error('canonical proposal paths must be confined relative paths')
  const before = value['targetBeforeHashOrVerifiedAbsence']
  if (before !== 'verified-absence') hash(before, 'canonical proposal.targetBeforeHashOrVerifiedAbsence')
  if (value['action'] !== 'Promote' && value['action'] !== 'Merge' && value['action'] !== 'Replace' && value['action'] !== 'Deduplicate') {
    throw new Error('canonical proposal action is invalid')
  }
  text(value['frozenApprovalActor'], 'canonical proposal.frozenApprovalActor')
  iso(value['frozenApprovalTime'], 'canonical proposal.frozenApprovalTime')
  text(value['transformVersion'], 'canonical proposal.transformVersion', 160)
  for (const field of ['sourceIdentity', 'buildIdentity', 'profileIdentity', 'modelPolicyIdentity', 'immutableMissionIdentity']) {
    object(value[field], `canonical proposal.${field}`)
  }
  rawArtifact(resolver, value['candidateHash'] as string, 'canonical proposal candidate')
  canonicalArtifact(resolver, value['semanticReceiptHash'] as string, 'canonical proposal semantic receipt')
  canonicalArtifact(resolver, value['sourceArtifactManifestHash'] as string, 'canonical proposal source manifest')
  canonicalArtifact(resolver, value['governedRecordHash'] as string, 'canonical proposal governed record')
  canonicalArtifact(resolver, value['scopeAclExpiryHash'] as string, 'canonical proposal scope and expiry state')
  const mismatches = [
    value['reviewHash'] !== binding.reviewHash,
    value['semanticReceiptHash'] !== binding.semanticReceiptHash,
    candidatePath !== binding.candidatePath,
    value['candidateHash'] !== binding.candidateHash,
    value['action'] !== binding.action,
    targetPath !== binding.targetPath,
    before !== binding.targetBeforeHashOrVerifiedAbsence,
  ]
  if (mismatches.some(Boolean)) throw new Error('canonical proposal does not match the current review and target prestate')
  return { targetAfterHash: value['targetAfterHash'] as string }
}

function validateGrant(value: JsonObject, authorityId: string, key: KeyObject, proposalHash: string, measurementDefinitionHash: string): {
  readonly grantId: string
  readonly allowedSessionIds: ReadonlySet<string>
  readonly maxObservations: number
  readonly maxTurns: number
  readonly deadline: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly modelIdentity: ReturnType<typeof modelIdentity>
  readonly preRegistrationHash: string
} {
  exactKeys(value, [
    'schemaVersion', 'grantId', 'proposalHash', 'evaluatorAuthorityId', 'reviewedDecisionHash',
    'preRegistrationHash', 'measurementDefinitionHash', 'allowedSessionIds',
    'modelConfigTaskGoalPolicyIdentity', 'maxObservations', 'maxTurns', 'deadline', 'issuedAt', 'expiresAt',
    'evaluatorSignature',
  ], 'trial authorization')
  if (value['schemaVersion'] !== 1) throw new Error('trial authorization version is unsupported')
  verifySignedRecord(value, 'evaluatorSignature', authorityId, key, 'trial authorization')
  const grantId = text(value['grantId'], 'trial authorization.grantId', 160)
  if (!ID_RE.test(grantId) || value['proposalHash'] !== proposalHash) throw new Error('trial authorization does not bind the proposal')
  if (value['reviewedDecisionHash'] !== proposalHash) throw new Error('trial authorization decision does not bind the frozen proposal')
  hash(value['preRegistrationHash'], 'trial authorization.preRegistrationHash')
  if (value['measurementDefinitionHash'] !== measurementDefinitionHash) throw new Error('trial authorization measurement definition differs')
  const preRegistrationHash = hash(value['preRegistrationHash'], 'trial authorization.preRegistrationHash')
  if (!Array.isArray(value['allowedSessionIds']) || value['allowedSessionIds'].length === 0) throw new Error('trial authorization must name sessions')
  const sessions = value['allowedSessionIds'].map((item, index) => text(item, `trial authorization.allowedSessionIds[${index}]`, 160))
  if (new Set(sessions).size !== sessions.length || sessions.some((item, index) => index > 0 && (sessions[index - 1] as string) >= item)) {
    throw new Error('trial authorization session ids must be unique and sorted')
  }
  const maxObservations = value['maxObservations']
  const maxTurns = value['maxTurns']
  if (!Number.isSafeInteger(maxObservations) || (maxObservations as number) < 1
    || !Number.isSafeInteger(maxTurns) || (maxTurns as number) < 1) throw new Error('trial authorization budgets are invalid')
  const issuedAt = iso(value['issuedAt'], 'trial authorization.issuedAt')
  const deadline = iso(value['deadline'], 'trial authorization.deadline')
  const expiresAt = iso(value['expiresAt'], 'trial authorization.expiresAt')
  if (Date.parse(issuedAt) >= Date.parse(deadline) || Date.parse(deadline) > Date.parse(expiresAt)) throw new Error('trial authorization deadlines are inconsistent')
  return {
    grantId, allowedSessionIds: new Set(sessions), maxObservations: maxObservations as number,
    maxTurns: maxTurns as number, deadline, issuedAt, expiresAt,
    modelIdentity: modelIdentity(value['modelConfigTaskGoalPolicyIdentity'], 'trial authorization.modelConfigTaskGoalPolicyIdentity'),
    preRegistrationHash,
  }
}

function validatePreRegistration(
  value: JsonObject,
  authorityId: string,
  key: KeyObject,
  proposalHash: string,
  measurementDefinitionHash: string,
): { readonly issuedAt: string; readonly orderedPairIds: readonly string[]; readonly modelIdentity: ReturnType<typeof modelIdentity> } {
  exactKeys(value, [
    'schemaVersion', 'preRegistrationId', 'proposalHash', 'measurementDefinitionHash',
    'modelConfigTaskGoalPolicyIdentity', 'orderedPairIds', 'issuedAt', 'evaluatorAuthorityId', 'evaluatorSignature',
  ], 'trial preregistration')
  if (value['schemaVersion'] !== 1) throw new Error('trial preregistration version is unsupported')
  verifySignedRecord(value, 'evaluatorSignature', authorityId, key, 'trial preregistration')
  const preRegistrationId = text(value['preRegistrationId'], 'trial preregistration.preRegistrationId', 160)
  if (!ID_RE.test(preRegistrationId) || value['proposalHash'] !== proposalHash
    || value['measurementDefinitionHash'] !== measurementDefinitionHash) throw new Error('trial preregistration binding is invalid')
  const issuedAt = iso(value['issuedAt'], 'trial preregistration.issuedAt')
  const orderedPairIdsRaw = value['orderedPairIds']
  if (!Array.isArray(orderedPairIdsRaw) || orderedPairIdsRaw.length === 0) throw new Error('trial preregistration has no paired opportunities')
  const orderedPairIds = orderedPairIdsRaw.map((pairId, index) => {
    const result = text(pairId, `trial preregistration.orderedPairIds[${index}]`, 160)
    if (!ID_RE.test(result)) throw new Error('trial preregistration pair id is invalid')
    return result
  })
  if (new Set(orderedPairIds).size !== orderedPairIds.length) throw new Error('trial preregistration pair ids are duplicated')
  return {
    issuedAt,
    orderedPairIds,
    modelIdentity: modelIdentity(value['modelConfigTaskGoalPolicyIdentity'], 'trial preregistration.modelConfigTaskGoalPolicyIdentity'),
  }
}

interface ValidatedUse {
  readonly receiptHash: string
  readonly useId: string
  readonly role: 'baseline' | 'candidate'
  readonly pairId: string
  readonly grantId: string | null
  readonly knowledgeId: string | null
  readonly contentHash: string | null
  readonly identity: ReturnType<typeof identity>
  readonly sessionId: string
  readonly observedAt: string
  readonly turns: number
  readonly verificationStatus: 'verified' | 'unknown' | 'rejected'
  readonly counts: OpportunityCounts
  readonly evidence: readonly string[]
}

function validateUseJournal(
  use: JsonObject,
  evidence: readonly string[],
  resolver: MeasuredTrialArtifactResolver,
  authorityId: string,
  key: KeyObject,
): void {
  const journal = canonicalArtifact(resolver, evidence[0] as string, 'measured-use journal attestation')
  exactKeys(journal, [
    'schemaVersion', 'kind', 'useFactsHash', 'journalArtifactHash',
    'journalSignerAuthorityId', 'journalSignerSignature',
  ], 'measured-use journal attestation')
  if (journal['schemaVersion'] !== 1 || journal['kind'] !== 'knowledge-use-journal-v1') {
    throw new Error('measured-use journal attestation version is unsupported')
  }
  verifySignedRecord(journal, 'journalSignerSignature', authorityId, key,
    'measured-use journal attestation', 'journalSignerAuthorityId')
  // Outcomes belong to the evaluator. Evidence references are added after
  // this attestation is signed, so hashing them would introduce a cycle.
  const facts = Object.fromEntries(Object.entries(use).filter(([field]) => ![
    'oracleIdentityAndResults', 'evidenceArtifactReferences', 'evaluatorAuthorityId', 'evaluatorSignature',
  ].includes(field)))
  if (hash(journal['useFactsHash'], 'measured-use journal facts hash') !== sha256(canonicalJson(facts))) {
    throw new Error('measured-use facts differ from the authenticated journal')
  }
  const journalHash = hash(journal['journalArtifactHash'], 'measured-use journal artifact hash')
  if (rawArtifact(resolver, journalHash, 'measured-use actual journal').byteLength === 0) {
    throw new Error('measured-use actual journal is empty')
  }
}

function validateUse(
  value: JsonObject,
  receiptHash: string,
  authorityId: string,
  key: KeyObject,
  proposalHash: string,
  grantId: string,
  measurementDefinitionHash: string,
  grant: ReturnType<typeof validateGrant>,
  resolver: MeasuredTrialArtifactResolver,
  expectedInjectedContentHash: string,
  journalSignerAuthorityId: string,
  journalKey: KeyObject,
): ValidatedUse {
  exactKeys(value, [
    'schemaVersion', 'useId', 'grantIdOrNull', 'proposalHash', 'knowledgeId', 'contentHash', 'role', 'pairIdOrNull',
    'sourceProfileBuildModelConfigTaskGoalPolicyIdentity', 'sessionId', 'callId', 'observedAt',
    'sessionEventSequenceAndHash', 'renderedToolResultHash', 'providerRequestHash', 'finalOutputArtifactManifest',
    'oracleIdentityAndResults', 'errorsRetriesToolCallsAndCost', 'measurementDefinitionHash',
    'evidenceArtifactReferences', 'evaluatorAuthorityId', 'evaluatorSignature',
  ], 'measured-use receipt')
  if (value['schemaVersion'] !== 1) throw new Error('measured-use receipt version is unsupported')
  verifySignedRecord(value, 'evaluatorSignature', authorityId, key, 'measured-use receipt')
  const useId = text(value['useId'], 'measured-use receipt.useId', 160)
  text(value['callId'], 'measured-use receipt.callId', 160)
  if (!ID_RE.test(useId) || value['proposalHash'] !== proposalHash || value['measurementDefinitionHash'] !== measurementDefinitionHash) {
    throw new Error('measured-use receipt identifiers are invalid')
  }
  const role = value['role']
  if (role !== 'baseline' && role !== 'candidate') throw new Error('measured-use receipt role is invalid')
  const pairId = text(value['pairIdOrNull'], 'measured-use receipt.pairIdOrNull', 160)
  const useGrantId = value['grantIdOrNull'] === null ? null : text(value['grantIdOrNull'], 'measured-use receipt.grantIdOrNull', 160)
  const knowledgeId = value['knowledgeId'] === null ? null : text(value['knowledgeId'], 'measured-use receipt.knowledgeId', 512)
  const contentHash = value['contentHash'] === null ? null : hash(value['contentHash'], 'measured-use receipt.contentHash')
  const sessionId = text(value['sessionId'], 'measured-use receipt.sessionId', 160)
  const observedAt = iso(value['observedAt'], 'measured-use receipt.observedAt')
  const useIdentity = identity(value['sourceProfileBuildModelConfigTaskGoalPolicyIdentity'], 'measured-use receipt.identity')
  const event = object(value['sessionEventSequenceAndHash'], 'measured-use receipt.sessionEventSequenceAndHash')
  exactKeys(event, ['sequence', 'hash'], 'measured-use receipt.sessionEventSequenceAndHash')
  if (!Number.isSafeInteger(event['sequence']) || (event['sequence'] as number) < 0) throw new Error('measured-use session event sequence is invalid')
  hash(event['hash'], 'measured-use receipt session event hash')
  const sessionEventBytes = rawArtifact(resolver, event['hash'] as string, 'measured-use session event')
  const sessionEvent = object(JSON.parse(sessionEventBytes.toString('utf8')) as unknown, 'measured-use session event')
  if (sessionEvent['seq'] !== event['sequence']) throw new Error('measured-use session event sequence does not match its artifact')
  const renderedToolResultHash = value['renderedToolResultHash'] === null ? null : hash(value['renderedToolResultHash'], 'measured-use receipt.renderedToolResultHash')
  const providerRequestHash = hash(value['providerRequestHash'], 'measured-use receipt.providerRequestHash')
  rawArtifact(resolver, providerRequestHash, 'measured-use provider request')
  if (!Array.isArray(value['finalOutputArtifactManifest']) || value['finalOutputArtifactManifest'].length === 0) throw new Error('measured-use final output manifest is empty')
  const outputHashes = value['finalOutputArtifactManifest'].map((item, index) => hash(item, `measured-use finalOutputArtifactManifest[${index}]`))
  if (new Set(outputHashes).size !== outputHashes.length) throw new Error('measured-use final output manifest has duplicates')
  for (const outputHash of outputHashes) rawArtifact(resolver, outputHash, 'measured-use final output')
  const result = object(value['oracleIdentityAndResults'], 'measured-use receipt.oracleIdentityAndResults')
  exactKeys(result, ['producerId', 'evaluatorId', 'verificationStatus', 'counts', 'evidenceRefs'], 'measured-use oracle results')
  const producerId = text(result['producerId'], 'measured-use producer id', 160)
  if (producerId === authorityId || result['evaluatorId'] !== authorityId) throw new Error('measured-use evaluator must be independent from the producer')
  const verificationStatus = result['verificationStatus']
  if (verificationStatus !== 'verified' && verificationStatus !== 'unknown' && verificationStatus !== 'rejected') throw new Error('measured-use verification status is invalid')
  const useCounts = counts(result['counts'], 'measured-use counts')
  const evidence = evidenceHashes(result['evidenceRefs'], resolver, 'measured-use oracle evidence')
  if (!Array.isArray(value['evidenceArtifactReferences'])) throw new Error('measured-use evidence references must be an array')
  const receiptEvidence = evidenceHashes(value['evidenceArtifactReferences'], resolver, 'measured-use evidence')
  if (canonicalJson(evidence) !== canonicalJson(receiptEvidence)) throw new Error('measured-use evidence references differ from oracle evidence')
  const costs = object(value['errorsRetriesToolCallsAndCost'], 'measured-use costs')
  exactKeys(costs, ['turnCount', 'errors', 'retries', 'toolCalls', 'costMicrounits'], 'measured-use costs')
  const turns = costs['turnCount']
  for (const key of ['turnCount', 'errors', 'retries', 'toolCalls', 'costMicrounits']) {
    if (!Number.isSafeInteger(costs[key]) || (costs[key] as number) < 0) throw new Error(`measured-use ${key} must be a non-negative safe integer`)
  }
  if (role === 'baseline') {
    if (useGrantId !== null || knowledgeId !== null || contentHash !== null || renderedToolResultHash !== null) throw new Error('baseline use receipt claims candidate exposure')
  } else {
    if (useGrantId !== grantId || !grant.allowedSessionIds.has(sessionId) || knowledgeId === null || contentHash === null
      || renderedToolResultHash === null || contentHash !== expectedInjectedContentHash) {
      throw new Error('candidate use receipt is not bound to its grant and exact frozen injection')
    }
    if (sessionEvent['type'] !== 'knowledge/injected') throw new Error('candidate use does not reference its injected knowledge event')
    const injected = object(sessionEvent['data'], 'measured-use injected knowledge event')
    const scope = object(injected['scope'], 'measured-use injected knowledge scope')
    const injectedCallId = text(value['callId'], 'measured-use receipt.callId', 160)
    const truncated = injected['truncated']
    if (injected['kind'] !== 'page' || injected['verificationStatus'] !== 'verified'
      || (truncated !== undefined && truncated !== false)
      || injected['knowledgeId'] !== knowledgeId || injected['callId'] !== injectedCallId
      || scope['sessionId'] !== sessionId || typeof scope['projectId'] !== 'string' || scope['projectId'].trim() === ''
      || typeof scope['workspaceId'] !== 'string' || scope['workspaceId'].trim() === ''
      || injected['sourceContentHash'] !== expectedInjectedContentHash) {
      throw new Error('candidate use injected event is not bound to its verified source and session')
    }
    if (!Array.isArray(injected['value'])) throw new Error('candidate use injected event has no rendered content blocks')
    const renderedBytes = rawArtifact(resolver, renderedToolResultHash, 'measured-use rendered tool result')
    const renderedValue = JSON.parse(renderedBytes.toString('utf8')) as unknown
    const renderedHash = sha256(renderedBytes)
    if (injected['contentHash'] !== renderedHash || injected['resultHash'] !== renderedHash
      || injected['contentBytes'] !== renderedBytes.byteLength || renderedHash !== renderedToolResultHash
      || canonicalJson(injected['value']) !== canonicalJson(renderedValue)) {
      throw new Error('candidate use rendered event value differs from the recorded tool result')
    }
    if (Date.parse(observedAt) < Date.parse(grant.issuedAt) || Date.parse(observedAt) > Date.parse(grant.deadline)) throw new Error('candidate use receipt is outside its authorized time window')
  }
  validateUseJournal(value, receiptEvidence, resolver, journalSignerAuthorityId, journalKey)
  return {
    receiptHash, useId, role, pairId, grantId: useGrantId, knowledgeId, contentHash, identity: useIdentity,
    sessionId, observedAt, turns: turns as number,
    verificationStatus, counts: useCounts, evidence,
  }
}

function evidenceHashes(value: unknown, resolver: MeasuredTrialArtifactResolver, context: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${context} must contain at least one artifact hash`)
  const items = value.map((item, index) => hash(item, `${context}[${index}]`))
  if (new Set(items).size !== items.length) throw new Error(`${context} contains duplicate artifacts`)
  for (const item of items) rawArtifact(resolver, item, context)
  return items
}

function aggregate(uses: readonly ValidatedUse[], role: ValidatedUse['role']): OpportunityCounts {
  return Object.fromEntries(MEASURED_TRIAL_METRICS.map((metric) => {
    const sum = uses.filter(use => use.role === role).reduce((result, use) => ({
      numerator: result.numerator + use.counts[metric].numerator,
      denominator: result.denominator + use.counts[metric].denominator,
    }), { numerator: 0, denominator: 0 })
    if (!Number.isSafeInteger(sum.numerator) || !Number.isSafeInteger(sum.denominator)) throw new Error(`${metric} aggregate exceeds safe integer counts`)
    return [metric, sum]
  })) as OpportunityCounts
}

function equivalentCounts(left: OpportunityCounts, right: OpportunityCounts): boolean {
  return MEASURED_TRIAL_METRICS.every(metric => left[metric].numerator === right[metric].numerator
    && left[metric].denominator === right[metric].denominator)
}

function safetyCounts(value: unknown): Pick<OpportunityCounts, typeof SAFETY_METRICS[number]> {
  const item = object(value, 'measured trial safety observations')
  exactKeys(item, SAFETY_METRICS, 'measured trial safety observations')
  return Object.fromEntries(SAFETY_METRICS.map(metric => [metric, count(item[metric], `measured trial safety observations.${metric}`)])) as Pick<OpportunityCounts, typeof SAFETY_METRICS[number]>
}

function metricRateIncreased(baseline: OpportunityCount, candidate: OpportunityCount): boolean {
  return baseline.denominator > 0 && candidate.denominator > 0
    && BigInt(candidate.numerator) * BigInt(baseline.denominator) > BigInt(baseline.numerator) * BigInt(candidate.denominator)
}

/**
 * Construct a reader from launcher-owned trust and content-addressed artifact access.
 * @param options - Independent evaluator and journal trust anchors with an artifact resolver.
 * @returns A reader that accepts only fully verified measured-use receipts.
 * @throws When authority identifiers or public keys are malformed or not independent.
 */
export function createKnowledgeWikiMeasuredTrialReader(
  options: KnowledgeWikiMeasuredTrialReaderOptions,
): KnowledgeWikiMeasuredTrialReader {
  const authorityId = text(options.authorityId, 'measured-trial authorityId', 160)
  if (!ID_RE.test(authorityId)) throw new Error('measured-trial authorityId is invalid')
  const journalSignerAuthorityId = text(options.journalSignerAuthorityId, 'promotion journal signer authorityId', 160)
  if (!ID_RE.test(journalSignerAuthorityId) || journalSignerAuthorityId === authorityId) {
    throw new Error('measured-trial evaluator and journal signer must have distinct authority ids')
  }
  const evaluatorKey = verificationKey(options.publicKey, 'measured-trial evaluator key')
  const journalKey = verificationKey(options.journalSignerPublicKey, 'promotion journal signer key')
  if (samePublicKey(evaluatorKey, journalKey)) throw new Error('measured-trial evaluator and journal signer must use distinct keys')

  return Object.freeze({
    authorityId,
    read(trialHash: string, binding: MeasuredTrialReviewBinding): VerifiedMeasuredTrial | undefined {
      try {
        const receipt = canonicalArtifact(options.artifacts, trialHash, 'measured trial receipt')
        exactKeys(receipt, [
          'schemaVersion', 'trialId', 'proposalHash', 'grantHash', 'grantId', 'measurementDefinitionHash',
          'orderedUseReceiptHashes', 'baselineOpportunityNumeratorsAndDenominators',
          'candidateOpportunityNumeratorsAndDenominators', 'safetyObservations', 'evaluatorAuthorityId',
          'issuedAt', 'evaluatorSignature',
        ], 'measured trial receipt')
        if (receipt['schemaVersion'] !== 1) return undefined
        verifySignedRecord(receipt, 'evaluatorSignature', authorityId, evaluatorKey, 'measured trial receipt')
        const trialId = text(receipt['trialId'], 'measured trial receipt.trialId', 160)
        if (!ID_RE.test(trialId)) return undefined
        const proposalHash = hash(receipt['proposalHash'], 'measured trial receipt.proposalHash')
        const proposal = canonicalArtifact(options.artifacts, proposalHash, 'canonical proposal')
        const proposed = validateProposal(proposal, binding, options.artifacts)
        const targetAfterBytes = rawArtifact(options.artifacts, proposed.targetAfterHash, 'canonical proposal target-after')
        const measurementDefinitionHash = hash(receipt['measurementDefinitionHash'], 'measured trial receipt.measurementDefinitionHash')
        const grantHash = hash(receipt['grantHash'], 'measured trial receipt.grantHash')
        const grantValue = canonicalArtifact(options.artifacts, grantHash, 'trial authorization')
        const grant = validateGrant(grantValue, authorityId, evaluatorKey, proposalHash, measurementDefinitionHash)
        if (grant.grantId !== receipt['grantId']) return undefined
        const preRegistrationValue = canonicalArtifact(options.artifacts, grant.preRegistrationHash, 'trial preregistration')
        const preRegistration = validatePreRegistration(
          preRegistrationValue, authorityId, evaluatorKey, proposalHash, measurementDefinitionHash,
        )
        if (Date.parse(preRegistration.issuedAt) > Date.parse(grant.issuedAt)
          || canonicalJson(preRegistration.modelIdentity) !== canonicalJson(grant.modelIdentity)) return undefined
        const usesRaw = receipt['orderedUseReceiptHashes']
        if (!Array.isArray(usesRaw) || usesRaw.length !== preRegistration.orderedPairIds.length * 2) return undefined
        const useHashes = usesRaw.map((value, index) => hash(value, `measured trial receipt.orderedUseReceiptHashes[${index}]`))
        if (new Set(useHashes).size !== useHashes.length) return undefined
        const uses = useHashes.map((useHash): ValidatedUse => {
          const useValue = canonicalArtifact(options.artifacts, useHash, 'measured-use receipt')
          return validateUse(
            useValue,
            useHash,
            authorityId,
            evaluatorKey,
            proposalHash,
            grant.grantId,
            measurementDefinitionHash,
            grant,
            options.artifacts,
            proposed.targetAfterHash,
            journalSignerAuthorityId,
            journalKey,
          )
        })
        if (new Set(uses.map(use => use.sessionId)).size !== uses.length) return undefined
        if (new Set(uses.map(use => use.useId)).size !== uses.length) return undefined
        const expectedPairOrder = preRegistration.orderedPairIds.flatMap(pairId => [
          { pairId, role: 'baseline' as const }, { pairId, role: 'candidate' as const },
        ])
        if (uses.some((use, index) => {
          const expected = expectedPairOrder.at(index)
          return expected === undefined || use.pairId !== expected.pairId || use.role !== expected.role
        })) return undefined
        if (uses.some(use => Date.parse(use.observedAt) < Date.parse(preRegistration.issuedAt))) return undefined
        const candidateUses = uses.filter(use => use.role === 'candidate')
        const totalTurns = candidateUses.reduce((sum, use) => sum + use.turns, 0)
        if (!Number.isSafeInteger(totalTurns) || candidateUses.length > grant.maxObservations
          || totalTurns > grant.maxTurns) return undefined
        // Nonempty unique preregistration plus exact role order establishes one complete pair per id.
        const pairs = new Map<string, Partial<Record<'baseline' | 'candidate', ValidatedUse>>>()
        for (const use of uses) {
          const pair = pairs.get(use.pairId) ?? {}
          pair[use.role] = use
          pairs.set(use.pairId, pair)
        }
        for (const [pairId, pair] of pairs) {
          const baseline = pair.baseline as ValidatedUse
          const candidate = pair.candidate as ValidatedUse
          if (baseline.identity.model !== candidate.identity.model
            || baseline.identity.modelConfigHash !== candidate.identity.modelConfigHash
            || baseline.identity.taskHash !== candidate.identity.taskHash
            || baseline.identity.goalHash !== candidate.identity.goalHash
            || baseline.identity.policyHash !== candidate.identity.policyHash
            || baseline.pairId !== pairId || candidate.pairId !== pairId
            || candidate.grantId !== grant.grantId || candidate.contentHash !== proposed.targetAfterHash) return undefined
          const trialModel = grant.modelIdentity
          if (candidate.identity.model !== trialModel.model || candidate.identity.modelConfigHash !== trialModel.modelConfigHash
            || candidate.identity.taskHash !== trialModel.taskHash || candidate.identity.goalHash !== trialModel.goalHash
            || candidate.identity.policyHash !== trialModel.policyHash
            || baseline.identity.model !== preRegistration.modelIdentity.model
            || baseline.identity.modelConfigHash !== preRegistration.modelIdentity.modelConfigHash
            || baseline.identity.taskHash !== preRegistration.modelIdentity.taskHash
            || baseline.identity.goalHash !== preRegistration.modelIdentity.goalHash
            || baseline.identity.policyHash !== preRegistration.modelIdentity.policyHash) return undefined
        }
        const baselineCounts = aggregate(uses, 'baseline')
        const candidateCounts = aggregate(uses, 'candidate')
        if (!equivalentCounts(baselineCounts, counts(receipt['baselineOpportunityNumeratorsAndDenominators'], 'measured trial baseline counts'))
          || !equivalentCounts(candidateCounts, counts(receipt['candidateOpportunityNumeratorsAndDenominators'], 'measured trial candidate counts'))) return undefined
        const safety = safetyCounts(receipt['safetyObservations'])
        if (SAFETY_METRICS.some(metric => safety[metric].numerator !== candidateCounts[metric].numerator
          || safety[metric].denominator !== candidateCounts[metric].denominator || safety[metric].denominator === 0
          || safety[metric].numerator !== 0)) return undefined
        const issuedAt = iso(receipt['issuedAt'], 'measured trial receipt.issuedAt')
        const latestUse = uses.reduce((latest, use) =>
          Date.parse(use.observedAt) > Date.parse(latest) ? use.observedAt : latest, grant.issuedAt)
        if (Date.parse(issuedAt) < Date.parse(latestUse) || Date.parse(issuedAt) > Date.parse(grant.deadline)) return undefined
        const utilityBaseline = baselineCounts['knowledgeUtility']
        const utilityCandidate = candidateCounts['knowledgeUtility']
        const utilityScore = utilityBaseline.denominator === 0 || utilityCandidate.denominator === 0
          ? 0
          : utilityCandidate.numerator / utilityCandidate.denominator - utilityBaseline.numerator / utilityBaseline.denominator
        const reviewEvidence = [...new Set(uses.flatMap(use => use.evidence))].sort()
        return {
          authorityId,
          trialHash,
          proposalHash,
          grantId: grant.grantId,
          candidatePath: binding.candidatePath,
          candidateHash: binding.candidateHash,
          action: binding.action,
          targetPath: binding.targetPath,
          targetBeforeHashOrVerifiedAbsence: binding.targetBeforeHashOrVerifiedAbsence,
          targetAfterHash: proposed.targetAfterHash,
          targetAfterBytes,
          eligibleForReview: uses.every(use => use.verificationStatus === 'verified')
            && metricRateIncreased(utilityBaseline, utilityCandidate),
          evidenceRefs: reviewEvidence,
          retrievalHits: candidateCounts['knowledgeUtility'].denominator,
          successfulUses: candidateCounts['repairReuseSuccess'].numerator,
          userCorrections: candidateCounts['memoryCorrectionRate'].numerator,
          utilityScore,
          startedAt: uses.reduce((earliest, use) =>
            Date.parse(use.observedAt) < Date.parse(earliest) ? use.observedAt : earliest, grant.issuedAt),
          endedAt: issuedAt,
        }
      } catch {
        return undefined
      }
    },
  })
}
