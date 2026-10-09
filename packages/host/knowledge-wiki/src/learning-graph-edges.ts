/** Resolve every declared protocol reference edge; opaque external values remain bounded leaves. */

import { z } from 'zod'
import type { ArtifactRef, EvaluatorKind } from './learning-artifacts.ts'
import type { GraphContext } from './learning-graph-context.ts'
import * as S from './learning-graph-schema.ts'

const jsonObject = z.record(z.string(), z.unknown())

function assertNever(_value: never): never { throw new Error('unsupported learning protocol payload') }

function envelope<T>(ctx: GraphContext, ref: ArtifactRef, kind: EvaluatorKind, schema: z.ZodType<T>): void {
  ctx.envelope(ref, kind, schema, value => value)
}

function watermark(ctx: GraphContext, value: z.infer<typeof S.watermark>): void {
  // Prefix bytes are a retained journal leaf; decoding its events again would invent a cyclic history edge.
  ctx.text(value.journalPrefix)
}

function snapshot(ctx: GraphContext, value: S.GovernedSnapshot): void {
  ctx.json(value.record, S.record)
  watermark(ctx, value.watermark)
}

function transition(ctx: GraphContext, value: z.infer<typeof S.transition>): void {
  ctx.json(value.canonicalProvenance, S.provenance)
}

function arm(ctx: GraphContext, value: S.TrialArm): void {
  ctx.mission(value.run.mission)
  ctx.resolve(value.frozenTaskWorld)
  ctx.resolve(value.expectedOutputManifest)
}

function injection(ctx: GraphContext, value: z.infer<typeof S.injection>): void {
  for (const reference of [value.toolCall, value.retrieved, value.injected, value.toolResult]) {
    ctx.json(reference.sessionPrefix, S.sessionPrefix)
  }
  ctx.text(value.renderedToolResult)
}

function useFacts(ctx: GraphContext, value: z.infer<typeof S.useFacts>): void {
  ctx.mission(value.run.mission)
  for (const ref of [value.initialWorld, value.finalWorld, value.finalOutputManifest, value.exposure.check]) ctx.resolve(ref)
  ctx.json(value.completeSession, S.sessionPrefix)
  for (const ref of value.requests) ctx.json(ref, S.providerRequest)
  for (const valueInjection of value.injections) injection(ctx, valueInjection)
}

function observation(ctx: GraphContext, value: z.infer<typeof S.observation>): void {
  for (const ref of [value.execution, value.errorObservations, value.usageAndCostObservations]) ctx.resolve(ref)
}

function projection(ctx: GraphContext, value: z.infer<typeof S.projection>): void {
  transition(ctx, value.transition)
  ctx.json(value.canonicalRecordAfter, S.record)
  ctx.json(value.candidateRecordAfter, S.record)
}

function journalEvent(ctx: GraphContext, event: S.JournalEvent): void {
  const value = event.payload
  switch (value.type) {
    case 'knowledge/journal-started':
      if (value.legacyLog !== null) ctx.resolve(value.legacyLog)
      return
    case 'knowledge/trial-authorized':
      envelope(ctx, value.grant, 'trial-authorization', S.authorization)
      ctx.json(value.proposal, S.proposal)
      return
    case 'knowledge/use-observed':
      ctx.json(value.factManifest, S.useFacts)
      return
    case 'knowledge/use-measured':
      envelope(ctx, value.receipt, 'measured-use', S.use)
      return
    case 'knowledge/trial-measured':
      envelope(ctx, value.receipt, 'measured-trial', S.trial)
      return
    case 'knowledge/verified':
      ctx.semantic(value.semanticReceipt)
      ctx.json(value.recordSnapshot, S.record)
      return
    case 'knowledge/promoted':
      ctx.json(value.proposal, S.proposal)
      envelope(ctx, value.trial, 'measured-trial', S.trial)
      ctx.json(value.wal, S.wal)
      projection(ctx, value.projection)
      return
    case 'knowledge/rejected':
    case 'knowledge/conflict':
    case 'knowledge/expired':
    case 'knowledge/rolled_back':
      ctx.resolve(value.evidence)
      return
    case 'knowledge/trial-consumed':
    case 'knowledge/trial-closed':
    case 'knowledge/observed':
    case 'knowledge/candidate':
    case 'knowledge/retrieved':
    case 'knowledge/injected':
      return
    default: return assertNever(value)
  }
}

/**
 * Traverse references declared by an already parsed protocol schema inside its artifact visit.
 * Every occurrence resolves again through the same traversal; equality and prior reads waive no budget.
 * Session events, semantic v2 objects, provider values and external worlds are not recursively interpreted as protocol.
 * @param ctx - Operation-local bounded read owner; JSON/envelope reads recursively invoke this walker.
 * @param schema - Exact owning schema used to parse value; schemas with no declared reference fields are leaves.
 * @param value - Value already parsed by schema at the durable boundary.
 */
export function visitLearningPayloadEdges(ctx: GraphContext, schema: z.ZodType, value: unknown): void {
  if (schema === S.proposal) {
    const proposal = value as S.Proposal
    ctx.json(proposal.review, jsonObject)
    ctx.semantic(proposal.semanticReceipt)
    snapshot(ctx, proposal.governedCandidate)
    ctx.text(proposal.candidate)
    ctx.resolve(proposal.source.reference)
    if (proposal.targetBefore !== null) ctx.text(proposal.targetBefore)
    if (proposal.targetGovernance.kind === 'existing') snapshot(ctx, proposal.targetGovernance.governed)
    transition(ctx, proposal.canonicalIdentityTransition)
    ctx.text(proposal.targetAfter)
    ctx.mission(proposal.mission)
  } else if (schema === S.provenance) {
    const provenance = value as z.infer<typeof S.provenance>
    ctx.json(provenance.candidateRecord, S.record)
    ctx.text(provenance.candidateBytes)
    ctx.resolve(provenance.candidateSource.reference)
    if (provenance.targetRecordBefore !== null) ctx.json(provenance.targetRecordBefore, S.record)
    if (provenance.targetBytesBefore !== null) ctx.text(provenance.targetBytesBefore)
    ctx.semantic(provenance.semanticReceipt)
  } else if (schema === S.authorization) {
    const grant = value as S.Authorization
    envelope(ctx, grant.initiationCapability, 'trial-initiation-capability', S.capability)
    ctx.json(grant.proposal, S.proposal)
    ctx.semantic(grant.semanticReceipt)
    envelope(ctx, grant.definition, 'measurement-definition', S.definition)
    for (const sessionArm of grant.sessionArms) arm(ctx, sessionArm)
  } else if (schema === S.definition) {
    const definition = value as S.Definition
    for (const ref of [definition.corpus, definition.oracleDefinition, definition.oracleBuild, definition.exclusionRules,
      definition.safetyProbeManifest, ...Object.values(definition.opportunityDefinitions)]) ctx.resolve(ref)
    for (const sessionArm of definition.completeOrderedArms) arm(ctx, sessionArm)
  } else if (schema === S.capability) {
    ctx.resolve((value as z.infer<typeof S.capability>).userApproval)
  } else if (schema === S.use || schema === S.useFacts) {
    useFacts(ctx, value as z.infer<typeof S.useFacts>)
    if (schema === S.use) observation(ctx, (value as S.MeasuredUse).oracle)
  } else if (schema === S.trial) {
    const trial = value as S.MeasuredTrial
    envelope(ctx, trial.grant, 'trial-authorization', S.authorization)
    for (const ref of trial.allUsesInPreregisteredOrder) envelope(ctx, ref, 'measured-use', S.use)
    for (const exclusion of trial.exclusions) {
      ctx.resolve(exclusion.rule)
      ctx.resolve(exclusion.evidence)
    }
    ctx.json(trial.evaluationInput, jsonObject)
    ctx.json(trial.evaluationOutput, jsonObject)
  } else if (schema === S.childRequest) {
    const request = value as S.ChildRequest
    switch (request.operation) {
      case 'authorizeTrial':
        ctx.json(request.proposal, S.proposal)
        envelope(ctx, request.initiationCapability, 'trial-initiation-capability', S.capability)
        return
      case 'measureUse':
        envelope(ctx, request.grant, 'trial-authorization', S.authorization)
        ctx.json(request.facts, S.useFacts)
        return
      case 'measureTrial':
        envelope(ctx, request.grant, 'trial-authorization', S.authorization)
        for (const ref of request.useReceipts) envelope(ctx, ref, 'measured-use', S.use)
        return
      default: return assertNever(request)
    }
  } else if (schema === S.providerRequest) {
    const request = value as S.ProviderRequest
    ctx.json(request.sessionPrefix, S.sessionPrefix)
    ctx.json(request.providerInput, jsonObject)
    ctx.text(request.requestBody)
  } else if (schema === S.journalEvent) {
    journalEvent(ctx, value as S.JournalEvent)
  } else if (schema === S.wal) {
    const wal = value as S.PromotionWal
    ctx.json(wal.proposal, S.proposal)
    ctx.semantic(wal.semanticReceipt)
    envelope(ctx, wal.measuredTrial, 'measured-trial', S.trial)
    watermark(ctx, wal.journalHeadBefore)
  } else if (schema === S.mission) {
    ctx.mission(value as S.SuccessorBinding)
  } else if (schema === S.run) {
    ctx.mission((value as z.infer<typeof S.run>).mission)
  } else if (schema === S.arm) {
    arm(ctx, value as S.TrialArm)
  } else if (schema === S.snapshot) {
    snapshot(ctx, value as S.GovernedSnapshot)
  } else if (schema === S.watermark) {
    watermark(ctx, value as z.infer<typeof S.watermark>)
  } else if (schema === S.transition) {
    transition(ctx, value as z.infer<typeof S.transition>)
  } else if (schema === S.injection) {
    injection(ctx, value as z.infer<typeof S.injection>)
  } else if (schema === S.eventRef) {
    ctx.json((value as z.infer<typeof S.eventRef>).sessionPrefix, S.sessionPrefix)
  } else if (schema === S.observation) {
    observation(ctx, value as z.infer<typeof S.observation>)
  } else if (schema === S.projection) {
    projection(ctx, value as z.infer<typeof S.projection>)
  }
}
