/** Complete read-only v2 journal replay against a separately captured protected head. */

import { z } from 'zod'
import type { ArtifactRef } from './learning-artifacts.ts'
import { decodeCanonicalJson } from './learning-artifacts.ts'
import { GraphContext, digest, equal, originalText, requireRelation } from './learning-graph-context.ts'
import * as S from './learning-graph-schema.ts'
import { indexKnowledgeRecordsBySource, knowledgeInjectionDecision, validateKnowledgeRecord } from './knowledge-governance.ts'
import type { KnowledgeRecord } from './types.ts'
import type { RecordedReservation } from './learning-graph-session.ts'
import { sha256 } from './verifier.ts'
import { visitLearningPayloadEdges } from './learning-graph-edges.ts'

/** One authenticated authorization and its durable closure, before any positive credit. */
export interface RecordedGrant {
  readonly ref: ArtifactRef
  readonly value: S.Authorization
  readonly seq: number
  readonly closed?: string
}
/** Immutable replay projection at one authenticated journal position. */
export interface JournalState {
  readonly records: ReadonlyMap<string, KnowledgeRecord>
  readonly grants: ReadonlyMap<string, RecordedGrant>
  readonly reservations: ReadonlyMap<string, RecordedReservation>
  readonly useReceipts: ReadonlyMap<string, ArtifactRef>
  readonly observedFacts: ReadonlyMap<string, ArtifactRef>
  readonly trialReceipts: ReadonlyMap<string, ArtifactRef>
  readonly creditOwners: ReadonlyMap<string, string>
}

/** Canonical immutable admission projection; optional public fields remain distinct from nullable projection fields.
 * @param record - Authenticated governed record.
 * @returns The immutable admission identity, excluding observational counters and mutable status.
 */
export function admissionFor(record: KnowledgeRecord): S.GovernedSnapshot['admissionIdentity'] {
  return S.admission.parse({ id: record.id, content: record.content, source: record.source, sourceHash: record.sourceHash,
    contentHash: record.contentHash, claimKey: record.claimKey ?? null, scope: record.scope, acl: record.acl ?? null,
    createdAt: record.createdAt, expiresAt: record.expiresAt })
}

/** Apply unchanged non-lifecycle admission rules and the selected candidate/target lifecycle.
 * @param ctx - Selected current owner context.
 * @param record - Authenticated current governed record.
 * @param sessionId - Session whose selected access context applies.
 * @param canonical - Whether the record must have canonical rather than candidate lifecycle.
 * @returns Normally only when the record exists and passes the unchanged current admission rules.
 */
export function admitRecord(ctx: GraphContext, record: KnowledgeRecord | undefined, sessionId: string,
  canonical: boolean): asserts record is KnowledgeRecord {
  const context = ctx.owner.sessionContexts.get(sessionId)
  if (context === undefined) ctx.unavailable()
  requireRelation(record !== undefined && validateKnowledgeRecord(record).ok && record.userCorrections === 0
    && record.expiresAt !== null && record.lastVerifiedAt !== null && record.lifecycle === (canonical ? 'canonical' : 'candidate')
    && knowledgeInjectionDecision(record, context, new Date(ctx.owner.now)).allowed)
}

/** Replays every event; positive historical folds must be supplied by the complete graph validator. */
export class LearningJournal {
  /** Operation-local proof, artifact and protected context. */
  readonly ctx: GraphContext
  /** Complete historical promotion validator supplied by the graph owner. */
  readonly promote: (event: S.JournalEvent, before: JournalState) => ReadonlyMap<string, KnowledgeRecord>
  /** Complete authenticated event sequence through the separately protected head. */
  readonly events: readonly S.JournalEvent[]
  private readonly lines: readonly string[]
  private readonly states = new Map<number, JournalState>()
  private readonly active = new Set<number>()

  constructor(ctx: GraphContext, promote: (event: S.JournalEvent,
    before: JournalState) => ReadonlyMap<string, KnowledgeRecord>) {
    this.ctx = ctx
    this.promote = promote
    const input = ctx.owner.currentJournal
    S.position.parse({ epoch: input.protectedHead.epoch, seq: input.protectedHead.seq, eventHash: input.protectedHead.eventHash })
    S.hash.parse(input.protectedHead.prefixHash)
    requireRelation(input.artifact.mediaType === 'application/x-ndjson' && input.artifact.digest === input.protectedHead.prefixHash)
    const parsed = ctx.owner.artifacts.visit(input.artifact, (bytes) => {
      const raw = originalText(bytes)
      requireRelation(raw.endsWith('\n') && raw !== '\n')
      const lines = raw.slice(0, -1).split('\n')
      let previous: S.JournalEvent | undefined
      const ids = new Set<string>()
      const events = lines.map((line, seq) => {
        const event = S.journalEvent.parse(decodeCanonicalJson(Buffer.from(line, 'utf8')))
        requireRelation(event.seq === seq && event.epoch === input.protectedHead.epoch
          && event.projectIdentityHash === ctx.owner.proofs.projectIdentityHash
          && event.previousEventHash === (previous?.eventHash ?? null) && event.timestamp <= ctx.owner.now && !ids.has(event.id)
          && (previous === undefined || event.timestamp >= previous.timestamp))
        const { eventHash, seal, ...body } = event
        requireRelation(digest({ ...body, seal }) === eventHash)
        const signed = ctx.owner.proofs.verifyJournalEnvelope(seal, 'event')
        requireRelation(equal(signed.payload, { eventBodyHash: digest(body) }))
        visitLearningPayloadEdges(ctx, S.journalEvent, event)
        ids.add(event.id)
        previous = event
        return event
      })
      requireRelation(events.length === input.protectedHead.seq + 1 && previous?.eventHash === input.protectedHead.eventHash)
      return { lines, events }
    })
    this.lines = parsed.lines
    this.events = parsed.events
    this.states.set(-1, { records: new Map(), grants: new Map(), reservations: new Map(), useReceipts: new Map(),
      observedFacts: new Map(), trialReceipts: new Map(), creditOwners: new Map() })
  }

  /** Authenticate a retained prefix checkpoint against the complete current journal.
   * @param value - Signed checkpoint and exact prefix reference.
   * @returns The replayed state at that checkpoint.
   */
  watermark(value: z.infer<typeof S.watermark>): JournalState {
    const head = this.ctx.owner.currentJournal.protectedHead
    requireRelation(value.epoch === head.epoch && value.projectIdentityHash === this.ctx.owner.proofs.projectIdentityHash
      && value.seq <= head.seq)
    requireRelation(this.events[value.seq]?.eventHash === value.eventHash)
    requireRelation(value.journalPrefix.mediaType === 'application/x-ndjson')
    const expected = `${this.lines.slice(0, value.seq + 1).join('\n')}\n`
    requireRelation(value.journalPrefix.digest === sha256(expected) && this.ctx.text(value.journalPrefix) === expected)
    const signed = this.ctx.owner.proofs.verifyJournalEnvelope(value.checkpoint, 'journal-watermark')
    requireRelation(equal(signed.payload, { epoch: value.epoch, seq: value.seq, eventHash: value.eventHash,
      projectIdentityHash: value.projectIdentityHash, prefixHash: value.journalPrefix.digest }))
    return this.stateAt(value.seq)
  }

  /** Authenticate the entire snapshot record and its immutable admission projection.
   * @param value - Record, admission identity and protected prefix checkpoint.
   * @returns The exactly replayed governed record.
   */
  snapshot(value: S.GovernedSnapshot): KnowledgeRecord {
    const state = this.watermark(value.watermark)
    const record = this.ctx.json(value.record, S.record)
    requireRelation(equal(record, state.records.get(record.id)) && equal(admissionFor(record), value.admissionIdentity)
      && digest(value.admissionIdentity) === value.admissionIdentityHash)
    indexKnowledgeRecordsBySource(state.records.values())
    return record
  }

  /** Replay every event up to the requested historical position.
   * @param seq - Inclusive journal sequence, or minus one for empty genesis input.
   * @returns The complete replay projection at that position.
   */
  stateAt(seq: number): JournalState {
    requireRelation(Number.isSafeInteger(seq) && seq >= -1 && seq < this.events.length)
    const existing = this.states.get(seq)
    if (existing !== undefined) return existing
    requireRelation(!this.active.has(seq))
    this.active.add(seq)
    try {
      let start = seq - 1
      while (!this.states.has(start)) start -= 1
      let state = this.states.get(start)
      requireRelation(state !== undefined)
      for (let index = start + 1; index <= seq; index += 1) {
        const event = this.events[index]
        requireRelation(event !== undefined)
        state = this.fold(state, event)
        this.states.set(index, state)
      }
      return state
    } finally { this.active.delete(seq) }
  }

  private fold(state: JournalState, event: S.JournalEvent): JournalState {
    const payload = event.payload
    if (event.seq === 0) {
      requireRelation(payload.type === 'knowledge/journal-started')
      if (payload.legacyLog !== null) this.ctx.resolve(payload.legacyLog)
      requireRelation((payload.legacyLog === null) === (payload.legacyLastEventHash === null))
      return state
    }
    requireRelation(payload.type !== 'knowledge/journal-started')
    let records = state.records
    const current = records.get(event.knowledgeId)
    const update = (next: KnowledgeRecord) => {
      requireRelation(validateKnowledgeRecord(next).ok && next.id === event.knowledgeId)
      records = new Map(records).set(next.id, next)
      indexKnowledgeRecordsBySource(records.values())
    }
    switch (payload.type) {
      case 'knowledge/observed':
      case 'knowledge/candidate': {
        const raw = z.object({ record: S.record }).strict().parse(payload.legacyShapePayload).record
        requireRelation(raw.id === event.knowledgeId && equal(raw.scope, event.scope))
        requireRelation(current === undefined || (payload.type === 'knowledge/candidate'
          && current.verificationStatus === 'observed' && equal(admissionFor(raw), admissionFor(current))))
        update({ ...raw, verificationStatus: payload.type === 'knowledge/candidate' ? 'candidate' : 'observed', trust: 'low',
          authority: 'untrusted-observation',
          confidence: 0, lastVerifiedAt: null, retrievalHits: current?.retrievalHits ?? 0, successfulUses: 0,
          userCorrections: current?.userCorrections ?? 0, utilityScore: 0, lifecycle: 'candidate' })
        break
      }
      case 'knowledge/verified': {
        const next = this.ctx.json(payload.recordSnapshot, S.record)
        const semantic = this.ctx.semantic(payload.semanticReceipt)
        requireRelation(current !== undefined && equal(admissionFor(current), admissionFor(next)) && equal(next.scope, event.scope)
          && current.userCorrections === 0 && !['rejected', 'conflict', 'expired'].includes(current.verificationStatus)
          && current.lifecycle !== 'rolled_back' && current.lifecycle !== 'downgraded')
        requireRelation(next.verificationStatus === 'verified' && next.authority === this.ctx.owner.proofs.evaluatorAuthorityId
          && next.trust !== 'high' && next.confidence > 0 && next.lastVerifiedAt === semantic.result.issuedAt
          && next.lastVerifiedAt <= event.timestamp && next.source === semantic.request.candidatePath
          && next.sourceHash === semantic.request.sourceHash && next.contentHash === semantic.request.candidateHash
            && sha256(next.content) === next.contentHash
          && next.lifecycle === current.lifecycle && next.retrievalHits === current.retrievalHits
            && next.successfulUses === current.successfulUses
          && next.userCorrections === current.userCorrections && next.utilityScore === current.utilityScore
            && next.conflicts.length === 0 && next.evidenceRefs.length > 0)
        update(next)
        break
      }
      case 'knowledge/retrieved': {
        const value = z.object({ path: S.id, retrievalAt: S.time }).strict().parse(payload.legacyShapePayload)
        requireRelation(value.retrievalAt === event.timestamp)
        if (current !== undefined) {
          requireRelation(value.path === current.source)
          update({ ...current, retrievalHits: S.integer.parse(current.retrievalHits + 1) })
        }
        break
      }
      case 'knowledge/injected': {
        const value = z.object({ path: S.id, outcome: z.enum(['successful', 'neutral', 'corrected']),
          outcomeSource: z.literal('user-feedback'), utilityScore: z.number() }).strict().parse(payload.legacyShapePayload)
        if (current !== undefined) {
          requireRelation(value.path === current.source)
          if (value.outcome === 'corrected') update({ ...current,
            userCorrections: S.integer.parse(current.userCorrections + 1), verificationStatus: 'rejected', lifecycle: 'downgraded' })
        }
        break
      }
      case 'knowledge/rejected':
      case 'knowledge/conflict':
      case 'knowledge/expired':
      case 'knowledge/rolled_back': {
        this.ctx.resolve(payload.evidence)
        if (current !== undefined) update({ ...current,
          verificationStatus: payload.type === 'knowledge/conflict' ? 'conflict' : payload.type === 'knowledge/expired' ? 'expired' : 'rejected',
          lifecycle: payload.type === 'knowledge/rolled_back' ? 'rolled_back' : 'downgraded' })
        break
      }
      case 'knowledge/trial-authorized': {
        const value = this.ctx.envelope(payload.grant, 'trial-authorization', S.authorization, grant => grant)
        requireRelation(value.proposalHash === payload.proposal.digest && equal(value.proposal, payload.proposal)
          && value.initiationCapability.digest === payload.initiationCapabilityHash && !state.grants.has(value.grantId))
        requireRelation(![...state.grants.values()].some(
          grant => grant.value.initiationCapability.digest === value.initiationCapability.digest))
        return { ...state, grants: new Map(state.grants).set(value.grantId, { value, ref: payload.grant, seq: event.seq }) }
      }
      case 'knowledge/trial-consumed': {
        const value = payload.reservation
        const grant = state.grants.get(value.grantId)
        requireRelation(grant !== undefined && grant.closed === undefined && !state.reservations.has(value.reservationId)
          && value.proposalHash === grant.value.proposalHash && event.timestamp >= grant.value.notBefore
            && event.timestamp <= grant.value.deadline)
        const arm = grant.value.sessionArms.find(row => row.useId === value.useId && row.sessionId === value.sessionId)
        requireRelation(arm !== undefined)
        const proposal = this.ctx.json(grant.value.proposal, S.proposal)
        requireRelation(proposal.knowledgeId === event.knowledgeId && equal(event.scope, proposal.scope))
        admitRecord(this.ctx, state.records.get(proposal.knowledgeId), value.sessionId, false)
        if (proposal.targetGovernance.kind === 'existing') admitRecord(this.ctx,
          state.records.get(proposal.canonicalIdentityTransition.canonicalKnowledgeId), value.sessionId, true)
        requireRelation(value.phase === 'knowledge-read' ? value.callId !== null && value.requestAttemptId === null
          && arm.variant === 'candidate' : value.callId === null && value.requestAttemptId !== null)
        const previous = [...state.reservations.values()].filter(row => row.value.grantId === value.grantId)
        requireRelation(value.ordinal === previous.filter(row => row.value.useId === value.useId
          && row.value.phase === value.phase).length + 1)
        requireRelation(previous.filter(row => row.value.phase === value.phase).length < (value.phase === 'knowledge-read' ? grant.value.maxKnowledgeReads : grant.value.maxModelAttempts))
        requireRelation(new Set([...previous.map(row => `${row.value.sessionId}:${row.value.turn}`),
          `${value.sessionId}:${value.turn}`]).size <= grant.value.maxTurns)
        requireRelation(value.requestAttemptId === null || !previous.some(row => row.value.requestAttemptId === value.requestAttemptId))
        return { ...state, reservations: new Map(state.reservations).set(value.reservationId, { value,
          timestamp: event.timestamp, seq: event.seq }) }
      }
      case 'knowledge/use-observed': {
        this.ctx.resolve(payload.factManifest)
        const prior = state.observedFacts.get(payload.useId)
        requireRelation(prior === undefined || equal(prior, payload.factManifest))
        return { ...state, observedFacts: new Map(state.observedFacts).set(payload.useId, payload.factManifest) }
      }
      case 'knowledge/use-measured': {
        this.ctx.envelope(payload.receipt, 'measured-use', S.use, (use, _envelope, request) => {
          requireRelation(use.useId === payload.useId && request?.operation === 'measureUse' && request.useId === use.useId
            && equal(request.facts, state.observedFacts.get(use.useId)) && equal(request.grant, state.grants.get(use.grantId)?.ref))
        })
        const prior = state.useReceipts.get(payload.useId)
        requireRelation(prior === undefined || equal(prior, payload.receipt))
        return { ...state, useReceipts: new Map(state.useReceipts).set(payload.useId, payload.receipt) }
      }
      case 'knowledge/trial-measured': {
        this.ctx.envelope(payload.receipt, 'measured-trial', S.trial, (trial) => { requireRelation(trial.grantId === payload.grantId) })
        const prior = state.trialReceipts.get(payload.grantId)
        requireRelation(prior === undefined || equal(prior, payload.receipt))
        return { ...state, trialReceipts: new Map(state.trialReceipts).set(payload.grantId, payload.receipt) }
      }
      case 'knowledge/trial-closed': {
        const grant = state.grants.get(payload.grantId)
        requireRelation(grant !== undefined && (grant.closed === undefined || grant.closed === payload.reason))
        return { ...state, grants: new Map(state.grants).set(payload.grantId, { ...grant, closed: payload.reason }) }
      }
      case 'knowledge/promoted': {
        records = this.promote(event, state)
        indexKnowledgeRecordsBySource(records.values())
        const creditOwners = new Map(state.creditOwners)
        for (const useId of payload.projection.newlyCreditedUseIds) {
          requireRelation(!creditOwners.has(useId))
          creditOwners.set(useId, `${payload.projection.transition.canonicalKnowledgeId}:${payload.projection.revisionId}`)
        }
        return { ...state, records, creditOwners }
      }
    }
    return { ...state, records }
  }
}
