/** Complete synthetic test evidence. Test keys and generated provider facts confer no real learning authority. */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { vi } from 'vitest'
import { Session, SessionId, foldRequestHeader, type SessionEvent } from '@deepseek-ai/dsh-session'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import '../../knowledge-wiki-tools/src/session-events.ts'
import { prepareCanonicalTarget } from '../src/canonical-merge.ts'
import { governanceArchivePath, promotionOperation, promotionTransactionId } from '../src/reviews.ts'
import { createKnowledgeRecord, type KnowledgeAccessContext } from '../src/knowledge-governance.ts'
import { governancePolicyVersion } from '../src/governance-policy.ts'
import { buildVerificationRequest, canonicalJson, immutableReviewRow, sha256, type IndependentVerificationRequest, type KnowledgeWikiSourceIdentity, type KnowledgeWikiVerifierAuthority } from '../src/verifier.ts'
import type { KnowledgeRecord, WikiReviewItem } from '../src/types.ts'
import type { ArtifactRef } from '../src/learning-artifacts.ts'
import { evaluateLearning, parseEvaluationInput } from '../../../../scripts/rust-migration/evaluate-learning.ts'

export const FIXTURE_TIME = Object.freeze({
  created: '2026-10-08T00:00:00.000Z',
  preregistered: '2026-10-08T00:00:01.000Z',
  reviewed: '2026-10-08T00:00:02.000Z',
  authorized: '2026-10-08T00:00:03.000Z',
  started: '2026-10-08T00:00:04.000Z',
  ended: '2026-10-08T00:00:05.000Z',
  measured: '2026-10-08T00:00:06.000Z',
  now: '2026-10-08T00:00:07.000Z',
  deadline: '2026-10-08T00:10:00.000Z',
  evidenceExpiry: '2026-10-10T00:00:00.000Z',
  knowledgeExpiry: '2026-10-09T00:00:00.000Z',
})

const FIXTURE_METRICS = Object.freeze({
  repeatedErrorRate: 'lower', repeatedToolCallRate: 'lower', verifiedTaskSuccess: 'higher',
  falseRecallRate: 'lower', staleRecallRate: 'lower', conflictDetectionRate: 'higher',
  memoryCorrectionRate: 'higher', recoverySuccess: 'higher', knowledgeUtility: 'higher',
  crossSessionLeakage: 'lower', falseCompletionRate: 'lower', userCorrectionFrequency: 'lower',
  memoryPrivilegeEscalation: 'lower', memoryPoisoning: 'lower', repairReuseSuccess: 'higher',
  conflictEscalationRate: 'higher', replayExplainability: 'higher',
} as const)
export type FixtureMetric = keyof typeof FIXTURE_METRICS
export type FixtureCount = { numerator: number; denominator: number }
type JsonObject = Record<string, unknown>
type Envelope = JsonObject & { payload: JsonObject }
type FixtureTimes = { [K in keyof typeof FIXTURE_TIME]: string }

/** The only fixture artifact store; every retained ref resolves to exact original bytes below this real path. */
export class LearningFixtureArtifacts {
  readonly root: string
  readonly entries = new Map<string, { ref: ArtifactRef; bytes: Buffer }>()
  constructor() {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), 'wiki-learning-graph-synthetic-')))
  }
  putBytes(value: string | Buffer, mediaType: ArtifactRef['mediaType'] = 'application/json'): ArtifactRef {
    const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8')
    const digest = sha256(bytes)
    const ref: ArtifactRef = { algorithm: 'sha256', digest, bytes: bytes.byteLength, mediaType }
    const path = this.path(ref)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const existing = this.entries.get(digest)
    if (existing !== undefined && !existing.bytes.equals(bytes)) throw new Error('synthetic artifact collision')
    if (existing === undefined) writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
    this.entries.set(digest, { ref, bytes })
    return ref
  }
  put(value: unknown): ArtifactRef { return this.putBytes(canonicalJson(value)) }
  path(ref: ArtifactRef): string { return join(this.root, 'sha256', ref.digest.slice(0, 2), ref.digest) }
  json(ref: ArtifactRef): JsonObject { return JSON.parse(readFileSync(this.path(ref), 'utf8')) as JsonObject }
  dispose(): void { rmSync(this.root, { recursive: true, force: true }) }
}

export interface HistoricalFixtureChanges {
  readonly wal?: (value: JsonObject) => void
  readonly projection?: (value: JsonObject) => void
  readonly canonicalRecord?: (value: KnowledgeRecord) => KnowledgeRecord
  readonly update?: LearningFixtureChanges
}

/** Seed a full test-authenticated historical Promote; no production positive writer or measured execution runs. */
export function createHistoricalUpdateFixture(changes: HistoricalFixtureChanges = {}) {
  const historical = createLearningGraphFixture()
  try {
    const { artifacts, signers, journal, semantic, proposalPayload } = historical
    const roots = historical.captureContext()
    const auditTime = historical.times.measured
    const reviewBefore = readFileSync(roots.reviewFile, 'utf8')
    const reviews = JSON.parse(reviewBefore) as JsonObject[]
    const reviewAfter = JSON.stringify(reviews.map(row => row['id'] === semantic.review.id
      ? { ...row, resolved: true, resolvedAction: 'Promote', appliedPath: semantic.targetPath, resolvedAt: Date.parse(auditTime) } : row), null, 2)
    const governanceAfter = `${JSON.stringify({ timestamp: auditTime, policyVersion: governancePolicyVersion(), reviewId: semantic.review.id,
      action: 'Promote', actor: 'synthetic-approved-principal', outcome: 'applied', candidateHash: semantic.candidate.digest,
      previousCanonicalHash: '', targetPath: semantic.targetPath, appliedPath: semantic.targetPath })}\n`
    const transactionId = promotionTransactionId(semantic.review.id, semantic.candidate.digest, auditTime)
    const archivedCandidate = governanceArchivePath(roots.archiveRoot, dirname(roots.wikiRoot), auditTime, semantic.candidate.digest, semantic.candidatePath, 'candidate')
    const targetAbsolute = join(roots.wikiRoot, semantic.targetPath)
    const candidateAbsolute = join(roots.wikiRoot, semantic.candidatePath)
    const tuples = [
      { role: 'candidate-archive' as const, path: archivedCandidate, before: undefined, after: semantic.verifiedRecord.content },
      { role: 'canonical' as const, path: targetAbsolute, before: undefined, after: semantic.targetAfter },
      { role: 'review' as const, path: roots.reviewFile, before: reviewBefore, after: reviewAfter },
      { role: 'governance' as const, path: join(dirname(roots.reviewFile), 'governance.jsonl'), before: undefined, after: governanceAfter },
      { role: 'candidate' as const, path: candidateAbsolute, before: semantic.verifiedRecord.content, after: undefined },
    ]
    const operations = tuples.map((value, index) => {
      const actual = promotionOperation(transactionId, index, value.role, value.path, value.before, value.after)
      return { role: actual.role, path: actual.path, before: actual.before ?? null, after: actual.after ?? null,
        stagingPath: actual.stagingPath ?? null, tombstonePath: actual.tombstonePath ?? null }
    })
    const core: JsonObject = { schemaVersion: 2, id: transactionId, createdAt: auditTime, proposal: historical.proposal,
      semanticReceipt: semantic.semanticReceipt, measuredTrial: historical.trial, journalHeadBefore: journal.watermark(),
      operationSetHash: sha256(canonicalJson(operations)), action: 'Promote', operations }
    changes.wal?.(core)
    const wal = artifacts.put({ ...core, seal: signers.journalEnvelope('promotion-wal', { walCoreHash: sha256(canonicalJson(core)) }) })
    const transition = proposalPayload['canonicalIdentityTransition'] as JsonObject
    const baseCanonical: KnowledgeRecord = { ...semantic.verifiedRecord, source: semantic.targetPath, content: semantic.targetAfter,
      contentHash: String(proposalPayload['evaluatedContentHash']), sourceHash: (transition['canonicalProvenance'] as ArtifactRef).digest,
      lifecycle: 'canonical', retrievalHits: 1, successfulUses: 1, utilityScore: 1, lastVerifiedAt: historical.times.measured,
      evidenceRefs: [...semantic.verifiedRecord.evidenceRefs, `sha256:${historical.proposal.digest}`, `sha256:${historical.trial.digest}`, `sha256:${wal.digest}`] }
    const canonical = changes.canonicalRecord?.(baseCanonical) ?? baseCanonical
    const canonicalRecord = artifacts.put(canonical)
    const projection: JsonObject = { transition, revisionId: sha256(canonicalJson({ kind: 'ark.knowledge.canonical-revision', canonicalKnowledgeId: canonical.id,
      proposalHash: historical.proposal.digest, targetAfterHash: proposalPayload['evaluatedContentHash'] })), canonicalRecordAfter: canonicalRecord,
    candidateDisposition: 'same-id-promoted', candidateRecordAfter: canonicalRecord, newlyCreditedUseIds: ['synthetic-use-candidate'] }
    changes.projection?.(projection)
    journal.append(canonical.id, { type: 'knowledge/promoted', proposal: historical.proposal, trial: historical.trial, wal, projection }, auditTime)
    const admissionIdentity = fixtureAdmission(canonical)
    const targetSnapshot = { record: canonicalRecord, admissionIdentity,
      admissionIdentityHash: sha256(canonicalJson(admissionIdentity)), watermark: journal.watermark() }
    // These are isolated fixture setup bytes, not application writes or proof of fsync/power loss.
    for (const value of tuples) {
      if (value.after === undefined) rmSync(value.path)
      else { mkdirSync(dirname(value.path), { recursive: true, mode: 0o700 }); writeFileSync(value.path, value.after, { mode: 0o600 }) }
    }
    const update = createLearningGraphFixture(changes.update, {
      artifacts, signers, journal, tag: 'synthetic-update', timeOffsetMs: 10_000,
      target: { bytes: semantic.targetAfter, record: canonical, snapshot: targetSnapshot },
      allowedDefinitions: historical.descriptor.evaluator.allowedDefinitions,
      allowedInitiationCapabilities: historical.descriptor.evaluator.allowedInitiationCapabilities,
      sessionContexts: historical.sessionContexts,
    })
    return { ...update, historical, wal, projection, historicalCanonical: canonical, targetSnapshot }
  } catch (error) { historical.artifacts.dispose(); throw error }
}

/** Independent in-memory test signing roles. Only public material is exposed or written. */
export class LearningFixtureSigners {
  readonly evaluatorId = 'synthetic-external-evaluator'
  readonly journalId = 'synthetic-product-journal'
  readonly projectIdentityHash = sha256('synthetic-protected-project-owner')
  private readonly evaluator = generateKeyPairSync('ed25519')
  private readonly journal = generateKeyPairSync('ed25519')
  readonly evaluatorPublic = this.publicAnchor(this.evaluator.publicKey, this.evaluatorId)
  readonly journalPublic = { ...this.publicAnchor(this.journal.publicKey, this.journalId), projectIdentityHash: this.projectIdentityHash }
  private publicAnchor(key: KeyObject, keyId: string) {
    return { keyId, keyFingerprint: sha256(key.export({ type: 'spki', format: 'der' })), publicKeySpkiPem: key.export({ type: 'spki', format: 'pem' }).toString() }
  }
  evaluatorEnvelope(kind: string, payload: JsonObject, requestArtifact: ArtifactRef | null = null, changes: JsonObject = {}): Envelope {
    const unsigned = {
      schemaVersion: 1, domain: 'ark.knowledge.evaluator', kind, authorityId: this.evaluatorId,
      keyId: this.evaluatorPublic.keyId, keyFingerprint: this.evaluatorPublic.keyFingerprint,
      requestHash: requestArtifact?.digest ?? null, requestArtifact,
      issuedAt: FIXTURE_TIME.measured, expiresAt: FIXTURE_TIME.evidenceExpiry, payload, ...changes,
    }
    return { ...unsigned, proof: { algorithm: 'Ed25519', signatureBase64: sign(null, Buffer.from(`ARK-KNOWLEDGE-EVALUATOR\0${canonicalJson(unsigned)}`), this.evaluator.privateKey).toString('base64') } }
  }
  journalEnvelope(kind: string, payload: JsonObject, changes: JsonObject = {}): Envelope {
    const unsigned = {
      schemaVersion: 1, domain: 'ark.knowledge.local-journal', kind,
      signerId: this.journalId, keyId: this.journalPublic.keyId, keyFingerprint: this.journalPublic.keyFingerprint,
      projectIdentityHash: this.projectIdentityHash, payload, ...changes,
    }
    return { ...unsigned, proof: { algorithm: 'Ed25519', signatureBase64: sign(null, Buffer.from(`ARK-KNOWLEDGE-LOCAL-JOURNAL\0${canonicalJson(unsigned)}`), this.journal.privateKey).toString('base64') } }
  }
  semantic(request: IndependentVerificationRequest, issuedAt: string = FIXTURE_TIME.reviewed): JsonObject {
    const result = {
      authorityId: this.evaluatorId, requestHash: sha256(canonicalJson(request)), result: 'pass',
      methods: ['integration_test'], outcomes: [{ name: 'synthetic-exact-source-review', result: 'pass', evidence: ['Synthetic test-only source review; no evaluator was provisioned.'] }],
      issuedAt,
    }
    const signed = { ...result, proof: sign(null, Buffer.from(canonicalJson(result)), this.evaluator.privateKey).toString('base64') }
    const unsigned = { schemaVersion: 2, request, result: signed }
    const receiptHash = sha256(canonicalJson(unsigned))
    return { ...unsigned, id: `verification-${receiptHash.slice(0, 32)}`, receiptHash }
  }
}

const FIXTURE_SOURCE: KnowledgeWikiSourceIdentity = Object.freeze({
  commit: '15cf20d4ea40e88a9f634d00510ad4b0e2da7f51',
  sourceDigest: sha256('synthetic-source-identity'), dirty: true,
  dirtyDigest: sha256('synthetic-dirty-source'), buildDigest: sha256('synthetic-build-identity-no-build-executed'),
})

/** Synthetic local owner emits signed bytes only; it never dispatches, promotes, or supplies production trust. */
export class LearningFixtureJournal {
  readonly epoch = 'synthetic-test-epoch-1'
  readonly events: JsonObject[] = []
  constructor(readonly artifacts: LearningFixtureArtifacts, readonly signers: LearningFixtureSigners, readonly scope: JsonObject) {}
  append(knowledgeId: string, payload: JsonObject, timestamp: string = FIXTURE_TIME.measured): JsonObject {
    const body = {
      schemaVersion: 2, epoch: this.epoch, projectIdentityHash: this.signers.projectIdentityHash,
      id: `synthetic-event-${this.events.length}`, seq: this.events.length, timestamp, knowledgeId, scope: this.scope,
      previousEventHash: this.events.at(-1)?.['eventHash'] ?? null, payload,
    }
    const seal = this.signers.journalEnvelope('event', { eventBodyHash: sha256(canonicalJson(body)) })
    const event = { ...body, seal, eventHash: sha256(canonicalJson({ ...body, seal })) }
    this.events.push(event)
    return event
  }
  head() {
    const last = this.events.at(-1)
    if (last === undefined) throw new Error('synthetic journal is empty')
    const artifact = this.artifacts.putBytes(`${this.events.map(canonicalJson).join('\n')}\n`, 'application/x-ndjson')
    const protectedHead = { epoch: this.epoch, seq: this.events.length - 1, eventHash: String(last['eventHash']), prefixHash: artifact.digest }
    return { artifact, protectedHead }
  }
  watermark(): JsonObject {
    const { artifact, protectedHead } = this.head()
    return {
      epoch: protectedHead.epoch, seq: protectedHead.seq, eventHash: protectedHead.eventHash,
      projectIdentityHash: this.signers.projectIdentityHash, journalPrefix: artifact,
      checkpoint: this.signers.journalEnvelope('journal-watermark', { ...protectedHead, projectIdentityHash: this.signers.projectIdentityHash }),
    }
  }
}

function fixtureAdmission(record: KnowledgeRecord): JsonObject {
  return {
    id: record.id, content: record.content, source: record.source, sourceHash: record.sourceHash, contentHash: record.contentHash,
    claimKey: record.claimKey ?? null, scope: record.scope, acl: record.acl ?? null,
    createdAt: record.createdAt, expiresAt: record.expiresAt,
  }
}

const CANDIDATE_BYTES = '---\ntitle: Synthetic bounded repair protocol\nstatus: candidate\nsources: [https://example.test/synthetic-source]\nrelated: [repair-protocol]\ncreated: 2026-10-08\n---\n\n# Synthetic bounded repair protocol\n\n## 适用条件与边界\n这是测试专用的独立输入，说明在输入边界发生错误时如何按照明确流程检查并恢复。规则适用于有固定验收目标和可重放证据的任务，不适用于未经验证的完成声明。\n\n## 验证证据与步骤\n先检查输入值、约束和输出格式，再执行修复；保留失败观察和完整原始记录。确认回滚点及每个操作的前后状态，验收时依据可重复的输出检查，不以工具调用成功代替任务成功。\n\n## 防复发动作\n使用明确的前提、限制和触发条件，并在同一验证流程中保存适用和不适用案例。每次输出必须遵守原约束；出现冲突时停止并保留证据，不能借旧结论重新认证新的字节。\n'

export interface FixtureSessionFacts {
  readonly session: Session
  readonly initialPrefix: ArtifactRef
  readonly arm: JsonObject
  readonly requests: JsonObject[]
  readonly injections: JsonObject[]
  readonly reservations: JsonObject[]
  readonly context: KnowledgeAccessContext
  readonly completeSession: ArtifactRef
}

function sessionArtifact(artifacts: LearningFixtureArtifacts, session: Session): ArtifactRef {
  return artifacts.put({ schemaVersion: 1, kind: 'ark.knowledge.session-prefix', sessionId: session.id, header: session.header, throughSeq: session.seq - 1, events: session.events })
}

/** Append through the actual Session/surface owner, and freeze the original log rather than a restored seed. */
function fixtureSession(artifacts: LearningFixtureArtifacts, variant: 'baseline' | 'candidate', binding: {
  run: JsonObject
  grantId: string
  useId: string
  proposalHash: string
  targetPath: string
  targetAfter: string
  frozenWorld: ArtifactRef
  expectedOutput: ArtifactRef
  scope: JsonObject
  candidate: KnowledgeRecord
  times?: FixtureTimes
  pairId?: string
}): FixtureSessionFacts {
  const times = binding.times ?? FIXTURE_TIME
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(times.created))
  try {
    const sessionId = SessionId(`synthetic-${binding.useId}`)
    const session = Session.create(sessionId, undefined, { version: 0, id: sessionId, createdAt: Date.parse(times.created) })
    const config = { provider: String(binding.run['provider']), model: String(binding.run['model']), temperature: 0, maxTokens: 256 }
    session.append('turn/start', { turn: 0 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic isolated task: preserve the declared repair output.' }] }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 0, step: 0 })
    session.append('request/header', { header: { config, system: 'Synthetic test task, with no provider dispatch.' }, reason: 'initial' })
    session.append('request/context', { provider: config.provider, model: config.model })
    const initialPrefix = sessionArtifact(artifacts, session)
    const arm = {
      useId: binding.useId, pairId: binding.pairId ?? 'synthetic-pair-1', variant, sessionId,
      initialSessionHeaderHash: sha256(canonicalJson(session.header)), initialSessionPrefixHash: initialPrefix.digest,
      run: binding.run, frozenTaskWorld: binding.frozenWorld, expectedOutputManifest: binding.expectedOutput,
    }
    clock.mockReturnValue(Date.parse(times.started))
    const requests: JsonObject[] = []
    const reservations: JsonObject[] = []
    const injections: JsonObject[] = []
    const request = (step: number) => {
      const prefix = sessionArtifact(artifacts, session)
      const header = foldRequestHeader(session.events)
      if (header === undefined) throw new Error('fixture request lacks actual logged header')
      const input = { ...header.config, messages: session.deriveMessages(),
        ...header.system === undefined ? {} : { system: header.system },
        ...header.tools === undefined ? {} : { tools: header.tools }, sessionId }
      const providerInput = artifacts.put(input)
      // This is a synthetic externally-shaped body, not an observed real transport request.
      const requestBody = artifacts.putBytes(JSON.stringify({ model: config.model, messages: input.messages, syntheticTestOnly: true }), 'application/octet-stream')
      const ordinal = requests.length + 1
      const attemptId = `synthetic-attempt-${binding.useId}-${ordinal}`
      reservations.push({ reservationId: `synthetic-request-${binding.useId}-${ordinal}`, grantId: binding.grantId, useId: binding.useId, sessionId, phase: 'model-request', ordinal, callId: null, requestAttemptId: attemptId, proposalHash: binding.proposalHash, sessionPrefixHash: prefix.digest, turn: 0, step })
      const sentAt = new Date(Date.now()).toISOString()
      const settledAt = new Date(Date.now() + 100).toISOString()
      requests.push({ schemaVersion: 1, kind: 'ark.knowledge.provider-request-fact', attemptId, grantId: binding.grantId, useId: binding.useId, sessionId, turn: 0, step, ordinal,
        adapter: 'llm-deepseek', api: 'chat-completions', endpointIdentity: sha256('synthetic-endpoint-no-network'), model: config.model,
        modelConfigHash: binding.run['modelConfigHash'], sessionPrefix: prefix, providerInput, requestBody, bodySha256: requestBody.digest,
        dispatchState: 'response-received', httpStatus: 200, providerRequestId: `synthetic-provider-${attemptId}`, sentAt, settledAt })
      clock.mockReturnValue(Date.parse(settledAt))
    }
    request(0)
    if (variant === 'candidate') {
      const callId = CallId(`synthetic-read-${binding.useId}`)
      session.append('assistant/message', { turn: 0, step: 0, message: createAssistantMessage({ source: { provider: config.provider, model: config.model }, content: [{ type: 'tool-call', id: callId, name: 'wiki_read', arguments: JSON.stringify({ path: binding.targetPath }) }] }) }, { surfaceOp: 'append' })
      const toolCall = session.append('tool/call', { turn: 0, step: 0, callId, name: 'wiki_read', arguments: JSON.stringify({ path: binding.targetPath }) })
      const reservedPrefix = sessionArtifact(artifacts, session)
      const reservationId = `synthetic-read-reservation-${binding.useId}`
      reservations.push({ reservationId, grantId: binding.grantId, useId: binding.useId, sessionId, phase: 'knowledge-read', ordinal: 1, callId, requestAttemptId: null, proposalHash: binding.proposalHash, sessionPrefixHash: reservedPrefix.digest, turn: 0, step: 0 })
      const value = { path: binding.targetPath, content: binding.targetAfter }
      const content = [{ type: 'text' as const, text: binding.targetAfter }]
      const common = { knowledgeId: binding.candidate.id, path: binding.targetPath, tool: 'wiki_read', callId,
        scope: { ...binding.scope, sessionId }, sourceHash: binding.candidate.sourceHash,
        sourceContentHash: sha256(binding.targetAfter), trust: binding.candidate.trust, authority: binding.candidate.authority,
        evidenceRefs: [...binding.candidate.evidenceRefs], verificationStatus: binding.candidate.verificationStatus,
        expiresAt: binding.candidate.expiresAt, conflicts: [...binding.candidate.conflicts], kind: 'page' as const }
      const retrieved = session.append('knowledge/retrieved', { ...common, value, resultHash: sha256(JSON.stringify(value)), contentHash: sha256(JSON.stringify(value)), allowed: true, reason: 'ok' })
      const renderedToolResultHash = sha256(JSON.stringify(content))
      const injected = session.append('knowledge/injected', { ...common, value: content, resultHash: renderedToolResultHash, contentHash: renderedToolResultHash, contentBytes: Buffer.byteLength(JSON.stringify(content)) })
      const toolResult = session.append('tool/result', { turn: 0, step: 0, message: createToolResultMessage({ callId, content, isError: false }) }, { surfaceOp: 'append' })
      const injectionPrefix = sessionArtifact(artifacts, session)
      const eventRef = (event: SessionEvent) => ({ sessionId, seq: event.seq,
        eventHash: sha256(canonicalJson(event)), sessionPrefix: injectionPrefix })
      injections.push({ reservationId, callId, toolCall: eventRef(toolCall), retrieved: eventRef(retrieved),
        injected: eventRef(injected), toolResult: eventRef(toolResult), evaluatedContentHash: sha256(binding.targetAfter),
        renderedToolResultHash, renderedToolResult: artifacts.putBytes(JSON.stringify(content)),
        sourceContentHash: sha256(binding.targetAfter) })
      session.append('step/end', { turn: 0, step: 0 })
      session.append('step/start', { turn: 0, step: 1 })
      request(1)
    }
    const finalStep = variant === 'candidate' ? 1 : 0
    session.append('assistant/message', { turn: 0, step: finalStep, message: createAssistantMessage({ source: { provider: config.provider, model: config.model }, content: [{ type: 'text', text: variant === 'candidate' ? 'synthetic-output: repaired' : 'synthetic-output: failed' }] }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 0, step: finalStep })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    return { session, initialPrefix, arm, requests, injections, reservations, context: { projectId: String(binding.scope['projectId']), actor: 'synthetic-approved-principal', sessionId }, completeSession: sessionArtifact(artifacts, session) }
  } finally { clock.mockRestore() }
}

function fixtureCounts(variant: 'baseline' | 'candidate'): Record<FixtureMetric, FixtureCount> {
  return Object.fromEntries(Object.entries(FIXTURE_METRICS).map(([name, direction]) => [name, { numerator: variant === 'candidate' ? direction === 'higher' ? 1 : 0 : direction === 'higher' ? 0 : 1, denominator: 1 }])) as Record<FixtureMetric, FixtureCount>
}

/** Construct retained semantic v2 bytes by calling the existing real request owner on isolated files. */
function fixtureSemantic(artifacts: LearningFixtureArtifacts, signers: LearningFixtureSigners, setup: {
  tag?: string
  times?: FixtureTimes
  target?: { bytes: string; record: KnowledgeRecord; snapshot: JsonObject }
} = {}) {
  const times = setup.times ?? FIXTURE_TIME
  const tag = setup.tag ?? 'synthetic'
  const wikiRoot = join(artifacts.root, 'isolated-project', 'wiki')
  const candidatePath = `_candidates/${tag}-repair.md`
  const targetPath = 'methodology/synthetic-repair.md'
  mkdirSync(join(wikiRoot, '_candidates'), { recursive: true })
  writeFileSync(join(wikiRoot, candidatePath), CANDIDATE_BYTES, { mode: 0o600 })
  const action = setup.target === undefined ? 'Promote' : 'Replace'
  const review: WikiReviewItem = { id: `${tag}-review`, type: 'candidate', title: 'Synthetic bounded repair protocol', resolved: false, reviewKind: 'candidate', candidatePath, candidateHash: sha256(CANDIDATE_BYTES), targetPath, sourcePath: 'synthetic:independent-source-label', sourceHash: sha256('synthetic:independent-source-label') }
  const authority: KnowledgeWikiVerifierAuthority = {
    authorityId: signers.evaluatorId, sourceIdentity: () => FIXTURE_SOURCE,
    verifyCandidate: () => { throw new Error('synthetic fixture must not execute an evaluator') }, validateCandidateResult: () => false,
    sealPromotion: () => { throw new Error('synthetic fixture must not promote') }, validatePromotion: () => false,
  }
  const request = buildVerificationRequest(authority, wikiRoot, review, action)
  if (request === undefined || (action === 'Promote' && request.governanceDecision.action !== 'Promote')) throw new Error('synthetic semantic request is not a genuine compatible request')
  const receipt = signers.semantic(request, times.reviewed)
  const semanticReceipt = artifacts.putBytes(JSON.stringify(receipt, null, 2))
  const candidate = artifacts.putBytes(CANDIDATE_BYTES, 'text/markdown; charset=utf-8')
  const immutableReview = artifacts.put(immutableReviewRow(review))
  const targetAfter = prepareCanonicalTarget({ action, candidateContent: CANDIDATE_BYTES, targetPath, targetBefore: setup.target?.bytes, reviewedAt: times.reviewed, actor: 'synthetic-approved-principal' })
  const verifiedRecord = createKnowledgeRecord({
    id: `${tag}-candidate`, content: CANDIDATE_BYTES, source: candidatePath, sourceHash: request.sourceHash, contentHash: candidate.digest,
    claimKey: 'synthetic-repair-claim', scope: { projectId: 'synthetic-project', visibility: 'project' },
    acl: { readers: ['synthetic-approved-principal'], writers: ['synthetic-approved-principal'] },
    trust: 'medium', authority: signers.evaluatorId, confidence: 0.9, verificationStatus: 'verified', lifecycle: 'candidate',
    evidenceRefs: [`artifact:${semanticReceipt.digest}`], createdAt: times.created,
    lastVerifiedAt: times.reviewed, expiresAt: times.knowledgeExpiry,
  })
  return { review, request, receipt, semanticReceipt, candidate, immutableReview,
    candidatePath, targetPath, targetAfter, verifiedRecord, action }
}


export interface LearningFixtureChanges {
  readonly candidateRecord?: (value: KnowledgeRecord) => KnowledgeRecord
  readonly sessionFacts?: (value: FixtureSessionFacts, variant: 'baseline' | 'candidate') => void
  readonly definition?: (value: JsonObject) => void
  readonly capability?: (value: JsonObject) => void
  readonly snapshot?: (value: JsonObject) => void
  readonly proposal?: (value: JsonObject) => void
  readonly grant?: (value: JsonObject) => void
  readonly use?: (value: JsonObject, variant: 'baseline' | 'candidate') => void
  readonly useEnvelope?: (value: JsonObject, variant: 'baseline' | 'candidate', signers: LearningFixtureSigners) => JsonObject
  readonly childRequest?: (value: JsonObject) => void
  readonly trial?: (value: JsonObject) => void
  readonly suffix?: (journal: LearningFixtureJournal, knowledgeId: string, record: KnowledgeRecord) => void
  readonly protectedHead?: (value: JsonObject) => void
}

interface LearningFixtureSetup {
  readonly artifacts?: LearningFixtureArtifacts
  readonly signers?: LearningFixtureSigners
  readonly journal?: LearningFixtureJournal
  readonly tag?: string
  readonly timeOffsetMs?: number
  readonly target?: { readonly bytes: string; readonly record: KnowledgeRecord; readonly snapshot: JsonObject }
  readonly allowedDefinitions?: Record<string, ArtifactRef>
  readonly allowedInitiationCapabilities?: readonly ArtifactRef[]
  readonly sessionContexts?: ReadonlyMap<string, KnowledgeAccessContext>
}

/** Build every referenced leaf and all original child requests before issuing the corresponding test proof. */
export function createLearningGraphFixture(changes: LearningFixtureChanges = {}, setup: LearningFixtureSetup = {}) {
  const artifacts = setup.artifacts ?? new LearningFixtureArtifacts()
  const signers = setup.signers ?? new LearningFixtureSigners()
  const tag = setup.tag ?? 'synthetic'
  const times = Object.fromEntries(Object.entries(FIXTURE_TIME).map(([name, value]) =>
    [name, new Date(Date.parse(value) + (setup.timeOffsetMs ?? 0)).toISOString()])) as FixtureTimes
  try {
    const semantic = fixtureSemantic(artifacts, signers, { tag, times, ...setup.target === undefined ? {} : { target: setup.target } })
    if (changes.candidateRecord !== undefined) semantic.verifiedRecord = changes.candidateRecord(semantic.verifiedRecord)
    const candidateRecordRef = artifacts.put(semantic.verifiedRecord)
    const scope = semantic.verifiedRecord.scope
    const journal = setup.journal ?? new LearningFixtureJournal(artifacts, signers, { ...scope })
    if (journal.events.length === 0) journal.append('synthetic-genesis', { type: 'knowledge/journal-started', legacyLog: null, legacyLastEventHash: null }, times.created)
    const candidateRecord = createKnowledgeRecord({ ...semantic.verifiedRecord, verificationStatus: 'candidate', trust: 'low',
      authority: 'untrusted-observation', confidence: 0, evidenceRefs: [], lastVerifiedAt: null })
    journal.append(candidateRecord.id, { type: 'knowledge/candidate', legacyShapePayload: { record: candidateRecord } }, times.created)
    journal.append(candidateRecord.id, { type: 'knowledge/verified', semanticReceipt: semantic.semanticReceipt,
      recordSnapshot: candidateRecordRef }, times.reviewed)
    const admissionIdentity = fixtureAdmission(semantic.verifiedRecord)
    const snapshot: JsonObject = { record: candidateRecordRef, admissionIdentity,
      admissionIdentityHash: sha256(canonicalJson(admissionIdentity)), watermark: journal.watermark() }
    changes.snapshot?.(snapshot)

    const baseline = JSON.parse(readFileSync(new URL('../../../../scripts/rust-migration/evidence/learning-protocol-baseline-20261008.json', import.meta.url), 'utf8')) as { artifacts: { name: string; utf8: string }[] }
    const manifest = baseline.artifacts.find(value => value.name === 'retained/project-manifest.json')
    const format = baseline.artifacts.find(value => value.name === 'data-format-preimage.canonical.json')
    const plan = baseline.artifacts.find(value => value.name === 'affected-plan-preimage.canonical.json')
    const approval = baseline.artifacts.find(value => value.name === 'retained/approval-record.json')
    if (manifest === undefined || format === undefined || plan === undefined || approval === undefined) throw new Error('approved baseline artifacts missing')
    const originalManifest = artifacts.putBytes(manifest.utf8)
    const formatObject = JSON.parse(format.utf8) as { originalImmutable: JsonObject }
    const mission = { originalManifest, original: formatObject.originalImmutable, approvalRecordHash: sha256(approval.utf8),
      affectedPlanHash: sha256(plan.utf8), dataFormatHash: sha256(format.utf8), stateVersion: 1 }
    const config = { provider: 'synthetic-provider', model: 'synthetic-model-no-call', temperature: 0, maxTokens: 256 }
    const run: JsonObject = { projectId: 'synthetic-project', profile: 'synthetic-profile', profileDigest: sha256('synthetic-profile'), source: FIXTURE_SOURCE, mission, model: config.model, provider: config.provider,
      modelConfigHash: sha256(canonicalJson(config)), taskHash: sha256('synthetic-frozen-task'),
      goalHash: mission.original['goalHash'], policyHash: sha256('synthetic-frozen-policy') }
    const leaf = (kind: string, fields: JsonObject = {}) => artifacts.put({ schemaVersion: 1, kind, authority: 'TEST_ONLY_SYNTHETIC', ...fields })
    const frozenTask = artifacts.putBytes('Synthetic isolated task: preserve the declared repair output.', 'application/octet-stream')
    const frozenWorld = leaf('synthetic.world-manifest', { directories: ['task'], files: [{ path: 'task/input.txt', bytes: frozenTask.bytes, content: frozenTask }] })
    const expectedBytes = artifacts.putBytes('synthetic-output: repaired', 'application/octet-stream')
    const expectedOutput = leaf('synthetic.expected-output-manifest', { files: [{ path: 'task/output.txt', content: expectedBytes, bytes: expectedBytes.bytes }] })
    const grantId = `${tag}-grant-1`
    const sessions = (['baseline', 'candidate'] as const).map(variant => fixtureSession(artifacts, variant, {
      run, grantId, useId: `${tag}-use-${variant}`, proposalHash: sha256('pending-synthetic-proposal'), targetPath: semantic.targetPath, targetAfter: semantic.targetAfter,
      frozenWorld, expectedOutput, scope: { ...scope }, candidate: semantic.verifiedRecord, times, pairId: `${tag}-pair-1`,
    }))
    for (const [index, session] of sessions.entries()) changes.sessionFacts?.(session, index === 0 ? 'baseline' : 'candidate')
    const arms = sessions.map(value => value.arm)
    const oracleDefinition = leaf('synthetic.oracle-definition', { task: frozenTask, expectedOutput, acceptance: 'Exact declared output; failed baseline remains an observed failed opportunity.', metricUnits: Object.keys(FIXTURE_METRICS) })
    const oracleBuild = artifacts.putBytes('TEST_ONLY_SYNTHETIC oracle: compare complete declared artifacts; not a provisioned evaluator executable.', 'application/octet-stream')
    const opportunityDefinitions = Object.fromEntries(Object.keys(FIXTURE_METRICS).map(name => [name, leaf('synthetic.metric-opportunity', { metric: name, numeratorMeaning: FIXTURE_METRICS[name as FixtureMetric] === 'higher' ? 'independently observed correct synthetic opportunity' : 'independently observed erroneous synthetic opportunity', denominatorMeaning: 'one explicitly declared synthetic opportunity per ordered arm' })]))
    const definitionPayload: JsonObject = {
      schemaVersion: 1, kind: 'ark.knowledge.measurement-definition', definitionId: `${tag}-definition-1`, preregisteredAt: times.preregistered,
      corpus: leaf('synthetic.corpus', { tasks: [frozenTask], worlds: [frozenWorld], orderedUseIds: arms.map(value => value['useId']) }), oracleDefinition, oracleBuild,
      opportunityDefinitions, requiredMetricNames: Object.keys(FIXTURE_METRICS), completeOrderedArms: arms,
      exclusionRules: leaf('synthetic.exclusion-rules', { rules: [], retrospectiveExclusionAllowed: false }),
      safetyProbeManifest: leaf('synthetic.safety-probes', { probes: Object.keys(FIXTURE_METRICS).filter(name => FIXTURE_METRICS[name as FixtureMetric] === 'lower'), world: frozenWorld }),
      maxKnowledgeReads: 2, maxModelAttempts: 4, maxTurns: 2, maxArtifacts: 5000, maxArtifactBytes: 10_000_000,
      deadline: times.deadline, evidenceExpiresAt: times.evidenceExpiry, knowledgeExpiresAt: times.knowledgeExpiry,
    }
    changes.definition?.(definitionPayload)
    const definition = artifacts.put(signers.evaluatorEnvelope('measurement-definition', definitionPayload, null, { issuedAt: times.preregistered }))
    const targetBefore = setup.target === undefined ? null : artifacts.putBytes(setup.target.bytes, 'text/markdown; charset=utf-8')
    const targetAdmissionHash = setup.target?.snapshot['admissionIdentityHash'] ?? null
    const userApproval = leaf('synthetic.user-approval', { principal: 'synthetic-approved-principal', reviewId: semantic.review.id, targetPath: semantic.targetPath, action: semantic.action, definition })
    const capabilityPayload: JsonObject = {
      capabilityId: `${tag}-capability-1`, userApproval, projectId: 'synthetic-project', profileDigest: run['profileDigest'], sourceIdentity: FIXTURE_SOURCE,
      reviewId: semantic.review.id, reviewHash: semantic.immutableReview.digest, candidateHash: semantic.candidate.digest,
      targetPath: semantic.targetPath, targetBeforeHash: targetBefore?.digest ?? null,
      action: semantic.action, definitionId: definitionPayload['definitionId'], definitionHash: definition.digest, approvedActorPrincipalId: 'synthetic-approved-principal', reviewedAt: times.reviewed,
      candidateAdmissionIdentityHash: snapshot['admissionIdentityHash'], targetAdmissionIdentityHash: targetAdmissionHash, maxInitiations: 1,
    }
    changes.capability?.(capabilityPayload)
    const capability = artifacts.put(signers.evaluatorEnvelope('trial-initiation-capability', capabilityPayload, null, { issuedAt: times.preregistered }))
    const decision = { reviewId: semantic.review.id, reviewHash: semantic.immutableReview.digest, action: semantic.action, targetPath: semantic.targetPath, actorPrincipalId: 'synthetic-approved-principal', reviewedAt: times.reviewed, initiationCapabilityHash: capability.digest, policyVersion: governancePolicyVersion() }
    const reviewedDecisionHash = sha256(canonicalJson(decision))
    const sourceLabel = artifacts.putBytes(semantic.review.sourcePath ?? '', 'application/octet-stream')
    const source = { kind: 'identity-label', reference: sourceLabel, sourceHash: sourceLabel.digest }
    const canonicalProvenance = artifacts.put({ schemaVersion: 1, kind: 'ark.knowledge.canonical-revision-provenance', candidateRecord: candidateRecordRef, candidateBytes: semantic.candidate, candidateSource: source,
      targetRecordBefore: setup.target?.snapshot['record'] ?? null, targetBytesBefore: targetBefore, targetSourceHashBefore: setup.target?.record.sourceHash ?? null, semanticReceipt: semantic.semanticReceipt, reviewedDecisionHash })
    const transition = { policy: 'ark.target-stable-equal-restrictions/1', kind: setup.target === undefined ? 'new-canonical' : 'update-canonical', candidateKnowledgeId: candidateRecord.id, canonicalKnowledgeId: setup.target?.record.id ?? candidateRecord.id,
      candidateAdmissionIdentityHash: snapshot['admissionIdentityHash'], targetAdmissionIdentityHash: targetAdmissionHash, canonicalProvenance, canonicalScope: scope, canonicalAcl: semantic.verifiedRecord.acl ?? null, canonicalExpiresAt: setup.target?.record.expiresAt ?? times.knowledgeExpiry }
    const targetAfter = artifacts.putBytes(semantic.targetAfter, 'text/markdown; charset=utf-8')
    const proposalPayload: JsonObject = {
      schemaVersion: 1, kind: 'ark.knowledge.canonical-proposal', review: semantic.immutableReview,
      reviewHash: semantic.immutableReview.digest, semanticReceipt: semantic.semanticReceipt,
      governedCandidate: snapshot, decision, reviewedDecisionHash, candidatePath: semantic.candidatePath,
      candidateHash: semantic.candidate.digest, candidate: semantic.candidate,
      source, targetPath: semantic.targetPath, targetBefore, targetGovernance: setup.target === undefined ? { kind: 'verified-absence', governed: null } : { kind: 'existing', governed: setup.target.snapshot }, canonicalIdentityTransition: transition,
      targetAfter, evaluatedContentHash: targetAfter.digest, knowledgeId: candidateRecord.id,
      scope, acl: semantic.verifiedRecord.acl ?? null,
      knowledgeExpiresAt: semantic.verifiedRecord.expiresAt, transformVersion: 'ark.canonical-transform/1', sourceIdentity: FIXTURE_SOURCE, profile: run['profile'], profileDigest: run['profileDigest'], mission,
    }
    changes.proposal?.(proposalPayload)
    const proposal = artifacts.put(proposalPayload)
    const authorization: JsonObject = {
      grantId, initiationCapability: capability, proposal, proposalHash: proposal.digest, evaluatedContentHash: proposalPayload['evaluatedContentHash'], semanticReceipt: semantic.semanticReceipt,
      reviewedDecisionHash, definition, definitionHash: definition.digest, sessionArms: arms, scope,
      maxKnowledgeReads: 2, maxModelAttempts: 4, maxTurns: 2, notBefore: times.authorized, deadline: times.deadline,
    }
    changes.grant?.(authorization)
    const authorizeRequest: JsonObject = { schemaVersion: 2, requestId: `${tag}-authorize-request-1`, operation: 'authorizeTrial', proposal, definitionId: definitionPayload['definitionId'], initiationCapability: capability }
    changes.childRequest?.(authorizeRequest)
    const grant = artifacts.put(signers.evaluatorEnvelope('trial-authorization', authorization, artifacts.put(authorizeRequest), { issuedAt: times.authorized }))
    journal.append(candidateRecord.id, { type: 'knowledge/trial-authorized', grant, proposal, initiationCapabilityHash: capability.digest }, times.authorized)
    const sessionContexts = new Map<string, KnowledgeAccessContext>(setup.sessionContexts)
    const usePayloads: JsonObject[] = []
    const useReceipts: ArtifactRef[] = []
    const allReservations = sessions.flatMap(session => session.reservations.map((pending) => {
      const prefix = artifacts.entries.get(String(pending['sessionPrefixHash']))
      if (prefix === undefined) throw new Error('synthetic reservation prefix unavailable')
      const value = JSON.parse(prefix.bytes.toString('utf8')) as { events: SessionEvent[] }
      const timestamp = new Date(Math.max(Date.parse(times.started), value.events.at(-1)?.time ?? 0)).toISOString()
      return { pending, timestamp }
    })).sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    for (const { pending, timestamp } of allReservations) {
      journal.append(candidateRecord.id, { type: 'knowledge/trial-consumed', reservation: { ...pending, proposalHash: proposal.digest } }, timestamp)
      if (pending['phase'] === 'knowledge-read') journal.append(candidateRecord.id, {
        type: 'knowledge/retrieved', legacyShapePayload: { path: candidateRecord.source, retrievalAt: timestamp },
      }, timestamp)
    }
    for (const [index, session] of sessions.entries()) {
      const variant = index === 0 ? 'baseline' : 'candidate'
      const useId = `${tag}-use-${variant}`
      sessionContexts.set(session.session.id, session.context)
      const requests = session.requests.map(value => artifacts.put(value))
      const outputBytes = artifacts.putBytes(`synthetic-output: ${variant === 'candidate' ? 'repaired' : 'failed'}`, 'application/octet-stream')
      const finalOutputManifest = leaf('synthetic.final-output-manifest', { files: [{ path: 'task/output.txt', content: outputBytes, bytes: outputBytes.bytes }] })
      const finalWorld = leaf('synthetic.world-manifest', { directories: ['task'], files: [{ path: 'task/input.txt', content: frozenTask, bytes: frozenTask.bytes }, { path: 'task/output.txt', content: outputBytes, bytes: outputBytes.bytes }] })
      const exposureCheck = leaf('synthetic.exposure-check', { candidatePresent: variant === 'candidate', proposal, initialWorld: frozenWorld, finalWorld, providerRequests: requests, completeSession: session.completeSession, inspectedEveryRequest: true, result: 'pass' })
      const counts = fixtureCounts(variant)
      const errorObservations = leaf('synthetic.errors', { variant, repeatedErrors: variant === 'baseline' ? [{ kind: 'declared-output-mismatch', opportunity: 1 }] : [], allFailuresRetained: true })
      const usageAndCostObservations = leaf('synthetic.usage-and-cost', { providerRequests: requests, actualProviderCalls: 0, syntheticOnly: true, usage: [] })
      const execution = leaf('synthetic.oracle-execution', { oracleDefinition, oracleBuild, initialWorld: frozenWorld, finalWorld, finalOutputManifest, expectedOutput, exposureCheck, completeSession: session.completeSession, providerRequests: requests, counts, taskSuccess: variant === 'candidate' ? 'pass' : 'fail', testOnly: true })
      const usePayload: JsonObject = {
        useId, grantId, pairId: `${tag}-pair-1`, variant, proposalHash: proposal.digest, evaluatedContentHash: proposalPayload['evaluatedContentHash'], knowledgeId: candidateRecord.id,
        definitionHash: definition.digest, run, sessionId: session.session.id, initialWorld: session.arm['frozenTaskWorld'], finalWorld, finalOutputManifest, completeSession: session.completeSession,
        requests, injections: session.injections, exposure: { candidatePresent: variant === 'candidate', check: exposureCheck, verdict: 'pass' },
        oracle: { oracleDefinitionHash: oracleDefinition.digest, oracleBuildHash: oracleBuild.digest, execution, verdict: variant === 'candidate' ? 'pass' : 'fail', applicableRepair: 'pass', correctRepairReuse: variant === 'candidate' ? 'pass' : 'fail', taskSuccess: variant === 'candidate' ? 'pass' : 'fail', counts, toolCalls: variant === 'candidate' ? 1 : 0, retries: 0, errorObservations, usageAndCostObservations },
        result: variant === 'candidate' ? 'pass' : 'fail', startedAt: times.started, endedAt: times.ended,
      }
      changes.use?.(usePayload, variant)
      const { oracle: _oracle, result: _result, ...productFacts } = usePayload
      const factManifest = artifacts.put(productFacts)
      const child: JsonObject = { schemaVersion: 2, requestId: `synthetic-measure-${useId}`, operation: 'measureUse', grant, useId, facts: factManifest }
      changes.childRequest?.(child)
      const envelope = signers.evaluatorEnvelope('measured-use', usePayload, artifacts.put(child), { issuedAt: times.measured, expiresAt: times.evidenceExpiry })
      const receipt = artifacts.put(changes.useEnvelope?.(envelope, variant, signers) ?? envelope)
      usePayloads.push(usePayload)
      useReceipts.push(receipt)
      journal.append(candidateRecord.id, { type: 'knowledge/use-observed', useId, factManifest }, times.measured)
      journal.append(candidateRecord.id, { type: 'knowledge/use-measured', useId, receipt }, times.measured)
    }
    const records = usePayloads.map((value, index) => ({
      pairId: value['pairId'], variant: value['variant'], model: run['model'], modelConfigHash: run['modelConfigHash'], taskHash: run['taskHash'], goalHash: run['goalHash'], policyHash: run['policyHash'],
      producerId: signers.journalId, evaluatorId: signers.evaluatorId, verificationStatus: value['result'] === 'unknown' ? 'unknown' : 'verified', evidenceRefs: [`sha256:${useReceipts[index]?.digest}`], counts: (value['oracle'] as JsonObject)['counts'],
    }))
    const evaluationInput = { schemaVersion: 1, records }
    const evaluationOutput = evaluateLearning(parseEvaluationInput(evaluationInput))
    const totals = Object.fromEntries(Object.keys(FIXTURE_METRICS).map(name => [name, { baseline: ((usePayloads[0]?.['oracle'] as JsonObject)['counts'] as Record<string, FixtureCount>)[name], candidate: ((usePayloads[1]?.['oracle'] as JsonObject)['counts'] as Record<string, FixtureCount>)[name] }]))
    const reducerSourceHash = sha256(readFileSync(new URL('../src/learning-evaluation.ts', import.meta.url)))
    const trialPayload: JsonObject = { grantId, proposalHash: proposal.digest, evaluatedContentHash: proposalPayload['evaluatedContentHash'], definitionHash: definition.digest, grant,
      allUsesInPreregisteredOrder: useReceipts, omittedUses: [], exclusions: [], counts: totals, reducerSourceHash, evaluationInput: artifacts.put(evaluationInput), evaluationOutput: artifacts.put(evaluationOutput), result: evaluationOutput.smartnessClaim.status === 'SUPPORTED' ? 'pass' : evaluationOutput.smartnessClaim.status === 'UNKNOWN' ? 'unknown' : 'fail', startedAt: times.started, endedAt: times.ended }
    changes.trial?.(trialPayload)
    const trialRequest: JsonObject = { schemaVersion: 2, requestId: `${tag}-measure-trial-1`, operation: 'measureTrial', grant, useReceipts: trialPayload['allUsesInPreregisteredOrder'] }
    changes.childRequest?.(trialRequest)
    const trial = artifacts.put(signers.evaluatorEnvelope('measured-trial', trialPayload, artifacts.put(trialRequest), { issuedAt: times.measured, expiresAt: times.evidenceExpiry }))
    journal.append(candidateRecord.id, { type: 'knowledge/trial-measured', grantId, receipt: trial }, times.measured)
    journal.append(candidateRecord.id, { type: 'knowledge/trial-closed', grantId, reason: 'complete' }, times.measured)
    changes.suffix?.(journal, candidateRecord.id, semantic.verifiedRecord)
    const currentJournal = journal.head()
    changes.protectedHead?.(currentJournal.protectedHead)
    const custodyAttestation = leaf('synthetic.public-custody-attestation', { realCustody: 'UNAVAILABLE', purpose: 'Test-only public anchors for graph validation.' })
    const executable = artifacts.putBytes('TEST_ONLY_SYNTHETIC: never execute this fixture evaluator.', 'application/octet-stream')
    const descriptor = {
      schemaVersion: 2, kind: 'ark.knowledge.launcher-descriptor',
      evaluator: { authorityId: signers.evaluatorId, ...signers.evaluatorPublic, custodyAttestation,
        executable: artifacts.path(executable), executableDigest: executable.digest, fixedArgs: [], artifactRoot: artifacts.root,
        allowedDefinitions: { ...setup.allowedDefinitions, [String(definitionPayload['definitionId'])]: definition }, allowedInitiationCapabilities: [...setup.allowedInitiationCapabilities ?? [], capability] },
      journal: { signerId: signers.journalId, ...signers.journalPublic, privateKeyHandle: 'synthetic-writer-unavailable', protectedHeadRoot: artifacts.root, epoch: journal.epoch, rotationPolicy: 'no-automatic-rotation', legacyArchiveRecovery: null },
      sourceIdentity: FIXTURE_SOURCE, profile: run['profile'], profileDigest: run['profileDigest'], mission,
      timeoutMs: 10_000, maxArtifactBytes: 10_000_000, maxArtifactsPerReceipt: 10_000, maxTotalArtifactBytes: 100_000_000,
      maxArtifactGraphDepth: 64, maxChildRequestBytes: 1_000_000, maxChildResponseBytes: 1_000_000,
    }
    const wikiRoot = join(artifacts.root, 'isolated-project', 'wiki')
    const reviewFile = join(artifacts.root, 'isolated-project', '.llm-wiki', 'reviews.json')
    const archiveRoot = join(artifacts.root, 'isolated-project', 'jiuzhang-tarballs')
    mkdirSync(dirname(reviewFile), { recursive: true, mode: 0o700 })
    mkdirSync(archiveRoot, { recursive: true, mode: 0o700 })
    writeFileSync(reviewFile, JSON.stringify([semantic.review, { id: 'synthetic-unrelated-advisory', type: 'advisory', title: 'Unrelated fixture row retained byte-for-byte by transaction transformation', resolved: false }]), { mode: 0o600 })
    const captureContext = () => ({ now: times.now, projectId: 'synthetic-project', currentJournal, sessionContexts, wikiRoot, reviewFile, archiveRoot })
    return { artifacts, signers, journal, semantic, descriptor, captureContext, reducerSourceHash, trial, trialPayload,
      proposal, proposalPayload, capability, capabilityPayload, definition, definitionPayload, grant, authorization,
      snapshot, sessions, usePayloads, useReceipts, evaluationInput, evaluationOutput, currentJournal, sessionContexts,
      candidateRecordRef, times }
  } catch (error) { artifacts.dispose(); throw error }
}
