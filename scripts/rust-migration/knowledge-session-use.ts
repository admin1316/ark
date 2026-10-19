/** Complete session observations and test-key journal seals; no production trust is provisioned here. */

import assert from 'node:assert/strict'
import { KeyObject, verify } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import z from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, type ContentBlock, type GenerateOptions, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore, type SessionEvent, type SessionEventType, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '../../packages/host/knowledge-wiki-tools/src/session-events.ts'
import { readRegularFileBounded } from '../../packages/host/knowledge-wiki/src/filesystem.ts'
import { parseExitStatus } from '../../packages/shell/shell/src/render.ts'
import { canonicalJson, sha256, type KnowledgeWikiSourceIdentity } from '../../packages/host/knowledge-wiki/src/verifier.ts'

/** Preregistered facts supplied by the fixed-project pilot owner, separately from model output. */
export interface KnowledgeUseBinding {
  readonly useId: string
  readonly sessionId: string
  readonly projectRoot: string
  readonly turn: number
  readonly role: 'baseline' | 'candidate'
  readonly pairId: string
  readonly grantId: string | null
  readonly proposalHash: string
  readonly measurementDefinitionHash: string
  readonly sourceIdentity: KnowledgeWikiSourceIdentity
  readonly profileIdentity: string
  readonly buildIdentity: string
  readonly config: LlmCallConfig
  readonly task: string
  readonly goalHash: string
  readonly policyHash: string
  readonly permissions: Readonly<Record<'permission/preset' | 'sandbox/mode' | 'approval/policy', Record<string, string>>>
  readonly knowledge: { readonly id: string; readonly sourceContentHash: string; readonly rendered: readonly ContentBlock[] } | null
  /** Independently retained cost evidence; absence permits observation but prevents issuing a use seal. */
  readonly cost: { readonly microunits: number; readonly artifactBytes: Buffer } | null
  /** Fixed evidence-owner test identity, never selected by session/project input; production custody is not provisioned. */
  readonly retryEvidence?: { readonly authorityId: string; readonly publicKey: KeyObject; readonly artifactBytes: Buffer }
}

/** Content-addressed observations. Counts and evaluator signatures remain a separate responsibility. */
export interface CapturedKnowledgeUse {
  readonly facts: Readonly<Record<string, unknown>>
  readonly artifacts: ReadonlyMap<string, Buffer>
  readonly journalArtifactHash: string
  readonly wholeOutput: string
  readonly requests: readonly Readonly<Record<string, unknown>>[]
  readonly errors: number
  readonly repeatedCalls: number
  readonly costAvailable: boolean
}

/** Fixed-purpose measured-use journal signer; it returns only a signature over this exact attestation request. */
export interface KnowledgeUseJournalSigningAuthority {
  readonly authorityId: string
  readonly publicKey: KeyObject
  signKnowledgeUseJournal(request: KnowledgeUseJournalSignRequest, signal: AbortSignal): Promise<Uint8Array>
}

/** The one attestation payload accepted by a measured-use journal signer. */
export interface KnowledgeUseJournalSignRequest {
  readonly schemaVersion: 1
  readonly kind: 'knowledge-use-journal-v1'
  readonly useFactsHash: string
  readonly journalArtifactHash: string
  readonly journalSignerAuthorityId: string
}

// Sealing checks the exact capture owned by this module, including borrowed Buffer bytes.
const capturedBindings = new WeakMap<CapturedKnowledgeUse, {
  factsHash: string
  journalHash: string
  artifacts: readonly string[]
  costAvailable: boolean
  retryKeyHash: string | null
}>()

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const retrySchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('same-arguments-failed-parent-retry-v1'),
  authorityId: z.string().regex(/^pilot-test:[A-Za-z0-9._:-]{1,140}$/u),
  sessionId: z.string(), turn: z.number().int(), snapshotHash: digest, taskHash: digest,
  calls: z.array(z.object({ callId: z.string(), callSeq: z.number().int(), resultSeq: z.number().int(),
    resultHash: digest, argumentsHash: digest, name: z.string(), failed: z.boolean(), retryOf: z.string().nullable() }).strict()),
  proof: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
}).strict()

type ObservedCall = Omit<z.infer<typeof retrySchema>['calls'][number], 'retryOf'>

function authenticatedRetries(
  evidence: NonNullable<KnowledgeUseBinding['retryEvidence']>, calls: readonly ObservedCall[],
  binding: KnowledgeUseBinding, snapshotHash: string,
): { count: number; keyHash: string } {
  assert(evidence.artifactBytes.byteLength > 0 && evidence.artifactBytes.byteLength <= 2 * 1024 * 1024,
    'retry evidence must be nonempty and bounded')
  assert(evidence.publicKey.type === 'public' && evidence.publicKey.asymmetricKeyType === 'ed25519', 'retry evidence requires a fixed Ed25519 public key')
  const { proof, ...unsigned } = retrySchema.parse(JSON.parse(evidence.artifactBytes.toString('utf8')) as unknown)
  assert(unsigned.authorityId === evidence.authorityId
    && verify(null, Buffer.from(canonicalJson(unsigned), 'utf8'), evidence.publicKey, Buffer.from(proof, 'base64')),
  'retry attribution signature or fixed authority differs')
  assert(unsigned.sessionId === binding.sessionId && unsigned.turn === binding.turn
    && unsigned.snapshotHash === snapshotHash && unsigned.taskHash === sha256(binding.task)
    && unsigned.calls.length === calls.length, 'retry attribution interval differs')
  const seen = new Map<string, ObservedCall>()
  const consumed = new Set<string>()
  let count = 0
  for (const [index, entry] of unsigned.calls.entries()) {
    const { retryOf, ...observed } = entry
    assert(canonicalJson(observed) === canonicalJson(calls[index]), 'retry attribution call/result differs')
    if (retryOf !== null) {
      const parent = seen.get(retryOf)
      assert(parent !== undefined && parent.failed && parent.resultSeq < entry.callSeq
        && parent.name === entry.name && parent.argumentsHash === entry.argumentsHash && !consumed.has(retryOf),
      'retry parent must be an earlier unconsumed failed call with the same tool and canonical arguments')
      consumed.add(retryOf)
      count += 1
    }
    seen.set(entry.callId, observed)
  }
  return { count, keyHash: sha256(evidence.publicKey.export({ format: 'der', type: 'spki' })) }
}

function ofType<T extends SessionEventType>(events: readonly SessionEvent[], type: T): SessionEvent<T>[] {
  return events.filter((event): event is SessionEvent<T> => event.type === type)
}

function only<T>(items: readonly T[], context: string): T {
  assert(items.length === 1, context)
  // oxlint-disable-next-line typescript/no-non-null-assertion -- exact cardinality checked above
  return items[0]!
}

function visibleText(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Derive one complete turn from an owner-loaded session snapshot and frozen project/task identity.
 * @param metadata - Metadata decoded by the existing SessionPersistence owner from the original byte snapshot.
 * @param events - The same owner's complete contiguous decoded event stream, starting at seq 0.
 * @param snapshot - Original persisted bytes; the loading entry point must bind these bytes to metadata/events.
 * @param binding - Fixed preregistration, not model-supplied claims or a project preview journal.
 * @returns Full output, reconstructed harness requests, artifacts, and observed facts; missing cost or retry evidence stays unsealable.
 * @throws On incomplete, inconsistent, cross-project, wrong-task/model/policy, or unobserved knowledge evidence.
 */
export function captureKnowledgeUse(
  metadata: SessionHeader,
  events: readonly SessionEvent[],
  snapshot: Buffer,
  binding: KnowledgeUseBinding,
): CapturedKnowledgeUse {
  assert(snapshot.byteLength > 0 && snapshot.byteLength <= 16 * 1024 * 1024, 'session snapshot must be nonempty and bounded')
  assert(isAbsolute(binding.projectRoot) && metadata.cwd === binding.projectRoot && metadata.id === binding.sessionId, 'session/project binding differs')
  // Reuse core envelope, sequence, message, and surface validation instead of a second session parser.
  Session.create(SessionId(binding.sessionId), events, metadata)
  const start = only(ofType(events, 'turn/start').filter(event => event.data.turn === binding.turn), 'turn is incomplete or repeated')
  const end = only(ofType(events, 'turn/end').filter(event => event.data.turn === binding.turn), 'turn is incomplete or repeated')
  assert(end.seq > start.seq && end.data.reason.kind === 'completed', 'turn is cancelled, interrupted, or out of order')
  const first = start.seq
  const last = end.seq
  const interval = events.slice(first, last + 1)
  assert(!interval.some(event => event.type === 'turn/start' && event.seq !== first), 'turn intervals overlap')
  const direct = only(ofType(interval, 'user/message').filter(event => event.data.source.kind === 'user'), 'direct task is missing or repeated')
  assert(visibleText(direct.data.content) === binding.task, 'direct task differs')
  for (const [type, expected] of Object.entries(binding.permissions)) {
    const policyEvents = events.slice(0, last + 1).filter(event => event.type === type)
    const before = policyEvents.filter(event => event.seq < first).at(-1)
    assert(before !== undefined && canonicalJson(before.data) === canonicalJson(expected)
      && policyEvents.filter(event => event.seq >= first).every(event => canonicalJson(event.data) === canonicalJson(expected)), 'permission policy differs or changes during the turn')
  }

  const artifacts = new Map<string, Buffer>()
  const put = (bytes: Buffer): string => { const hash = sha256(bytes); artifacts.set(hash, bytes); return hash }
  const putJson = (value: unknown): string => put(Buffer.from(canonicalJson(value), 'utf8'))
  const originalSnapshotHash = put(snapshot)
  const cost = binding.cost
  if (cost !== null) assert(Number.isSafeInteger(cost.microunits) && cost.microunits >= 0 && cost.artifactBytes.byteLength > 0, 'independent cost evidence is invalid')
  const costEvidenceHash = cost === null ? null : put(cost.artifactBytes)
  const retry = binding.retryEvidence
  const messages = ofType(interval, 'assistant/message')
  assert(messages.length > 0, 'completed turn has no model output')
  const requests: Record<string, unknown>[] = []
  const consumed = new Set<number>()
  const requestedCalls = new Map<string, { name: string; arguments: string; step: number }>()
  let wholeOutput = ''
  for (const event of messages) {
    assert(event.data.turn === binding.turn && event.data.interrupted !== true, 'assistant output is interrupted or belongs to another turn')
    const sourceSeqs = event.sourceEventSeqs
    assert(sourceSeqs !== undefined, 'model output has no raw-stream provenance')
    const firstSeq = sourceSeqs[0]
    assert(firstSeq !== undefined, 'model output has no raw-stream provenance')
    const stepStart = only(ofType(interval, 'step/start').filter(item => item.data.step === event.data.step && item.data.turn === binding.turn), 'model step start is incomplete or repeated')
    const stepEnd = only(ofType(interval, 'step/end').filter(item => item.data.step === event.data.step && item.data.turn === binding.turn), 'model step end is incomplete or repeated')
    assert(stepStart.seq < firstSeq && stepEnd.seq > event.seq, 'model step overlaps its output')
    const assembler = new BlockAssembler()
    let finishSeq: number | undefined
    let previous = first
    for (const seq of sourceSeqs) {
      const chunk = events[seq]
      assert(seq > previous && seq < event.seq && !consumed.has(seq) && chunk?.type === 'assistant/chunk'
        && chunk.data.turn === binding.turn && chunk.data.step === event.data.step, 'stream provenance is missing, duplicated, reordered, or belongs to another step')
      consumed.add(seq)
      previous = seq
      assert(finishSeq === undefined, 'model stream has chunks after its finish')
      if (chunk.data.chunk.type === 'finish') finishSeq = seq
      assembler.push(chunk.data.chunk)
    }
    assert(finishSeq !== undefined && ['stop', 'tool-calls'].includes(assembler.finish.kind), 'model stream did not finish normally')
    assert(canonicalJson(assembler.blocks()) === canonicalJson(event.data.message.content)
      && canonicalJson(assembler.usage) === canonicalJson(event.data.usage), 'assembled output or usage differs from raw chunks')
    const prefix = Session.create(SessionId(binding.sessionId), events.slice(0, firstSeq), metadata)
    const header = prefix.requestHeader()
    assert(header !== undefined && canonicalJson(header.config) === canonicalJson(binding.config), 'actual model config differs from preregistration')
    assert(event.data.message.source.provider === binding.config.provider && event.data.message.source.model === binding.config.model, 'model output attribution differs from request')
    const request = { ...header.config, messages: prefix.deriveMessages(),
      ...(header.system === undefined ? {} : { system: header.system }),
      ...(header.tools === undefined ? {} : { tools: header.tools }), sessionId: binding.sessionId }
    requests.push(request)
    wholeOutput += visibleText(event.data.message.content)
    for (const block of event.data.message.content) {
      if (block.type !== 'tool-call') continue
      assert(!requestedCalls.has(String(block.id)), 'model call id is repeated')
      requestedCalls.set(String(block.id), { name: block.name, arguments: block.arguments, step: event.data.step })
    }
  }
  assert(interval.filter(event => event.type === 'assistant/chunk').every(event => consumed.has(event.seq)), 'unaccounted model chunks remain')
  const calls = ofType(interval, 'tool/call')
  const results = ofType(interval, 'tool/result')
  assert(calls.length === requestedCalls.size && results.length === calls.length, 'tool call/result interval is incomplete')
  const fingerprints = new Set<string>()
  const observedCalls: ObservedCall[] = []
  let errors = 0
  let repeatedCalls = 0
  for (const call of calls) {
    const expected = requestedCalls.get(String(call.data.callId))
    assert(expected !== undefined && expected.name === call.data.name && expected.arguments === call.data.arguments
      && expected.step === call.data.step && call.data.turn === binding.turn, 'tool call differs from raw model request')
    requestedCalls.delete(String(call.data.callId))
    const matching = only(results.filter(event => event.data.message.source.callId === call.data.callId), 'tool result is duplicated or missing')
    assert(matching.seq > call.seq && matching.data.turn === binding.turn
      && matching.data.step === call.data.step, 'tool result is reordered or belongs to another turn')
    const block = only(matching.data.message.content, 'tool result must have one result block')
    assert(block.toolCallId === call.data.callId, 'tool result block differs from call')
    let failed = block.isError === true
    if (call.data.name === 'bash' || call.data.name === 'pwsh') {
      const status = parseExitStatus(visibleText(block.content))
      failed ||= 'signal' in status || status.exitCode !== 0 || /\n\[timed out after [0-9]+ms\]$/u.test(status.body)
    }
    if (failed) errors += 1
    observedCalls.push({ callId: String(call.data.callId), callSeq: call.seq, resultSeq: matching.seq,
      resultHash: sha256(canonicalJson(matching)), name: call.data.name,
      argumentsHash: sha256(canonicalJson(JSON.parse(call.data.arguments) as unknown)), failed })
    const message = messages.find(event => event.data.step === call.data.step)
    const stepEnd = interval.find(event => event.type === 'step/end' && event.data.step === call.data.step)
    assert(message !== undefined && stepEnd !== undefined && call.seq > message.seq && matching.seq < stepEnd.seq, 'tool execution lies outside its model step')
    const fingerprint = canonicalJson([call.data.name, JSON.parse(call.data.arguments) as unknown])
    if (fingerprints.has(fingerprint)) repeatedCalls += 1
    fingerprints.add(fingerprint)
  }

  const knowledgeEvents = ofType(interval, 'knowledge/injected')
  let exposure: SessionEvent<'knowledge/injected'> | undefined
  let renderedHash: string | null = null
  let requestHash: string
  if (binding.role === 'baseline') {
    assert(binding.grantId === null && binding.knowledge === null
      && ofType(events.slice(0, last + 1), 'knowledge/injected').length === 0, 'baseline contains candidate exposure')
    requestHash = putJson(requests.at(-1))
  } else {
    assert(binding.grantId !== null && binding.knowledge !== null, 'candidate has no frozen grant or knowledge')
    const expectedKnowledge = binding.knowledge
    exposure = only(knowledgeEvents.filter(event => event.data.knowledgeId === expectedKnowledge.id), 'candidate knowledge was not injected exactly once')
    const data = exposure.data
    const rendered = JSON.stringify(expectedKnowledge.rendered)
    assert(data.kind === 'page' && data.truncated !== true && data.verificationStatus === 'verified'
      && data.scope.sessionId === binding.sessionId && data.scope.projectId === binding.projectRoot
      && data.scope.workspaceId === binding.projectRoot && data.sourceContentHash === expectedKnowledge.sourceContentHash
      && data.contentHash === sha256(rendered) && data.resultHash === sha256(rendered)
      && data.contentBytes === Buffer.byteLength(rendered) && JSON.stringify(data.value) === rendered, 'knowledge identity, scope, source, or rendered bytes differ')
    const exposureSeq = exposure.seq
    const retrieved = only(ofType(interval, 'knowledge/retrieved').filter(event => event.data.callId === data.callId
      && event.data.knowledgeId === data.knowledgeId && event.seq < exposureSeq), 'injection has no matching retrieval')
    assert(retrieved.data.allowed && retrieved.data.reason === 'ok'
      && retrieved.data.sourceContentHash === data.sourceContentHash
      && canonicalJson(retrieved.data.scope) === canonicalJson(data.scope), 'injection has no matching allowed retrieval')
    const call = calls.find(event => event.data.callId === data.callId)
    const result = results.find(event => event.data.message.source.callId === data.callId)
    assert(call !== undefined && result !== undefined && call.data.name === data.tool && call.seq < exposure.seq, 'knowledge injection has no actual calling tool')
    const block = only(result.data.message.content, 'knowledge tool result must have one result block')
    assert(block.isError !== true && JSON.stringify(block.content) === rendered, 'rendered knowledge differs from the actual tool result')
    const includedIndex = requests.findIndex((request, index) => {
      const response = messages[index]
      assert(response !== undefined, 'request has no corresponding model output')
      return response.data.step > call.data.step && (request['messages'] as GenerateOptions['messages']).some(message =>
        message.content.some(item => item.type === 'tool-result' && item.toolCallId === data.callId && JSON.stringify(item.content) === rendered))
    })
    assert(includedIndex >= 0, 'knowledge did not reach a subsequent model request')
    const included = requests[includedIndex]
    const response = messages[includedIndex]
    assert(included !== undefined && response !== undefined, 'included request has no model response')
    const nextStep = ofType(interval, 'step/start').find(event => event.data.step === response.data.step)
    assert(nextStep !== undefined && result.seq < nextStep.seq && exposure.seq < nextStep.seq, 'knowledge was recorded after the model step began')
    renderedHash = put(Buffer.from(rendered, 'utf8'))
    requestHash = putJson(included)
  }
  const selectedEvent = exposure ?? end
  const eventHash = putJson(selectedEvent)
  const outputHash = put(Buffer.from(wholeOutput, 'utf8'))
  const lastMessage = messages.at(-1)
  assert(lastMessage !== undefined, 'completed turn has no final model message')
  const attribution = retry === undefined ? null : authenticatedRetries(retry, observedCalls, binding, originalSnapshotHash)
  const retryCount = attribution?.count ?? (errors === 0 ? 0 : null)
  const retryEvidenceHash = retry === undefined ? null : put(retry.artifactBytes)
  const journalArtifactHash = putJson({ schemaVersion: 1, originalSnapshotHash, metadata, events, sourceIdentity: binding.sourceIdentity,
    projectRoot: binding.projectRoot, profileIdentity: binding.profileIdentity, buildIdentity: binding.buildIdentity,
    costEvidenceHash, retryEvidenceHash })
  const facts = {
    schemaVersion: 1, useId: binding.useId, grantIdOrNull: binding.grantId, proposalHash: binding.proposalHash,
    knowledgeId: binding.knowledge?.id ?? null, contentHash: binding.knowledge?.sourceContentHash ?? null,
    role: binding.role, pairIdOrNull: binding.pairId,
    sourceProfileBuildModelConfigTaskGoalPolicyIdentity: { profileIdentity: binding.profileIdentity, buildIdentity: binding.buildIdentity,
      model: binding.config.model, modelConfigHash: sha256(canonicalJson(binding.config)), taskHash: sha256(binding.task),
      goalHash: binding.goalHash, policyHash: binding.policyHash },
    sessionId: binding.sessionId, callId: exposure?.data.callId ?? `model-step:${binding.turn}:${lastMessage.data.step}`,
    observedAt: new Date(end.time).toISOString(), sessionEventSequenceAndHash: { sequence: selectedEvent.seq, hash: eventHash },
    renderedToolResultHash: renderedHash, providerRequestHash: requestHash, finalOutputArtifactManifest: [outputHash],
    errorsRetriesToolCallsAndCost: { turnCount: 1, errors, retries: retryCount, toolCalls: calls.length,
      costMicrounits: cost?.microunits ?? null },
    measurementDefinitionHash: binding.measurementDefinitionHash,
  }
  const captured = { facts, artifacts, journalArtifactHash, wholeOutput, requests, errors, repeatedCalls, costAvailable: cost !== null }
  capturedBindings.set(captured, { factsHash: sha256(canonicalJson(facts)), journalHash: journalArtifactHash,
    artifacts: [...artifacts.keys()], costAvailable: captured.costAvailable, retryKeyHash: attribution?.keyHash ?? null })
  return captured
}

/**
 * Seal captured use facts through the operation-specific measured-use journal authority.
 * @param captured - Complete owner-derived capture; missing independent cost evidence refuses sealing.
 * @param authority - Fixed journal authority with its verification key and measured-use-only signer method.
 * @param signal - Caller-owned cancellation signal; cancellation is checked after the signer settles.
 * @returns Canonical attestation bytes, hash, and factual binding for the existing evidence references.
 * @throws When captured evidence changes, cost/retry evidence is absent, authority/signature is invalid, or signing fails.
 */
export async function sealCapturedUse(
  captured: CapturedKnowledgeUse, authority: KnowledgeUseJournalSigningAuthority, signal: AbortSignal,
): Promise<{ hash: string; bytes: Buffer }> {
  const owned = capturedBindings.get(captured)
  const assertCaptureUnchanged = (): void => {
    assert(owned !== undefined && sha256(canonicalJson(captured.facts)) === owned.factsHash
      && captured.journalArtifactHash === owned.journalHash && captured.costAvailable === owned.costAvailable
      && captured.artifacts.size === owned.artifacts.length
      && owned.artifacts.every((hash) => {
        const bytes = captured.artifacts.get(hash)
        return bytes !== undefined && sha256(bytes) === hash
      }), 'captured facts or artifacts changed before sealing')
  }
  assertCaptureUnchanged()
  assert(owned !== undefined, 'captured facts have no owner binding')
  assert(owned.costAvailable, 'missing independent cost evidence prevents issuing a measured-use seal')
  const costs = captured.facts['errorsRetriesToolCallsAndCost'] as Record<string, unknown>
  assert(costs['retries'] !== null, 'missing independent retry evidence prevents issuing a measured-use seal')
  const authorityId = authority.authorityId
  const publicKey = authority.publicKey
  assert(typeof authorityId === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(authorityId)
    && publicKey instanceof KeyObject
    && publicKey.type === 'public' && publicKey.asymmetricKeyType === 'ed25519'
    && typeof authority.signKnowledgeUseJournal === 'function', 'journal signer authority is invalid')
  const publicKeyHash = sha256(publicKey.export({ format: 'der', type: 'spki' }))
  assert(owned.retryKeyHash !== publicKeyHash,
    'retry attribution and journal signing keys must be distinct')
  assert(!signal.aborted, 'measured-use journal signing was aborted before dispatch')
  const request: KnowledgeUseJournalSignRequest = Object.freeze({
    schemaVersion: 1, kind: 'knowledge-use-journal-v1', useFactsHash: owned.factsHash,
    journalArtifactHash: owned.journalHash, journalSignerAuthorityId: authorityId,
  })
  const canonicalRequest = Buffer.from(canonicalJson(request), 'utf8')
  const returnedSignature = await authority.signKnowledgeUseJournal(request, signal)
  assert(returnedSignature instanceof Uint8Array, 'journal signer returned a non-byte signature value')
  const signature = Buffer.from(returnedSignature)
  assert(!signal.aborted, 'measured-use journal signing was aborted before settlement')
  assert(authority.authorityId === authorityId && authority.publicKey === publicKey
    && sha256(publicKey.export({ format: 'der', type: 'spki' })) === publicKeyHash,
  'journal signer authority changed while signing')
  assertCaptureUnchanged()
  assert(signature.byteLength === 64 && verify(null, canonicalRequest, publicKey, signature),
    'journal signer returned an invalid signature for this authority and request')
  const bytes = Buffer.from(canonicalJson({ ...request, journalSignerSignature: signature.toString('base64') }), 'utf8')
  return { hash: sha256(bytes), bytes }
}

/**
 * Decode an exact persisted snapshot through the existing JSONL owner in a private temporary copy.
 * @param snapshotPath - Absolute ordinary JSONL or JSONL/Zstandard snapshot, never the project preview journal.
 * @param expectedSnapshotHash - Digest frozen by the evidence owner before this read.
 * @param binding - Fixed project/session/task identity for the decoded complete turn.
 * @returns The same capture as captureKnowledgeUse, with original bytes bound to owner-decoded events.
 * @throws On changed/unsafe bytes, unsupported encoding, loader repair, invalid content, or cleanup failure.
 */
export async function capturePersistedKnowledgeUse(
  snapshotPath: string, expectedSnapshotHash: string, binding: KnowledgeUseBinding,
): Promise<CapturedKnowledgeUse> {
  assert(isAbsolute(snapshotPath), 'session snapshot path must be absolute')
  const compression = snapshotPath.endsWith('.jsonl.zstd') ? 'zstd' : snapshotPath.endsWith('.jsonl') ? 'none' : undefined
  assert(compression !== undefined, 'session snapshot encoding is unsupported')
  const snapshot = readRegularFileBounded(snapshotPath, 16 * 1024 * 1024)
  assert(sha256(snapshot) === expectedSnapshotHash, 'session snapshot changed after freezing')
  const root = await mkdtemp(join(tmpdir(), 'ark-knowledge-use-capture-'))
  const context = new Context()
  try {
    await context.plugin(SessionStore)
    await context.plugin(JsonlSessionPersistence, { root, compression })
    const meta: SessionHeader = { version: 0, id: SessionId(binding.sessionId), createdAt: 0, cwd: binding.projectRoot }
    const location = context.sessionPersistence.locate(meta)
    assert(location !== undefined && location.kind === 'jsonl', 'JSONL owner provided no snapshot location')
    await mkdir(dirname(location.path), { recursive: true, mode: 0o700 })
    await writeFile(location.path, snapshot, { flag: 'wx', mode: 0o600 })
    const loaded = await context.sessionPersistence.load(meta.id)
    assert(sha256(readRegularFileBounded(location.path, 16 * 1024 * 1024)) === expectedSnapshotHash, 'session owner repaired an incomplete or corrupt snapshot')
    return captureKnowledgeUse(loaded.meta, loaded.events, snapshot, binding)
  } finally {
    try { await context.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
}
