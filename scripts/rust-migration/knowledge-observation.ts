/** Private pre-observation helpers. Native owns admission, revisions, joins and commits. */
import assert from 'node:assert/strict'
import { lstatSync, readdirSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { TextDecoder } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { scanZstdFrames } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import { atomicWriteFile, readRegularFileBounded, resolveConfinedPath } from '../../packages/host/knowledge-wiki/src/filesystem.ts'
import { canonicalJson, sha256 } from '../../packages/host/knowledge-wiki/src/verifier.ts'
import { capturePersistedKnowledgeUse, type KnowledgeUseBinding } from './knowledge-session-use.ts'
import { witnessedUseCost, type SettledUseCostWitnessV1 } from './knowledge-use-producer.ts'
import { describeRegisteredKnowledgeTrial, type KnowledgeTrialDescriptionConfiguration, type KnowledgeUseEvaluatorConfiguration } from
  './knowledge-use-evaluator.ts'
import { parseObservation, type BlobRef, type Intent, type Slot, type CaptureSlot, type CaptureNextInput,
  type IntentHelperLaunch, type FrozenTaskProjection, type CompletedEvaluationLaunch } from './knowledge-observation-schema.ts'

const SNAPSHOT_LIMIT = 16 * 1024 * 1024
const PROJECT_LIMIT = 2 * 1024 * 1024

function readArtifact(root: string, ref: BlobRef, nonempty = false): Buffer {
  const bytes = readRegularFileBounded(resolveConfinedPath(root, ref.hash, false), SNAPSHOT_LIMIT)
  assert(bytes.byteLength === ref.byteLength && sha256(bytes) === ref.hash && (!nonempty || bytes.byteLength > 0),
    'observation artifact bytes differ')
  return bytes
}
function readHash(root: string, hash: string): Buffer {
  const bytes = readRegularFileBounded(resolveConfinedPath(root, hash, false), SNAPSHOT_LIMIT)
  assert(sha256(bytes) === hash && bytes.byteLength > 0, 'observation structured artifact differs')
  return bytes
}
function json(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value: unknown = JSON.parse(text)
  assert(canonicalJson(value) === text, 'observation structured artifact is not canonical')
  return value
}
function store(root: string, bytes: Buffer): BlobRef {
  const ref = { hash: sha256(bytes), byteLength: bytes.byteLength }
  assert(bytes.byteLength <= SNAPSHOT_LIMIT, 'observation artifact exceeds limit')
  const path = resolveConfinedPath(root, ref.hash, true)
  try { assert(readArtifact(root, ref).equals(bytes), 'content-addressed observation changed') }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    atomicWriteFile(path, bytes)
  }
  return ref
}

function binding(intent: Intent, slot: Slot): KnowledgeUseBinding {
  const core = intent.core
  const config = json(readArtifact(core.artifactRoot, core.originalConfigCanonicalBytes, true)) as KnowledgeUseBinding['config']
  const permissions = json(readArtifact(core.artifactRoot, core.originalPermissionsCanonicalBytes, true)) as
    KnowledgeUseBinding['permissions']
  const renderedBytes = slot.knowledge === null ? undefined : readArtifact(core.artifactRoot, slot.knowledge.renderedBytes, true)
  const rendered = renderedBytes === undefined ? null : JSON.parse(renderedBytes.toString('utf8')) as
    NonNullable<KnowledgeUseBinding['knowledge']>['rendered']
  assert(renderedBytes === undefined || (Array.isArray(rendered) && JSON.stringify(rendered) === renderedBytes.toString('utf8')),
    'original rendered bytes differ')
  if (slot.knowledge !== null) readArtifact(core.artifactRoot, slot.knowledge.sourceContentBytes, true)
  return { useId: slot.useId, sessionId: slot.sessionId, projectRoot: core.projectRoot, turn: slot.turn,
    role: slot.role, pairId: slot.pairId, grantId: slot.grantId, proposalHash: core.proposalBytes.hash,
    measurementDefinitionHash: core.measurementDefinitionBytes.hash, sourceIdentity: core.sourceIdentity,
    profileIdentity: core.profileIdentity, buildIdentity: core.buildIdentity, config,
    task: new TextDecoder('utf-8', { fatal: true }).decode(readArtifact(core.artifactRoot, core.originalTaskUtf8Bytes, true)),
    goalHash: core.goalHash, policyHash: core.policyHash, permissions, cost: null,
    knowledge: slot.knowledge === null ? null : { id: slot.knowledge.id, sourceContentHash: slot.knowledge.sourceContentBytes.hash,
      rendered: rendered ?? [] } }
}

function descriptionConfig(intent: Intent): KnowledgeTrialDescriptionConfiguration {
  const core = intent.core
  return { schemaVersion: 1, authorityId: core.authorities.evaluator.authorityId,
    producerId: core.authorities.producerId, promotionAuthorityId: core.authorities.promotion.authorityId,
    promotionVerificationManifestHashes: core.promotionPolicy.promotionVerificationManifestHashes,
    promotionRequestHashes: core.promotionPolicy.promotionRequestHashes, liveCostAdmissionHash: intent.liveCostAdmissionBytes.hash,
    sourceBindingHash: intent.sourceBindingHash, artifactRoot: core.artifactRoot, costAuthorityId: core.authorities.costAuthorityId,
    evaluatorPublicKeySpki: core.authorities.evaluator.publicKeySpkiBase64,
    journalAuthorityId: core.authorities.journal.authorityId, journalPublicKeySpki: core.authorities.journal.publicKeySpkiBase64,
    registrations: core.orderedSlots.map((slot) => { const full = binding(intent, slot); return {
      binding: { ...full, knowledge: slot.knowledge === null ? null : { id: slot.knowledge.id,
        sourceContentHash: slot.knowledge.sourceContentBytes.hash, renderedArtifactHash: slot.knowledge.renderedBytes.hash } },
      registeredTask: { taskKind: slot.taskDefinition.kind } } }),
    trial: { trialId: core.trialId, proposalHash: core.proposalBytes.hash, grantHash: core.grantBytes.hash,
      preRegistrationHash: core.preRegistrationBytes.hash, measurementDefinitionHash: core.measurementDefinitionBytes.hash,
      orderedSessionIds: core.orderedSlots.map(slot => slot.sessionId) } }
}

function loadIntent(rawLaunch: unknown) {
  const launch = parseObservation('IntentHelperLaunch', rawLaunch)
  const intent = parseObservation('Intent', json(readHash(launch.artifactRoot, launch.intentHash)))
  const core = intent.core
  assert(core.artifactRoot === launch.artifactRoot && intent.sourceBindingHash === launch.sourceBindingHash
    && sha256(canonicalJson(core)) === intent.sourceBindingHash, 'immutable admission core binding differs')
  for (const ref of [core.proposalBytes, core.grantBytes, core.preRegistrationBytes, core.measurementDefinitionBytes,
    core.packReceiptBytes, core.installedManifestBytes, core.cost.initialLedgerBytes, core.cost.guardConfigurationBytes,
    intent.liveCostAdmissionBytes]) readArtifact(core.artifactRoot, ref, true)
  assert(sha256(readRegularFileBounded(core.nodePath, 256 * 1024 * 1024)) === core.nodeHash
    && sha256(readRegularFileBounded(resolveConfinedPath(core.runtimeRoot, core.entryRelativePath, false), PROJECT_LIMIT)) ===
      core.entryHash
    && sha256(readRegularFileBounded(resolveConfinedPath(core.runtimeRoot, core.guardEntryRelativePath, false), PROJECT_LIMIT)) ===
      core.guardEntryHash,
  'admission executable pins differ')
  const prereg = json(readArtifact(core.artifactRoot, core.preRegistrationBytes, true)) as Record<string, unknown>
  const grant = json(readArtifact(core.artifactRoot, core.grantBytes, true)) as Record<string, unknown>
  assert(canonicalJson(prereg['orderedPairIds']) === canonicalJson(core.orderedPairIds)
    && grant['deadline'] === core.deadline && grant['expiresAt'] === core.expiresAt, 'intent window or pair order differs')
  assert(new Set(core.orderedSlots.map(slot => slot.useId)).size === core.orderedSlots.length
    && new Set(core.orderedSlots.map(slot => slot.allocatedTaskProjectionRelativeRoot)).size === core.orderedSlots.length,
  'intent use or projection set differs')
  const proposal = json(readArtifact(core.artifactRoot, core.proposalBytes, true)) as Record<string, unknown>
  const firstSlot = core.orderedSlots[0]
  assert(firstSlot !== undefined, 'admission has no fixed task')
  for (const slot of core.orderedSlots) {
    assert(canonicalJson(slot.taskDefinition) === canonicalJson(firstSlot.taskDefinition), 'admission mixes fixed task definitions')
    const request = json(readArtifact(core.artifactRoot, slot.registeredVerificationRequestBytes, true)) as Record<string, unknown>
    assert(request['schemaVersion'] === 2 && request['candidateHash'] === proposal['candidateHash'],
      'admission fixed request or rule differs')
    const task = slot.taskDefinition
    const sourceRefs = task.kind === 'pagination-v1' ? task.protectedFiles
      : task.kind === 'single-line-v1' ? [task.terms] : [task.invoices, task.rates]
    for (const file of sourceRefs) readArtifact(core.artifactRoot, file.bytes)
    if (task.kind === 'pagination-v1') readArtifact(core.artifactRoot, task.initialCodeBytes)
  }
  const guardConfig = json(readArtifact(core.artifactRoot, core.cost.guardConfigurationBytes, true))
  assert(canonicalJson(guardConfig) === canonicalJson({ schemaVersion: 1, ledgerPath: core.cost.ledgerPath }),
    'cost guard launcher configuration differs')
  const originalConfig = json(readArtifact(core.artifactRoot, core.originalConfigCanonicalBytes, true)) as Record<string, unknown>
  assert(originalConfig['model'] === core.cost.configuredModel && originalConfig['provider'] === core.cost.provider,
    'admission original model/provider differs')
  const descriptor = parseObservation('DescriptorV1', describeRegisteredKnowledgeTrial(descriptionConfig(intent)))
  assert(canonicalJson(descriptor.operationLimits) === canonicalJson(core.operationLimits)
    && descriptor.liveCostAdmission.ledgerArtifactHash === core.cost.initialLedgerBytes.hash
    && descriptor.liveCostAdmission.maximumNewDispatches === core.cost.maximumNewDispatches
    && descriptor.liveCostAdmission.maximumNewSettlements === core.cost.maximumNewSettlements,
  'intent finite cost or operation bounds differ')
  return { launch, intent, descriptor, descriptorHash: sha256(canonicalJson(descriptor)) }
}

/** Decode the original physical artifact with the persistence owner, refusing every repair. */
export async function readObservationSnapshot(snapshot: Buffer, intent: Intent, slot: Slot, signal: AbortSignal) {
  assert(snapshot.byteLength > 0 && snapshot.byteLength <= SNAPSHOT_LIMIT, 'original snapshot must be nonempty and bounded')
  let plaintext = snapshot
  if (slot.startFence.encoding === 'jsonl-zstd') {
    const scan = scanZstdFrames(snapshot)
    assert(scan.frames.length > 0 && scan.tornStart === undefined && scan.frames.at(-1)?.end === snapshot.byteLength,
      'incomplete original Zstd frame')
    const chunks: Buffer[] = []
    let size = 0
    for (const frame of scan.frames) {
      const chunk = zstdDecompressSync(snapshot.subarray(frame.start, frame.end), { maxOutputLength: 64 * 1024 * 1024 - size })
      size += chunk.byteLength
      assert(size <= 64 * 1024 * 1024, 'decoded original snapshot exceeds limit')
      chunks.push(Buffer.from(chunk))
    }
    plaintext = Buffer.concat(chunks)
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  assert(text.endsWith('\n') && !text.includes('\n\n'), 'original snapshot has an incomplete JSONL line')
  const firstNewline = plaintext.indexOf(10)
  assert(firstNewline > 0, 'original snapshot has no complete header')
  const root = await mkdtemp(join(tmpdir(), 'ark-admission-snapshot-'))
  const context = new Context()
  try {
    await context.plugin(SessionStore)
    await context.plugin(JsonlSessionPersistence, { root, compression: slot.startFence.encoding === 'jsonl-zstd' ? 'zstd' : 'none' })
    const meta: SessionHeader = { version: 0, id: SessionId(slot.sessionId), createdAt: 0, cwd: intent.core.projectRoot }
    const location = context.sessionPersistence.locate(meta)
    assert(location !== undefined && location.kind === 'jsonl', 'persistence provided no original snapshot location')
    await mkdir(dirname(location.path), { recursive: true, mode: 0o700 })
    await writeFile(location.path, snapshot, { flag: 'wx', mode: 0o600 })
    const raw = await context.sessionPersistence.readRaw(meta.id, signal)
    assert(raw !== undefined && raw.content === text, 'persistence original decoded bytes differ')
    const loaded = await context.sessionPersistence.load(meta.id)
    assert(readRegularFileBounded(location.path, SNAPSHOT_LIMIT).equals(snapshot), 'persistence repaired original snapshot')
    assert(loaded.meta.id === slot.sessionId && loaded.meta.cwd === intent.core.projectRoot, 'original metadata identity differs')
    return { metadata: plaintext.subarray(0, firstNewline + 1), eventBytes: plaintext.subarray(firstNewline + 1), loaded }
  } finally { try { await context.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } }
}

/** Accept only the existing owner's initialization/configuration records before any trial observation. */
export function assertUnobservedKnowledgeStartPrefix(events: readonly { readonly type: string }[]): void {
  const initialization = new Set(['session/end-seed', 'agent-preset/selected', 'model/selection', 'plan/mode',
    'permission/preset', 'sandbox/mode', 'approval/policy'])
  assert(events.every(event => initialization.has(event.type)), 'start fence contains task observations')
}

async function validateFence(intent: Intent, slot: Slot, signal: AbortSignal, snapshot?: Buffer) {
  const root = intent.core.artifactRoot
  const fence = slot.startFence
  const initial = readArtifact(root, fence.originalInitialSnapshotBytes, true)
  const initialDecoded = await readObservationSnapshot(initial, intent, slot, signal)
  const header = readArtifact(root, fence.metadataEnvelopeBytes, true)
  const eventPrefix = readArtifact(root, fence.eventSequencePrefixBytes)
  assert(header.byteLength + eventPrefix.byteLength <= PROJECT_LIMIT && initialDecoded.metadata.equals(header)
    && initialDecoded.eventBytes.equals(eventPrefix), 'original start envelope bytes differ')
  const events = initialDecoded.loaded.events
  assert((events.length === 0 ? null : events.at(-1)?.seq) === fence.lastEventSeq && fence.expectedTurn === slot.turn,
    'original start sequence differs')
  assertUnobservedKnowledgeStartPrefix(events)
  if (snapshot === undefined) return
  const completed = await readObservationSnapshot(snapshot, intent, slot, signal)
  assert(canonicalJson(completed.loaded.meta) === canonicalJson(initialDecoded.loaded.meta)
    && canonicalJson(completed.loaded.events.slice(0, events.length)) === canonicalJson(events),
  'completed snapshot replaced the authoritative start prefix')
  if (completed.loaded.events.length === events.length) return
  const start = completed.loaded.events.find(event => event.type === 'turn/start' && event.data.turn === slot.turn)
  assert(start === undefined || start.seq > (fence.lastEventSeq ?? -1), 'task did not start after admission fence')
}

function generationPath(root: string, generationId: string, relative: string, missing: boolean): string {
  return resolveConfinedPath(root, `trial-generations/${generationId}/${relative}`, missing)
}
async function writeFrozen(path: string, bytes: Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o400 }) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    assert(readRegularFileBounded(path, SNAPSHOT_LIMIT).equals(bytes), 'prepared physical observation differs')
  }
}

async function preparedBudget(intent: Intent,
  input: CaptureNextInput | { generationId: string; intentHash: string; descriptorHash: string }, priorCount: number) {
  const root = intent.core.artifactRoot
  const blobs = new Map<string, number>()
  let total = 0
  let files = 0
  const physical = (bytes: number) => {
    assert(Number.isSafeInteger(bytes) && bytes >= 0 && total + bytes <= 64 * 1024 * 1024,
      'trial preparation exceeds its 64 MiB bound')
    total += bytes
  }
  const blob = (ref: BlobRef) => {
    const previous = blobs.get(ref.hash)
    assert(previous === undefined || previous === ref.byteLength, 'prepared blob length differs')
    if (previous === undefined) { physical(ref.byteLength); blobs.set(ref.hash, ref.byteLength) }
  }
  const directory = generationPath(root, input.generationId, 'prepared-artifacts', true)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const generationRoot = resolveConfinedPath(root, `trial-generations/${input.generationId}`, false)
  const scan = (path: string, depth: number) => {
    // Bounds derive from 32 slots, two 4096-ref lists, 66 files and 1024-byte relative paths.
    assert(depth <= 1024 && ++files <= 32 * (8192 + 66 * 1024 + 32), 'trial preparation file inventory exceeds bound')
    const info = lstatSync(path)
    assert(!info.isSymbolicLink(), 'trial preparation must not contain links')
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) scan(resolveConfinedPath(generationRoot,
        path === generationRoot ? entry : `${path.slice(generationRoot.length + 1)}/${entry}`, false), depth + 1)
    } else {
      assert(info.isFile() && info.size <= SNAPSHOT_LIMIT, 'trial preparation file must be ordinary and bounded')
      physical(info.size)
      if (dirname(path) === join(generationRoot, 'prepared-owner-artifacts')) {
        const hash = path.slice(dirname(path).length + 1)
        const bytes = readRegularFileBounded(path, SNAPSHOT_LIMIT)
        assert(/^[a-f0-9]{64}$/u.test(hash) && sha256(bytes) === hash, 'prepared owner raw artifact differs')
        physical(bytes.byteLength) // Separate Native owner-root copy, in addition to its physical raw accounting copy.
      }
      if (dirname(path) === directory) {
        const hash = path.slice(directory.length + 1)
        assert(/^[a-f0-9]{64}$/u.test(hash), 'prepared raw artifact name differs')
        const bytes = readRegularFileBounded(path, SNAPSHOT_LIMIT)
        assert(sha256(bytes) === hash, 'prepared raw artifact bytes differ')
        blob({ hash, byteLength: bytes.byteLength })
      }
    }
  }
  scan(generationRoot, 0)
  const priorRefs: BlobRef[] = []
  const additionalRefs = new Map<string, BlobRef>()
  for (let index = 0; index < priorCount; index += 1) {
    const bytes = readRegularFileBounded(generationPath(root, input.generationId,
      `committed-captures/slot-${index}.json`, false), SNAPSHOT_LIMIT)
    const output = parseObservation('CaptureNextOutput', json(bytes))
    const registered = intent.core.orderedSlots[index]
    assert(registered !== undefined && output.slotIndex === index && output.slot.sessionId === registered.sessionId
      && output.intentHash === input.intentHash && output.descriptorHash === input.descriptorHash
      && output.generationId === input.generationId, 'prepared prior committed capture differs')
    // Native stores its exact output artifact in addition to the committed marker.
    priorRefs.push({ hash: sha256(bytes), byteLength: bytes.byteLength }); blob(priorRefs.at(-1) ?? { hash: sha256(bytes), byteLength:
      bytes.byteLength })
    for (const ref of output.slot.retainedOriginalBytes) { readArtifact(root, ref); priorRefs.push(ref); blob(ref) }
    const captured = output.slot.capture
    if (captured === null) continue
    for (const ref of [captured.originalSnapshot, captured.originalMetadata, captured.captureFactsBytes,
      captured.journalArtifactBytes, captured.wholeOutputUtf8Bytes, captured.taskProjectionBytes,
      ...captured.capturedArtifactBytes, ...captured.actualTaskFiles.map(file => file.bytes)]) {
      readArtifact(root, ref); priorRefs.push(ref); blob(ref)
    }
  }
  const refresh = () => {
    total = 0; files = 0; blobs.clear(); scan(generationRoot, 0)
    for (const ref of priorRefs) blob(ref)
    for (const ref of additionalRefs.values()) blob(ref)
  }
  const put = async (bytes: Buffer) => {
    refresh() // Native helper/producer writes settle before the next owned write.
    const ref = { hash: sha256(bytes), byteLength: bytes.byteLength }
    const rawPath = resolveConfinedPath(root, `trial-generations/${input.generationId}/prepared-artifacts/${ref.hash}`, true)
    let exists = false
    try { assert(readRegularFileBounded(rawPath, SNAPSHOT_LIMIT).equals(bytes), 'prepared raw artifact differs'); exists = true }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    blob(ref)
    if (!exists) { physical(bytes.byteLength); await writeFrozen(rawPath, bytes) }
    return store(root, bytes)
  }
  return { physical, blob: (ref: BlobRef) => { additionalRefs.set(ref.hash, ref); blob(ref) }, put }
}

async function captureNext(intent: Intent, input: CaptureNextInput, signal: AbortSignal): Promise<CaptureSlot> {
  const core = intent.core
  const slot = core.orderedSlots[input.slotIndex]
  assert(slot !== undefined, 'capture slot is not registered')
  const retained: BlobRef[] = []
  const budget = await preparedBudget(intent, input, input.slotIndex)
  const put = budget.put
  const putJson = (value: unknown) => put(Buffer.from(canonicalJson(value)))
  const base = { pairId: slot.pairId, role: slot.role, useId: slot.useId, sessionId: slot.sessionId, turn: slot.turn }
  let reason: CaptureSlot['reason'] = 'source-unreadable'
  try {
    signal.throwIfAborted()
    const suffix = slot.startFence.encoding === 'jsonl-zstd' ? '.jsonl.zstd' : '.jsonl'
    assert(slot.snapshotRelativePath.endsWith(suffix), 'snapshot physical suffix differs')
    const sourcePath = resolveConfinedPath(core.sessionRoot, slot.snapshotRelativePath, false)
    const snapshot = readRegularFileBounded(sourcePath, SNAPSHOT_LIMIT)
    retained.push(await put(snapshot))
    reason = 'prefix-mismatch'
    await validateFence(intent, slot, signal, snapshot)
    reason = 'turn-not-completed'
    const captured = await capturePersistedKnowledgeUse(sourcePath, sha256(snapshot), binding(intent, slot))
    signal.throwIfAborted()
    const decoded = await readObservationSnapshot(snapshot, intent, slot, signal)
    const request = json(readArtifact(core.artifactRoot, slot.registeredVerificationRequestBytes, true)) as Record<string, unknown>
    assert(typeof request['candidatePath'] === 'string' && request['schemaVersion'] === 2, 'fixed verification request differs')
    const task = slot.taskDefinition
    const declared = task.kind === 'single-line-v1' ? [task.terms] : task.kind === 'invoice-v1' ? [task.invoices, task.rates] :
      task.protectedFiles
    const paths = [...declared.map(file => file.path), ...(task.kind === 'pagination-v1' ? [task.codePath] : []),
      `.llm-wiki/${request['candidatePath']}`]
    assert(new Set(paths).size === paths.length, 'task projection has duplicate files')
    const physicalRelativeRoot = `trial-generations/${input.generationId}/${slot.allocatedTaskProjectionRelativeRoot}`
    const files: { path: string; bytes: BlobRef }[] = []
    let preparedBytes = snapshot.byteLength
    reason = 'task-input-changed'
    for (const path of paths) {
      const bytes = readRegularFileBounded(resolveConfinedPath(core.projectRoot, path, false), PROJECT_LIMIT)
      const ref = await put(bytes)
      retained.push(ref)
      const frozenInput = declared.find(file => file.path === path)
      assert(frozenInput === undefined || (ref.hash === frozenInput.bytes.hash && ref.byteLength === frozenInput.bytes.byteLength),
        'registered task input or protected file differs')
      if (path.startsWith('.llm-wiki/')) assert(ref.hash === request['candidateHash'], 'registered candidate source differs')
      preparedBytes += bytes.byteLength
      assert(preparedBytes <= 64 * 1024 * 1024, 'prepared projection exceeds limit')
      budget.physical(bytes.byteLength)
      await writeFrozen(resolveConfinedPath(core.artifactRoot, `${physicalRelativeRoot}/${path}`, true), bytes)
      files.push({ path, bytes: ref })
    }
    const projection = parseObservation('FrozenTaskProjection', { schemaVersion: 1, kind: 'fixed-trial-task-projection-v1',
      intentHash: input.intentHash, descriptorHash: input.descriptorHash, generationId: input.generationId, slotIndex: input.slotIndex,
      sessionId: slot.sessionId, logicalProjectRoot: core.projectRoot, physicalRelativeRoot, files })
    const frozenSnapshotRelativePath = `trial-generations/${input.generationId}/snapshots/slot-${input.slotIndex}${suffix}`
    budget.physical(snapshot.byteLength)
    await writeFrozen(resolveConfinedPath(core.artifactRoot, frozenSnapshotRelativePath, true), snapshot)
    reason = 'snapshot-changed'
    assert(readRegularFileBounded(sourcePath, SNAPSHOT_LIMIT).equals(snapshot), 'original snapshot changed during capture')
    for (const file of files) assert(readRegularFileBounded(resolveConfinedPath(core.projectRoot, file.path, false),
      PROJECT_LIMIT).equals(readArtifact(core.artifactRoot, file.bytes)), 'actual original task bytes changed during capture')
    const artifacts: BlobRef[] = []
    for (const bytes of captured.artifacts.values()) artifacts.push(await put(bytes))
    const result = parseObservation('CaptureSlot', { ...base, outcome: 'complete', reason: null, retainedOriginalBytes: retained,
      capture: { originalSnapshot: retained[0], frozenSnapshotRelativePath,
        originalMetadata: await put(decoded.metadata), captureFactsBytes: await putJson(captured.facts),
        journalArtifactBytes: { hash: captured.journalArtifactHash, byteLength: readHash(core.artifactRoot,
          captured.journalArtifactHash).byteLength },
        wholeOutputUtf8Bytes: await put(Buffer.from(captured.wholeOutput)),
        capturedRequestHashes: captured.requests.map(item => sha256(canonicalJson(item))), capturedArtifactBytes: artifacts,
        actualTaskFiles: files.filter(file => !file.path.startsWith('.llm-wiki/')), taskProjectionBytes: await putJson(projection) } })
    const { operation: _operation, ...echo } = input
    const output = { ...echo, kind: 'fixed-trial-next-slot-capture-v1', slot: result }
    const outputBytes = Buffer.from(canonicalJson(output))
    budget.blob({ hash: sha256(outputBytes), byteLength: outputBytes.byteLength }); budget.physical(outputBytes.byteLength)
    return result
  } catch (error) {
    if (error instanceof Error && error.message === 'trial preparation exceeds its 64 MiB bound') reason = 'output-limit'
    else if (error instanceof Error && error.message.includes('permission policy')) reason = 'permission-mismatch'
    else if (error instanceof Error && error.message.includes('knowledge')) reason = 'knowledge-mismatch'
    else if (error instanceof Error && (error.message.includes('direct task differs') || error.message.includes('session/project'))) {
      reason = 'identity-mismatch'
    }
    // Preserve every available original task file even when session provenance is incomplete.
    const task = slot.taskDefinition
    const paths = task.kind === 'pagination-v1' ? [task.codePath, ...task.protectedFiles.map(file => file.path)]
      : task.kind === 'single-line-v1' ? [task.terms.path] : [task.invoices.path, task.rates.path]
    for (const path of paths) {
      try {
        const ref = await put(readRegularFileBounded(resolveConfinedPath(core.projectRoot, path, false), PROJECT_LIMIT))
        if (!retained.some(item => item.hash === ref.hash)) retained.push(ref)
      } catch (_preservationError) { break }
    }
    const cancelled = signal.aborted
    return parseObservation('CaptureSlot', { ...base, outcome: cancelled ? 'cancelled' : reason === 'source-unreadable' ?
      'unreadable-source' : reason === 'turn-not-completed' ? 'incomplete' : 'invalid-source',
    reason: cancelled ? 'cancelled' : reason, retainedOriginalBytes: retained, capture: null })
  }
}

/** Execute only the closed operations from the fixed launcher intent, without signing. */
export async function evaluateObservationOperation(rawLaunch: unknown, rawRequest: unknown, signal: AbortSignal): Promise<unknown> {
  const { launch, intent, descriptor, descriptorHash } = loadIntent(rawLaunch)
  signal.throwIfAborted()
  const operation = (rawRequest as { operation?: unknown }).operation
  if (operation === 'describeAdmissionIntentV1') {
    parseObservation('DescribeIntentInput', rawRequest)
    for (const slot of intent.core.orderedSlots) {
      const live = readRegularFileBounded(resolveConfinedPath(intent.core.sessionRoot, slot.snapshotRelativePath, false), SNAPSHOT_LIMIT)
      await validateFence(intent, slot, signal, live)
      const task = slot.taskDefinition
      const protectedInputs = task.kind === 'pagination-v1' ? task.protectedFiles
        : task.kind === 'single-line-v1' ? [task.terms] : [task.invoices, task.rates]
      for (const file of protectedInputs) assert(readRegularFileBounded(resolveConfinedPath(intent.core.projectRoot,
        file.path, false), PROJECT_LIMIT).equals(readArtifact(intent.core.artifactRoot, file.bytes)), 'live registered input differs')
      const request = json(readArtifact(intent.core.artifactRoot, slot.registeredVerificationRequestBytes, true)) as Record<string, unknown>
      assert(typeof request['candidatePath'] === 'string', 'registered candidate path missing')
      const candidate = readRegularFileBounded(resolveConfinedPath(intent.core.projectRoot, `.llm-wiki/${request['candidatePath']}`,
        false), PROJECT_LIMIT)
      assert(sha256(candidate) === request['candidateHash'], 'live candidate or accepted rule differs')
      if (task.kind === 'pagination-v1') readArtifact(intent.core.artifactRoot, task.initialCodeBytes)
    }
    return parseObservation('DescribeIntentOutput', { schemaVersion: 1, kind: 'fixed-trial-admission-description-v1',
      intentHash: launch.intentHash, sourceBindingHash: intent.sourceBindingHash, descriptor })
  }
  const name = operation === 'captureNextCompletedRegisteredSlotV1' ? 'CaptureNextInput'
    : operation === 'collectFrozenRegisteredSlotsV1' ? 'CaptureInput' : 'AssemblerInput'
  const input = parseObservation(name, rawRequest)
  assert(input.intentHash === launch.intentHash && input.descriptorHash === descriptorHash, 'capture admission binding differs')
  if (input.operation === 'captureNextCompletedRegisteredSlotV1') {
    const { operation: _operation, ...echo } = input
    return parseObservation('CaptureNextOutput', { ...echo, kind: 'fixed-trial-next-slot-capture-v1', slot: await captureNext(intent,
      input, signal) })
  }
  if (input.operation === 'collectFrozenRegisteredSlotsV1') {
    const orderedSlots = intent.core.orderedSlots.map((slot, slotIndex) => {
      const path = generationPath(intent.core.artifactRoot, input.generationId, `committed-captures/slot-${slotIndex}.json`, false)
      const output = parseObservation('CaptureNextOutput', json(readRegularFileBounded(path, SNAPSHOT_LIMIT)))
      assert(output.intentHash === input.intentHash && output.descriptorHash === input.descriptorHash
        && output.generationId === input.generationId && output.slotIndex === slotIndex && output.inflightEpoch <= input.inflightEpoch
        && output.reservationRevision <= input.reservationRevision && output.slot.sessionId === slot.sessionId
        && output.slot.useId === slot.useId && output.slot.pairId === slot.pairId && output.slot.role === slot.role && output.slot.turn
          === slot.turn,
      'committed slot capture binding differs')
      return output.slot
    })
    return parseObservation('CaptureOutput', { schemaVersion: 1, kind: 'fixed-trial-uncosted-captures-v1',
      intentHash: input.intentHash, descriptorHash: input.descriptorHash, generationId: input.generationId,
      reservationRevision: input.reservationRevision, inflightEpoch: input.inflightEpoch, orderedSlots })
  }
  const root = intent.core.artifactRoot
  const captures = parseObservation('CaptureOutput', json(readHash(root, input.captureOutputHash)))
  const costs = parseObservation('CostResolution', json(readHash(root, input.costResolutionHash)))
  for (const item of [captures, costs]) assert(item.intentHash === input.intentHash && item.descriptorHash === input.descriptorHash
    && item.generationId === input.generationId && item.reservationRevision === input.reservationRevision,
  'assembler fenced evidence differs')
  assert(captures.inflightEpoch === input.inflightEpoch && captures.orderedSlots.length === intent.core.orderedSlots.length
    && costs.orderedSlots.length === intent.core.orderedSlots.length, 'assembler complete slot set differs')
  const budget = await preparedBudget(intent, input, intent.core.orderedSlots.length)
  const putJson = (value: unknown) => budget.put(Buffer.from(canonicalJson(value)))
  budget.blob({ hash: input.captureOutputHash, byteLength: readHash(root, input.captureOutputHash).byteLength })
  budget.blob({ hash: input.costResolutionHash, byteLength: readHash(root, input.costResolutionHash).byteLength })
  const manifests: string[] = [], witnessHashes: string[] = [], projectionHashes: string[] = []
  const registrations: KnowledgeUseEvaluatorConfiguration['registrations'][number][] = []
  let eligible = true
  for (const [index, slot] of intent.core.orderedSlots.entries()) {
    const observed = captures.orderedSlots[index], cost = costs.orderedSlots[index]
    assert(observed !== undefined && cost !== undefined, 'assembler omitted registered slot')
    assert(observed.sessionId === slot.sessionId && observed.useId === slot.useId && observed.turn === slot.turn
      && observed.role === slot.role && observed.pairId === slot.pairId && cost.sessionId === slot.sessionId,
    'assembler slot identity differs')
    if (observed.capture === null || observed.outcome !== 'complete' || cost.status !== 'verified' || cost.witnessBytes === null) {
      eligible = false; continue }
    const capture = observed.capture
    assert(cost.sessionSnapshotHash === capture.originalSnapshot.hash && canonicalJson(cost.capturedRequestHashes) ===
      canonicalJson(capture.capturedRequestHashes), 'cost capture request coverage differs')
    const snapshotPath = resolveConfinedPath(root, capture.frozenSnapshotRelativePath, false)
    const uncostedBinding = binding(intent, slot)
    const recaptured = await capturePersistedKnowledgeUse(snapshotPath, capture.originalSnapshot.hash, uncostedBinding)
    assert(sha256(canonicalJson(recaptured.facts)) === capture.captureFactsBytes.hash
      && sha256(recaptured.wholeOutput) === capture.wholeOutputUtf8Bytes.hash && recaptured.journalArtifactHash ===
        capture.journalArtifactBytes.hash, 'frozen session recapture differs')
    budget.blob(cost.witnessBytes)
    const witness = json(readArtifact(root, cost.witnessBytes, true)) as SettledUseCostWitnessV1
    assert(witnessedUseCost(witness, intent.core.authorities.costAuthorityId, uncostedBinding, recaptured,
      capture.originalSnapshot.hash) !== undefined, 'native cost witness does not cover original capture')
    assert(canonicalJson(cost.registrationArtifactHashes) === canonicalJson(witness.attempts.map(attempt =>
      attempt.registrationArtifactHash))
      && canonicalJson(cost.settlementArtifactHashes) === canonicalJson(witness.attempts.map(attempt =>
        attempt.settlementArtifactHash)), 'native cost artifact set differs')
    const projection = parseObservation('FrozenTaskProjection', json(readArtifact(root, capture.taskProjectionBytes, true)))
    assert(projection.slotIndex === index && projection.sessionId === slot.sessionId && projection.intentHash === input.intentHash
      && projection.descriptorHash === input.descriptorHash && projection.generationId === input.generationId,
    'task projection admission differs')
    const task = slot.taskDefinition
    const frozenFile = (path: string) => { const file = capture.actualTaskFiles.find(item => item.path === path); assert(file !==
      undefined, 'task projection missing actual original file'); return { path, hash: file.bytes.hash } }
    const manifestTask = task.kind === 'pagination-v1' ? { kind: task.kind, code: frozenFile(task.codePath), protectedFiles:
      task.protectedFiles.map(file => frozenFile(file.path)), timeoutMs: task.timeoutMs }
      : task.kind === 'single-line-v1' ? { kind: task.kind, terms: frozenFile(task.terms.path), outputHash:
        capture.wholeOutputUtf8Bytes.hash }
        : { kind: task.kind, invoices: frozenFile(task.invoices.path), rates: frozenFile(task.rates.path), outputHash:
          capture.wholeOutputUtf8Bytes.hash }
    const manifest = await putJson({ schemaVersion: 1, mode: 'ephemeral-test-only', authorityId:
      intent.core.authorities.evaluator.authorityId,
    projectRoot: intent.core.projectRoot, artifactRoot: root, expectedRequestHash: slot.registeredVerificationRequestBytes.hash,
    acceptedRuleHash: slot.acceptedRuleHash, task: manifestTask })
    manifests.push(manifest.hash); witnessHashes.push(cost.witnessBytes.hash); projectionHashes.push(capture.taskProjectionBytes.hash)
    const { cost: _cost, knowledge: _knowledge, ...legacyBinding } = uncostedBinding
    registrations.push({ snapshotPath, expectedSnapshotHash: capture.originalSnapshot.hash, binding: { ...legacyBinding,
      knowledge: slot.knowledge === null ? null : { id: slot.knowledge.id, sourceContentHash: slot.knowledge.sourceContentBytes.hash,
        renderedArtifactHash: slot.knowledge.renderedBytes.hash } },
    registeredTask: { taskKind: task.kind, manifestHash: manifest.hash, requestHash: slot.registeredVerificationRequestBytes.hash },
    costWitnessHash: cost.witnessBytes.hash })
  }
  const completedConfig = eligible ? await putJson({ ...descriptionConfig(intent), registrations }) : null
  const completedLaunch = completedConfig === null ? null : await putJson(parseObservation('CompletedEvaluationLaunch', {
    schemaVersion: 1, kind: 'fixed-trial-completed-evaluation-launch-v1', intentHash: input.intentHash,
    descriptorHash: input.descriptorHash, generationId: input.generationId, artifactRoot: root, sourceBindingHash: intent.sourceBindingHash,
    completedConfigHash: completedConfig.hash, orderedTaskProjectionHashes: projectionHashes }))
  return parseObservation('AssemblerOutput', { schemaVersion: 1, kind: 'fixed-trial-completed-config-v1',
    intentHash: input.intentHash, descriptorHash: input.descriptorHash, generationId: input.generationId,
    reservationRevision: input.reservationRevision, inflightEpoch: input.inflightEpoch,
    status: eligible ? 'complete' : 'ineligible-observation', completedConfigBytes: completedConfig,
    orderedRegisteredManifestHashes: eligible ? manifests : [], orderedCostWitnessHashes: eligible ? witnessHashes : [],
    completedLaunchBytes: completedLaunch })
}

/** Resolve the separate immutable post-capture launch and its confined per-session task projections. */
export function resolveCompletedEvaluation(rawLaunch: unknown): {
  config: KnowledgeUseEvaluatorConfiguration
  projections: ReadonlyMap<string, FrozenTaskProjection>
  launch: CompletedEvaluationLaunch
} {
  const launch = parseObservation('CompletedEvaluationLaunch', rawLaunch)
  const intentLaunch: IntentHelperLaunch = { schemaVersion: 1, kind: 'fixed-trial-intent-helper-launch-v1', intentHash: launch.intentHash,
    artifactRoot: launch.artifactRoot, sourceBindingHash: launch.sourceBindingHash }
  const admitted = loadIntent(intentLaunch)
  assert(launch.descriptorHash === admitted.descriptorHash, 'completed evaluation admission differs')
  const config = json(readHash(launch.artifactRoot, launch.completedConfigHash)) as KnowledgeUseEvaluatorConfiguration
  assert(config.sourceBindingHash === launch.sourceBindingHash && config.artifactRoot === launch.artifactRoot
    && config.registrations.length === admitted.intent.core.orderedSlots.length
    && launch.orderedTaskProjectionHashes.length === config.registrations.length, 'completed config slot set differs')
  const projections = new Map<string, FrozenTaskProjection>()
  for (const [index, hash] of launch.orderedTaskProjectionHashes.entries()) {
    const projection = parseObservation('FrozenTaskProjection', json(readHash(launch.artifactRoot, hash)))
    const slot = admitted.intent.core.orderedSlots[index]
    assert(slot !== undefined, 'completed projection omitted slot')
    assert(projection.intentHash === launch.intentHash && projection.descriptorHash === launch.descriptorHash
      && projection.generationId === launch.generationId && projection.slotIndex === index && projection.sessionId === slot.sessionId
      && projection.logicalProjectRoot === admitted.intent.core.projectRoot && projection.physicalRelativeRoot ===
        `trial-generations/${launch.generationId}/${slot.allocatedTaskProjectionRelativeRoot}`,
    'completed task projection differs')
    for (const file of projection.files) assert(readRegularFileBounded(resolveConfinedPath(launch.artifactRoot,
      `${projection.physicalRelativeRoot}/${file.path}`, false), PROJECT_LIMIT).equals(readArtifact(launch.artifactRoot, file.bytes)),
    'completed physical task bytes differ')
    projections.set(projection.sessionId, projection)
  }
  return { config, projections, launch }
}

/** Fixed completed-generation allocation owner for new offline/evaluator artifacts; never a request field. */
export async function createFrozenObservationArtifactWriter(rawLaunch: unknown): Promise<(bytes: Buffer) => Promise<void>> {
  const { launch } = resolveCompletedEvaluation(rawLaunch)
  const admitted = loadIntent({ schemaVersion: 1, kind: 'fixed-trial-intent-helper-launch-v1', intentHash: launch.intentHash,
    artifactRoot: launch.artifactRoot, sourceBindingHash: launch.sourceBindingHash })
  const budget = await preparedBudget(admitted.intent, launch, admitted.intent.core.orderedSlots.length)
  return async (bytes) => { await budget.put(bytes) }
}
