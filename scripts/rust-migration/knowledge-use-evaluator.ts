/** Keyless fixed-pilot evidence evaluator, launched only with a pinned owner configuration. */

import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import z from 'zod'
import { knowledgeCostAdmissionCapacity } from './knowledge-cost-guard.mjs'
import { readRegularFileBounded } from '../../packages/host/knowledge-wiki/src/filesystem.ts'
import { createFileMeasuredTrialArtifactResolver, MEASURED_TRIAL_METRICS,
  type OpportunityCounts } from '../../packages/host/knowledge-wiki/src/measured-trial.ts'
import { canonicalJson, encodeKnowledgeWikiPromotionSealRequest, sha256,
  type KnowledgeWikiPromotionSealRequest } from '../../packages/host/knowledge-wiki/src/verifier.ts'
import { capturePersistedKnowledgeUse, type CapturedKnowledgeUse, type KnowledgeUseBinding } from './knowledge-session-use.ts'
import { verifyKnowledgePilotEvidence, type KnowledgePilotManifest, type KnowledgePilotExecutionRoot } from './knowledge-pilot-verifier.ts'
import { evaluateObservationOperation, resolveCompletedEvaluation, createFrozenObservationArtifactWriter } from './knowledge-observation.ts'
import { deriveObservedUseCounts, witnessedUseCost, FIXED_KNOWLEDGE_MEASUREMENT_DEFINITION_V1, type SettledUseCostWitnessV1, type
UseSnapshotV1 } from './knowledge-use-producer.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const id = z.string().min(1).max(160)
const referenceFields = {
  schemaVersion: z.literal(1), sessionId: id, sessionSnapshotHash: digest, captureFactsHash: digest,
  registeredManifestHash: digest, registeredRequestHash: digest,
  taskKind: z.enum(['invoice-v1', 'single-line-v1', 'pagination-v1']),
  finalOutputHash: digest, capturedProviderRequestHash: digest,
}
const verifyRequest = z.object({ ...referenceFields, operation: z.literal('verify-registered-knowledge-task-v1') }).strict()
const evaluateRequest = z.object({ ...referenceFields, operation: z.literal('evaluate-captured-knowledge-use-v1'),
  journalAttestationHash: digest, fixedTaskOracleHash: digest, costWitnessHash: digest }).strict()
const finalizeRequest = z.object({ schemaVersion: z.literal(1), operation: z.literal('finalize-knowledge-measured-trial-v1'),
  proposalHash: digest, grantHash: digest, preRegistrationHash: digest, measurementDefinitionHash: digest,
  orderedUseReceiptHashes: z.array(digest).min(2).max(256) }).strict()
const journalRequest = z.object({ schemaVersion: z.literal(1), kind: z.literal('knowledge-use-journal-v1'),
  useFactsHash: digest, journalArtifactHash: digest, journalSignerAuthorityId: id }).strict()

/** Private frozen registration. Paths are launcher configuration, never operation fields. */
export interface KnowledgeUseEvaluatorConfiguration {
  readonly schemaVersion: 1
  readonly authorityId: string
  readonly producerId: string
  readonly promotionAuthorityId: string
  readonly promotionVerificationManifestHashes: readonly string[]
  readonly liveCostAdmissionHash?: string
  readonly sourceBindingHash: string
  readonly artifactRoot: string
  readonly costAuthorityId: string
  readonly evaluatorPublicKeySpki: string
  readonly journalAuthorityId: string
  readonly journalPublicKeySpki: string
  readonly registrations: readonly (Omit<UseSnapshotV1, 'binding'> & {
    readonly costWitnessHash: string
    readonly binding: Omit<UseSnapshotV1['binding'], 'knowledge'> & {
      readonly knowledge: { readonly id: string; readonly sourceContentHash: string; readonly renderedArtifactHash: string } | null
    }
  })[]
  readonly trial: {
    readonly trialId: string
    readonly proposalHash: string
    readonly grantHash: string
    readonly preRegistrationHash: string
    readonly measurementDefinitionHash: string
    readonly orderedSessionIds: readonly string[]
  }
  /** Exact existing promotion request digests admitted by the native review owner. */
  readonly promotionRequestHashes: readonly string[]
}

/** Immutable pre-observation view; no snapshot, manifest or cost hash exists yet. */
export type KnowledgeTrialDescriptionConfiguration = Omit<KnowledgeUseEvaluatorConfiguration, 'registrations'> & {
  readonly registrations: readonly {
    readonly binding: KnowledgeUseEvaluatorConfiguration['registrations'][number]['binding']
    readonly registeredTask: { readonly taskKind: UseSnapshotV1['registeredTask']['taskKind'] }
  }[]
}

/** Recipe over original canonical bytes; only the protected owner can add the named signature. */
export interface KnowledgeUseSealRecipe {
  readonly schemaVersion: 1
  readonly role: 'evaluator' | 'journal' | 'promotion'
  readonly signatureField: 'proof' | 'evaluatorSignature' | 'journalSignerSignature'
  readonly canonicalBytes: string
  readonly sealBinding: { readonly operation: string; readonly requestHash: string; readonly sourceBindingHash: string }
}

type ExecutionRoots = ReadonlyMap<string, KnowledgePilotExecutionRoot>

function artifact(config: Pick<KnowledgeUseEvaluatorConfiguration, 'artifactRoot'>, hash: string): Buffer {
  const bytes = createFileMeasuredTrialArtifactResolver(config.artifactRoot).resolveArtifact(hash)
  assert(bytes !== undefined && sha256(Buffer.from(bytes)) === hash, 'registered artifact is absent or changed')
  return Buffer.from(bytes)
}

function jsonArtifact(config: Pick<KnowledgeUseEvaluatorConfiguration, 'artifactRoot'>, hash: string): Record<string, unknown> {
  const bytes = artifact(config, hash)
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  assert(typeof value === 'object' && value !== null && !Array.isArray(value), 'registered artifact is not an object')
  assert(canonicalJson(value) === bytes.toString('utf8'), 'registered artifact is not canonical')
  return value as Record<string, unknown>
}

function authenticated(config: Pick<KnowledgeUseEvaluatorConfiguration, 'artifactRoot' | 'authorityId' | 'journalAuthorityId' |
  'evaluatorPublicKeySpki' | 'journalPublicKeySpki'>, hash: string, field = 'evaluatorSignature'): Record<string, unknown> {
  const value = jsonArtifact(config, hash)
  const proof = value[field]
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field))
  const journal = field === 'journalSignerSignature'
  const authorityField = journal ? 'journalSignerAuthorityId' : field === 'proof' ? 'authorityId' : 'evaluatorAuthorityId'
  const expectedAuthority = journal ? config.journalAuthorityId : config.authorityId
  const spki = journal ? config.journalPublicKeySpki : config.evaluatorPublicKeySpki
  const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' })
  assert(key.asymmetricKeyType === 'ed25519' && unsigned[authorityField] === expectedAuthority
    && typeof proof === 'string' && verify(null, Buffer.from(canonicalJson(unsigned)), key, Buffer.from(proof, 'base64')),
  'artifact authority or signature differs')
  return unsigned
}

function registration<T extends { readonly binding: { readonly sessionId: string } }>(config: { readonly registrations: readonly T[] },
  sessionId: string) {
  const found = config.registrations.filter(item => item.binding.sessionId === sessionId)
  assert(found.length === 1 && found[0] !== undefined, 'session is not uniquely registered')
  return found[0]
}

function registeredBinding(config: KnowledgeUseEvaluatorConfiguration, entry:
KnowledgeUseEvaluatorConfiguration['registrations'][number]): KnowledgeUseBinding {
  const knowledge = entry.binding.knowledge
  if (knowledge === null) return { ...entry.binding, knowledge: null, cost: null }
  const bytes = artifact(config, digest.parse(knowledge.renderedArtifactHash))
  const rendered: unknown = JSON.parse(bytes.toString('utf8'))
  // Rendered blocks were hashed with JSON.stringify at injection. Preserve those original
  // bytes through canonical launcher configuration; field equality is not byte equality.
  assert(Array.isArray(rendered) && JSON.stringify(rendered) === bytes.toString('utf8'), 'rendered artifact bytes differ')
  return { ...entry.binding, knowledge: { id: knowledge.id, sourceContentHash: knowledge.sourceContentHash,
    rendered: rendered as NonNullable<KnowledgeUseBinding['knowledge']>['rendered'] }, cost: null }
}

async function recapture(config: KnowledgeUseEvaluatorConfiguration, entry: KnowledgeUseEvaluatorConfiguration['registrations'][number],
  signal: AbortSignal): Promise<CapturedKnowledgeUse> {
  signal.throwIfAborted()
  const uncosted = registeredBinding(config, entry)
  const probe = await capturePersistedKnowledgeUse(entry.snapshotPath, entry.expectedSnapshotHash, uncosted)
  const costBytes = artifact(config, entry.costWitnessHash)
  const costValue = jsonArtifact(config, entry.costWitnessHash)
  const witness = costValue as unknown as SettledUseCostWitnessV1
  const microunits = witnessedUseCost(witness, config.costAuthorityId, uncosted, probe, entry.expectedSnapshotHash)
  assert(microunits !== undefined, 'registered cost witness does not cover every settled attempt')
  const captured = await capturePersistedKnowledgeUse(entry.snapshotPath, entry.expectedSnapshotHash,
    { ...uncosted, cost: { microunits, artifactBytes: costBytes } })
  signal.throwIfAborted()
  return captured
}

function validateTrialRegistration(config: KnowledgeTrialDescriptionConfiguration): void {
  assert(config.authorityId !== config.producerId
    && config.authorityId !== config.journalAuthorityId && isAbsolute(config.artifactRoot), 'evaluator owner configuration is invalid')
  digest.parse(config.sourceBindingHash)
  const trial = config.trial
  const expectedDefinition = canonicalJson(FIXED_KNOWLEDGE_MEASUREMENT_DEFINITION_V1)
  assert(trial.measurementDefinitionHash === sha256(expectedDefinition)
    && artifact(config, trial.measurementDefinitionHash).toString('utf8') === expectedDefinition,
  'measurement definition differs from the fixed observable semantics')
  const grant = authenticated(config, trial.grantHash)
  const prereg = authenticated(config, trial.preRegistrationHash)
  const proposal = jsonArtifact(config, trial.proposalHash)
  assert(grant['proposalHash'] === trial.proposalHash && grant['preRegistrationHash'] === trial.preRegistrationHash
    && grant['measurementDefinitionHash'] === trial.measurementDefinitionHash
    && prereg['proposalHash'] === trial.proposalHash && prereg['measurementDefinitionHash'] === trial.measurementDefinitionHash,
  'registered trial artifact binding differs')
  const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
  const issuedAt = Date.parse(timestamp.parse(grant['issuedAt']))
  const deadline = Date.parse(timestamp.parse(grant['deadline']))
  const expiresAt = Date.parse(timestamp.parse(grant['expiresAt']))
  const preregisteredAt = Date.parse(timestamp.parse(prereg['issuedAt']))
  assert(preregisteredAt <= issuedAt && issuedAt <= deadline && deadline <= expiresAt && expiresAt > Date.now(),
    'registered grant is expired or its time window differs')
  assert(grant['reviewedDecisionHash'] === trial.proposalHash, 'grant does not authorize the frozen proposal')
  const maxObservations = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(grant['maxObservations'])
  const maxTurns = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(grant['maxTurns'])
  assert(config.registrations.length / 2 <= maxObservations && config.registrations.length / 2 <= maxTurns,
    'registered observations exceed grant bounds')
  assert(new Set(trial.orderedSessionIds).size === trial.orderedSessionIds.length
    && trial.orderedSessionIds.length === config.registrations.length && trial.orderedSessionIds.length >= 2
    && trial.orderedSessionIds.length <= 256 && trial.orderedSessionIds.length % 2 === 0, 'registered session set differs')
  const pairIds: string[] = []
  for (let index = 0; index < trial.orderedSessionIds.length; index += 2) {
    const baselineId = trial.orderedSessionIds[index]
    const candidateId = trial.orderedSessionIds[index + 1]
    assert(baselineId !== undefined && candidateId !== undefined, 'registered pair is incomplete')
    const baseline = registration(config, baselineId).binding
    const candidate = registration(config, candidateId).binding
    assert(baseline.role === 'baseline' && baseline.grantId === null && baseline.knowledge === null
      && candidate.role === 'candidate' && candidate.grantId === grant['grantId'] && candidate.knowledge !== null
      && baseline.pairId === candidate.pairId && Array.isArray(grant['allowedSessionIds'])
      && grant['allowedSessionIds'].includes(candidateId), 'registered pair role or grant differs')
    for (const binding of [baseline, candidate]) {
      assert(canonicalJson(binding.sourceIdentity) === canonicalJson(proposal['sourceIdentity'])
        && binding.buildIdentity === (proposal['buildIdentity'] as { digest: string }).digest
        && binding.profileIdentity === (proposal['profileIdentity'] as { profile: string }).profile,
      'registered source/profile/build identity differs from the frozen proposal')
      const identity = { model: binding.config.model, modelConfigHash: sha256(canonicalJson(binding.config)),
        taskHash: sha256(binding.task), goalHash: binding.goalHash, policyHash: binding.policyHash }
      assert(binding.proposalHash === trial.proposalHash && binding.measurementDefinitionHash === trial.measurementDefinitionHash
        && canonicalJson(identity) === canonicalJson(grant['modelConfigTaskGoalPolicyIdentity'])
        && canonicalJson(identity) === canonicalJson(prereg['modelConfigTaskGoalPolicyIdentity']),
      'registered use task/model/mission identity differs')
    }
    pairIds.push(baseline.pairId)
  }
  assert(canonicalJson(pairIds) === canonicalJson(prereg['orderedPairIds']), 'registered pair order differs')
}

async function fixedEvidence(config: KnowledgeUseEvaluatorConfiguration,
  request: z.infer<typeof verifyRequest> | z.infer<typeof evaluateRequest>,
  subprocess: SubprocessRuntime, sandbox: SandboxProvider, signal: AbortSignal, executions?: ExecutionRoots, writeNewArtifact?: (bytes:
  Buffer) => Promise<void>) {
  const entry = registration(config, request.sessionId)
  assert(entry.expectedSnapshotHash === request.sessionSnapshotHash
    && entry.registeredTask.manifestHash === request.registeredManifestHash
    && entry.registeredTask.requestHash === request.registeredRequestHash
    && entry.registeredTask.taskKind === request.taskKind, 'fixed-task registration differs')
  const captured = await recapture(config, entry, signal)
  assert(sha256(canonicalJson(captured.facts)) === request.captureFactsHash
    && sha256(captured.wholeOutput) === request.finalOutputHash
    && captured.facts['providerRequestHash'] === request.capturedProviderRequestHash, 'captured facts or complete output differs')
  const manifest = jsonArtifact(config, request.registeredManifestHash) as unknown as KnowledgePilotManifest
  assert(manifest.artifactRoot === config.artifactRoot && manifest.projectRoot === entry.binding.projectRoot
    && manifest.authorityId === config.authorityId && manifest.task.kind === request.taskKind,
  'fixed manifest owner, project or task differs')
  if (manifest.task.kind !== 'pagination-v1') assert(manifest.task.outputHash === request.finalOutputHash,
    'fixed oracle output is not the complete captured output')
  const result = await verifyKnowledgePilotEvidence(manifest,
    { schemaVersion: 1, operation: 'verifyCandidate', request: jsonArtifact(config, request.registeredRequestHash) }, subprocess,
    sandbox, signal, executions?.get(request.sessionId), writeNewArtifact)
  assert(sha256(readRegularFileBounded(entry.snapshotPath, 16 * 1024 * 1024)) === entry.expectedSnapshotHash,
    'registered snapshot changed during oracle verification')
  const observedAt = Date.parse(String(captured.facts['observedAt']))
  const grant = authenticated(config, config.trial.grantHash)
  const preregistration = authenticated(config, config.trial.preRegistrationHash)
  assert(observedAt >= Date.parse(String(preregistration['issuedAt']))
    && (entry.binding.role === 'baseline' || (observedAt >= Date.parse(String(grant['issuedAt']))
      && observedAt <= Date.parse(String(grant['deadline'])))), 'observed use is outside its registered time window')
  return { entry, captured, result }
}

async function evaluatedUse(config: KnowledgeUseEvaluatorConfiguration, request: z.infer<typeof evaluateRequest>,
  subprocess: SubprocessRuntime, sandbox: SandboxProvider, signal: AbortSignal, executions?: ExecutionRoots, writeNewArtifact?: (bytes:
  Buffer) => Promise<void>) {
  const { entry, captured, result } = await fixedEvidence(config, request, subprocess, sandbox, signal, executions, writeNewArtifact)
  assert(request.costWitnessHash === entry.costWitnessHash, 'cost reference differs from registration')
  const journal = authenticated(config, request.journalAttestationHash, 'journalSignerSignature')
  assert(journal['schemaVersion'] === 1 && journal['kind'] === 'knowledge-use-journal-v1'
    && journal['useFactsHash'] === request.captureFactsHash && journal['journalArtifactHash'] === captured.journalArtifactHash,
  'journal attestation differs from complete recapture')
  const oracle = authenticated(config, request.fixedTaskOracleHash, 'proof')
  const withoutTime = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'issuedAt'))
  assert(canonicalJson(withoutTime(oracle)) === canonicalJson(withoutTime(result)),
    'fixed oracle differs from independently rerun evidence')
  const counts = deriveObservedUseCounts(captured, result.result)
  const evidenceRefs = [request.journalAttestationHash, request.fixedTaskOracleHash, request.costWitnessHash]
  return { ...captured.facts, oracleIdentityAndResults: {
    producerId: config.producerId, evaluatorId: config.authorityId, verificationStatus: 'verified', counts, evidenceRefs,
  }, evidenceArtifactReferences: evidenceRefs, evaluatorAuthorityId: config.authorityId }
}

/**
 * Independently reconstruct the whole captured request set for the private cost owner.
 * @param config - Pinned launcher registration.
 * @param rawRequest - Local-only registered snapshot reference.
 * @param signal - Owner cancellation.
 * @returns Domain-separated session digest and ordered captured request hashes, without requiring cost evidence.
 */
export async function describeCapturedKnowledgeCostUse(config: KnowledgeUseEvaluatorConfiguration,
  rawRequest: unknown, signal: AbortSignal) {
  validateTrialRegistration(config)
  const request = z.object({ schemaVersion: z.literal(1), operation: z.literal('describeCapturedCostUse'),
    sessionId: id, sessionSnapshotHash: digest }).strict().parse(rawRequest)
  const entry = registration(config, request.sessionId)
  assert(entry.expectedSnapshotHash === request.sessionSnapshotHash, 'cost snapshot reference differs from registration')
  signal.throwIfAborted()
  const captured = await capturePersistedKnowledgeUse(entry.snapshotPath, entry.expectedSnapshotHash, registeredBinding(config, entry))
  signal.throwIfAborted()
  return { sessionIdHash: sha256(`ark-cost-session-v1\0${request.sessionId}`), sessionSnapshotHash: request.sessionSnapshotHash,
    capturedRequestHashes: captured.requests.map(item => sha256(canonicalJson(item))) }
}

function liveCostAdmission(config: KnowledgeTrialDescriptionConfiguration) {
  if (config.liveCostAdmissionHash === undefined) return undefined
  const hash = digest.parse(config.liveCostAdmissionHash)
  const value = z.object({ schemaVersion: z.literal(1), kind: z.literal('knowledge-live-cost-admission-v1'),
    evaluatorAuthorityId: id, proposalHash: digest, grantHash: digest, preRegistrationHash: digest, sourceBindingHash: digest,
    sessionIDs: z.array(id).min(2).max(256), ledgerArtifactHash: digest,
    maximumNewDispatches: z.number().int().positive().max(32), maximumNewSettlements: z.number().int().positive().max(32),
  }).strict().parse(authenticated(config, hash))
  assert(value.proposalHash === config.trial.proposalHash && value.grantHash === config.trial.grantHash
    && value.preRegistrationHash === config.trial.preRegistrationHash && value.sourceBindingHash === config.sourceBindingHash
    && canonicalJson(value.sessionIDs) === canonicalJson(config.trial.orderedSessionIds), 'live cost admission identity differs')
  const ledger: unknown = JSON.parse(artifact(config, value.ledgerArtifactHash).toString('utf8'))
  const capacity = knowledgeCostAdmissionCapacity(ledger, 8192)
  assert(value.maximumNewDispatches <= capacity.remainingRequests && value.maximumNewSettlements <= value.maximumNewDispatches
    && capacity.remainingBudgetMicroCny >= capacity.perRequestReserveMicroCny, 'live cost admission exceeds existing ledger capacity')
  return { admissionHash: hash, ledgerArtifactHash: value.ledgerArtifactHash,
    maximumNewDispatches: value.maximumNewDispatches, maximumNewSettlements: value.maximumNewSettlements }
}

/**
 * Rebuild the local review summary from authenticated fixed registrations.
 * @param config - Pinned completed-session registration; unavailable future costs never imply dispatch authority.
 * @returns Native summary and finite operation limits derived from exact registered observations.
 */
export function describeRegisteredKnowledgeTrial(config: KnowledgeTrialDescriptionConfiguration) {
  validateTrialRegistration(config)
  const grant = authenticated(config, config.trial.grantHash)
  const proposal = jsonArtifact(config, config.trial.proposalHash)
  const first = config.registrations[0]
  assert(first !== undefined, 'trial has no registered use')
  for (const entry of config.registrations) assert(entry.binding.projectRoot === first.binding.projectRoot
    && entry.binding.profileIdentity === first.binding.profileIdentity && entry.binding.buildIdentity === first.binding.buildIdentity,
  'trial crosses project/profile/build identity')
  const useCount = config.registrations.length
  const live = liveCostAdmission(config)
  return { schemaVersion: 1, grantHash: config.trial.grantHash, preRegistrationHash: config.trial.preRegistrationHash,
    proposalHash: config.trial.proposalHash, candidateHash: digest.parse(proposal['candidateHash']),
    sourceBindingHash: config.sourceBindingHash,
    projectRoot: first.binding.projectRoot, profileIdentity: first.binding.profileIdentity, buildIdentity: first.binding.buildIdentity,
    expiresAt: String(grant['expiresAt']), sessionIDs: config.trial.orderedSessionIds,
    fixedOracleIDs: [...new Set(config.registrations.map(entry => entry.registeredTask.taskKind))],
    ...(live === undefined ? {} : { liveCostAdmission: live }),
    operationLimits: { sealPromotion: config.promotionRequestHashes.length, signKnowledgeUseJournal: useCount,
      verifyCandidate: useCount + config.promotionVerificationManifestHashes.length, evaluateCapturedUse: useCount,
      finalizeMeasuredTrial: 1,
      registerProviderDispatch: live?.maximumNewDispatches ?? 0, recordProviderSettlement: live?.maximumNewSettlements ?? 0,
      resolveSettledUseCost: useCount } }
}

/**
 * Resolve fixed references, rerun independent oracles and return a domain-specific signing recipe.
 * @param config - Pinned launcher registration and fixed artifact roots; not supplied by Node requests.
 * @param rawRequest - Closed reference operation with no counts or signing bytes.
 * @param subprocess - Existing owned subprocess implementation.
 * @param sandbox - Existing read-only network-fenced oracle provider.
 * @param signal - Owner cancellation, checked after all owned work settles.
 * @returns Original canonical bytes and the one permitted signature field, with no signing material.
 */
export async function evaluateKnowledgeUseOperation(config: KnowledgeUseEvaluatorConfiguration, rawRequest: unknown,
  subprocess: SubprocessRuntime, sandbox: SandboxProvider, signal: AbortSignal, executions?: ExecutionRoots, writeNewArtifact?: (bytes:
  Buffer) => Promise<void>):
Promise<KnowledgeUseSealRecipe> {
  validateTrialRegistration(config)
  signal.throwIfAborted()
  const raw = z.record(z.string(), z.unknown()).parse(rawRequest)
  let role: KnowledgeUseSealRecipe['role'] = 'evaluator'
  let field: KnowledgeUseSealRecipe['signatureField'] = 'evaluatorSignature'
  let operation: string
  let canonical: string
  if (raw['kind'] === 'knowledge-use-journal-v1') {
    const request = journalRequest.parse(raw)
    assert(request.journalSignerAuthorityId === config.journalAuthorityId, 'journal authority differs')
    let matched = 0
    for (const entry of config.registrations) {
      const captured = await recapture(config, entry, signal)
      if (sha256(canonicalJson(captured.facts)) === request.useFactsHash
        && captured.journalArtifactHash === request.journalArtifactHash) matched += 1
    }
    assert(matched === 1, 'journal does not match one registered complete use')
    role = 'journal'; field = 'journalSignerSignature'; operation = 'signKnowledgeUseJournal'; canonical = canonicalJson(request)
  } else if (raw['operation'] === 'sealPromotion') {
    const envelope = z.object({ operation: z.literal('sealPromotion'), request: z.record(z.string(), z.unknown()) }).strict().parse(raw)
    // The existing encoder owns domain/field validation and preserves its exact signed bytes.
    canonical = encodeKnowledgeWikiPromotionSealRequest(envelope.request as unknown as KnowledgeWikiPromotionSealRequest)
    assert(config.promotionRequestHashes.includes(sha256(canonical)), 'promotion request is not registered by native review')
    assert(envelope.request['authorityId'] === config.promotionAuthorityId, 'promotion authority differs')
    role = 'promotion'; field = 'proof'; operation = 'sealPromotion'
  } else if (raw['schemaVersion'] === 2) {
    const requestHash = sha256(canonicalJson(raw))
    const manifests = config.promotionVerificationManifestHashes.map(hash => jsonArtifact(config, digest.parse(hash)))
      .filter(manifest => manifest['expectedRequestHash'] === requestHash)
    assert(manifests.length === 1, 'candidate verification is not uniquely registered')
    const manifest = manifests[0] as unknown as KnowledgePilotManifest
    const proposal = jsonArtifact(config, config.trial.proposalHash)
    const first = config.registrations[0]
    assert(first !== undefined, 'trial has no registered use')
    assert(manifest.authorityId === config.promotionAuthorityId && manifest.artifactRoot === config.artifactRoot
      && manifest.projectRoot === first.binding.projectRoot && raw['candidateHash'] === proposal['candidateHash']
      && raw['candidatePath'] === proposal['candidatePath']
      && config.registrations.some(entry => entry.registeredTask.taskKind === manifest.task.kind),
    'candidate verification authority or frozen scope differs')
    canonical = canonicalJson(await verifyKnowledgePilotEvidence(manifest,
      { schemaVersion: 1, operation: 'verifyCandidate', request: raw }, subprocess, sandbox, signal,
      executions?.get(first.binding.sessionId), writeNewArtifact))
    role = 'promotion'; field = 'proof'; operation = 'verifyCandidate'
  } else if (raw['operation'] === 'verify-registered-knowledge-task-v1') {
    const request = verifyRequest.parse(raw)
    canonical = canonicalJson((await fixedEvidence(config, request, subprocess, sandbox, signal, executions, writeNewArtifact)).result)
    field = 'proof'; operation = 'verifyCandidate'
  } else if (raw['operation'] === 'evaluate-captured-knowledge-use-v1') {
    const request = evaluateRequest.parse(raw)
    canonical = canonicalJson(await evaluatedUse(config, request, subprocess, sandbox, signal, executions, writeNewArtifact))
    operation = 'evaluateCapturedUse'
  } else {
    const request = finalizeRequest.parse(raw)
    const trial = config.trial
    for (const name of ['proposalHash', 'grantHash', 'preRegistrationHash', 'measurementDefinitionHash'] as const) {
      assert(request[name] === trial[name], 'trial finalization binding differs')
    }
    assert(request.orderedUseReceiptHashes.length === trial.orderedSessionIds.length, 'trial omits registered uses')
    const rows: Array<{ role: 'baseline' | 'candidate'; counts: OpportunityCounts }> = []
    for (const [index, hash] of request.orderedUseReceiptHashes.entries()) {
      const signedUse = authenticated(config, hash)
      const sessionId = trial.orderedSessionIds[index]
      assert(typeof sessionId === 'string' && signedUse['sessionId'] === sessionId, 'trial use order differs')
      const entry = registration(config, sessionId)
      const refs = z.array(digest).length(3).parse(signedUse['evidenceArtifactReferences'])
      const facts = Object.fromEntries(Object.entries(signedUse).filter(([key]) => !['oracleIdentityAndResults',
        'evidenceArtifactReferences', 'evaluatorAuthorityId'].includes(key)))
      const output = z.array(digest).length(1).parse(signedUse['finalOutputArtifactManifest'])
      const rebuilt = await evaluatedUse(config, evaluateRequest.parse({
        schemaVersion: 1, operation: 'evaluate-captured-knowledge-use-v1', sessionId,
        sessionSnapshotHash: entry.expectedSnapshotHash, captureFactsHash: sha256(canonicalJson(facts)),
        registeredManifestHash: entry.registeredTask.manifestHash, registeredRequestHash: entry.registeredTask.requestHash,
        taskKind: entry.registeredTask.taskKind, finalOutputHash: output[0], capturedProviderRequestHash: facts['providerRequestHash'],
        journalAttestationHash: refs[0], fixedTaskOracleHash: refs[1], costWitnessHash: refs[2],
      }), subprocess, sandbox, signal, executions, writeNewArtifact)
      assert(canonicalJson(rebuilt) === canonicalJson(signedUse), 'use receipt differs from independent rederivation')
      rows.push({ role: entry.binding.role, counts: rebuilt.oracleIdentityAndResults.counts })
    }
    const aggregate = (arm: 'baseline' | 'candidate') => Object.fromEntries(MEASURED_TRIAL_METRICS.map((metric) => {
      const count = rows.filter(row => row.role === arm).reduce((sum, row) => ({ numerator: sum.numerator + row.counts[metric].numerator,
        denominator: sum.denominator + row.counts[metric].denominator }), { numerator: 0, denominator: 0 })
      assert(Number.isSafeInteger(count.numerator) && Number.isSafeInteger(count.denominator), 'metric sum overflow')
      return [metric, count]
    })) as OpportunityCounts
    const candidate = aggregate('candidate')
    const grant = authenticated(config, trial.grantHash)
    canonical = canonicalJson({ schemaVersion: 1, trialId: trial.trialId, proposalHash: trial.proposalHash,
      grantHash: trial.grantHash, grantId: grant['grantId'], measurementDefinitionHash: trial.measurementDefinitionHash,
      orderedUseReceiptHashes: request.orderedUseReceiptHashes,
      baselineOpportunityNumeratorsAndDenominators: aggregate('baseline'), candidateOpportunityNumeratorsAndDenominators: candidate,
      safetyObservations: Object.fromEntries(['staleRecallRate', 'crossSessionLeakage', 'falseCompletionRate',
        'memoryPrivilegeEscalation', 'memoryPoisoning'].map(metric => [metric, candidate[metric as keyof OpportunityCounts]])),
      issuedAt: new Date().toISOString(), evaluatorAuthorityId: config.authorityId })
    operation = 'finalizeMeasuredTrial'
  }
  signal.throwIfAborted()
  assert(Buffer.byteLength(canonical) <= 4 * 1024 * 1024, 'signing recipe exceeds private channel limit')
  return { schemaVersion: 1, role, signatureField: field, canonicalBytes: Buffer.from(canonical).toString('base64'),
    sealBinding: { operation, requestHash: sha256(canonicalJson(rawRequest)), sourceBindingHash: config.sourceBindingHash } }
}

async function main(): Promise<void> {
  const path = process.argv[2]
  assert(process.argv.length === 3 && path !== undefined && isAbsolute(path),
    'usage: knowledge-use-evaluator.ts <pinned-owner-config.json>')
  const launch: unknown = JSON.parse(readRegularFileBounded(path, 2 * 1024 * 1024).toString('utf8'))
  const launchKind = (launch as { kind?: unknown }).kind
  const completed = launchKind === 'fixed-trial-completed-evaluation-launch-v1' ? resolveCompletedEvaluation(launch) : undefined
  const writeNewArtifact = completed === undefined ? undefined : await createFrozenObservationArtifactWriter(launch)
  const config = completed?.config ?? launch as KnowledgeUseEvaluatorConfiguration
  const executions = completed === undefined ? undefined : new Map([...completed.projections].map(([sessionId, projection]) => [sessionId, {
    logicalProjectRoot: projection.logicalProjectRoot,
    physicalProjectRoot: resolve(completed.launch.artifactRoot, projection.physicalRelativeRoot),
    files: projection.files.map(file => ({ path: file.path, hash: file.bytes.hash })),
  }]))
  let context: Context | undefined
  const controller = new AbortController()
  const parentPid = process.ppid
  const abort = () => {
    const reason = new Error('evaluator process cancelled or owner exited')
    controller.abort(reason)
    if (!process.stdin.readableEnded && !process.stdin.destroyed) process.stdin.destroy(reason)
  }
  process.once('SIGTERM', abort)
  process.once('SIGINT', abort)
  const checkParent = () => { if (parentPid <= 1 || process.ppid !== parentPid) abort() }
  const parentWatch = setInterval(checkParent, 250)
  const deadline = setTimeout(abort, 120_000)
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk as Uint8Array)
      size += bytes.byteLength
      assert(size <= 8 * 1024 * 1024, 'evaluator operation exceeds private channel limit')
      chunks.push(bytes)
    }
    checkParent()
    controller.signal.throwIfAborted()
    const inputBytes = Buffer.concat(chunks)
    const request: unknown = JSON.parse(inputBytes.toString('utf8'))
    const operation = z.record(z.string(), z.unknown()).parse(request)['operation']
    let result: unknown
    if (launchKind === 'fixed-trial-intent-helper-launch-v1') {
      result = await evaluateObservationOperation(launch, request, controller.signal)
    } else if (operation === 'describeRegisteredTrial') {
      z.object({ schemaVersion: z.literal(1), operation: z.literal('describeRegisteredTrial') }).strict().parse(request)
      result = describeRegisteredKnowledgeTrial(config)
    } else if (operation === 'describeCapturedCostUse') {
      result = await describeCapturedKnowledgeCostUse(config, request, controller.signal)
    } else {
      const [{ Context }, { default: LocalSubprocessRuntime }, { default: SandboxLocal }] = await Promise.all([
        import('@deepseek-ai/cordis'),
        import('@deepseek-ai/dsh-subprocess-local'),
        import('@deepseek-ai/dsh-sandbox-local'),
      ])
      controller.signal.throwIfAborted()
      context = new Context()
      await context.plugin(LocalSubprocessRuntime)
      await context.plugin(SandboxLocal)
      const recipe = await evaluateKnowledgeUseOperation(config, request, context.subprocess, context.sandbox, controller.signal,
        executions, writeNewArtifact)
      // Bind the private transport to the exact owner-sent bytes. Swift and JS may
      // encode equal numbers differently; legacy canonical signing bytes stay unchanged.
      result = { ...recipe, sealBinding: { ...recipe.sealBinding, requestHash: sha256(inputBytes) } }
    }
    controller.signal.throwIfAborted()
    process.stdout.write(`${canonicalJson(result)}\n`)
  } finally {
    try { await context?.fiber.dispose() } finally {
      clearTimeout(deadline)
      clearInterval(parentWatch)
      process.off('SIGTERM', abort)
      process.off('SIGINT', abort)
    }
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
