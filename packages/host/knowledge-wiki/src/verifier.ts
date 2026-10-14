/** Independent Candidate verification contract and receipt validation. */

import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { atomicWriteFile, readRegularFileBounded } from './filesystem.ts'
import { readReviewStore } from './review-store.ts'
import { validateKnowledgeRecord } from './knowledge-governance.ts'
import { decideCandidateGovernance, governancePolicyVersion, resolveGovernedWikiPath } from './governance-policy.ts'
import type { CandidateVerification, CandidateVerificationResult, VerificationReceiptReference, WikiReviewItem } from './types.ts'

export type { CandidateVerificationResult } from './types.ts'

const RECEIPT_SCHEMA = 2
const SHA256_RE = /^[0-9a-f]{64}$/u
const COMMIT_RE = /^[0-9a-f]{40}$/u
const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/u
const VERIFICATION_METHODS = new Set<CandidateVerification['methods'][number]>([
  'unit_test',
  'integration_test',
  'production_observation',
  'manual_review',
])

/** Full source identity supplied by the trusted launcher/build owner. */
export interface KnowledgeWikiSourceIdentity {
  readonly commit: string
  readonly sourceDigest: string
  readonly dirty: boolean
  readonly dirtyDigest: string
  readonly buildDigest: string
}

/** One independently executed check. */
export interface IndependentVerificationOutcome {
  readonly name: string
  readonly result: 'pass' | 'fail'
  readonly evidence: string[]
}

/** Immutable request given to the independent verifier. */
export interface IndependentVerificationRequest {
  readonly schemaVersion: 2
  readonly review: Readonly<Record<string, unknown>>
  readonly reviewHash: string
  readonly candidatePath: string
  readonly candidateHash: string
  readonly sourceHash: string
  readonly targetPath: string | null
  readonly governanceAction: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' | 'Archive'
  readonly governanceDecision: {
    readonly action: string
    readonly targetPath: string | null
    readonly policyVersion: string
  }
  readonly sourceIdentity: KnowledgeWikiSourceIdentity
  readonly environment: {
    readonly nodeVersion: string
    readonly platform: string
    readonly arch: string
    readonly policyVersion: string
  }
}

/** Result and opaque proof produced by an actual independent verifier owner. */
export interface IndependentVerificationResult {
  readonly authorityId: string
  readonly requestHash: string
  readonly result: 'pass' | 'fail'
  readonly methods: CandidateVerification['methods']
  readonly outcomes: IndependentVerificationOutcome[]
  readonly issuedAt: string
  readonly proof: string
}

/** Authentication attached to a promotion WAL by the same external authority. */
export interface VerificationAuthoritySeal {
  readonly authorityId: string
  readonly proof: string
}

/** A JSON-only operation row carried by the promotion WAL signer. */
export interface PromotionOperationSigningPayload {
  readonly role: 'candidate' | 'candidate-archive' | 'canonical' | 'canonical-archive' | 'review' | 'governance'
  readonly path: string
  readonly before?: string
  readonly after?: string
  readonly stagingPath?: string
  readonly tombstonePath?: string
}

/** The exact existing WAL core shape; it does not include state or seal. */
export interface PromotionJournalSigningPayload {
  readonly schemaVersion: 1
  readonly id: string
  readonly reviewId: string
  readonly candidateHash: string
  readonly createdAt: string
  readonly action: string
  readonly targetPath: string | null
  readonly reviewHash: string | null
  readonly receiptId: string | null
  readonly receiptHash: string | null
  readonly measuredTrial?: {
    readonly trialHash: string
    readonly authorityId: string
    readonly proposalHash: string
    readonly targetAfterHash: string
    readonly evidenceRefs: readonly string[]
    readonly retrievalHits: number
    readonly successfulUses: number
    readonly userCorrections: number
    readonly utilityScore: number
    readonly startedAt: string
    readonly endedAt: string
  } | null
  readonly operationSetHash: string
  readonly operations: readonly PromotionOperationSigningPayload[]
}

/** Closed source-only request vocabulary for signing the three existing domains. */
export type KnowledgeWikiPromotionSealRequest = {
  readonly schemaVersion: 1
  readonly domain: 'ark.knowledge-wiki'
  readonly authorityId: string
} & (
  | {
    readonly operation: 'seal-knowledge-event'
    readonly eventType: 'knowledge/verified' | 'knowledge/promoted'
    readonly knowledgeId: string
    readonly payload: Readonly<Record<string, unknown>>
  }
  | {
    readonly operation: 'seal-promotion-wal'
    readonly journal: PromotionJournalSigningPayload
  }
)

/**
 * Recreate only the legacy canonical byte payloads accepted by persisted event/WAL readers.
 * The request wrapper is never serialized or signed.
 * @param request - Closed operation request whose payload is validated before encoding.
 * @returns The legacy canonical payload bytes represented as a UTF-8 string.
 * @throws If the request does not match a supported schema, domain, authority, or payload.
 */
export function encodeKnowledgeWikiPromotionSealRequest(request: KnowledgeWikiPromotionSealRequest): string {
  assertSealRequest(request)
  if (request.operation === 'seal-knowledge-event') {
    return canonicalJson({ type: request.eventType, knowledgeId: request.knowledgeId, payload: request.payload })
  }
  return canonicalJson(request.journal)
}

const EVENT_VERIFIED_FIELDS = new Set([
  'record', 'verificationStatus', 'trust', 'authority', 'confidence', 'lastVerifiedAt', 'evidenceRefs',
  'candidatePath', 'candidateHash', 'source',
])
const EVENT_PROMOTED_FIELDS = new Set([
  'action', 'appliedPath', 'lifecycle', 'candidateHash', 'trialHash', 'proposalHash', 'targetAfterHash',
  'measuredTrialAuthorityId', 'evidenceRefs', 'retrievalHits', 'successfulUses', 'userCorrections',
  'utilityScore', 'startedAt', 'endedAt',
])

function exactRecord(value: unknown, expected: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string')) return false
  const allowed = new Set([...expected, ...optional])
  return expected.every(key => Object.hasOwn(value, key))
    && keys.length <= allowed.size
    && keys.every(key => typeof key === 'string' && allowed.has(key)
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
      && Object.getOwnPropertyDescriptor(value, key)?.set === undefined)
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  let valid = false
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value)
    valid = keys.length === value.length + 1
      && keys.every(key => key === 'length' || (typeof key === 'string' && /^(0|[1-9][0-9]*)$/u.test(key)
        && Number(key) < value.length && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
        && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
        && Object.getOwnPropertyDescriptor(value, key)?.set === undefined))
      && value.every(item => isJsonValue(item, seen))
  } else if (exactRecord(value, [], Reflect.ownKeys(value).filter((key): key is string => typeof key === 'string'))) {
    valid = Object.values(value).every(item => isJsonValue(item, seen))
  }
  seen.delete(value)
  return valid
}

function assertSealRequest(value: unknown): asserts value is KnowledgeWikiPromotionSealRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('promotion seal request is invalid')
  const prototype: unknown = Object.getPrototypeOf(value)
  const requestKeys = Reflect.ownKeys(value)
  if ((prototype !== Object.prototype && prototype !== null)
    || requestKeys.some(key => typeof key !== 'string'
      || Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true
      || Object.getOwnPropertyDescriptor(value, key)?.get !== undefined
      || Object.getOwnPropertyDescriptor(value, key)?.set !== undefined)) {
    throw new Error('promotion seal request must contain only plain data fields')
  }
  const operation: unknown = Object.getOwnPropertyDescriptor(value, 'operation')?.value
  const common = ['schemaVersion', 'domain', 'authorityId', 'operation']
  if (operation === 'seal-knowledge-event') {
    if (!exactRecord(value, [...common, 'eventType', 'knowledgeId', 'payload'])
      || value.schemaVersion !== 1 || value.domain !== 'ark.knowledge-wiki'
      || typeof value.authorityId !== 'string' || value.authorityId.length === 0
      || (value.eventType !== 'knowledge/verified' && value.eventType !== 'knowledge/promoted')
      || typeof value.knowledgeId !== 'string' || !/^candidate:[A-Za-z0-9._:-]{1,160}$/u.test(value.knowledgeId)
      || !exactRecord(value.payload, [], [...(value.eventType === 'knowledge/verified' ? EVENT_VERIFIED_FIELDS : EVENT_PROMOTED_FIELDS)])
      || !isJsonValue(value.payload)) throw new Error('promotion knowledge-event seal request is invalid')
    if (value.eventType === 'knowledge/verified'
      && (typeof value.payload.candidateHash !== 'string' || !/^[0-9a-f]{64}$/u.test(value.payload.candidateHash)
        || typeof value.payload.candidatePath !== 'string' || value.payload.candidatePath.trim() === ''
        || typeof value.payload.source !== 'string' || value.payload.source.trim() === ''
        || !Array.isArray(value.payload.evidenceRefs) || !value.payload.evidenceRefs.every(item => typeof item === 'string')
        || typeof value.payload.trust !== 'string'
        || !['low', 'medium', 'high'].includes(value.payload.trust)
        || value.payload.authority !== value.authorityId
        || typeof value.payload.confidence !== 'number' || !Number.isFinite(value.payload.confidence)
        || value.payload.confidence < 0 || value.payload.confidence > 1
        || typeof value.payload.lastVerifiedAt !== 'string' || !validCanonicalIso(value.payload.lastVerifiedAt)
        || value.payload.record === undefined || !validKnowledgeRecordSigningPayload(value.payload.record, value.knowledgeId))) {
      throw new Error('promotion knowledge/verified payload schema is invalid')
    }
    if (value.eventType === 'knowledge/promoted'
      && (typeof value.payload.action !== 'string' || typeof value.payload.lifecycle !== 'string'
        || !['Promote', 'Merge', 'Replace', 'Deduplicate', 'Archive'].includes(value.payload.action)
        || !['canonical', 'downgraded'].includes(value.payload.lifecycle)
        || typeof value.payload.candidateHash !== 'string' || !/^[0-9a-f]{64}$/u.test(value.payload.candidateHash)
        || typeof value.payload.appliedPath !== 'string' || value.payload.appliedPath.trim() === '')) {
      throw new Error('promotion knowledge/promoted payload schema is invalid')
    }
    if (value.eventType === 'knowledge/promoted' && value.payload.trialHash !== undefined
      && !validMeasuredTrialEventPayload(value.payload)) throw new Error('promotion measured-trial event payload schema is invalid')
    return
  }
  if (operation === 'seal-promotion-wal') {
    if (!exactRecord(value, [...common, 'journal']) || value.schemaVersion !== 1
      || value.domain !== 'ark.knowledge-wiki' || typeof value.authorityId !== 'string' || value.authorityId.length === 0
      || !validPromotionJournalSigningPayload(value.journal)) throw new Error('promotion WAL seal request is invalid')
    return
  }
  throw new Error('promotion seal operation is unknown')
}

function validPromotionJournalSigningPayload(value: unknown): value is PromotionJournalSigningPayload {
  if (!exactRecord(value,
    ['schemaVersion', 'id', 'reviewId', 'candidateHash', 'createdAt', 'action', 'targetPath', 'reviewHash',
      'receiptId', 'receiptHash', 'operationSetHash', 'operations'], ['measuredTrial'])
    || value.schemaVersion !== 1 || typeof value.id !== 'string' || !/^promotion-[0-9a-f]{24}$/u.test(value.id)
    || typeof value.reviewId !== 'string' || !ID_RE.test(value.reviewId)
    || typeof value.candidateHash !== 'string' || !SHA256_RE.test(value.candidateHash)
    || typeof value.createdAt !== 'string' || !validCanonicalIso(value.createdAt)
    || typeof value.action !== 'string' || !['Promote', 'Merge', 'Replace', 'Deduplicate', 'Archive'].includes(value.action)
    || !(value.targetPath === null || typeof value.targetPath === 'string')
    || !(value.reviewHash === null || typeof value.reviewHash === 'string')
    || !(value.receiptId === null || typeof value.receiptId === 'string')
    || !(value.receiptHash === null || typeof value.receiptHash === 'string')
    || typeof value.operationSetHash !== 'string' || !SHA256_RE.test(value.operationSetHash)
    || !Array.isArray(value.operations) || value.operations.length === 0
    || !value.operations.every(validPromotionOperationSigningPayload)) return false
  if (Object.hasOwn(value, 'measuredTrial') && value.measuredTrial !== null && !validMeasuredTrialSigningPayload(value.measuredTrial)) return false
  if ((value.receiptId === null) !== (value.receiptHash === null)
    || (value.receiptHash !== null && !SHA256_RE.test(value.receiptHash))
    || (value.reviewHash !== null && !SHA256_RE.test(value.reviewHash))) return false
  return value.operationSetHash === sha256(canonicalJson(value.operations)) && isJsonValue(value)
}

function validPromotionOperationSigningPayload(value: unknown): value is PromotionOperationSigningPayload {
  if (!exactRecord(value, ['role', 'path'], ['before', 'after', 'stagingPath', 'tombstonePath'])
    || typeof value.role !== 'string'
    || !['candidate', 'candidate-archive', 'canonical', 'canonical-archive', 'review', 'governance'].includes(value.role)
    || typeof value.path !== 'string' || value.path.trim() === '') return false
  if (!['before', 'after', 'stagingPath', 'tombstonePath'].every(key => value[key] === undefined || typeof value[key] === 'string')) return false
  return value.after === undefined
    ? typeof value.tombstonePath === 'string' && value.stagingPath === undefined
    : typeof value.stagingPath === 'string' && value.tombstonePath === undefined
}

function validMeasuredTrialSigningPayload(value: unknown): boolean {
  return exactRecord(value,
    ['trialHash', 'authorityId', 'proposalHash', 'targetAfterHash', 'evidenceRefs', 'retrievalHits', 'successfulUses',
      'userCorrections', 'utilityScore', 'startedAt', 'endedAt'])
    && ['trialHash', 'authorityId', 'proposalHash', 'targetAfterHash', 'startedAt', 'endedAt']
      .every(key => typeof value[key] === 'string')
    && Array.isArray(value.evidenceRefs) && value.evidenceRefs.every(item => typeof item === 'string')
    && ['retrievalHits', 'successfulUses', 'userCorrections', 'utilityScore'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))
    && ['trialHash', 'proposalHash', 'targetAfterHash'].every(key => typeof value[key] === 'string' && SHA256_RE.test(value[key]))
    && typeof value.authorityId === 'string' && value.authorityId.length > 0
    && value.evidenceRefs.every(reference => SHA256_RE.test(reference))
    && ['retrievalHits', 'successfulUses', 'userCorrections'].every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
    && (value.retrievalHits as number) > 0 && (value.utilityScore as number) > 0
    && validCanonicalIso(value.startedAt as string) && validCanonicalIso(value.endedAt as string)
    && Date.parse(value.endedAt as string) >= Date.parse(value.startedAt as string)
}

function validMeasuredTrialEventPayload(value: Record<string, unknown>): boolean {
  return typeof value.trialHash === 'string' && SHA256_RE.test(value.trialHash)
    && typeof value.proposalHash === 'string' && SHA256_RE.test(value.proposalHash)
    && typeof value.targetAfterHash === 'string' && SHA256_RE.test(value.targetAfterHash)
    && typeof value.measuredTrialAuthorityId === 'string' && value.measuredTrialAuthorityId.length > 0
    && Array.isArray(value.evidenceRefs) && value.evidenceRefs.every(item => typeof item === 'string')
    && ['retrievalHits', 'successfulUses', 'userCorrections', 'utilityScore']
      .every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))
    && value.evidenceRefs.every(item => SHA256_RE.test(item))
    && ['retrievalHits', 'successfulUses', 'userCorrections'].every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
    && (value.retrievalHits as number) > 0 && (value.utilityScore as number) > 0
    && typeof value.startedAt === 'string' && validCanonicalIso(value.startedAt)
    && typeof value.endedAt === 'string' && validCanonicalIso(value.endedAt)
    && Date.parse(value.endedAt) >= Date.parse(value.startedAt)
}

function validCanonicalIso(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function validKnowledgeRecordSigningPayload(value: unknown, knowledgeId: string): boolean {
  if (!exactRecord(value,
    ['id', 'content', 'source', 'sourceHash', 'scope', 'trust', 'authority', 'evidenceRefs', 'verificationStatus',
      'confidence', 'createdAt', 'lastVerifiedAt', 'expiresAt', 'conflicts', 'retrievalHits', 'successfulUses',
      'userCorrections', 'utilityScore'], ['claimKey', 'acl', 'lifecycle'])
    || value.id !== knowledgeId || !exactRecord(value.scope, [], ['projectId', 'workspaceId', 'sessionId', 'visibility'])
    || Object.values(value.scope).some(item => typeof item !== 'string')
    || (!exactRecord(value.acl, [], ['readers', 'writers']) && value.acl !== undefined)) return false
  if (value.lifecycle !== undefined && (typeof value.lifecycle !== 'string'
    || !['candidate', 'canonical', 'downgraded', 'rolled_back'].some(lifecycle => lifecycle === value.lifecycle))) return false
  return validateKnowledgeRecord(value).ok
}

/** Synchronous audit/crash-consistency position reported by a promotion transaction. */
export interface PromotionCheckpoint {
  /** Persisted-journal, per-operation, or pre-commit position at which the authority is called. */
  readonly phase:
    | 'journal-persisted'
    | 'stage-written'
    | 'entry-renamed'
    | 'tombstone-unlinked'
    | 'operation-applied'
    | 'before-commit-marker'
  /** Zero-based operation index; -1 after journal persistence, operation count before the commit marker. */
  readonly operationIndex: number
}

/**
 * Injected authority. Secrets and execution live outside project-writable Wiki
 * content; this package only asks it to run/validate and to authenticate WAL bytes.
 */
export interface KnowledgeWikiVerifierAuthority {
  readonly authorityId: string
  sourceIdentity(): KnowledgeWikiSourceIdentity
  verifyCandidate(request: IndependentVerificationRequest, signal: AbortSignal): Promise<IndependentVerificationResult>
  validateCandidateResult(
    request: IndependentVerificationRequest,
    result: IndependentVerificationResult,
  ): boolean
  /**
   * Sign one closed promotion operation.
   * @param request - Typed event or promotion-WAL request with its existing canonical payload.
   * @param signal - Optional cooperative cancellation; an owner must terminate and join owned work before settling.
   * @returns The authority seal, synchronously or after owned asynchronous work settles.
   * @throws On cancellation, refusal, or signing failure. An owner that ignores the signal may remain pending.
   */
  sealPromotion(
    request: KnowledgeWikiPromotionSealRequest,
    signal?: AbortSignal,
  ): VerificationAuthoritySeal | Promise<VerificationAuthoritySeal>
  validatePromotion(payload: string, seal: VerificationAuthoritySeal): boolean
  /** Optional external audit/crash-consistency checkpoint. */
  checkpointPromotion?(payload: string, checkpoint: PromotionCheckpoint): void
}

/** Receipt copy persisted in the project; authority proof remains externally verifiable. */
export interface TrustedVerificationReceipt {
  readonly schemaVersion: 2
  readonly id: string
  readonly request: IndependentVerificationRequest
  readonly result: IndependentVerificationResult
  readonly receiptHash: string
}

/**
 * Canonical JSON used for every hash and authority call.
 * @param value - Acyclic JSON data; undefined object properties are omitted.
 * @returns JSON text with sorted object keys and the original array order.
 * @throws If the value contains a cycle or a primitive JSON cannot serialize, such as bigint.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .filter(key => object[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

/**
 * Hash receipt, review, or Candidate bytes for identity comparisons.
 * @param value - UTF-8 text or the exact bytes to hash.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Immutable Review proposal fields; mutable resolution/verification mirrors are excluded.
 * @param item - Review whose proposal fields are bound into a verification request.
 * @returns Frozen proposal with copied, frozen arrays, explicit nulls, and resolved fixed to false.
 */
export function immutableReviewRow(item: WikiReviewItem): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: item.id,
    title: item.title,
    type: item.type,
    description: item.description ?? null,
    sourcePath: item.sourcePath ?? null,
    affectedPages: Object.freeze([...(item.affectedPages ?? [])]),
    resolved: false,
    createdAt: item.createdAt ?? null,
    searchQueries: Object.freeze([...(item.searchQueries ?? [])]),
    reviewKind: item.reviewKind ?? null,
    candidatePath: item.candidatePath ?? null,
    candidateHash: item.candidateHash ?? null,
    ...(item.sourceHash === undefined ? {} : { sourceHash: item.sourceHash }),
    targetPath: item.targetPath ?? null,
  })
}

function validSourceIdentity(value: KnowledgeWikiSourceIdentity): boolean {
  return COMMIT_RE.test(value.commit)
    && SHA256_RE.test(value.sourceDigest)
    && SHA256_RE.test(value.dirtyDigest)
    && SHA256_RE.test(value.buildDigest)
    && typeof value.dirty === 'boolean'
}

function environment(): IndependentVerificationRequest['environment'] {
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    policyVersion: governancePolicyVersion(),
  }
}

function receiptDirectory(reviewFile: string): string {
  return join(dirname(reviewFile), 'verification-receipts')
}

function isReviewItem(value: unknown): value is WikiReviewItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return typeof Reflect.get(value, 'id') === 'string'
    && typeof Reflect.get(value, 'resolved') === 'boolean'
    && typeof Reflect.get(value, 'title') === 'string'
}

function loadReview(reviewFile: string, reviewId: string): WikiReviewItem | undefined {
  const bytes = readReviewStore(reviewFile)
  if (bytes === undefined) return undefined
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (!Array.isArray(parsed) || !parsed.every(isReviewItem)) throw new Error('invalid review state')
  return parsed.find(item => item.id === reviewId)
}

function actionIsCompatible(
  action: IndependentVerificationRequest['governanceAction'],
  targetPath: string | undefined,
  targetExists: boolean,
): boolean {
  if (action === 'Archive') return true
  if (targetPath === undefined) return false
  return action === 'Promote' ? !targetExists : targetExists
}

type CandidateSourceReview = WikiReviewItem & { readonly candidatePath: string }

function sourceHashForReview(wikiRoot: string, item: CandidateSourceReview): string {
  const source = item.sourcePath ?? item.candidatePath
  const projectRoot = resolve(dirname(wikiRoot))
  const absolute = resolve(projectRoot, source)
  const rel = relative(projectRoot, absolute)
  try {
    const stat = lstatSync(absolute)
    if (source !== '' && rel !== '' && !rel.startsWith(`..${sep}`) && !rel.includes(`${sep}..${sep}`)
      && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
      return sha256(readRegularFileBounded(absolute, 100 * 1024 * 1024))
    }
  } catch {
    // URL, virtual research label, or missing source: bind the stable label.
  }
  return sha256(source)
}

/**
 * Construct the exact request; the external authority, never Candidate text, decides pass/fail.
 * @param authority - Trusted owner supplying the source/build identity; no verification is run here.
 * @param wikiRoot - Wiki root used to resolve the Candidate and optional canonical target.
 * @param item - Unresolved Candidate review supplying proposal fields and the expected Candidate content hash.
 * @param action - Requested action, checked against target presence and bound into the request.
 * @returns Frozen request, or undefined for an ineligible review, invalid Candidate/target, or incompatible action.
 * @throws On invalid trusted source identity or uncaught filesystem/read failures.
 */
export function buildVerificationRequest(
  authority: KnowledgeWikiVerifierAuthority,
  wikiRoot: string,
  item: WikiReviewItem,
  action: IndependentVerificationRequest['governanceAction'],
): IndependentVerificationRequest | undefined {
  if (item.reviewKind !== 'candidate' || item.resolved || !item.candidatePath || !item.candidateHash) return undefined
  const candidateSourceItem: CandidateSourceReview = { ...item, candidatePath: item.candidatePath }
  const candidate = resolveGovernedWikiPath(wikiRoot, item.candidatePath, false)
  if (candidate === undefined || !candidate.relativePath.startsWith('_candidates/')) return undefined
  const stat = lstatSync(candidate.absolutePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return undefined
  const content = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString('utf8')
  if (sha256(content) !== item.candidateHash) return undefined

  const target = item.targetPath === undefined
    ? undefined
    : resolveGovernedWikiPath(wikiRoot, item.targetPath, true)
  if (item.targetPath !== undefined && target === undefined) return undefined
  if (item.sourceHash !== undefined && item.sourceHash !== sourceHashForReview(wikiRoot, candidateSourceItem)) return undefined
  let targetExists = false
  if (target !== undefined) {
    try {
      const targetStat = lstatSync(target.absolutePath)
      if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) return undefined
      targetExists = true
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT')) throw error
    }
  }
  if (!actionIsCompatible(action, item.targetPath, targetExists)) return undefined

  const sourceIdentity = authority.sourceIdentity()
  if (!validSourceIdentity(sourceIdentity)) throw new Error('invalid trusted source identity')
  const review = immutableReviewRow(item)
  const governance = decideCandidateGovernance(wikiRoot, item.candidatePath, content, item.targetPath)
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    review,
    reviewHash: sha256(canonicalJson(review)),
    candidatePath: item.candidatePath,
    candidateHash: item.candidateHash,
    sourceHash: item.sourceHash ?? sha256(item.sourcePath ?? item.candidatePath),
    targetPath: item.targetPath ?? null,
    governanceAction: action,
    governanceDecision: Object.freeze({
      action: governance.action,
      targetPath: governance.targetPath ?? null,
      policyVersion: governancePolicyVersion(),
    }),
    sourceIdentity: Object.freeze({ ...sourceIdentity }),
    environment: Object.freeze(environment()),
  })
}

function resultIsCoherent(
  authority: KnowledgeWikiVerifierAuthority,
  request: IndependentVerificationRequest,
  result: IndependentVerificationResult,
): boolean {
  if (result.authorityId !== authority.authorityId || !ID_RE.test(result.authorityId)) return false
  if (result.requestHash !== sha256(canonicalJson(request)) || !SHA256_RE.test(result.requestHash)) return false
  const methods: readonly unknown[] = result.methods
  if (!Array.isArray(methods) || methods.length === 0
    || !methods.every(method => typeof method === 'string'
      && VERIFICATION_METHODS.has(method as CandidateVerification['methods'][number]))) return false
  if (!Array.isArray(result.outcomes) || result.outcomes.length === 0) return false
  if (!(result.outcomes as readonly unknown[]).every(isIndependentOutcome)) return false
  const derived = result.outcomes.every(outcome => outcome.result === 'pass') ? 'pass' : 'fail'
  if (derived !== result.result || !Number.isFinite(Date.parse(result.issuedAt)) || result.proof === '') return false
  return authority.validateCandidateResult(request, result)
}

function isIndependentOutcome(value: unknown): value is IndependentVerificationOutcome {
  if (typeof value !== 'object' || value === null) return false
  const name: unknown = Reflect.get(value, 'name')
  const result: unknown = Reflect.get(value, 'result')
  const evidence: unknown = Reflect.get(value, 'evidence')
  return typeof name === 'string'
    && name !== ''
    && (result === 'pass' || result === 'fail')
    && Array.isArray(evidence)
    && evidence.length > 0
    && evidence.every(item => typeof item === 'string' && item !== '')
}

/**
 * Ask the injected independent authority to verify and persist its receipt copy.
 * Authenticated pass and fail results are written before returning; the review is not updated here.
 * @param authority - External verifier owner; absence returns verifier-authority-unavailable.
 * @param reviewFile - Review JSON file; receipts are written in its sibling verification-receipts directory.
 * @param wikiRoot - Wiki root used to bind the Candidate and governance target.
 * @param reviewId - Review id to load from the persisted review array.
 * @param action - Governance action to bind into the independent request.
 * @param signal - Passed to the authority and checked immediately before and after its asynchronous call.
 * @returns Persisted verdict/evidence, or an explicit blocker; ok is true only for a pass.
 * @throws On cancellation, authority errors, malformed review state, or uncaught filesystem failures.
 */
export async function verifyCandidate(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reviewFile: string,
  wikiRoot: string,
  reviewId: string,
  action: IndependentVerificationRequest['governanceAction'],
  signal: AbortSignal,
): Promise<CandidateVerificationResult> {
  if (authority === undefined) {
    return { ok: false, evidence: [], errorCode: 'verifier-authority-unavailable' }
  }
  const item = loadReview(reviewFile, reviewId)
  if (item === undefined) return { ok: false, evidence: [], errorCode: 'review-not-found' }
  let request: IndependentVerificationRequest | undefined
  try {
    request = buildVerificationRequest(authority, wikiRoot, item, action)
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid trusted source identity') {
      return { ok: false, evidence: [error.message], errorCode: 'source-identity-invalid' }
    }
    throw error
  }
  if (request === undefined) return { ok: false, evidence: [], errorCode: 'candidate-invalid' }
  signal.throwIfAborted()
  const result = await authority.verifyCandidate(request, signal)
  signal.throwIfAborted()
  if (!resultIsCoherent(authority, request, result)) {
    return { ok: false, evidence: [], errorCode: 'verification-failed' }
  }
  const unsigned = { schemaVersion: RECEIPT_SCHEMA, request, result } as const
  const receiptHash = sha256(canonicalJson(unsigned))
  const id = `verification-${receiptHash.slice(0, 32)}`
  const receipt: TrustedVerificationReceipt = { ...unsigned, id, receiptHash }
  atomicWriteFile(join(receiptDirectory(reviewFile), `${id}.json`), `${JSON.stringify(receipt, null, 2)}\n`)
  return {
    ok: result.result === 'pass',
    receiptId: id,
    result: result.result,
    evidence: result.outcomes.flatMap(outcome => outcome.evidence),
    ...(result.result === 'pass' ? {} : { errorCode: 'verification-failed' }),
  }
}

/**
 * Revalidate a project-stored receipt through the injected external authority.
 * @param authority - Owner validating the proof and supplying the current source/build identity.
 * @param reviewFile - Review file whose sibling verification-receipts directory stores the receipt.
 * @param receiptId - Receipt basename id; invalid ids are rejected before file access.
 * @returns Authenticated pass or fail receipt matching the current source/environment, or undefined on rejection.
 * File-read and JSON-parse failures return undefined; this does not re-read Candidate bytes.
 * @throws If later receipt structure access or an authority callback throws.
 */
export function readTrustedReceipt(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reviewFile: string,
  receiptId: string,
): TrustedVerificationReceipt | undefined {
  if (authority === undefined || !ID_RE.test(receiptId)) return undefined
  const path = join(receiptDirectory(reviewFile), `${receiptId}.json`)
  let raw: unknown
  try {
    raw = JSON.parse(readRegularFileBounded(path, 2 * 1024 * 1024).toString('utf8')) as unknown
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Reflect.get(raw, 'schemaVersion') !== RECEIPT_SCHEMA) return undefined
  const receipt = raw as TrustedVerificationReceipt
  if (receipt.id !== receiptId) return undefined
  const { receiptHash, id: _id, ...unsigned } = receipt
  if (receiptHash !== sha256(canonicalJson(unsigned))
    || !resultIsCoherent(authority, receipt.request, receipt.result)
    || canonicalJson(receipt.request.sourceIdentity) !== canonicalJson(authority.sourceIdentity())
    || canonicalJson(receipt.request.environment) !== canonicalJson(environment())) return undefined
  return receipt
}

/**
 * Revalidate a receipt and the still-current Candidate/Review bytes.
 * @param authority - External proof and source/build identity owner.
 * @param reviewFile - Review file locating the sibling verification-receipts directory.
 * @param wikiRoot - Wiki root used to rebuild the request from current Candidate bytes and target state.
 * @param item - Current review proposal to compare with the authenticated request.
 * @param receiptId - Receipt to authenticate and match against the rebuilt request.
 * @param expectedAction - Required action recorded in the receipt request.
 * @returns Matching passing receipt and its verification projection, or undefined when authentication, verdict, or matching fails.
 * @throws On uncaught receipt-validation, authority, source-identity, or Candidate read failures.
 */
export function readTrustedVerification(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reviewFile: string,
  wikiRoot: string,
  item: WikiReviewItem,
  receiptId: string,
  expectedAction: IndependentVerificationRequest['governanceAction'],
): {
  authority: KnowledgeWikiVerifierAuthority
  verification: CandidateVerification & Required<Pick<CandidateVerification, 'authorityId' | 'lastVerifiedAt'>>
  receipt: TrustedVerificationReceipt
} | undefined {
  const receipt = readTrustedReceipt(authority, reviewFile, receiptId)
  if (receipt === undefined || receipt.result.result !== 'pass'
    || receipt.request.governanceAction !== expectedAction || authority === undefined) return undefined
  const path = join(receiptDirectory(reviewFile), `${receiptId}.json`)
  const request = buildVerificationRequest(authority, wikiRoot, item, expectedAction)
  if (request === undefined || canonicalJson(request) !== canonicalJson(receipt.request)) return undefined
  const outcomes = receipt.result.outcomes
  const reference: VerificationReceiptReference = {
    id: receipt.id,
    path: `verification-receipts/${basename(path)}`,
    receiptHash: receipt.receiptHash,
    environmentHash: sha256(canonicalJson(request.environment)),
    result: 'pass',
    gitCommit: request.sourceIdentity.commit,
  }
  return {
    authority,
    receipt,
    verification: {
      status: 'passed',
      candidateHash: request.candidateHash,
      sourceHash: request.sourceHash,
      action: expectedAction,
      reviewHash: request.reviewHash,
      sourceIdentity: request.sourceIdentity,
      authorityId: receipt.result.authorityId,
      methods: receipt.result.methods,
      evidence: outcomes.flatMap(outcome => outcome.evidence),
      receipts: [reference],
      confidence: 1,
      successCount: outcomes.filter(outcome => outcome.result === 'pass').length,
      failureCount: outcomes.filter(outcome => outcome.result === 'fail').length,
      verifiedBy: 'deterministic-executor',
      lastVerifiedAt: receipt.result.issuedAt,
    },
  }
}
