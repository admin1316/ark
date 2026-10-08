/**
 * Durable governance for cross-session knowledge.
 *
 * The wiki files and review JSON remain the human-facing projection. This
 * module is the small authority-neutral state machine underneath that
 * projection: it validates the complete record shape, applies scope/ACL and
 * freshness gates before model injection, and folds an append-only event
 * stream back into the same state for replay and audit.
 */

import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readRegularFileBounded } from './filesystem.ts'
import type {
  KnowledgeAcl,
  KnowledgeEvent,
  KnowledgeEventType,
  KnowledgeRecord,
  KnowledgeScope,
  KnowledgeTrust,
  KnowledgeVerificationStatus,
} from './types.ts'

const SHA256_RE = /^[0-9a-f]{64}$/u
const EVENT_TYPES: ReadonlySet<KnowledgeEventType> = new Set([
  'knowledge/observed',
  'knowledge/candidate',
  'knowledge/verified',
  'knowledge/rejected',
  'knowledge/retrieved',
  'knowledge/injected',
  'knowledge/conflict',
  'knowledge/expired',
  'knowledge/promoted',
  'knowledge/rolled_back',
])

/** Immutable set of lifecycle event names accepted by the journal. */
export const KNOWLEDGE_EVENT_TYPES = EVENT_TYPES

/** Small access context used by the scope/ACL gates. */
export interface KnowledgeAccessContext {
  readonly projectId?: string
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly actor?: string
}

/** Result of validating a complete durable knowledge record. */
export interface KnowledgeValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
}

/** Explain why one record is allowed or denied at the model boundary. */
export interface KnowledgeInjectionDecision {
  readonly allowed: boolean
  readonly reason:
    | 'ok'
    | 'invalid'
    | 'unverified'
    | 'expired'
    | 'conflict'
    | 'scope-denied'
    | 'acl-denied'
    | 'low-confidence'
}

/** Replay fold state for one project knowledge event stream. */
export interface KnowledgeState {
  readonly records: ReadonlyMap<string, KnowledgeRecord>
  readonly lastSeq: number
  readonly lastEventHash: string | null
}

/** Optional trusted verifier seam used to authenticate verified-event seals. */
export interface KnowledgeEventAuthority {
  readonly authorityId: string
  validatePromotion(payload: string, seal: { readonly authorityId: string; readonly proof: string }): boolean
}

/** Stable JSON; object keys are sorted, arrays retain their semantic order.
 * @param value - Value to canonicalize.
 * @returns Deterministic JSON text.
 */
export function canonicalKnowledgeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalKnowledgeJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().filter(key => object[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalKnowledgeJson(object[key])}`).join(',')}}`
}

/** Hash canonical bytes with SHA-256.
 * @param value - Bytes or text to hash.
 * @returns Lowercase SHA-256 digest.
 */
export function knowledgeSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function validIso(value: string | null): boolean {
  return value === null || Number.isFinite(Date.parse(value))
}

function validScope(scope: unknown): scope is KnowledgeScope {
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) return false
  const value = scope as Record<string, unknown>
  for (const key of ['projectId', 'workspaceId', 'sessionId']) {
    if (value[key] !== undefined && !nonEmpty(value[key])) return false
  }
  const visibilityValid = value.visibility === undefined
    || value.visibility === 'session'
    || value.visibility === 'workspace'
    || value.visibility === 'project'
  if (!visibilityValid) return false
  if (value.visibility === 'session' && value.sessionId === undefined) return false
  if (value.visibility === 'workspace' && value.workspaceId === undefined) return false
  if (value.visibility === 'project' && value.projectId === undefined) return false
  return true
}

function validAcl(acl: unknown): acl is KnowledgeAcl | undefined {
  if (acl === undefined) return true
  if (typeof acl !== 'object' || acl === null || Array.isArray(acl)) return false
  for (const key of ['readers', 'writers']) {
    const value = (acl as Record<string, unknown>)[key]
    if (value !== undefined && (!Array.isArray(value) || !value.every(nonEmpty))) return false
  }
  return true
}

/** Validate the complete durable record before it can enter the event stream.
 * @param record - Candidate value to validate.
 * @returns Validation status and field errors.
 */
export function validateKnowledgeRecord(record: unknown): KnowledgeValidationResult {
  const errors: string[] = []
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { ok: false, errors: ['record must be an object'] }
  }
  const value = record as Partial<KnowledgeRecord>
  if (!nonEmpty(value.id)) errors.push('id is required')
  if (!nonEmpty(value.content)) errors.push('content is required')
  if (!nonEmpty(value.source)) errors.push('source is required')
  if (!nonEmpty(value.sourceHash) || !SHA256_RE.test(value.sourceHash)) errors.push('sourceHash must be sha256')
  if (value.contentHash !== undefined && (typeof value.contentHash !== 'string' || !SHA256_RE.test(value.contentHash))) errors.push('contentHash must be sha256')
  if (!validScope(value.scope)) errors.push('scope is invalid')
  if (!['low', 'medium', 'high'].includes(value.trust as string)) errors.push('trust is invalid')
  if (!nonEmpty(value.authority)) errors.push('authority is required')
  if (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.every(nonEmpty)) errors.push('evidenceRefs are invalid')
  if (!['observed', 'candidate', 'verified', 'rejected', 'conflict', 'expired'].includes(value.verificationStatus as string)) errors.push('verificationStatus is invalid')
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) errors.push('confidence must be between 0 and 1')
  if (!nonEmpty(value.createdAt) || !validIso(value.createdAt)) errors.push('createdAt is invalid')
  if (value.lastVerifiedAt === undefined || !validIso(value.lastVerifiedAt)) errors.push('lastVerifiedAt is invalid')
  if (value.expiresAt === undefined || !validIso(value.expiresAt)) errors.push('expiresAt is invalid')
  if (value.expiresAt !== null && value.expiresAt !== undefined && value.createdAt !== undefined
    && Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) errors.push('expiresAt must be after createdAt')
  if (!Array.isArray(value.conflicts) || !value.conflicts.every(nonEmpty)) errors.push('conflicts are invalid')
  for (const key of ['retrievalHits', 'successfulUses', 'userCorrections'] as const) {
    if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0) errors.push(`${key} must be a non-negative integer`)
  }
  if (typeof value.utilityScore !== 'number' || !Number.isFinite(value.utilityScore)) errors.push('utilityScore must be finite')
  if (!validAcl(value.acl)) errors.push('acl is invalid')
  return { ok: errors.length === 0, errors }
}

/** Create a complete record with conservative defaults for untrusted observations.
 * @param input - Record fields and optional lifecycle defaults.
 * @returns A validated immutable-shape knowledge record.
 */
export function createKnowledgeRecord(input: {
  readonly id: string
  readonly content: string
  readonly source: string
  readonly claimKey?: string
  readonly sourceHash?: string
  readonly contentHash?: string
  readonly scope: KnowledgeScope
  readonly trust?: KnowledgeTrust
  readonly authority?: string
  readonly evidenceRefs?: readonly string[]
  readonly verificationStatus?: KnowledgeVerificationStatus
  readonly confidence?: number
  readonly createdAt?: string
  readonly lastVerifiedAt?: string | null
  readonly expiresAt?: string | null
  readonly conflicts?: readonly string[]
  readonly retrievalHits?: number
  readonly successfulUses?: number
  readonly userCorrections?: number
  readonly utilityScore?: number
  readonly acl?: KnowledgeAcl
  readonly lifecycle?: KnowledgeRecord['lifecycle']
}): KnowledgeRecord {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const record: KnowledgeRecord = {
    id: input.id,
    content: input.content,
    source: input.source,
    ...(input.claimKey === undefined ? {} : { claimKey: input.claimKey }),
    // Bind provenance identity by default; candidate content is separately
    // hash-bound by review.candidateHash and must not masquerade as source.
    sourceHash: input.sourceHash ?? knowledgeSha256(input.source),
    ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
    scope: { ...input.scope },
    trust: input.trust ?? 'low',
    authority: input.authority ?? 'untrusted-observation',
    evidenceRefs: [...(input.evidenceRefs ?? [])],
    verificationStatus: input.verificationStatus ?? 'observed',
    confidence: input.confidence ?? 0,
    createdAt,
    lastVerifiedAt: input.lastVerifiedAt ?? null,
    expiresAt: input.expiresAt ?? null,
    conflicts: [...(input.conflicts ?? [])],
    retrievalHits: input.retrievalHits ?? 0,
    successfulUses: input.successfulUses ?? 0,
    userCorrections: input.userCorrections ?? 0,
    utilityScore: input.utilityScore ?? 0,
    ...(input.acl === undefined ? {} : { acl: { ...input.acl } }),
    ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
  }
  const validation = validateKnowledgeRecord(record)
  if (!validation.ok) throw new Error(`invalid knowledge record: ${validation.errors.join(', ')}`)
  return record
}

function sameScope(left: KnowledgeScope, right: KnowledgeScope): boolean {
  return left.projectId === right.projectId
    && left.workspaceId === right.workspaceId
    && left.sessionId === right.sessionId
}

function claimKey(record: KnowledgeRecord): string {
  return record.claimKey ?? record.source
}

/** Find incompatible claims in the same scope; conflicts are never auto-overwritten.
 * @param record - Record whose claim is being checked.
 * @param peers - Existing records in the candidate scope.
 * @returns Conflicting record ids.
 */
export function detectKnowledgeConflicts(record: KnowledgeRecord, peers: Iterable<KnowledgeRecord>): string[] {
  const normalized = record.content.trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
  return [...peers]
    .filter(peer => peer.id !== record.id && sameScope(peer.scope, record.scope) && claimKey(peer) === claimKey(record))
    .filter(peer => peer.content.trim().replace(/\s+/gu, ' ').toLocaleLowerCase() !== normalized)
    .filter(peer => peer.verificationStatus === 'verified' || peer.verificationStatus === 'candidate')
    .map(peer => peer.id)
}

function scopeAllows(scope: KnowledgeScope, context: KnowledgeAccessContext): boolean {
  if (scope.projectId !== undefined && scope.projectId !== context.projectId) return false
  if (scope.workspaceId !== undefined && scope.workspaceId !== context.workspaceId) return false
  if (scope.visibility === 'session' && scope.sessionId !== context.sessionId) return false
  if (scope.sessionId !== undefined && scope.sessionId !== context.sessionId) return false
  return true
}

function aclAllows(acl: KnowledgeAcl | undefined, context: KnowledgeAccessContext): boolean {
  if (acl?.readers === undefined || acl.readers.length === 0) return true
  return context.actor !== undefined && acl.readers.includes(context.actor)
}

/** Gate one record before it can affect the model-visible prompt.
 * @param record - Record to check.
 * @param context - Session, project, workspace, and actor fence.
 * @param now - Clock used for expiry checks.
 * @returns The allow/deny decision and reason.
 */
export function knowledgeInjectionDecision(
  record: KnowledgeRecord,
  context: KnowledgeAccessContext,
  now = new Date(),
): KnowledgeInjectionDecision {
  if (!validateKnowledgeRecord(record).ok) return { allowed: false, reason: 'invalid' }
  if (record.verificationStatus === 'expired' || (record.expiresAt !== null && Date.parse(record.expiresAt) <= now.getTime())) return { allowed: false, reason: 'expired' }
  if (record.verificationStatus === 'conflict' || record.conflicts.length > 0) return { allowed: false, reason: 'conflict' }
  if (record.verificationStatus !== 'verified') return { allowed: false, reason: 'unverified' }
  if (!scopeAllows(record.scope, context)) return { allowed: false, reason: 'scope-denied' }
  if (!aclAllows(record.acl, context)) return { allowed: false, reason: 'acl-denied' }
  if (record.confidence <= 0) return { allowed: false, reason: 'low-confidence' }
  if (record.retrievalHits >= 3 && record.utilityScore <= 0) return { allowed: false, reason: 'low-confidence' }
  return { allowed: true, reason: 'ok' }
}

/** Low-trust material may be shown as evidence but cannot change policy, ACL, routes, or credentials.
 * @param record - Knowledge record attempting a policy-affecting change.
 * @returns Whether the record meets the high-trust policy gate.
 */
export function canKnowledgeChangePolicy(record: KnowledgeRecord): boolean {
  return record.trust === 'high'
    && record.verificationStatus === 'verified'
    && record.authority !== 'untrusted-observation'
    && record.conflicts.length === 0
    && (record.expiresAt === null || Date.parse(record.expiresAt) > Date.now())
}

function eventBody(event: Omit<KnowledgeEvent, 'eventHash'>): string {
  return canonicalKnowledgeJson(event)
}

/** Construct a tamper-evident event. Payload is copied to keep callers from mutating the hash.
 * @param type - Lifecycle event type.
 * @param knowledgeId - Stable record identity.
 * @param scope - Project/session scope for the event.
 * @param payload - JSON-like event details.
 * @param options - Optional sequence, timestamp, and chain fields.
 * @returns A hash-bound event envelope.
 */
export function createKnowledgeEvent(
  type: KnowledgeEventType,
  knowledgeId: string,
  scope: KnowledgeScope,
  payload: Readonly<Record<string, unknown>>,
  options: {
    readonly seq?: number
    readonly timestamp?: string
    readonly sourceHash?: string
    readonly previousEventHash?: string | null
    readonly id?: string
  } = {},
): KnowledgeEvent {
  if (!EVENT_TYPES.has(type)) throw new Error(`unknown knowledge event type: ${type}`)
  if (!nonEmpty(knowledgeId) || !validScope(scope)) throw new Error('knowledge event identity/scope is invalid')
  const event = {
    schemaVersion: 1 as const,
    type,
    id: options.id ?? `knowledge-event-${randomUUID()}`,
    seq: options.seq ?? 0,
    timestamp: options.timestamp ?? new Date().toISOString(),
    knowledgeId,
    scope: { ...scope },
    ...(options.sourceHash === undefined ? {} : { sourceHash: options.sourceHash }),
    previousEventHash: options.previousEventHash ?? null,
    payload: { ...payload },
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isFinite(Date.parse(event.timestamp))) throw new Error('knowledge event sequence/timestamp is invalid')
  return Object.freeze({ ...event, eventHash: knowledgeSha256(eventBody(event)) })
}

/** Validate one event and, when supplied, its predecessor link.
 * @param event - Event value to validate.
 * @param previous - Prior event in the same stream.
 * @returns Whether the event is structurally and cryptographically valid.
 */
export function validateKnowledgeEvent(event: unknown, previous?: KnowledgeEvent): boolean {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return false
  const raw = event as Record<string, unknown>
  const value = raw as unknown as KnowledgeEvent
  if (raw.schemaVersion !== 1 || typeof raw.type !== 'string' || !EVENT_TYPES.has(raw.type as KnowledgeEventType)
    || !nonEmpty(raw.id) || !nonEmpty(raw.knowledgeId)) return false
  if (!Number.isSafeInteger(raw.seq) || (raw.seq as number) < 0 || typeof raw.timestamp !== 'string'
    || !Number.isFinite(Date.parse(raw.timestamp)) || !validScope(raw.scope)) return false
  if (raw.sourceHash !== undefined && (typeof raw.sourceHash !== 'string' || !SHA256_RE.test(raw.sourceHash))) return false
  if (typeof raw.payload !== 'object' || raw.payload === null || Array.isArray(raw.payload)) return false
  if (value.previousEventHash !== null && !SHA256_RE.test(value.previousEventHash)) return false
  if (!SHA256_RE.test(value.eventHash)) return false
  const unsigned = { ...value } as Record<string, unknown>
  delete unsigned.eventHash
  if (knowledgeSha256(eventBody(unsigned as Omit<KnowledgeEvent, 'eventHash'>)) !== value.eventHash) return false
  if (previous !== undefined && (value.seq !== previous.seq + 1 || value.previousEventHash !== previous.eventHash)) return false
  return true
}

function cloneRecord(record: KnowledgeRecord): KnowledgeRecord {
  const acl = record.acl === undefined
    ? undefined
    : {
      ...(record.acl.readers === undefined ? {} : { readers: [...record.acl.readers] }),
      ...(record.acl.writers === undefined ? {} : { writers: [...record.acl.writers] }),
    }
  return {
    ...record,
    scope: { ...record.scope },
    evidenceRefs: [...record.evidenceRefs],
    conflicts: [...record.conflicts],
    ...(acl === undefined ? {} : { acl }),
  }
}

function admissionIdentity(record: KnowledgeRecord): string {
  return canonicalKnowledgeJson({
    id: record.id,
    content: record.content,
    source: record.source,
    sourceHash: record.sourceHash,
    claimKey: record.claimKey,
    scope: record.scope,
    acl: record.acl,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  })
}

/** Apply one event to state. Unsigned admission stays low-trust; verification binds its complete record.
 * @param state - Current replay state.
 * @param event - Next hash-bound event; callers authenticate seals with readKnowledgeEventLog before folding trusted state.
 * @returns Updated replay state.
 */
export function applyKnowledgeEvent(state: KnowledgeState, event: KnowledgeEvent): KnowledgeState {
  if (!validateKnowledgeEvent(event)) throw new Error('invalid knowledge event')
  if (state.lastSeq < 0 && (event.seq !== 0 || event.previousEventHash !== null)) throw new Error('knowledge event chain must start at seq 0')
  if (state.lastSeq >= 0 && (event.seq !== state.lastSeq + 1 || event.previousEventHash !== state.lastEventHash)) throw new Error('knowledge event chain gap')
  const records = new Map(state.records)
  const current = records.get(event.knowledgeId)
  const payload = event.payload
  const item = payload.record as KnowledgeRecord | undefined
  if (event.type === 'knowledge/observed' || event.type === 'knowledge/candidate') {
    if (item === undefined || !validateKnowledgeRecord(item).ok || item.id !== event.knowledgeId
      || canonicalKnowledgeJson(item.scope) !== canonicalKnowledgeJson(event.scope)) throw new Error('knowledge event record is invalid')
    if (current !== undefined && (event.type !== 'knowledge/candidate' || current.verificationStatus !== 'observed'
      || admissionIdentity(current) !== admissionIdentity(item))) throw new Error('unsigned knowledge admission cannot replace an existing record')
    records.set(event.knowledgeId, cloneRecord({
      ...item,
      verificationStatus: event.type === 'knowledge/candidate' ? 'candidate' : 'observed',
      trust: 'low',
      authority: 'untrusted-observation',
      confidence: 0,
      lastVerifiedAt: null,
      retrievalHits: current?.retrievalHits ?? 0,
      successfulUses: 0,
      userCorrections: current?.userCorrections ?? 0,
      utilityScore: 0,
      lifecycle: 'candidate',
    }))
  } else {
    let base = current
    if (event.type === 'knowledge/verified') {
      if (item === undefined || !validateKnowledgeRecord(item).ok || item.id !== event.knowledgeId
        || canonicalKnowledgeJson(item.scope) !== canonicalKnowledgeJson(event.scope)) throw new Error('knowledge verification record is invalid')
      // Verification authenticates its full record, never an unsigned earlier projection.
      base = item
    }
    if (base === undefined) {
      // Retrieval/injection events are useful audit facts even when their
      // page was never admitted as governed knowledge.
      return { records, lastSeq: event.seq, lastEventHash: event.eventHash }
    }
    const next = { ...cloneRecord(base) }
    switch (event.type) {
      case 'knowledge/verified':
        const authority = payload.authority
        const seal = payload.authoritySeal
        if (!nonEmpty(authority) || authority === 'untrusted-observation'
          || typeof seal !== 'object' || seal === null
          || Reflect.get(seal, 'authorityId') !== authority
          || !nonEmpty(Reflect.get(seal, 'proof'))
          || !Array.isArray(payload.evidenceRefs) || !payload.evidenceRefs.some(nonEmpty)) {
          throw new Error('knowledge verification lacks independent authority/evidence')
        }
        if (current !== undefined && (admissionIdentity(current) !== admissionIdentity(next)
          || current.verificationStatus === 'expired' || current.verificationStatus === 'conflict'
          || current.verificationStatus === 'rejected' || current.lifecycle === 'rolled_back')) throw new Error('knowledge verification conflicts with prior admission')
        if (current !== undefined) {
          next.retrievalHits = current.retrievalHits
          next.successfulUses = current.successfulUses
          next.userCorrections = current.userCorrections
          next.utilityScore = current.utilityScore
        }
        next.verificationStatus = 'verified'
        next.trust = (payload.trust as KnowledgeTrust | undefined) ?? 'medium'
        next.lastVerifiedAt = (payload.lastVerifiedAt as string | undefined) ?? event.timestamp
        next.confidence = typeof payload.confidence === 'number' ? payload.confidence : next.confidence
        next.authority = authority
        next.evidenceRefs = payload.evidenceRefs.filter(nonEmpty)
        break
      case 'knowledge/rejected': next.verificationStatus = 'rejected'; next.lifecycle = 'downgraded'; break
      case 'knowledge/retrieved': next.retrievalHits += 1; break
      case 'knowledge/injected': {
        const outcome = payload.outcome
        if (outcome === 'successful') next.successfulUses += 1
        if (outcome === 'corrected') next.userCorrections += 1
        if (outcome === 'successful' || outcome === 'corrected') {
          next.utilityScore = Number(((next.successfulUses * 2 - next.userCorrections * 3) / Math.max(1, next.retrievalHits)).toFixed(4))
        }
        break
      }
      case 'knowledge/conflict': next.verificationStatus = 'conflict'; next.conflicts = [...new Set([...next.conflicts, ...(Array.isArray(payload.conflictIds) ? payload.conflictIds.filter(nonEmpty) : [])])]; break
      case 'knowledge/expired': next.verificationStatus = 'expired'; break
      case 'knowledge/promoted':
        if (typeof payload.authorityId !== 'string'
          || typeof payload.authoritySeal !== 'object' || payload.authoritySeal === null
          || Reflect.get(payload.authoritySeal, 'authorityId') !== payload.authorityId
          || !nonEmpty(Reflect.get(payload.authoritySeal, 'proof'))) {
          throw new Error('knowledge promotion lacks authority seal')
        }
        if (next.verificationStatus !== 'verified' || next.evidenceRefs.length === 0 || next.conflicts.length > 0) throw new Error('knowledge promotion requires conflict-free verification evidence')
        if (typeof payload.contentHash !== 'string' || !SHA256_RE.test(payload.contentHash)) throw new Error('knowledge promotion lacks authenticated content hash')
        next.lifecycle = 'canonical'
        next.contentHash = payload.contentHash
        if (typeof payload.appliedPath === 'string' && payload.appliedPath !== '') next.source = payload.appliedPath
        break
      case 'knowledge/rolled_back': next.lifecycle = 'rolled_back'; next.verificationStatus = 'candidate'; break
    }
    if (!validateKnowledgeRecord(next).ok) throw new Error('knowledge transition produced an invalid record')
    records.set(event.knowledgeId, next)
  }
  return { records, lastSeq: event.seq, lastEventHash: event.eventHash }
}

/** Fold a complete event stream; malformed, out-of-order, and tampered events fail closed.
 * @param events - Events in sequence order.
 * @returns Reconstructed knowledge state.
 */
export function replayKnowledgeEvents(events: readonly KnowledgeEvent[]): KnowledgeState {
  let state: KnowledgeState = { records: new Map(), lastSeq: -1, lastEventHash: null }
  for (const event of events) state = applyKnowledgeEvent(state, event)
  return state
}

/**
 * Produce and fold explicit expiry events. Expiry is a state transition, so a
 * caller can append the returned events before exposing the updated state.
 * @param state - Current replay state.
 * @param now - Clock used for expiry checks.
 * @returns Updated state and the events that produce it.
 */
export function expireKnowledge(
  state: KnowledgeState,
  now = new Date(),
): { readonly state: KnowledgeState; readonly events: readonly KnowledgeEvent[] } {
  let next = state
  const events: KnowledgeEvent[] = []
  for (const record of state.records.values()) {
    if (record.expiresAt === null || Date.parse(record.expiresAt) > now.getTime()) continue
    if (record.verificationStatus === 'expired') continue
    const event = createKnowledgeEvent('knowledge/expired', record.id, record.scope, {
      expiresAt: record.expiresAt,
    }, {
      seq: next.lastSeq + 1,
      previousEventHash: next.lastEventHash,
      timestamp: now.toISOString(),
    })
    next = applyKnowledgeEvent(next, event)
    events.push(event)
  }
  return { state: next, events }
}

/** Knowledge with no utility lift is retained only while it is still useful.
 * @param record - Record whose retention is being evaluated.
 * @param options - Minimum retrieval and utility thresholds.
 * @returns Whether the record remains eligible for retention.
 */
export function shouldRetainKnowledge(
  record: KnowledgeRecord,
  options: { readonly minRetrievalHits?: number; readonly minUtilityScore?: number } = {},
): boolean {
  if (record.verificationStatus === 'expired' || record.verificationStatus === 'rejected') return false
  const minRetrievalHits = options.minRetrievalHits ?? 3
  const minUtilityScore = options.minUtilityScore ?? 0
  return record.retrievalHits < minRetrievalHits || record.utilityScore > minUtilityScore
}

/** Read an append-only JSONL stream and replay it. Blank lines are ignored.
 * @param path - Event-log path.
 * @param authority - Optional trusted authority used to validate verification seals.
 * @returns Validated events in sequence order.
 */
export function readKnowledgeEventLog(path: string, authority?: KnowledgeEventAuthority): KnowledgeEvent[] {
  let raw: string
  try { raw = readRegularFileBounded(path, 64 * 1024 * 1024).toString('utf8') } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return []
    throw error
  }
  const events: KnowledgeEvent[] = []
  for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
    const parsed = JSON.parse(line) as KnowledgeEvent
    if (!validateKnowledgeEvent(parsed, events.at(-1)) || (events.length === 0 && (parsed.seq !== 0 || parsed.previousEventHash !== null))) throw new Error('invalid knowledge event log')
    if ((parsed.type === 'knowledge/verified' || parsed.type === 'knowledge/promoted') && authority !== undefined) {
      const seal = parsed.payload.authoritySeal
      const authorityId = parsed.payload.authorityId
      if (typeof authorityId !== 'string' || authorityId !== authority.authorityId
        || typeof seal !== 'object' || seal === null
        || Reflect.get(seal, 'authorityId') !== authorityId
        || !nonEmpty(Reflect.get(seal, 'proof'))) throw new Error('unauthenticated knowledge verification event')
      const unsignedPayload = { ...parsed.payload }
      delete unsignedPayload.authorityId
      delete unsignedPayload.authoritySeal
      const sealValue = seal as { readonly authorityId: string; readonly proof: string }
      if (!authority.validatePromotion(canonicalKnowledgeJson({
        type: parsed.type,
        knowledgeId: parsed.knowledgeId,
        payload: unsignedPayload,
      }), sealValue)) throw new Error('knowledge verification event seal failed')
    }
    events.push(parsed)
  }
  return events
}

/** Append one event after checking its sequence/hash against the existing log.
 * @param path - Event-log path.
 * @param event - Event whose chain position is checked.
 */
export function appendKnowledgeEvent(path: string, event: KnowledgeEvent): void {
  const prior = readKnowledgeEventLog(path)
  const expectedOptions = {
    seq: prior.length,
    timestamp: event.timestamp,
    previousEventHash: prior.at(-1)?.eventHash ?? null,
    id: event.id,
    ...(event.sourceHash === undefined ? {} : { sourceHash: event.sourceHash }),
  }
  const expected = createKnowledgeEvent(event.type, event.knowledgeId, event.scope, event.payload, expectedOptions)
  if (expected.eventHash !== event.eventHash) throw new Error('knowledge event hash/sequence mismatch')
  mkdirSync(dirname(path), { recursive: true })
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('unsafe knowledge event log')
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT')) throw error
  }
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const descriptor = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | noFollow, 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(event)}\n`)
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
}

/** Record utility feedback in a pure, replayable way.
 * @param record - Current record counters.
 * @param outcome - Observed outcome of a use.
 * @returns Updated counters and utility score.
 */
export function updateKnowledgeUtility(record: KnowledgeRecord, outcome: 'successful' | 'corrected' | 'neutral'): KnowledgeRecord {
  const next = { ...cloneRecord(record) }
  if (outcome === 'successful') next.successfulUses += 1
  if (outcome === 'corrected') next.userCorrections += 1
  next.utilityScore = Number(((next.successfulUses * 2 - next.userCorrections * 3) / Math.max(1, next.retrievalHits)).toFixed(4))
  return next
}
