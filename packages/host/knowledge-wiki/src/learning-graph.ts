/** Read-only validation of the approved candidate-internal learning evidence graph. */

import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { ArtifactRef, EvaluatorEnvelope } from './learning-artifacts.ts'
import { GraphContext, LearningGraphUnavailable, digest, equal, requireRelation, type LearningGraphOwner } from './learning-graph-context.ts'
import * as S from './learning-graph-schema.ts'
import { LearningJournal, admissionFor, admitRecord, type JournalState } from './learning-graph-journal.ts'
import { validateUseSession } from './learning-graph-session.ts'
import { prepareCanonicalTarget } from './canonical-merge.ts'
import { governancePolicyVersion, resolveGovernedWikiPath } from './governance-policy.ts'
import { indexKnowledgeRecordsBySource } from './knowledge-governance.ts'
import { assertPromotionOperationConfined, governanceArchivePath, promotionOperation, promotionTransactionId } from './reviews.ts'
import { immutableReviewRow } from './verifier.ts'
import type { KnowledgeRecord, WikiReviewItem } from './types.ts'
import type { EvaluationInput, MetricComparison, OutcomeRecord, evaluateLearning } from './learning-evaluation.ts'

export type { LearningGraphOwner } from './learning-graph-context.ts'
export { measuredUseFacts } from './learning-graph-context.ts'
export type { LearningAuthorityDescriptorV2 } from './learning-graph-schema.ts'

/** Validated facts are never an activation, successful trial, or committed credit by themselves. */
export type LearningGraphValidation = {
  readonly status: 'validated'
  readonly proposalHash: string
  readonly grantId: string
  readonly trialHash: string
  readonly evaluatedContentHash: string
  readonly candidateKnowledgeId: string
  readonly canonicalKnowledgeId: string
  readonly uniqueCandidateUseIds: readonly string[]
  readonly recomputedCounts: S.MeasuredTrial['counts']
  readonly utilityDelta: number | null
  readonly trialResult: 'pass' | 'fail' | 'unknown'
  readonly uses: readonly { readonly useId: string; readonly variant: 'baseline' | 'candidate'; readonly result: 'pass' | 'fail' | 'unknown' }[]
  readonly evaluation: ReturnType<typeof evaluateLearning>
  readonly creditCommitted: false
  readonly activationAllowed: false
} | { readonly status: 'invalid'; readonly errorCode: 'invalid-learning-graph' }
  | { readonly status: 'unavailable'; readonly errorCode: 'learning-owner-unavailable' }

const object = z.record(z.string(), z.unknown())
const improvements = ['verifiedTaskSuccess', 'repeatedErrorRate', 'knowledgeUtility'] as const
const zero = ['staleRecallRate', 'crossSessionLeakage', 'memoryPrivilegeEscalation', 'memoryPoisoning', 'falseCompletionRate'] as const
const complete = ['repairReuseSuccess', 'conflictDetectionRate', 'conflictEscalationRate', 'replayExplainability'] as const
const requiredMetrics = [...improvements, ...zero, ...complete]

interface Prepared {
  readonly ref: ArtifactRef
  readonly value: S.Proposal
  readonly candidate: KnowledgeRecord
  readonly target: KnowledgeRecord | undefined
  readonly candidateBytes: string
  readonly before: string | undefined
  readonly after: string
}
interface Chain {
  readonly prepared: Prepared
  readonly trial: S.MeasuredTrial
  readonly envelope: EvaluatorEnvelope
  readonly grant: S.Authorization
  readonly uses: readonly S.MeasuredUse[]
  readonly result: Extract<LearningGraphValidation, { status: 'validated' }>
}

/** Reconstruct the existing reducer's input from authenticated receipts, including known failed tasks.
 * @param use - Complete independently signed measured use.
 * @param ref - Exact signed use receipt reference.
 * @param producerId - Selected local journal role identity.
 * @param evaluatorId - Verified external evaluator role identity.
 * @returns The existing reducer's outcome record, preserving every failed or unknown arm.
 */
export function learningEvaluationRecord(use: S.MeasuredUse, ref: ArtifactRef, producerId: string, evaluatorId: string): OutcomeRecord {
  return { pairId: use.pairId, variant: use.variant, model: use.run.model, modelConfigHash: use.run.modelConfigHash,
    taskHash: use.run.taskHash, goalHash: use.run.goalHash, policyHash: use.run.policyHash, producerId, evaluatorId,
    verificationStatus: use.result === 'unknown' || use.oracle.verdict === 'unknown' ? 'unknown' : 'verified',
    evidenceRefs: [`sha256:${ref.digest}`], counts: use.oracle.counts }
}

function scopedResult(evaluation: ReturnType<typeof evaluateLearning>): 'pass' | 'fail' | 'unknown' {
  if (requiredMetrics.some(name => evaluation.metrics[name].status === 'UNKNOWN')) return 'unknown'
  if (improvements.some(name => evaluation.metrics[name].status !== 'IMPROVED')) return 'fail'
  // The complete required-metric gate above excludes UNKNOWN for both groups.
  type KnownMetric = Exclude<MetricComparison, { readonly status: 'UNKNOWN' }>
  for (const name of zero) {
    const metric = evaluation.metrics[name] as KnownMetric
    if (metric.candidate.numerator !== 0) return 'fail'
  }
  for (const name of complete) {
    const metric = evaluation.metrics[name] as KnownMetric
    if (metric.candidate.numerator !== metric.candidate.denominator) return 'fail'
  }
  return 'pass'
}

class LearningGraph {
  readonly journal: LearningJournal
  readonly ctx: GraphContext
  constructor(ctx: GraphContext) {
    this.ctx = ctx
    this.journal = new LearningJournal(ctx, (event, state) => this.promote(event, state))
  }

  proposal(ref: ArtifactRef, atSeq: number): Prepared {
    return this.ctx.json(ref, S.proposal, (value) => {
      requireRelation(equal(value.sourceIdentity, this.ctx.owner.source)
        && value.profile === this.ctx.owner.profile && value.profileDigest === this.ctx.owner.profileDigest
          && equal(value.mission, this.ctx.owner.mission))
      this.ctx.mission(value.mission)
      requireRelation(value.reviewHash === value.review.digest && value.reviewedDecisionHash === digest(value.decision)
        && value.decision.reviewHash === value.reviewHash && value.decision.targetPath === value.targetPath
        && value.decision.policyVersion === governancePolicyVersion() && value.candidateHash === value.candidate.digest
        && value.evaluatedContentHash === value.targetAfter.digest && value.source.sourceHash === value.source.reference.digest)
      const candidatePath = resolveGovernedWikiPath(this.ctx.owner.wikiRoot, value.candidatePath, true)
      const targetPath = resolveGovernedWikiPath(this.ctx.owner.wikiRoot, value.targetPath, true)
      requireRelation(candidatePath !== undefined && candidatePath.relativePath.startsWith('_candidates/')
        && targetPath !== undefined && !targetPath.relativePath.startsWith('_candidates/'))
      const semantic = this.ctx.semantic(value.semanticReceipt)
      this.ctx.json(value.review, object, (review) => {
        requireRelation(equal(review, semantic.request.review) && review['id'] === value.decision.reviewId)
      })
      requireRelation(semantic.request.reviewHash === value.reviewHash && semantic.request.candidateHash === value.candidateHash
        && semantic.request.candidatePath === value.candidatePath && semantic.request.sourceHash === value.source.sourceHash
        && semantic.request.targetPath === value.targetPath && semantic.request.governanceAction === value.decision.action
        && semantic.request.governanceDecision.policyVersion === value.decision.policyVersion)
      requireRelation(value.governedCandidate.watermark.seq <= atSeq)
      const candidate = this.journal.snapshot(value.governedCandidate)
      requireRelation(candidate.id === value.knowledgeId && candidate.source === value.candidatePath
        && candidate.contentHash === value.candidateHash
        && candidate.sourceHash === value.source.sourceHash && equal(candidate.scope, value.scope)
          && equal(candidate.acl ?? null, value.acl)
        && candidate.expiresAt === value.knowledgeExpiresAt)
      const candidateBytes = this.ctx.text(value.candidate)
      requireRelation(candidateBytes === candidate.content)
      this.ctx.resolve(value.source.reference)
      const transition = value.canonicalIdentityTransition
      requireRelation(transition.candidateKnowledgeId === candidate.id
        && transition.candidateAdmissionIdentityHash === value.governedCandidate.admissionIdentityHash)
      const before = value.targetBefore === null ? undefined : this.ctx.text(value.targetBefore)
      let target: KnowledgeRecord | undefined
      if (value.decision.action === 'Promote') {
        requireRelation(value.targetBefore === null && value.targetGovernance.kind === 'verified-absence'
          && transition.kind === 'new-canonical' && transition.canonicalKnowledgeId === candidate.id
            && transition.targetAdmissionIdentityHash === null)
        const sources = indexKnowledgeRecordsBySource(this.journal.stateAt(value.governedCandidate.watermark.seq).records.values())
        requireRelation(!sources.has(value.targetPath))
      } else {
        requireRelation(value.targetBefore !== null && value.targetGovernance.kind === 'existing'
          && value.targetGovernance.governed.watermark.seq <= atSeq)
        target = this.journal.snapshot(value.targetGovernance.governed)
        requireRelation(target.id !== candidate.id && target.source === value.targetPath && target.content === before
          && target.contentHash === value.targetBefore.digest
          && transition.kind === 'update-canonical' && transition.canonicalKnowledgeId === target.id
          && transition.targetAdmissionIdentityHash === value.targetGovernance.governed.admissionIdentityHash)
        requireRelation(equal(target.scope, candidate.scope) && equal(target.acl ?? null, candidate.acl ?? null)
          && (target.claimKey ?? target.source) === (candidate.claimKey ?? candidate.source)
          && target.expiresAt !== null && target.expiresAt <= candidate.expiresAt)
      }
      const base = target ?? candidate
      requireRelation(equal(transition.canonicalScope, base.scope) && equal(transition.canonicalAcl, base.acl ?? null)
        && transition.canonicalExpiresAt === base.expiresAt && transition.canonicalExpiresAt > this.ctx.owner.now)
      this.ctx.json(transition.canonicalProvenance, S.provenance, (provenance) => {
        requireRelation(equal(provenance.candidateRecord, value.governedCandidate.record) && equal(provenance.candidateBytes,
          value.candidate)
          && equal(provenance.candidateSource, value.source) && equal(provenance.targetBytesBefore, value.targetBefore)
          && equal(provenance.targetRecordBefore,
            value.targetGovernance.kind === 'existing' ? value.targetGovernance.governed.record : null)
          && provenance.targetSourceHashBefore === (target?.sourceHash ?? null) && equal(provenance.semanticReceipt, value.semanticReceipt)
          && provenance.reviewedDecisionHash === value.reviewedDecisionHash)
      })
      const after = this.ctx.text(value.targetAfter)
      requireRelation(after === prepareCanonicalTarget({ action: value.decision.action, candidateContent: candidateBytes,
        targetPath: value.targetPath,
        targetBefore: before, reviewedAt: value.decision.reviewedAt, actor: value.decision.actorPrincipalId }))
      return { ref, value, candidate, target, candidateBytes, before, after }
    })
  }

  chain(ref: ArtifactRef, atSeq: number): Chain {
    return this.ctx.envelope(ref, 'measured-trial', S.trial, (trial, envelope) => {
      requireRelation(trial.omittedUses.length === 0 && trial.exclusions.length === 0 && trial.startedAt <= trial.endedAt
        && trial.endedAt <= envelope.issuedAt && trial.reducerSourceHash === this.ctx.owner.reducer.sourceHash)
      return this.ctx.envelope(trial.grant, 'trial-authorization', S.authorization, (grant, grantEnvelope) => {
        requireRelation(trial.startedAt >= grant.notBefore && trial.endedAt <= grant.deadline
          && grant.notBefore <= grant.deadline && grantEnvelope.issuedAt <= grant.notBefore)
        const prepared = this.proposal(grant.proposal, atSeq)
        const proposal = prepared.value
        return this.ctx.envelope(grant.definition, 'measurement-definition', S.definition, (definition, definitionEnvelope) => {
          requireRelation(equal(this.ctx.owner.allowedDefinitions[definition.definitionId], grant.definition)
            && definition.preregisteredAt <= definitionEnvelope.issuedAt && definitionEnvelope.issuedAt <= grant.notBefore)
          this.ctx.owner.artifacts.narrowLimits({ maxArtifactBytes: definition.maxArtifactBytes,
            maxArtifactsPerReceipt: definition.maxArtifacts })
          requireRelation(grant.deadline <= definition.deadline && grant.maxKnowledgeReads <= definition.maxKnowledgeReads
            && grant.maxModelAttempts <= definition.maxModelAttempts && grant.maxTurns <= definition.maxTurns)
          requireRelation(proposal.canonicalIdentityTransition.canonicalExpiresAt <= definition.knowledgeExpiresAt
            && proposal.canonicalIdentityTransition.canonicalExpiresAt <= definition.evidenceExpiresAt
            && definition.evidenceExpiresAt > this.ctx.owner.now && definition.knowledgeExpiresAt > this.ctx.owner.now)
          requireRelation(new Set(definition.requiredMetricNames).size === definition.requiredMetricNames.length
            && requiredMetrics.every(name => definition.requiredMetricNames.includes(name)
              && definition.opportunityDefinitions[name] !== undefined))
          const pairs = new Map<string, S.TrialArm[]>()
          for (const arm of definition.completeOrderedArms) pairs.set(arm.pairId, [...(pairs.get(arm.pairId) ?? []), arm])
          for (const pair of pairs.values()) {
            const [baseline, candidate] = pair
            requireRelation(pair.length === 2 && baseline?.variant === 'baseline' && candidate?.variant === 'candidate'
              && equal(baseline.run, candidate.run) && equal(baseline.frozenTaskWorld, candidate.frozenTaskWorld)
              && equal(baseline.expectedOutputManifest, candidate.expectedOutputManifest))
          }
          for (const artifact of [definition.corpus, definition.oracleDefinition, definition.oracleBuild,
            definition.exclusionRules, definition.safetyProbeManifest,
            ...Object.values(definition.opportunityDefinitions)]) this.ctx.resolve(artifact)
          this.capability(grant, definition)
          const state = this.journal.stateAt(atSeq)
          const recordedGrant = state.grants.get(grant.grantId)
          requireRelation(recordedGrant !== undefined && equal(recordedGrant.ref, trial.grant)
            && (recordedGrant.closed === undefined || recordedGrant.closed === 'complete'))
          const currentCandidate = state.records.get(proposal.knowledgeId)
          requireRelation(currentCandidate !== undefined && equal(admissionFor(currentCandidate),
            proposal.governedCandidate.admissionIdentity))
          const currentSources = indexKnowledgeRecordsBySource(state.records.values())
          // Authenticated replay retains the existing target's canonical source through every subsequent transition.
          const currentTarget = currentSources.get(proposal.targetPath) as KnowledgeRecord
          requireRelation(proposal.targetGovernance.kind === 'verified-absence'
            ? !currentSources.has(proposal.targetPath)
            : equal(admissionFor(currentTarget), proposal.targetGovernance.governed.admissionIdentity))
          const uses: S.MeasuredUse[] = []
          const records: OutcomeRecord[] = []
          const useIds = new Set<string>()
          const sessionIds = new Set<string>()
          const readEvents = new Set<number>()
          requireRelation(trial.allUsesInPreregisteredOrder.length === definition.completeOrderedArms.length)
          for (const [index, arm] of definition.completeOrderedArms.entries()) {
            const useRef = trial.allUsesInPreregisteredOrder[index]
            requireRelation(useRef !== undefined && !useIds.has(arm.useId) && !sessionIds.has(arm.sessionId))
            useIds.add(arm.useId); sessionIds.add(arm.sessionId)
            this.ctx.run(arm.run)
            admitRecord(this.ctx, currentCandidate, arm.sessionId, false)
            if (prepared.target !== undefined) admitRecord(this.ctx, state.records.get(prepared.target.id), arm.sessionId, true)
            this.ctx.resolve(arm.frozenTaskWorld); this.ctx.resolve(arm.expectedOutputManifest)
            this.ctx.envelope(useRef, 'measured-use', S.use, (use, useEnvelope, useRequest) => {
              requireRelation(useRequest?.operation === 'measureUse')
              requireRelation(use.knowledgeId === proposal.knowledgeId
                && use.startedAt >= trial.startedAt && use.endedAt <= trial.endedAt && use.startedAt <= use.endedAt
                && use.endedAt <= useEnvelope.issuedAt && useEnvelope.issuedAt <= envelope.issuedAt)
              requireRelation(use.oracle.oracleDefinitionHash === definition.oracleDefinition.digest
                && use.oracle.oracleBuildHash === definition.oracleBuild.digest)
              requireRelation(equal(state.observedFacts.get(use.useId), useRequest.facts))
              const imported = state.useReceipts.get(use.useId)
              requireRelation(imported === undefined || equal(imported, useRef))
              for (const artifact of [use.initialWorld, use.finalWorld, use.finalOutputManifest, use.exposure.check, use.oracle.execution,
                use.oracle.errorObservations, use.oracle.usageAndCostObservations]) this.ctx.resolve(artifact)
              validateUseSession(this.ctx, use, arm, grant, proposal, state.reservations, (reservation, timestamp) => {
                const nextReadReservation = [...state.reservations.values()].find(row => row.seq > reservation.seq
                  && row.value.phase === 'knowledge-read'
                  && row.value.proposalHash === grant.proposalHash)
                const matches = this.journal.events.filter(event => event.seq > reservation.seq && event.seq <= atSeq
                  && (nextReadReservation === undefined || event.seq < nextReadReservation.seq) && event.timestamp === timestamp
                  && event.knowledgeId === proposal.knowledgeId && event.payload.type === 'knowledge/retrieved')
                requireRelation(matches.length === 1)
                const event = matches[0]
                requireRelation(event !== undefined && !readEvents.has(event.seq))
                readEvents.add(event.seq)
                const beforeRead = this.journal.stateAt(event.seq - 1)
                admitRecord(this.ctx, beforeRead.records.get(proposal.knowledgeId), use.sessionId, false)
                if (prepared.target !== undefined) admitRecord(this.ctx, beforeRead.records.get(prepared.target.id), use.sessionId, true)
              })
              uses.push(use)
              records.push(learningEvaluationRecord(use, useRef, this.ctx.owner.proofs.journalSignerId, useEnvelope.authorityId))
            })
          }
          const extra = [...state.reservations.values()].filter(row => row.value.grantId === grant.grantId && !useIds.has(row.value.useId))
          requireRelation(extra.length === 0)
          const input: EvaluationInput = { schemaVersion: 1, records }
          const counts: S.MeasuredTrial['counts'] = {}
          for (const name of S.metric.options) {
            const values = records.map(row => row.counts[name])
            if (values.some(value => value === undefined)) continue
            const total = { baseline: { numerator: 0, denominator: 0 }, candidate: { numerator: 0, denominator: 0 } }
            for (const row of records) {
              const count = row.counts[name]
              requireRelation(count !== undefined)
              const arm = total[row.variant]
              arm.numerator = S.integer.parse(arm.numerator + count.numerator)
              arm.denominator = S.integer.parse(arm.denominator + count.denominator)
            }
            counts[name] = total
          }
          requireRelation(equal(counts, trial.counts))
          this.ctx.json(trial.evaluationInput, object, (value) => { requireRelation(equal(value, input)) })
          const evaluation = this.ctx.owner.reducer.evaluate(input)
          this.ctx.json(trial.evaluationOutput, object, (value) => { requireRelation(equal(value, evaluation)) })
          const trialResult = scopedResult(evaluation)
          requireRelation(trial.result === trialResult)
          const utility = evaluation.metrics.knowledgeUtility
          const result: Extract<LearningGraphValidation, { status: 'validated' }> = {
            status: 'validated', proposalHash: trial.proposalHash, grantId: grant.grantId, trialHash: ref.digest,
            evaluatedContentHash: trial.evaluatedContentHash, candidateKnowledgeId: proposal.knowledgeId,
            canonicalKnowledgeId: proposal.canonicalIdentityTransition.canonicalKnowledgeId,
            uniqueCandidateUseIds: uses.filter(use => use.variant === 'candidate' && use.result === 'pass'
              && use.oracle.applicableRepair === 'pass' && use.oracle.correctRepairReuse === 'pass'
                && use.oracle.taskSuccess === 'pass').map(use => use.useId),
            recomputedCounts: counts, utilityDelta: utility.status === 'UNKNOWN' ? null : utility.delta, trialResult,
            uses: uses.map(use => ({ useId: use.useId, variant: use.variant, result: use.result })), evaluation,
            creditCommitted: false, activationAllowed: false,
          }
          return { prepared, trial, envelope, grant, uses, result }
        })
      })
    })
  }

  private capability(grant: S.Authorization, definition: S.Definition): void {
    requireRelation(this.ctx.owner.allowedInitiationCapabilities.some(ref => equal(ref, grant.initiationCapability)))
    this.ctx.envelope(grant.initiationCapability, 'trial-initiation-capability', S.capability, (value, envelope) => {
      requireRelation(envelope.issuedAt <= grant.notBefore && value.reviewedAt <= grant.notBefore
        && value.reviewedAt >= definition.preregisteredAt)
      this.ctx.resolve(value.userApproval)
    })
  }

  private promote(event: S.JournalEvent, state: JournalState): ReadonlyMap<string, KnowledgeRecord> {
    requireRelation(event.payload.type === 'knowledge/promoted')
    const payload = event.payload
    const chain = this.chain(payload.trial, event.seq - 1)
    const p = chain.prepared.value
    requireRelation(chain.result.trialResult === 'pass' && chain.result.utilityDelta !== null && chain.result.utilityDelta > 0
      && equal(payload.proposal, chain.prepared.ref) && equal(payload.projection.transition, p.canonicalIdentityTransition)
      && event.knowledgeId === p.canonicalIdentityTransition.canonicalKnowledgeId && equal(event.scope, p.scope)
      && payload.projection.revisionId === digest({ kind: 'ark.knowledge.canonical-revision', canonicalKnowledgeId: event.knowledgeId,
        proposalHash: payload.proposal.digest, targetAfterHash: p.targetAfter.digest })
      && equal(payload.projection.newlyCreditedUseIds, chain.result.uniqueCandidateUseIds))
    this.validateWal(payload.wal, chain, event, payload.trial)
    const candidate = state.records.get(p.knowledgeId)
    const base = state.records.get(event.knowledgeId)
    requireRelation(candidate !== undefined && base !== undefined)
    const canonical = this.ctx.json(payload.projection.canonicalRecordAfter, S.record)
    requireRelation(canonical.id === event.knowledgeId && canonical.source === p.targetPath && canonical.content === chain.prepared.after
      && canonical.contentHash === p.evaluatedContentHash
        && canonical.sourceHash === p.canonicalIdentityTransition.canonicalProvenance.digest
      && equal(canonical.scope, base.scope) && equal(canonical.acl ?? null, base.acl ?? null) && canonical.claimKey === base.claimKey
      && canonical.createdAt === base.createdAt && canonical.expiresAt === base.expiresAt && canonical.lifecycle === 'canonical'
      && canonical.verificationStatus === 'verified' && canonical.conflicts.length === 0
        && canonical.authority === this.ctx.owner.proofs.evaluatorAuthorityId
      && canonical.confidence > 0 && canonical.confidence <= Math.min(candidate.confidence, base.confidence)
      && ['low', 'medium', 'high'].indexOf(canonical.trust) <= Math.min(1,
        ['low', 'medium', 'high'].indexOf(candidate.trust), ['low', 'medium', 'high'].indexOf(base.trust))
      && canonical.lastVerifiedAt === chain.envelope.issuedAt && canonical.retrievalHits === base.retrievalHits
        && canonical.userCorrections === base.userCorrections
      && canonical.successfulUses === S.integer.parse(base.successfulUses + chain.result.uniqueCandidateUseIds.length)
      && canonical.utilityScore === chain.result.utilityDelta)
    const priorEvidence = [...new Set([...candidate.evidenceRefs, ...base.evidenceRefs])]
    requireRelation(priorEvidence.every((ref, index) => canonical.evidenceRefs[index] === ref)
      && new Set(canonical.evidenceRefs).size === canonical.evidenceRefs.length)
    const candidateAfter = this.ctx.json(payload.projection.candidateRecordAfter, S.record)
    const records = new Map(state.records).set(canonical.id, canonical)
    if (candidate.id === canonical.id) {
      requireRelation(payload.projection.candidateDisposition === 'same-id-promoted' && equal(candidateAfter, canonical))
    } else {
      requireRelation(payload.projection.candidateDisposition === 'absorbed-by-canonical-revision'
        && equal(candidateAfter, { ...candidate, verificationStatus: 'rejected', lifecycle: 'downgraded' }))
      records.set(candidate.id, candidateAfter)
    }
    return records
  }

  private validateWal(ref: ArtifactRef, chain: Chain, event: S.JournalEvent, actualTrial: ArtifactRef): void {
    this.ctx.json(ref, S.wal, (wal) => {
      const p = chain.prepared.value
      requireRelation(equal(wal.proposal, chain.prepared.ref) && equal(wal.measuredTrial, actualTrial)
        && equal(wal.semanticReceipt, p.semanticReceipt) && wal.action === p.decision.action
        && wal.createdAt <= event.timestamp && wal.createdAt >= chain.trial.endedAt
        && wal.id === promotionTransactionId(p.decision.reviewId, p.candidateHash, wal.createdAt)
        && wal.operationSetHash === digest(wal.operations) && wal.journalHeadBefore.seq < event.seq)
      this.journal.watermark(wal.journalHeadBefore)
      const { seal, ...core } = wal
      const signed = this.ctx.owner.proofs.verifyJournalEnvelope(seal, 'promotion-wal')
      requireRelation(equal(signed.payload, { walCoreHash: digest(core) }))
      const roles = wal.action === 'Promote' ? ['candidate-archive', 'canonical', 'review', 'governance',
        'candidate'] : ['canonical-archive', 'candidate-archive', 'canonical', 'review', 'governance', 'candidate']
      requireRelation(wal.operations.length === roles.length
        && new Set(wal.operations.map(operation => resolve(operation.path))).size === roles.length)
      const candidate = resolveGovernedWikiPath(this.ctx.owner.wikiRoot, p.candidatePath, true)
      const target = resolveGovernedWikiPath(this.ctx.owner.wikiRoot, p.targetPath, true)
      requireRelation(candidate !== undefined && target !== undefined)
      const paths = {
        candidate: candidate.absolutePath, canonical: target.absolutePath, review: this.ctx.owner.reviewFile,
        governance: join(dirname(this.ctx.owner.reviewFile), 'governance.jsonl'),
        'candidate-archive': governanceArchivePath(this.ctx.owner.archiveRoot, dirname(this.ctx.owner.wikiRoot),
          wal.createdAt, p.candidateHash, p.candidatePath, 'candidate'),
        'canonical-archive': governanceArchivePath(this.ctx.owner.archiveRoot, dirname(this.ctx.owner.wikiRoot),
          wal.createdAt, p.targetBefore?.digest ?? '', p.targetPath, 'canonical-before-update'),
      }
      for (const [index, operation] of wal.operations.entries()) {
        requireRelation(operation.role === roles[index] && operation.path === paths[operation.role])
        const expected = promotionOperation(wal.id, index, operation.role, operation.path, operation.before ?? undefined,
          operation.after ?? undefined)
        requireRelation(operation.stagingPath === (expected.stagingPath ?? null)
          && operation.tombstonePath === (expected.tombstonePath ?? null))
        assertPromotionOperationConfined(expected, this.ctx.owner.reviewFile, this.ctx.owner.wikiRoot, this.ctx.owner.archiveRoot)
        if (operation.role === 'candidate') requireRelation(operation.before === chain.prepared.candidateBytes && operation.after === null)
        if (operation.role === 'candidate-archive') requireRelation(operation.before === null
          && operation.after === chain.prepared.candidateBytes)
        if (operation.role === 'canonical-archive') requireRelation(operation.before === null && operation.after === chain.prepared.before)
        if (operation.role === 'canonical') requireRelation(operation.before === (chain.prepared.before ?? null)
          && operation.after === chain.prepared.after)
        if (operation.role === 'review') {
          requireRelation(operation.before !== null && operation.after !== null)
          const reviews = z.array(object).parse(JSON.parse(operation.before) as unknown)
          const matches = reviews.filter(row => row['id'] === p.decision.reviewId)
          requireRelation(matches.length === 1)
          const item = matches[0]
          requireRelation(item !== undefined && item['resolved'] === false
            && digest(immutableReviewRow(item as unknown as WikiReviewItem)) === p.reviewHash)
          const resolved = reviews.map(row => row === item ? { ...row, resolved: true, resolvedAction: wal.action,
            appliedPath: p.targetPath, resolvedAt: Date.parse(wal.createdAt) } : row)
          requireRelation(operation.after === JSON.stringify(resolved, null, 2))
        }
        if (operation.role === 'governance') {
          const entry = { timestamp: wal.createdAt, policyVersion: governancePolicyVersion(), reviewId: p.decision.reviewId,
            action: wal.action,
            actor: p.decision.actorPrincipalId, outcome: 'applied', candidateHash: p.candidateHash,
            previousCanonicalHash: p.targetBefore?.digest ?? '', targetPath: p.targetPath, appliedPath: p.targetPath }
          requireRelation(operation.after === `${operation.before ?? ''}${JSON.stringify(entry)}\n`)
        }
      }
    })
  }
}

/**
 * Validate one complete learning graph against freshly captured owner context without writing, granting access, or dispatching.
 * @param trialRef - Exact content-addressed measured-trial envelope.
 * @param owner - Selected product/public-proof owners; absence is explicitly unavailable.
 * @returns Authenticated graph relations and recomputed measurements, or a generic failure without private source values.
 */
export function validateLearningGraph(trialRef: ArtifactRef, owner: LearningGraphOwner | undefined): LearningGraphValidation {
  if (owner === undefined) return { status: 'unavailable', errorCode: 'learning-owner-unavailable' }
  let context: GraphContext | undefined
  try {
    context = new GraphContext(owner)
    const graph = new LearningGraph(context)
    // The full current journal and this independent root both have complete typed descent.
    // Semantic rereads below still charge the same traversal, without repeating discovery.
    context.envelope(trialRef, 'measured-trial', S.trial, value => value)
    context.finishReferenceValidation()
    graph.journal.stateAt(owner.currentJournal.protectedHead.seq)
    const result = graph.chain(trialRef, owner.currentJournal.protectedHead.seq).result
    owner.artifacts.narrowLimits({})
    return result
  } catch (error) {
    return error instanceof LearningGraphUnavailable || context?.ownerInputUnavailable === true
      ? { status: 'unavailable', errorCode: 'learning-owner-unavailable' }
      : { status: 'invalid', errorCode: 'invalid-learning-graph' }
  }
}
