/** Operation-local inputs and bounded reads shared by the read-only graph validators. */

import type { z } from 'zod'
import { canonicalLearningJson, decodeCanonicalJson, type ArtifactRef, type EvaluatorEnvelope, type EvaluatorKind, type LearningArtifactTraversal, type LearningPublicProofs } from './learning-artifacts.ts'
import type { KnowledgeAccessContext } from './knowledge-governance.ts'
import type { EvaluationInput, evaluateLearning } from './learning-evaluation.ts'
import type { KnowledgeWikiSourceIdentity, TrustedVerificationReceipt } from './verifier.ts'
import { sha256 } from './verifier.ts'
import * as S from './learning-graph-schema.ts'
import { visitLearningPayloadEdges } from './learning-graph-edges.ts'

/** Captured by the selected product owner afresh for each validation, never decoded from a receipt. */
export interface LearningGraphOwner {
  readonly artifacts: LearningArtifactTraversal
  readonly proofs: LearningPublicProofs
  readonly now: string
  readonly projectId: string
  readonly source: KnowledgeWikiSourceIdentity
  readonly profile: string
  readonly profileDigest: string
  readonly mission: S.SuccessorBinding
  readonly allowedDefinitions: Readonly<Record<string, ArtifactRef>>
  readonly allowedInitiationCapabilities: readonly ArtifactRef[]
  readonly wikiRoot: string
  readonly reviewFile: string
  readonly archiveRoot: string
  readonly currentJournal: {
    readonly artifact: ArtifactRef
    readonly protectedHead: { readonly epoch: string; readonly seq: number; readonly eventHash: string; readonly prefixHash: string }
  }
  readonly sessionContexts: ReadonlyMap<string, KnowledgeAccessContext>
  readonly reducer: { readonly sourceHash: string; readonly evaluate: (input: EvaluationInput) => ReturnType<typeof evaluateLearning> }
  validateSemanticReceipt(raw: unknown): TrustedVerificationReceipt | undefined
}

/** Missing selected owner input; this is distinct from a malformed evidence graph. */
export class LearningGraphUnavailable extends Error {
  constructor() { super('learning graph owner input unavailable') }
}

/** Assert a relation without exposing artifact contents in an error.
 * @param value - Relation that must hold.
 * @returns Normally only when the relation holds; otherwise throws a generic error.
 */
export function requireRelation(value: unknown): asserts value {
  if (!value) throw new Error('invalid learning graph relation')
}

/** Compare complete JSON values, retaining optional-field and array-order distinctions.
 * @param left - First complete value.
 * @param right - Second complete value.
 * @returns Whether their canonical JSON bytes are identical.
 */
export function equal(left: unknown, right: unknown): boolean {
  return canonicalLearningJson(left) === canonicalLearningJson(right)
}

/** Hash an already validated canonical object.
 * @param value - Complete canonical JSON value.
 * @returns Its lowercase SHA-256 digest.
 */
export function digest(value: unknown): string { return sha256(canonicalLearningJson(value)) }

/** Decode original UTF-8 without changing its BOM, whitespace, or line endings.
 * @param bytes - Authenticated original bytes.
 * @returns The exact losslessly decoded text.
 */
export function originalText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  requireRelation(Buffer.from(text, 'utf8').equals(Buffer.from(bytes)))
  return text
}

/** Product-owned input projection; the external oracle supplies verdicts separately.
 * @param use - Complete independently signed measured use.
 * @returns The exact supported product facts preimage, without oracle or result.
 */
export function measuredUseFacts(use: S.MeasuredUse): Omit<S.MeasuredUse, 'oracle' | 'result'> {
  const { oracle: _oracle, result: _result, ...facts } = use
  return facts
}

/** One operation's artifact, proof, and semantic-owner access. No method writes or launches work. */
export class GraphContext {
  private traverseReferences = true
  /** Selected operation-local owners; no receipt can replace them. */
  readonly owner: LearningGraphOwner
  /** Set only when selected protected context is absent, even if a bounded read sanitizes the thrown error. */
  ownerInputUnavailable = false
  constructor(owner: LearningGraphOwner) {
    this.owner = owner
    const captured: Partial<LearningGraphOwner> = owner
    const journal: Partial<LearningGraphOwner['currentJournal']> | undefined = captured.currentJournal
    if (journal?.protectedHead === undefined || journal.artifact === undefined
      || captured.sessionContexts === undefined || typeof captured.sessionContexts.get !== 'function'
      || !owner.wikiRoot || !owner.reviewFile || !owner.archiveRoot || !owner.now || !owner.projectId) throw new LearningGraphUnavailable()
    S.time.parse(owner.now)
    S.sourceIdentity.parse(owner.source)
    S.mission.parse(owner.mission)
    S.hash.parse(owner.reducer.sourceHash)
    requireRelation(owner.projectId !== '' && owner.profile !== '')
  }

  /** Mark a missing selected owner input and stop validation.
   * @returns Never; always throws the unavailable owner marker.
   */
  unavailable(): never {
    this.ownerInputUnavailable = true
    throw new LearningGraphUnavailable()
  }

  /** End the mandatory complete reference stage before semantic replay, preserving every consumed budget. */
  finishReferenceValidation(): void {
    requireRelation(this.traverseReferences)
    this.owner.artifacts.narrowLimits({})
    this.traverseReferences = false
  }

  /** Read canonical JSON through its exact payload owner.
   * @param ref - Authenticated artifact reference.
   * @param schema - Closed schema for this reference position.
   * @param visit - Optional semantic operation on the validated payload.
   * @returns The payload or semantic operation result.
   */
  json<T, R = T>(ref: ArtifactRef, schema: z.ZodType<T>, visit?: (value: T) => R): R {
    requireRelation(ref.mediaType === 'application/json')
    const value = this.owner.artifacts.visit(ref, (bytes) => {
      const value = schema.parse(decodeCanonicalJson(bytes))
      if (this.traverseReferences) visitLearningPayloadEdges(this, schema, value)
      return value
    })
    const result = visit === undefined ? value as unknown as R : visit(value)
    this.owner.artifacts.narrowLimits({})
    return result
  }

  /** Read lossless original text without canonicalizing its bytes.
   * @param ref - Exact original artifact reference.
   * @returns Original UTF-8 text.
   */
  text(ref: ArtifactRef): string { return this.owner.artifacts.visit(ref, originalText) }

  /** Resolve an externally owned opaque leaf without inventing its producer schema.
   * @param ref - Exact nonempty leaf artifact reference.
   */
  resolve(ref: ArtifactRef): void {
    this.owner.artifacts.visit(ref, (bytes) => {
      requireRelation(bytes.byteLength > 0)
      if (ref.mediaType !== 'application/octet-stream') originalText(bytes)
    })
  }

  /** Verify one role-bound envelope and its original child request.
   * @param ref - Exact signed envelope artifact.
   * @param kind - Required evaluator operation domain.
   * @param schema - Closed payload schema for that domain.
   * @param visit - Semantic operation on the authenticated payload and request.
   * @returns The semantic operation result.
   */
  envelope<T, R>(ref: ArtifactRef, kind: EvaluatorKind, schema: z.ZodType<T>,
    visit: (value: T, envelope: EvaluatorEnvelope, request: S.ChildRequest | null) => R): R {
    requireRelation(ref.mediaType === 'application/json' && ref.bytes <= this.owner.artifacts.limits.maxChildResponseBytes)
    const parsed = this.owner.artifacts.visit(ref, (bytes) => {
      const envelope = this.owner.proofs.verifyEvaluatorEnvelope(decodeCanonicalJson(bytes), kind, this.owner.now)
      const value = schema.parse(envelope.payload)
      let request: S.ChildRequest | null = null
      if (envelope.requestArtifact !== null) {
        requireRelation(envelope.requestArtifact.digest === envelope.requestHash
          && envelope.requestArtifact.bytes <= this.owner.artifacts.limits.maxChildRequestBytes)
        request = this.json(envelope.requestArtifact, S.childRequest)
      }
      this.requestBinding(kind, value, request)
      if (this.traverseReferences) visitLearningPayloadEdges(this, schema, value)
      return { value, envelope, request }
    })
    const result = visit(parsed.value, parsed.envelope, parsed.request)
    this.owner.artifacts.narrowLimits({})
    return result
  }

  private requestBinding(kind: EvaluatorKind, value: unknown, request: S.ChildRequest | null): void {
    switch (kind) {
      case 'trial-initiation-capability':
      case 'measurement-definition':
        requireRelation(request === null)
        return
      case 'trial-authorization': {
        const grant = S.authorization.parse(value)
        requireRelation(request?.operation === 'authorizeTrial' && equal(request.proposal, grant.proposal)
          && equal(request.initiationCapability, grant.initiationCapability) && grant.proposalHash === grant.proposal.digest)
        const proposal = this.jsonNode(grant.proposal, S.proposal)
        const definition = this.evaluatorNode(grant.definition, 'measurement-definition', S.definition).value
        const capability = this.evaluatorNode(grant.initiationCapability, 'trial-initiation-capability', S.capability).value
        requireRelation(grant.definitionHash === grant.definition.digest && request.definitionId === definition.definitionId
          && equal(grant.sessionArms, definition.completeOrderedArms) && grant.evaluatedContentHash === proposal.evaluatedContentHash
          && equal(grant.semanticReceipt, proposal.semanticReceipt) && grant.reviewedDecisionHash === proposal.reviewedDecisionHash
          && equal(grant.scope, proposal.scope))
        requireRelation(capability.projectId === this.owner.projectId && capability.profileDigest === proposal.profileDigest
          && equal(capability.sourceIdentity, proposal.sourceIdentity) && capability.reviewId === proposal.decision.reviewId
          && capability.reviewHash === proposal.reviewHash && capability.candidateHash === proposal.candidateHash
          && capability.targetPath === proposal.targetPath && capability.targetBeforeHash === (proposal.targetBefore?.digest ?? null)
          && capability.action === proposal.decision.action && capability.definitionId === definition.definitionId
          && capability.definitionHash === grant.definitionHash
          && capability.approvedActorPrincipalId === proposal.decision.actorPrincipalId
          && capability.reviewedAt === proposal.decision.reviewedAt
          && capability.candidateAdmissionIdentityHash === proposal.governedCandidate.admissionIdentityHash
          && capability.targetAdmissionIdentityHash === proposal.canonicalIdentityTransition.targetAdmissionIdentityHash
          && grant.initiationCapability.digest === proposal.decision.initiationCapabilityHash)
        return
      }
      case 'measured-use': {
        const use = S.use.parse(value)
        requireRelation(request?.operation === 'measureUse' && request.useId === use.useId && use.result === use.oracle.verdict)
        const grant = this.evaluatorNode(request.grant, 'trial-authorization', S.authorization).value
        this.grantIdentity(grant, use)
        this.useArm(grant, use)
        requireRelation(equal(this.jsonNode(request.facts, S.useFacts), measuredUseFacts(use)))
        return
      }
      case 'measured-trial': {
        const trial = S.trial.parse(value)
        requireRelation(request?.operation === 'measureTrial' && equal(request.grant, trial.grant)
          && equal(request.useReceipts, trial.allUsesInPreregisteredOrder))
        const grant = this.evaluatorNode(trial.grant, 'trial-authorization', S.authorization).value
        this.grantIdentity(grant, trial)
        requireRelation(trial.allUsesInPreregisteredOrder.length === grant.sessionArms.length)
        for (const [index, ref] of trial.allUsesInPreregisteredOrder.entries()) {
          const use = this.evaluatorNode(ref, 'measured-use', S.use)
          requireRelation(use.request?.operation === 'measureUse' && equal(use.request.grant, request.grant))
          this.grantIdentity(grant, use.value)
          requireRelation(this.useArm(grant, use.value) === grant.sessionArms[index])
        }
      }
    }
  }

  private grantIdentity(grant: S.Authorization, value: S.MeasuredUse | S.MeasuredTrial): void {
    requireRelation(value.grantId === grant.grantId && value.proposalHash === grant.proposalHash
      && value.evaluatedContentHash === grant.evaluatedContentHash && value.definitionHash === grant.definitionHash)
  }

  private useArm(grant: S.Authorization, use: S.MeasuredUse): S.TrialArm {
    const matches = grant.sessionArms.filter(arm => arm.useId === use.useId)
    const arm = matches[0]
    requireRelation(matches.length === 1 && arm !== undefined && use.pairId === arm.pairId
      && use.variant === arm.variant && use.sessionId === arm.sessionId && equal(use.run, arm.run)
      && equal(use.initialWorld, arm.frozenTaskWorld))
    return arm
  }

  // Relationship reads do not rediscover descendants. The mandatory reference stage owns
  // every edge; these additional original-node reads still consume the same byte/edge budget.
  private jsonNode<T>(ref: ArtifactRef, schema: z.ZodType<T>): T {
    requireRelation(ref.mediaType === 'application/json')
    return this.owner.artifacts.visit(ref, bytes => schema.parse(decodeCanonicalJson(bytes)))
  }

  private evaluatorNode<T>(ref: ArtifactRef, kind: EvaluatorKind, schema: z.ZodType<T>): {
    readonly value: T
    readonly request: S.ChildRequest | null
  } {
    requireRelation(ref.mediaType === 'application/json' && ref.bytes <= this.owner.artifacts.limits.maxChildResponseBytes)
    return this.owner.artifacts.visit(ref, (bytes) => {
      const envelope = this.owner.proofs.verifyEvaluatorEnvelope(decodeCanonicalJson(bytes), kind, this.owner.now)
      let request: S.ChildRequest | null = null
      if (envelope.requestArtifact !== null) {
        requireRelation(envelope.requestArtifact.digest === envelope.requestHash
          && envelope.requestArtifact.bytes <= this.owner.artifacts.limits.maxChildRequestBytes)
        request = this.jsonNode(envelope.requestArtifact, S.childRequest)
      }
      return { value: schema.parse(envelope.payload), request }
    })
  }

  /** Reuse the original semantic receipt owner against frozen original JSON.
   * @param ref - Original semantic v2 receipt artifact.
   * @returns The selected authority's coherent passing receipt.
   */
  semantic(ref: ArtifactRef): TrustedVerificationReceipt {
    requireRelation(ref.mediaType === 'application/json')
    return this.owner.artifacts.visit(ref, (bytes) => {
      // Semantic v2 retains its original JSON bytes and proof preimage, including pretty JSON.
      const receipt = this.owner.validateSemanticReceipt(JSON.parse(originalText(bytes)) as unknown)
      requireRelation(receipt !== undefined && receipt.result.result === 'pass')
      requireRelation(equal(receipt.request.sourceIdentity, this.owner.source))
      return receipt
    })
  }

  /** Bind a captured run to the selected source, profile, project and mission.
   * @param value - Captured complete run binding.
   */
  run(value: S.TrialArm['run']): void {
    requireRelation(value.projectId === this.owner.projectId && value.profile === this.owner.profile
      && value.profileDigest === this.owner.profileDigest && equal(value.source, this.owner.source)
      && equal(value.mission, this.owner.mission) && value.goalHash === this.owner.mission.original.goalHash)
    this.mission(value.mission)
  }

  /** Resolve the retained global manifest and preserve all original immutable fields.
   * @param value - Selected candidate-internal successor binding.
   */
  mission(value: S.SuccessorBinding): void {
    this.owner.artifacts.visit(value.originalManifest, (bytes) => {
      const manifest = JSON.parse(originalText(bytes)) as {
        schemaVersion?: unknown
        immutable?: unknown
        projectId?: unknown
        profile?: unknown
      }
      requireRelation(manifest.schemaVersion === 1 && typeof manifest.projectId === 'string' && typeof manifest.profile === 'string'
        && equal(S.originalImmutable.parse(manifest.immutable), value.original))
    })
  }
}
