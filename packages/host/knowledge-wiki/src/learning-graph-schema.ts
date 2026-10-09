/** Closed payload boundaries for the candidate-internal, read-only learning graph. */

import { z } from 'zod'
import { parseArtifactRef } from './learning-artifacts.ts'
import type { KnowledgeRecord } from './types.ts'

/** Lowercase SHA-256 identity; alternate encodings are rejected. */
export const hash = z.string().regex(/^[0-9a-f]{64}$/u)
/** Nonempty identity without normalization. */
export const id = z.string().min(1)
/** Nonnegative exact JavaScript safe integer. */
export const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Positive exact JavaScript safe integer. */
export const positive = integer.min(1)
/** Canonical millisecond UTC timestamp, without timestamp repair. */
export const time = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
/** Artifact reference parsed by the shared bounded artifact owner. */
export const artifact = z.unknown().transform(value => parseArtifactRef(value))
/** Closed existing knowledge scope, preserving omitted fields. */
export const scope = z.object({ projectId: id.optional(), workspaceId: id.optional(), sessionId: id.optional(),
  visibility: z.enum(['session', 'workspace', 'project']).optional() }).strict()
/** Closed existing knowledge ACL, preserving omitted fields. */
export const acl = z.object({ readers: z.array(id).optional(), writers: z.array(id).optional() }).strict()
/** Exact selected commit, dirty source and build identity. */
export const sourceIdentity = z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/u), sourceDigest: hash, dirty: z.boolean(),
  dirtyDigest: hash, buildDigest: hash }).strict()
/** Unchanged original global manifest fields and state version. */
export const originalImmutable = z.object({ goalHash: hash, planHash: hash, scopeHash: hash, permissionsHash: hash,
  securityThresholdHash: hash, acceptanceHash: hash, dataFormatHash: hash, publishPolicyHash: hash, stateVersion: z.literal(1) }).strict()
/** Approved candidate-internal successor binding to the retained global manifest. */
export const mission = z.object({ originalManifest: artifact, original: originalImmutable, approvalRecordHash: hash,
  affectedPlanHash: hash, dataFormatHash: hash, stateVersion: z.literal(1) }).strict()
/** Parsed SuccessorBinding contract from its closed runtime schema. */
export type SuccessorBinding = z.infer<typeof mission>
/** Complete source, model, provider, task and policy identity for one arm. */
export const run = z.object({ projectId: id, profile: id, profileDigest: hash, source: sourceIdentity, mission, model: id,
  provider: id, modelConfigHash: hash, taskHash: hash, goalHash: hash, policyHash: hash }).strict()
/** Complete governed record snapshot; positive authority still requires replay. */
export const record = z.object({
  id, content: z.string(), source: id, claimKey: id.optional(), sourceHash: hash, contentHash: hash.optional(), scope,
  trust: z.enum(['low', 'medium', 'high']), authority: id, evidenceRefs: z.array(id),
  verificationStatus: z.enum(['observed', 'candidate', 'verified', 'rejected', 'conflict', 'expired']),
  confidence: z.number().min(0).max(1), createdAt: time, lastVerifiedAt: time.nullable(), expiresAt: time.nullable(),
  conflicts: z.array(id), retrievalHits: integer, successfulUses: integer, userCorrections: integer, utilityScore: z.number(),
  acl: acl.optional(), lifecycle: z.enum(['candidate', 'canonical', 'downgraded', 'rolled_back']).optional(),
}).strict().transform(value => value as KnowledgeRecord)
/** Immutable record identity excluding mutable counters and status. */
export const admission = z.object({ id, content: z.string(), source: id, sourceHash: hash, contentHash: hash,
  claimKey: id.nullable(), scope, acl: acl.nullable(), createdAt: time, expiresAt: time }).strict()
/** One exact authenticated journal position. */
export const position = z.object({ epoch: id, seq: integer, eventHash: hash }).strict()
/** Journal position with retained raw prefix and role-bound checkpoint. */
export const watermark = position.extend({ projectIdentityHash: hash, journalPrefix: artifact, checkpoint: z.unknown() }).strict()
/** Complete record snapshot with immutable identity and authenticated prefix. */
export const snapshot = z.object({ record: artifact, admissionIdentity: admission, admissionIdentityHash: hash, watermark }).strict()
/** Parsed GovernedSnapshot contract from its closed runtime schema. */
export type GovernedSnapshot = z.infer<typeof snapshot>
/** Supported canonical transformation actions owned by the existing transform. */
export const action = z.enum(['Promote', 'Merge', 'Replace', 'Deduplicate'])
/** Frozen actor, action, target and timestamp authorized before trial. */
export const decision = z.object({ reviewId: id, reviewHash: hash, action, targetPath: id, actorPrincipalId: id,
  reviewedAt: time, initiationCapabilityHash: hash, policyVersion: id }).strict()
/** Stable canonical identity and exact restriction carry-forward policy. */
export const transition = z.object({
  policy: z.literal('ark.target-stable-equal-restrictions/1'), kind: z.enum(['new-canonical', 'update-canonical']),
  candidateKnowledgeId: id, canonicalKnowledgeId: id, candidateAdmissionIdentityHash: hash, targetAdmissionIdentityHash: hash.nullable(),
  canonicalProvenance: artifact, canonicalScope: scope, canonicalAcl: acl.nullable(), canonicalExpiresAt: time,
}).strict()
/** Closed frozen canonical transformation proposal. */
export const proposal = z.object({
  schemaVersion: z.literal(1), kind: z.literal('ark.knowledge.canonical-proposal'), review: artifact, reviewHash: hash,
  semanticReceipt: artifact, governedCandidate: snapshot, decision, reviewedDecisionHash: hash, candidatePath: id, candidateHash: hash,
  candidate: artifact, source: z.object({ kind: z.enum(['bytes', 'identity-label']), reference: artifact, sourceHash: hash }).strict(),
  targetPath: id, targetBefore: artifact.nullable(),
  targetGovernance: z.discriminatedUnion('kind', [z.object({ kind: z.literal('verified-absence'),
    governed: z.null() }).strict(), z.object({ kind: z.literal('existing'), governed: snapshot }).strict()]),
  canonicalIdentityTransition: transition, targetAfter: artifact, evaluatedContentHash: hash, knowledgeId: id, scope, acl: acl.nullable(),
  knowledgeExpiresAt: time, transformVersion: z.literal('ark.canonical-transform/1'), sourceIdentity, profile: id,
  profileDigest: hash, mission,
}).strict()
/** Parsed Proposal contract from its closed runtime schema. */
export type Proposal = z.infer<typeof proposal>
/** Compound provenance for the exact new canonical bytes. */
export const provenance = z.object({
  schemaVersion: z.literal(1), kind: z.literal('ark.knowledge.canonical-revision-provenance'), candidateRecord: artifact,
  candidateBytes: artifact,
  candidateSource: proposal.shape.source, targetRecordBefore: artifact.nullable(), targetBytesBefore: artifact.nullable(),
  targetSourceHashBefore: hash.nullable(),
  semanticReceipt: artifact, reviewedDecisionHash: hash,
}).strict()
/** Single-initiation external authorization bound to one reviewed candidate. */
export const capability = z.object({
  capabilityId: id, userApproval: artifact, projectId: id, profileDigest: hash, sourceIdentity, reviewId: id,
  reviewHash: hash, candidateHash: hash,
  targetPath: id, targetBeforeHash: hash.nullable(), action, definitionId: id, definitionHash: hash,
  approvedActorPrincipalId: id, reviewedAt: time,
  candidateAdmissionIdentityHash: hash, targetAdmissionIdentityHash: hash.nullable(), maxInitiations: z.literal(1),
}).strict()
/** The unchanged seventeen measurement names. */
export const metric = z.enum(['repeatedErrorRate', 'repeatedToolCallRate', 'verifiedTaskSuccess', 'falseRecallRate',
  'staleRecallRate', 'conflictDetectionRate', 'memoryCorrectionRate', 'recoverySuccess', 'knowledgeUtility',
  'crossSessionLeakage', 'falseCompletionRate', 'userCorrectionFrequency', 'memoryPrivilegeEscalation', 'memoryPoisoning',
  'repairReuseSuccess', 'conflictEscalationRate', 'replayExplainability'])
/** Parsed MetricName contract from its closed runtime schema. */
export type MetricName = z.infer<typeof metric>
/** Exact bounded numerator and denominator, including zero opportunities. */
export const count = z.object({ numerator: integer, denominator: integer }).strict().refine(value => value.numerator <= value.denominator)
/** Parsed Count contract from its closed runtime schema. */
export type Count = z.infer<typeof count>
/** Explicitly supplied counts; omitted opportunities remain unknown. */
export const counts = z.partialRecord(metric, count)
/** One preregistered ordered use with frozen Session and world inputs. */
export const arm = z.object({ useId: id, pairId: id, variant: z.enum(['baseline', 'candidate']), sessionId: id,
  initialSessionHeaderHash: hash, initialSessionPrefixHash: hash, run, frozenTaskWorld: artifact,
  expectedOutputManifest: artifact }).strict()
/** Parsed TrialArm contract from its closed runtime schema. */
export type TrialArm = z.infer<typeof arm>
/** Preregistered measurement inputs, ordered arms and explicit limits. */
export const definition = z.object({
  schemaVersion: z.literal(1), kind: z.literal('ark.knowledge.measurement-definition'), definitionId: id, preregisteredAt: time,
  corpus: artifact, oracleDefinition: artifact, oracleBuild: artifact, opportunityDefinitions: z.partialRecord(metric, artifact),
  requiredMetricNames: z.array(metric), completeOrderedArms: z.array(arm).min(2), exclusionRules: artifact, safetyProbeManifest: artifact,
  maxKnowledgeReads: positive, maxModelAttempts: positive, maxTurns: positive, maxArtifacts: positive, maxArtifactBytes: positive,
  deadline: time, evidenceExpiresAt: time, knowledgeExpiresAt: time,
}).strict()
/** Parsed Definition contract from its closed runtime schema. */
export type Definition = z.infer<typeof definition>
/** One scoped grant bound to the frozen proposal and measurement definition. */
export const authorization = z.object({
  grantId: id, initiationCapability: artifact, proposal: artifact, proposalHash: hash, evaluatedContentHash: hash,
  semanticReceipt: artifact,
  reviewedDecisionHash: hash, definition: artifact, definitionHash: hash, sessionArms: z.array(arm).min(2), scope,
  maxKnowledgeReads: positive, maxModelAttempts: positive, maxTurns: positive, notBefore: time, deadline: time,
}).strict()
/** Parsed Authorization contract from its closed runtime schema. */
export type Authorization = z.infer<typeof authorization>
/** Original Session header and contiguous events delegated to the Session owner. */
export const sessionPrefix = z.object({ schemaVersion: z.literal(1), kind: z.literal('ark.knowledge.session-prefix'),
  sessionId: id, header: z.unknown(), throughSeq: integer, events: z.array(z.unknown()).min(1) }).strict()
/** An exact event inside a retained original Session prefix. */
export const eventRef = z.object({ sessionId: id, seq: integer, eventHash: hash, sessionPrefix: artifact }).strict()
/** One rendered candidate exposure with original tool and Session evidence. */
export const injection = z.object({ reservationId: id, callId: id, toolCall: eventRef, retrieved: eventRef,
  injected: eventRef, toolResult: eventRef, evaluatedContentHash: hash, renderedToolResultHash: hash,
  renderedToolResult: artifact, sourceContentHash: hash }).strict()
/** One explicit provider attempt, including failed or unknown dispatches. */
export const providerRequest = z.object({
  schemaVersion: z.literal(1), kind: z.literal('ark.knowledge.provider-request-fact'), attemptId: id, grantId: id, useId: id, sessionId: id,
  turn: integer, step: integer, ordinal: integer, adapter: z.enum(['llm-deepseek', 'llm-pi-ai']), api: id, endpointIdentity: hash,
  model: id, modelConfigHash: hash, sessionPrefix: artifact, providerInput: artifact, requestBody: artifact, bodySha256: hash,
  dispatchState: z.enum(['reserved', 'response-received', 'transport-failed', 'unknown']), httpStatus: integer.min(100).max(599).nullable(),
  providerRequestId: id.nullable(), sentAt: time, settledAt: time.nullable(),
}).strict()
/** Parsed ProviderRequest contract from its closed runtime schema. */
export type ProviderRequest = z.infer<typeof providerRequest>
/** Three-valued result without treating unknown as success. */
export const verdict = z.enum(['pass', 'fail', 'unknown'])
/** Independent oracle outcomes with all supplied counts and observation artifacts. */
export const observation = z.object({
  oracleDefinitionHash: hash, oracleBuildHash: hash, execution: artifact, verdict, applicableRepair: verdict, correctRepairReuse: verdict,
  taskSuccess: verdict, counts, toolCalls: integer.nullable(), retries: integer.nullable(), errorObservations: artifact,
  usageAndCostObservations: artifact,
}).strict()
/** Complete independently measured use, including failures and unknown results. */
export const use = z.object({
  useId: id, grantId: id, pairId: id, variant: z.enum(['baseline', 'candidate']), proposalHash: hash,
  evaluatedContentHash: hash, knowledgeId: id,
  definitionHash: hash, run, sessionId: id, initialWorld: artifact, finalWorld: artifact, finalOutputManifest: artifact,
  completeSession: artifact,
  requests: z.array(artifact), injections: z.array(injection), exposure: z.object({ candidatePresent: z.boolean(),
    check: artifact, verdict }).strict(),
  oracle: observation, result: verdict, startedAt: time, endedAt: time,
}).strict()
/** Parsed MeasuredUse contract from its closed runtime schema. */
export type MeasuredUse = z.infer<typeof use>
/** Supported product facts projection, excluding external oracle and result fields. */
export const useFacts = use.omit({ oracle: true, result: true })
/** Complete ordered paired trial and exact reducer input and output artifacts. */
export const trial = z.object({
  grantId: id, proposalHash: hash, evaluatedContentHash: hash, definitionHash: hash, grant: artifact,
  allUsesInPreregisteredOrder: z.array(artifact).min(2), omittedUses: z.array(id), exclusions: z.array(z.object({ useId: id,
    rule: artifact, evidence: artifact }).strict()),
  counts: z.partialRecord(metric, z.object({ baseline: count, candidate: count }).strict()), reducerSourceHash: hash,
  evaluationInput: artifact, evaluationOutput: artifact, result: verdict, startedAt: time, endedAt: time,
}).strict()
/** Parsed MeasuredTrial contract from its closed runtime schema. */
export type MeasuredTrial = z.infer<typeof trial>
/** Closed original child-operation requests preserved as exact artifacts. */
export const childRequest = z.discriminatedUnion('operation', [
  z.object({ schemaVersion: z.literal(2), requestId: id, operation: z.literal('authorizeTrial'), proposal: artifact,
    definitionId: id, initiationCapability: artifact }).strict(),
  z.object({ schemaVersion: z.literal(2), requestId: id, operation: z.literal('measureUse'), grant: artifact, useId: id,
    facts: artifact }).strict(),
  z.object({ schemaVersion: z.literal(2), requestId: id, operation: z.literal('measureTrial'), grant: artifact,
    useReceipts: z.array(artifact) }).strict(),
])
/** Parsed ChildRequest contract from its closed runtime schema. */
export type ChildRequest = z.infer<typeof childRequest>
/** Durable pre-exposure read or provider-attempt budget consumption. */
export const reservation = z.object({ reservationId: id, grantId: id, useId: id, sessionId: id,
  phase: z.enum(['knowledge-read', 'model-request']), ordinal: integer, callId: id.nullable(),
  requestAttemptId: id.nullable(), proposalHash: hash, sessionPrefixHash: hash, turn: integer, step: integer }).strict()
/** Parsed Reservation contract from its closed runtime schema. */
export type Reservation = z.infer<typeof reservation>
/** Atomic candidate/canonical record projection for one authenticated revision. */
export const projection = z.object({ transition, revisionId: hash, canonicalRecordAfter: artifact,
  candidateDisposition: z.enum(['same-id-promoted', 'absorbed-by-canonical-revision']), candidateRecordAfter: artifact,
  newlyCreditedUseIds: z.array(id) }).strict()
/** Closed v2 event domains; legacy-shaped observations confer no positive authority. */
export const journalPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('knowledge/journal-started'), legacyLog: artifact.nullable(), legacyLastEventHash: hash.nullable() }).strict(),
  z.object({ type: z.literal('knowledge/trial-authorized'), grant: artifact, proposal: artifact, initiationCapabilityHash: hash }).strict(),
  z.object({ type: z.literal('knowledge/trial-consumed'), reservation }).strict(),
  z.object({ type: z.literal('knowledge/use-observed'), useId: id, factManifest: artifact }).strict(),
  z.object({ type: z.literal('knowledge/use-measured'), useId: id, receipt: artifact }).strict(),
  z.object({ type: z.literal('knowledge/trial-measured'), grantId: id, receipt: artifact }).strict(),
  z.object({ type: z.literal('knowledge/trial-closed'), grantId: id, reason: z.enum(['complete', 'aborted', 'expired',
    'invalidated']) }).strict(),
  z.object({ type: z.literal('knowledge/verified'), semanticReceipt: artifact, recordSnapshot: artifact }).strict(),
  z.object({ type: z.literal('knowledge/promoted'), proposal: artifact, trial: artifact, wal: artifact, projection }).strict(),
  ...(['knowledge/rejected', 'knowledge/conflict', 'knowledge/expired',
    'knowledge/rolled_back'] as const).map(type => z.object({ type: z.literal(type), evidence: artifact }).strict()),
  ...(['knowledge/observed', 'knowledge/candidate', 'knowledge/retrieved',
    'knowledge/injected'] as const).map(type => z.object({ type: z.literal(type), legacyShapePayload: z.record(z.string(),
    z.unknown()) }).strict()),
])
/** Complete chained and locally sealed v2 journal event. */
export const journalEvent = z.object({ schemaVersion: z.literal(2), epoch: id, projectIdentityHash: hash, id, seq: integer,
  timestamp: time, knowledgeId: id, scope, previousEventHash: hash.nullable(), payload: journalPayload, seal: z.unknown(),
  eventHash: hash }).strict()
/** Parsed JournalEvent contract from its closed runtime schema. */
export type JournalEvent = z.infer<typeof journalEvent>
/** Immutable original, replacement and auxiliary paths of one WAL operation. */
export const operation = z.object({ role: z.enum(['candidate-archive', 'canonical-archive', 'canonical', 'review',
  'governance', 'candidate']), path: id, before: z.string().nullable(), after: z.string().nullable(),
stagingPath: id.nullable(), tombstonePath: id.nullable() }).strict()
/** Complete locally sealed promotion WAL bound to proposal, trial and protected prefix. */
export const wal = z.object({ schemaVersion: z.literal(2), id, createdAt: time, proposal: artifact,
  semanticReceipt: artifact, measuredTrial: artifact, journalHeadBefore: watermark, operationSetHash: hash, action,
  operations: z.array(operation), seal: z.unknown() }).strict()
/** Parsed PromotionWal contract from its closed runtime schema. */
export type PromotionWal = z.infer<typeof wal>
/** Strict explicitly selected read-only authority, roots, mission and budgets. */
export const descriptor = z.object({
  schemaVersion: z.literal(2), kind: z.literal('ark.knowledge.launcher-descriptor'),
  evaluator: z.object({
    authorityId: id, keyId: id, publicKeySpkiPem: id, keyFingerprint: hash, custodyAttestation: artifact,
    executable: id, executableDigest: hash, fixedArgs: z.array(z.string()), artifactRoot: id,
    allowedDefinitions: z.record(z.string().min(1), artifact), allowedInitiationCapabilities: z.array(artifact),
  }).strict(),
  journal: z.object({
    signerId: id, keyId: id, publicKeySpkiPem: id, keyFingerprint: hash, privateKeyHandle: id, protectedHeadRoot: id,
    projectIdentityHash: hash, epoch: id, rotationPolicy: z.literal('no-automatic-rotation'), legacyArchiveRecovery: artifact.nullable(),
  }).strict(),
  sourceIdentity, profile: id, profileDigest: hash, mission, timeoutMs: positive,
  maxArtifactBytes: positive, maxArtifactsPerReceipt: positive, maxTotalArtifactBytes: positive,
  maxArtifactGraphDepth: positive, maxChildRequestBytes: positive, maxChildResponseBytes: positive,
}).strict()
/** Parsed LearningAuthorityDescriptorV2 contract from its closed runtime schema. */
export type LearningAuthorityDescriptorV2 = z.infer<typeof descriptor>
