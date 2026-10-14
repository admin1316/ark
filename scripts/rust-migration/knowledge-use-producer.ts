/** Fixed-pilot persisted-use production. Trust anchors and registrations remain launcher-owned. */

import assert from 'node:assert/strict'
import { isAbsolute, resolve } from 'node:path'
import z from 'zod'
import { resolveCompletedEvaluation, createFrozenObservationArtifactWriter } from './knowledge-observation.ts'
import {
  atomicWriteFile,
  resolveConfinedPath,
} from '../../packages/host/knowledge-wiki/src/filesystem.ts'
import {
  createFileMeasuredTrialArtifactResolver,
  type KnowledgeWikiMeasuredTrialReader,
  type MeasuredTrialReviewBinding,
  MEASURED_TRIAL_METRICS,
  type OpportunityCounts,
} from '../../packages/host/knowledge-wiki/src/measured-trial.ts'
import {
  canonicalJson,
  sha256,
  type IndependentVerificationResult,
} from '../../packages/host/knowledge-wiki/src/verifier.ts'
import {
  capturePersistedKnowledgeUse,
  sealCapturedUse,
  type CapturedKnowledgeUse,
  type KnowledgeUseBinding,
  type KnowledgeUseJournalSigningAuthority,
} from './knowledge-session-use.ts'

/** Fixed observable semantics; other registered metrics remain unknown until their independent challenges exist. */
export const FIXED_KNOWLEDGE_MEASUREMENT_DEFINITION_V1 = Object.freeze({
  schemaVersion: 1,
  kind: 'fixed-knowledge-observed-opportunities-v1',
  metrics: Object.freeze(Object.fromEntries(MEASURED_TRIAL_METRICS.map(metric => [metric, ({
    repeatedErrorRate: 'repeated-isError-same-tool-canonical-arguments / observed-isError-results; unknown-if-other-error-classifications',
    repeatedToolCallRate: 'repeated-same-tool-canonical-arguments / complete-turn-tool-calls',
    verifiedTaskSuccess: 'fixed-independent-oracle-pass / complete-preregistered-uses',
    replayExplainability: 'fully-reconstructed-persisted-turns / complete-preregistered-uses',
  } as Partial<Record<typeof MEASURED_TRIAL_METRICS[number], string>>)[metric] ??
    'unobserved-independent-semantic-opportunity; numerator=0; denominator=0']))),
})

export interface RegisteredTaskV1 {
  readonly manifestHash: string
  readonly requestHash: string
  readonly taskKind: 'invoice-v1' | 'single-line-v1' | 'pagination-v1'
}

export interface UseSnapshotV1 {
  readonly snapshotPath: string
  readonly expectedSnapshotHash: string
  readonly binding: Omit<KnowledgeUseBinding, 'cost'>
  readonly registeredTask: RegisteredTaskV1
}

/** Authenticated complete attempt set supplied by the private cost owner, separate from the budget ledger. */
export interface SettledUseCostWitnessV1 {
  readonly schemaVersion: 1
  readonly kind: 'settled-use-cost-witness-v1'
  readonly sessionIdHash: string
  readonly sessionSnapshotHash: string
  readonly capturedRequestHashes: readonly string[]
  readonly attempts: readonly {
    readonly dispatchId: string
    readonly attemptId: string
    readonly capturedRequestHash: string
    readonly requestBodyHash: string
    readonly responseIdHash: string
    readonly responseModel: string
    readonly maxTokens: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly upperBoundMicroCny: number
    readonly finishReason: string
    readonly settledAt: string
    readonly registrationArtifactHash: string
    readonly settlementArtifactHash: string
    readonly retryOfDispatchId: string | null
    readonly retryAttributionArtifactHash: string | null
  }[]
  readonly totalUpperBoundMicrounits: number
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const unsignedCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const nonempty = z.string().trim().min(1).max(512)
const costWitnessSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('settled-use-cost-witness-v1'),
  sessionIdHash: hashSchema, sessionSnapshotHash: hashSchema,
  capturedRequestHashes: z.array(hashSchema).min(1).max(4096),
  attempts: z.array(z.object({
    dispatchId: nonempty, attemptId: nonempty, capturedRequestHash: hashSchema,
    requestBodyHash: hashSchema, responseIdHash: hashSchema, responseModel: nonempty,
    maxTokens: unsignedCount, inputTokens: unsignedCount, outputTokens: unsignedCount,
    upperBoundMicroCny: unsignedCount, finishReason: nonempty,
    settledAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
    registrationArtifactHash: hashSchema, settlementArtifactHash: hashSchema,
    retryOfDispatchId: nonempty.nullable(), retryAttributionArtifactHash: hashSchema.nullable(),
  }).strict()).min(1).max(4096), totalUpperBoundMicrounits: unsignedCount,
}).strict()

/** Only an authenticated whole-turn cost owner may return verified completeness. */
export type SettledUseCostResolutionV1 =
  | { readonly status: 'verified'; readonly artifactBytesBase64: string; readonly artifactHash: string }
  | { readonly status: 'unknown'; readonly reason: string }

/** Private cost owner; a missing or ambiguous complete attempt set remains unknown. */
export interface SettledUseCostEvidenceOwner {
  readonly authorityId: string
  resolveUniqueSettledUse(request: {
    readonly schemaVersion: 1
    readonly operation: 'resolve-settled-use-cost-v1'
    readonly sessionId: string
    readonly sessionSnapshotHash: string
    readonly capturedRequestHashes: readonly string[]
  }, signal: AbortSignal): Promise<SettledUseCostResolutionV1>
}

export interface VerifyRegisteredFixedTaskV1Request {
  readonly schemaVersion: 1
  readonly operation: 'verify-registered-knowledge-task-v1'
  readonly sessionId: string
  readonly sessionSnapshotHash: string
  readonly captureFactsHash: string
  readonly registeredManifestHash: string
  readonly registeredRequestHash: string
  readonly taskKind: RegisteredTaskV1['taskKind']
  readonly finalOutputHash: string
  readonly capturedProviderRequestHash: string
}

/** References accepted by the fixed evaluator; all facts and bytes are independently reread. */
export interface EvaluateCapturedUseV1Request extends Omit<VerifyRegisteredFixedTaskV1Request, 'operation'> {
  readonly operation: 'evaluate-captured-knowledge-use-v1'
  readonly journalAttestationHash: string
  readonly fixedTaskOracleHash: string
  readonly costWitnessHash: string
}

/** Closed operations; caller-provided counts, arbitrary bytes, paths and authorizations are absent. */
export interface KnowledgeMeasuredUseEvaluator {
  readonly authorityId: string
  verifyRegisteredFixedTask(request: VerifyRegisteredFixedTaskV1Request, signal: AbortSignal): Promise<IndependentVerificationResult>
  evaluateCapturedUse(request: EvaluateCapturedUseV1Request, signal: AbortSignal): Promise<Uint8Array>
  finalizeMeasuredTrial(request: {
    readonly schemaVersion: 1
    readonly operation: 'finalize-knowledge-measured-trial-v1'
    readonly proposalHash: string
    readonly grantHash: string
    readonly preRegistrationHash: string
    readonly measurementDefinitionHash: string
    readonly orderedUseReceiptHashes: readonly string[]
  }, signal: AbortSignal): Promise<Uint8Array>
}

export interface ProduceMeasuredUseInputV1 {
  readonly pairs: readonly {
    readonly pairId: string
    readonly baseline: UseSnapshotV1
    readonly candidate: UseSnapshotV1
  }[]
  readonly proposalHash: string
  readonly grantHash: string
  readonly preRegistrationHash: string
  readonly measurementDefinitionHash: string
  readonly journalAuthority: KnowledgeUseJournalSigningAuthority
  readonly costOwner: SettledUseCostEvidenceOwner
  readonly evaluator: KnowledgeMeasuredUseEvaluator
  readonly reader: KnowledgeWikiMeasuredTrialReader
  readonly reviewBinding: MeasuredTrialReviewBinding
  readonly artifactRoot: string
  readonly signal: AbortSignal
}

export type ProduceMeasuredUseResultV1 =
  | { readonly status: 'eligible'; readonly trialHash: string; readonly orderedUseReceiptHashes: readonly string[] }
  | { readonly status: 'rejected'
    readonly trialHash: string
    readonly reason: 'reader-rejected'
    readonly orderedUseReceiptHashes: readonly string[] }
  | { readonly status: 'ineligible'
    readonly trialHash: string
    readonly reason: 'insufficient-observed-opportunities'
    readonly orderedUseReceiptHashes: readonly string[] }
  | { readonly status: 'unknown'
    readonly reason: 'no-unique-settled-cost-witness' | 'evaluator-owner-mismatch'
    readonly orderedUseReceiptHashes: readonly string[] }

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${field} must be a lowercase SHA-256`)
  return value
}

function canonicalBytes(bytes: Uint8Array, label: string): Buffer {
  const raw = Buffer.from(bytes)
  const value: unknown = JSON.parse(raw.toString('utf8'))
  if (!Buffer.from(canonicalJson(value), 'utf8').equals(raw)) throw new Error(`${label} is not canonical UTF-8 JSON`)
  return raw
}

async function storeRaw(root: string, resolver: ReturnType<typeof createFileMeasuredTrialArtifactResolver>, bytes: Uint8Array,
  writeNewArtifact?: (bytes: Buffer) => Promise<void>): Promise<string> {
  const owned = Buffer.from(bytes)
  const hash = sha256(owned)
  const path = resolveConfinedPath(root, hash, true)
  const prior = resolver.resolveArtifact(hash)
  if (prior === undefined) {
    if (writeNewArtifact === undefined) atomicWriteFile(path, owned)
    else await writeNewArtifact(owned)
  }
  else if (!Buffer.from(prior).equals(owned)) throw new Error('content-addressed artifact already exists with different bytes')
  const written = resolver.resolveArtifact(hash)
  if (written === undefined || !Buffer.from(written).equals(owned)) throw new Error('content-addressed artifact failed readback')
  return hash
}

async function storeCaptured(root: string, resolver: ReturnType<typeof createFileMeasuredTrialArtifactResolver>,
  captured: CapturedKnowledgeUse, writeNewArtifact?: (bytes: Buffer) => Promise<void>): Promise<void> {
  for (const [hash, bytes] of captured.artifacts) {
    if (sha256(bytes) !== hash) throw new Error('capture artifact changed before materialization')
    const writtenHash = await storeRaw(root, resolver, bytes, writeNewArtifact)
    if (writtenHash !== hash) throw new Error('capture artifact content address changed')
  }
}

function capturedRequestHashes(capture: CapturedKnowledgeUse): readonly string[] {
  return capture.requests.map(request => sha256(canonicalJson(request)))
}

/**
 * Verify exact request coverage and sum every authenticated dispatch and retry settlement.
 * @param witness - Complete private-owner witness.
 * @param inputCostAuthorityId - Fixed launcher cost authority.
 * @param binding - Registered use identity.
 * @param capture - Reconstructed complete requests.
 * @param snapshotHash - Registered persisted snapshot digest.
 * @returns Complete safe-integer cost, or undefined when attribution is incomplete.
 */
export function witnessedUseCost(
  rawWitness: unknown,
  inputCostAuthorityId: string,
  binding: KnowledgeUseBinding,
  capture: CapturedKnowledgeUse,
  snapshotHash: string,
): number | undefined {
  const parsed = costWitnessSchema.safeParse(rawWitness)
  if (!parsed.success) return undefined
  const witness = parsed.data
  const expectedHashes = capturedRequestHashes(capture)
  if (inputCostAuthorityId.trim() === ''
    || witness.sessionIdHash !== sha256(`ark-cost-session-v1\0${binding.sessionId}`) || witness.sessionSnapshotHash !== snapshotHash
    || canonicalJson(witness.capturedRequestHashes) !== canonicalJson(expectedHashes)
    || new Set(expectedHashes).size !== expectedHashes.length) return undefined
  const covered = new Set<string>()
  const dispatches = new Map<string, SettledUseCostWitnessV1['attempts'][number]>()
  const attempts = new Set<string>()
  const retried = new Set<string>()
  let totalMicrounits = 0
  for (const attempt of witness.attempts) {
    if (!expectedHashes.includes(attempt.capturedRequestHash)
      || dispatches.has(attempt.dispatchId) || attempts.has(attempt.attemptId)) return undefined
    if (covered.has(attempt.capturedRequestHash) !== (attempt.retryOfDispatchId !== null)) return undefined
    if (attempt.retryOfDispatchId !== null) {
      const parent = dispatches.get(attempt.retryOfDispatchId)
      if (parent === undefined || retried.has(parent.dispatchId) || parent.capturedRequestHash !== attempt.capturedRequestHash
        || attempt.retryAttributionArtifactHash === null || !/^[a-f0-9]{64}$/u.test(attempt.retryAttributionArtifactHash)) return undefined
      retried.add(parent.dispatchId)
    } else if (attempt.retryAttributionArtifactHash !== null) return undefined
    totalMicrounits += attempt.upperBoundMicroCny
    if (!Number.isSafeInteger(totalMicrounits)) return undefined
    covered.add(attempt.capturedRequestHash)
    dispatches.set(attempt.dispatchId, attempt)
    attempts.add(attempt.attemptId)
  }
  if (covered.size !== expectedHashes.length || totalMicrounits !== witness.totalUpperBoundMicrounits) return undefined
  return totalMicrounits
}

/**
 * Capture paired persisted sessions, bind each to a registered fixed task and unique settled cost witness,
 * seal owner-captured facts, delegate all 17 metric derivations to the registered evaluator, then ask the
 * existing reader to make the final eligibility decision. No caller-supplied counts enter this operation.
 * @param input - Pre-registered pair/session identities and existing journal, cost, evaluator, and reader owners.
 * @returns UNKNOWN before receipt creation when per-use cost is absent; otherwise the reader's exact result.
 * @throws When any frozen snapshot, registered task, signed artifact, canonical byte string, or owner binding is invalid.
 */
export async function produceMeasuredUseV1(input: ProduceMeasuredUseInputV1, writeNewArtifact?: (bytes: Buffer) => Promise<void>):
Promise<ProduceMeasuredUseResultV1> {
  input.signal.throwIfAborted()
  if (input.evaluator.authorityId !== input.reader.authorityId
    || input.evaluator.authorityId === input.journalAuthority.authorityId) {
    return { status: 'unknown', reason: 'evaluator-owner-mismatch', orderedUseReceiptHashes: [] }
  }
  if (typeof input.costOwner.authorityId !== 'string' || input.costOwner.authorityId.trim() === '') {
    return { status: 'unknown', reason: 'no-unique-settled-cost-witness', orderedUseReceiptHashes: [] }
  }
  if (input.pairs.length === 0 || new Set(input.pairs.map(pair => pair.pairId)).size !== input.pairs.length) {
    throw new Error('measured-use producer requires nonempty unique preregistered pairs')
  }
  const observations = input.pairs.flatMap(pair => [pair.baseline, pair.candidate])
  for (const field of ['sessionId', 'useId'] as const) {
    if (new Set(observations.map(item => item.binding[field])).size !== observations.length) {
      throw new Error('measured trial observations require unique sessions and use identifiers')
    }
  }
  const taskIdentity = (observation: UseSnapshotV1): string => canonicalJson([
    observation.registeredTask.taskKind, observation.binding.task, observation.binding.config,
    observation.binding.goalHash, observation.binding.policyHash,
  ])
  const firstPair = input.pairs[0]
  if (firstPair === undefined) throw new Error('missing preregistered pair')
  const registeredTrialTask = taskIdentity(firstPair.baseline)
  if (input.pairs.some(pair => taskIdentity(pair.baseline) !== registeredTrialTask
    || taskIdentity(pair.candidate) !== registeredTrialTask)) {
    throw new Error('one measured trial cannot mix registered task families or task/model identities')
  }
  const resolver = createFileMeasuredTrialArtifactResolver(input.artifactRoot)
  const orderedUseReceiptHashes: string[] = []
  const prepared: Array<{
    readonly observation: UseSnapshotV1
    readonly binding: KnowledgeUseBinding
    readonly costWitnessBytes: Buffer
    readonly captured: CapturedKnowledgeUse
  }> = []

  // Resolve every session-bound cost row before the first content-addressed write or journal signature.
  // This prevents a late missing/ambiguous settlement from leaving a partially materialized trial.
  for (const pair of input.pairs) {
    if (pair.baseline.registeredTask.taskKind !== pair.candidate.registeredTask.taskKind
      || pair.baseline.binding.role !== 'baseline' || pair.candidate.binding.role !== 'candidate'
      || pair.baseline.binding.pairId !== pair.pairId || pair.candidate.binding.pairId !== pair.pairId
      || pair.baseline.binding.sessionId === pair.candidate.binding.sessionId
      || pair.baseline.binding.proposalHash !== input.proposalHash || pair.candidate.binding.proposalHash !== input.proposalHash
      || pair.baseline.binding.measurementDefinitionHash !== input.measurementDefinitionHash
      || pair.candidate.binding.measurementDefinitionHash !== input.measurementDefinitionHash) {
      throw new Error('pair role, session, proposal, or measurement binding differs')
    }
    for (const observation of [pair.baseline, pair.candidate]) {
      input.signal.throwIfAborted()
      digest(observation.registeredTask.manifestHash, 'registered task manifest hash')
      digest(observation.registeredTask.requestHash, 'registered verifier request hash')
      if (!['invoice-v1', 'single-line-v1', 'pagination-v1'].includes(observation.registeredTask.taskKind)) {
        throw new Error('registered fixed task family is unsupported')
      }
      const uncostedBinding: KnowledgeUseBinding = { ...observation.binding, cost: null }
      const probeCapture = await capturePersistedKnowledgeUse(
        observation.snapshotPath, observation.expectedSnapshotHash, uncostedBinding,
      )
      input.signal.throwIfAborted()
      const requestHashes = capturedRequestHashes(probeCapture)
      if (requestHashes.length === 0) return { status: 'unknown', reason: 'no-unique-settled-cost-witness', orderedUseReceiptHashes: [] }
      const costResolution = await input.costOwner.resolveUniqueSettledUse({
        schemaVersion: 1,
        operation: 'resolve-settled-use-cost-v1',
        sessionId: observation.binding.sessionId,
        sessionSnapshotHash: observation.expectedSnapshotHash,
        capturedRequestHashes: requestHashes,
      }, input.signal)
      input.signal.throwIfAborted()
      if (costResolution.status !== 'verified') {
        return { status: 'unknown', reason: 'no-unique-settled-cost-witness', orderedUseReceiptHashes: [] }
      }
      const costWitnessBytes = canonicalBytes(Buffer.from(costResolution.artifactBytesBase64, 'base64'), 'settled use cost witness')
      if (sha256(costWitnessBytes) !== costResolution.artifactHash) throw new Error('cost witness digest differs')
      const costWitness = JSON.parse(costWitnessBytes.toString('utf8')) as SettledUseCostWitnessV1
      const microunits = witnessedUseCost(costWitness, input.costOwner.authorityId, uncostedBinding, probeCapture,
        observation.expectedSnapshotHash)
      if (microunits === undefined) {
        return { status: 'unknown', reason: 'no-unique-settled-cost-witness', orderedUseReceiptHashes: [] }
      }
      const binding: KnowledgeUseBinding = {
        ...observation.binding,
        cost: { microunits, artifactBytes: costWitnessBytes },
      }
      const captured = await capturePersistedKnowledgeUse(observation.snapshotPath, observation.expectedSnapshotHash, binding)
      input.signal.throwIfAborted()
      prepared.push({ observation, binding, costWitnessBytes, captured })
    }
  }

  const verified: Array<{
    readonly entry: typeof prepared[number]
    readonly costWitnessHash: string
    readonly oracleHash: string
    readonly request: VerifyRegisteredFixedTaskV1Request
  }> = []
  // Complete every frozen task/oracle check before signing any journal attestation.
  for (const entry of prepared) {
    input.signal.throwIfAborted()
    const { observation, binding, captured, costWitnessBytes } = entry
    const costWitnessHash = await storeRaw(input.artifactRoot, resolver, costWitnessBytes, writeNewArtifact)
    const captureFactsHash = await storeRaw(input.artifactRoot, resolver, Buffer.from(canonicalJson(captured.facts)), writeNewArtifact)
    const outputHash = await storeRaw(input.artifactRoot, resolver, Buffer.from(captured.wholeOutput, 'utf8'), writeNewArtifact)
    await storeCaptured(input.artifactRoot, resolver, captured, writeNewArtifact)
    const request: VerifyRegisteredFixedTaskV1Request = {
      schemaVersion: 1,
      operation: 'verify-registered-knowledge-task-v1',
      sessionId: binding.sessionId,
      sessionSnapshotHash: observation.expectedSnapshotHash,
      captureFactsHash,
      registeredManifestHash: observation.registeredTask.manifestHash,
      registeredRequestHash: observation.registeredTask.requestHash,
      taskKind: observation.registeredTask.taskKind,
      finalOutputHash: outputHash,
      capturedProviderRequestHash: digest(captured.facts['providerRequestHash'], 'captured provider request hash'),
    }
    const oracle = await input.evaluator.verifyRegisteredFixedTask(request, input.signal)
    input.signal.throwIfAborted()
    if (oracle.authorityId !== input.evaluator.authorityId
      || oracle.requestHash !== observation.registeredTask.requestHash) {
      throw new Error('fixed-task result is not bound to the registered evaluator and request')
    }
    // A correctly authenticated fail is a real negative observation, not a reason to drop the session.
    // The registered evaluator derives success counts from this result; malformed or unbound results
    // remain rejected above and by the evaluator/reader owners.
    z.enum(['pass', 'fail']).parse(oracle.result)
    const oracleBytes = Buffer.from(canonicalJson(oracle), 'utf8')
    const oracleHash = await storeRaw(input.artifactRoot, resolver, oracleBytes, writeNewArtifact)
    verified.push({ entry, costWitnessHash, oracleHash, request })
  }

  for (const item of verified) {
    input.signal.throwIfAborted()
    const { entry, costWitnessHash, oracleHash, request } = item
    const attestation = await sealCapturedUse(entry.captured, input.journalAuthority, input.signal)
    const journalAttestationHash = await storeRaw(input.artifactRoot, resolver, attestation.bytes, writeNewArtifact)
    const receiptBytes = canonicalBytes(await input.evaluator.evaluateCapturedUse({
      ...request,
      operation: 'evaluate-captured-knowledge-use-v1',
      journalAttestationHash,
      fixedTaskOracleHash: oracleHash,
      costWitnessHash,
    }, input.signal), 'measured-use receipt')
    const receiptHash = await storeRaw(input.artifactRoot, resolver, receiptBytes, writeNewArtifact)
    orderedUseReceiptHashes.push(receiptHash)
  }
  const trialBytes = canonicalBytes(await input.evaluator.finalizeMeasuredTrial({
    schemaVersion: 1,
    operation: 'finalize-knowledge-measured-trial-v1',
    proposalHash: input.proposalHash,
    grantHash: input.grantHash,
    preRegistrationHash: input.preRegistrationHash,
    measurementDefinitionHash: input.measurementDefinitionHash,
    orderedUseReceiptHashes,
  }, input.signal), 'measured-trial receipt')
  const trialHash = await storeRaw(input.artifactRoot, resolver, trialBytes, writeNewArtifact)
  const measured = input.reader.read(trialHash, input.reviewBinding)
  if (measured === undefined) return { status: 'rejected', trialHash, reason: 'reader-rejected', orderedUseReceiptHashes }
  if (!measured.eligibleForReview) {
    return { status: 'ineligible', trialHash, reason: 'insufficient-observed-opportunities', orderedUseReceiptHashes }
  }
  return { status: 'eligible', trialHash, orderedUseReceiptHashes }
}

/**
 * Derive only independently observable opportunities from a complete captured turn.
 * @param capture - Owner-reconstructed snapshot and raw call/result history.
 * @param outcome - Fixed oracle outcome over frozen source and complete output.
 * @returns All 17 metrics; absent semantic challenges remain zero over zero.
 */
export function deriveObservedUseCounts(capture: CapturedKnowledgeUse, outcome: 'pass' | 'fail'): OpportunityCounts {
  const counts = Object.fromEntries(MEASURED_TRIAL_METRICS.map(metric => [metric, { numerator: 0,
    denominator: 0 }])) as Record<typeof MEASURED_TRIAL_METRICS[number], { numerator: number; denominator: number }>
  const journal = capture.artifacts.get(capture.journalArtifactHash)
  if (journal === undefined || sha256(journal) !== capture.journalArtifactHash) throw new Error('captured journal is absent or changed')
  const decoded = JSON.parse(journal.toString('utf8')) as {
    events: Array<{ seq: number; type: string; data: Record<string, unknown> }>
  }
  const sequence = (capture.facts['sessionEventSequenceAndHash'] as { sequence: number }).sequence
  const first = decoded.events.filter(event => event.type === 'turn/start' && event.seq <= sequence).at(-1)
  if (first === undefined) throw new Error('captured metric interval has no start')
  const last = decoded.events.find(event => event.type === 'turn/end' && event.seq > first.seq)
  if (last === undefined) throw new Error('captured metric interval has no end')
  const events = decoded.events.filter(event => event.seq >= first.seq && event.seq <= last.seq)
  const costs = capture.facts['errorsRetriesToolCallsAndCost'] as { toolCalls: number }
  counts.verifiedTaskSuccess = { numerator: outcome === 'pass' ? 1 : 0, denominator: 1 }
  counts.repeatedToolCallRate = { numerator: capture.repeatedCalls, denominator: costs.toolCalls }
  // A complete authenticated turn is one replay opportunity; validation has reconstructed every request.
  counts.replayExplainability = { numerator: 1, denominator: 1 }
  const failedArguments = new Set<string>()
  let repeatedErrors = 0
  let observedErrors = 0
  for (const call of events.filter(event => event.type === 'tool/call')) {
    const result = events.find(event => event.type === 'tool/result'
      && (event.data['message'] as { source: { callId: string } }).source.callId === call.data['callId'])
    const block = (result?.data['message'] as { content: Array<{ isError?: boolean }> } | undefined)?.content[0]
    // Shell nonzero exits have richer classification in capture; absent exact error evidence stays unknown.
    if (block?.isError !== true) continue
    observedErrors += 1
    const fingerprint = canonicalJson([call.data['name'], JSON.parse(String(call.data['arguments'])) as unknown])
    if (failedArguments.has(fingerprint)) repeatedErrors += 1
    failedArguments.add(fingerprint)
  }
  if (observedErrors === capture.errors) counts.repeatedErrorRate = { numerator: repeatedErrors, denominator: observedErrors }
  return counts
}

/** Run the existing producer once on the owner's separate completed launch, using a fresh owned channel. */
async function main(): Promise<void> {
  const { readRegularFileBounded } = await import('../../packages/host/knowledge-wiki/src/filesystem.ts')
  const { connectNativeKnowledgeOwner, nativeKnowledgeOwnerEndpointFromEnvironment } = await import(
    '../../packages/bundle/native-api-app/src/native-owner-channel.ts')
  const { createNativeKnowledgeOwnerProviders } = await import('../../packages/bundle/native-api-app/src/native-owner-providers.ts')
  const path = process.argv[2]
  assert(process.argv.length === 3 && path !== undefined && isAbsolute(path),
    'usage: knowledge-use-producer.ts <pinned-completed-evaluation-launch.json>')
  const launchBytes = readRegularFileBounded(path, 2 * 1024 * 1024)
  const rawLaunch: unknown = JSON.parse(launchBytes.toString('utf8'))
  assert(canonicalJson(rawLaunch) === launchBytes.toString('utf8'), 'completed producer launch bytes are not canonical')
  const { config } = resolveCompletedEvaluation(rawLaunch)
  const writeNewArtifact = await createFrozenObservationArtifactWriter(rawLaunch)
  const endpoint = nativeKnowledgeOwnerEndpointFromEnvironment(process.env)
  assert(endpoint !== undefined, 'offline producer requires a fresh App-owned Native channel')
  const controller = new AbortController()
  const parentPid = process.ppid
  const abort = () => { controller.abort(new Error('offline producer cancelled or owner exited')) }
  const checkParent = () => { if (parentPid <= 1 || process.ppid !== parentPid) abort() }
  const parentWatch = setInterval(checkParent, 250)
  process.once('SIGTERM', abort); process.once('SIGINT', abort)
  let connection: Awaited<ReturnType<typeof connectNativeKnowledgeOwner>> | undefined
  try {
    connection = await connectNativeKnowledgeOwner(endpoint, controller.signal)
    assert(connection.status === 'ready', 'offline Native signing authority is disabled')
    const identity = connection.channel.identity
    assert(identity.sourceBindingHash === config.sourceBindingHash && identity.artifactRoot === config.artifactRoot
      && canonicalJson(identity.sourceIdentity) === canonicalJson(config.registrations[0]?.binding.sourceIdentity),
    'offline producer owner hello differs from completed registration')
    for (const [role, id, key] of [
      ['evaluator', config.authorityId, config.evaluatorPublicKeySpki],
      ['journal', config.journalAuthorityId, config.journalPublicKeySpki],
    ] as const) assert(identity.authorities[role].authorityId === id
      && identity.authorities[role].publicKey.export({ format: 'der', type: 'spki' }).toString('base64') === key,
    'offline producer role identity differs')
    assert(identity.authorities.promotion.authorityId === config.promotionAuthorityId, 'offline promotion identity differs')
    const providers = createNativeKnowledgeOwnerProviders(connection.channel)
    const resolver = createFileMeasuredTrialArtifactResolver(config.artifactRoot)
    const readJson = (hash: string) => {
      const bytes = resolver.resolveArtifact(hash)
      assert(bytes !== undefined && sha256(Buffer.from(bytes)) === hash, 'offline registered artifact differs')
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>
    }
    const proposal = readJson(config.trial.proposalHash)
    const observations: UseSnapshotV1[] = config.registrations.map((entry) => {
      const knowledge = entry.binding.knowledge
      const renderedBytes = knowledge === null ? undefined : resolver.resolveArtifact(knowledge.renderedArtifactHash)
      assert(knowledge === null || renderedBytes !== undefined, 'offline rendered artifact is missing')
      const rendered = renderedBytes === undefined ? null : JSON.parse(Buffer.from(renderedBytes).toString('utf8')) as
        NonNullable<KnowledgeUseBinding['knowledge']>['rendered']
      assert(renderedBytes === undefined || (Array.isArray(rendered) && JSON.stringify(rendered) ===
        Buffer.from(renderedBytes).toString('utf8')),
      'offline original rendered bytes differ')
      return { snapshotPath: entry.snapshotPath, expectedSnapshotHash: entry.expectedSnapshotHash,
        registeredTask: entry.registeredTask, binding: { ...entry.binding, cost: null,
          knowledge: knowledge === null ? null : { id: knowledge.id, sourceContentHash: knowledge.sourceContentHash, rendered: rendered
            ?? [] } } }
    })
    const pairs: ProduceMeasuredUseInputV1['pairs'][number][] = []
    for (let index = 0; index < observations.length; index += 2) {
      const baseline = observations[index], candidate = observations[index + 1]
      assert(baseline !== undefined && candidate !== undefined && baseline.binding.role === 'baseline'
        && candidate.binding.role === 'candidate' && baseline.binding.pairId === candidate.binding.pairId,
      'offline registered pair order differs')
      pairs.push({ pairId: baseline.binding.pairId, baseline, candidate })
    }
    checkParent(); controller.signal.throwIfAborted()
    const reviewBinding: MeasuredTrialReviewBinding = {
      reviewHash: z.string().parse(proposal['reviewHash']), semanticReceiptHash: z.string().parse(proposal['semanticReceiptHash']),
      candidatePath: z.string().parse(proposal['candidatePath']), candidateHash: z.string().parse(proposal['candidateHash']),
      action: z.enum(['Promote', 'Replace']).parse(proposal['action']), targetPath: z.string().parse(proposal['targetPath']),
      targetBeforeHashOrVerifiedAbsence: z.string().parse(proposal['targetBeforeHashOrVerifiedAbsence']),
    }
    const result = await produceMeasuredUseV1({ pairs, ...config.trial,
      journalAuthority: providers.journalAuthority, costOwner: providers.costOwner,
      evaluator: providers.measuredUseEvaluator, reader: providers.measuredTrialReader,
      reviewBinding, artifactRoot: config.artifactRoot, signal: controller.signal }, writeNewArtifact)
    checkParent(); controller.signal.throwIfAborted()
    process.stdout.write(`${canonicalJson(result)}\n`)
  } finally {
    clearInterval(parentWatch); process.off('SIGTERM', abort); process.off('SIGINT', abort)
    if (connection?.status === 'ready') await connection.channel.close()
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
