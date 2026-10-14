/**
 * Review-item extraction from stage-2 model output.
 *
 * The generation prompt may emit `---REVIEW: <type> | <title>---` blocks
 * alongside FILE blocks; each becomes a `WikiReviewItem` appended to
 * `.llm-wiki/review.json` (an append-only array). Ids are deterministic
 * (`review-` + FNV-1a hex), so re-ingests replace, never duplicate, and
 * the existing app-era review file is preserved.
 * @module @deepseek-ai/dsh-knowledge-wiki/reviews
 */

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseFrontmatterArray, parseFrontmatterField } from './frontmatter-utils.ts'
import type { CandidateMeasuredTrialResult, CandidateTrial, CandidateVerification, WikiReviewItem } from './types.ts'
import { encodeReviewStore, readReviewStore, writeReviewStore } from './review-store.ts'
import {
  decideCandidateGovernance,
  governancePolicyVersion,
  resolveGovernedWikiPath,
  type GovernanceDecision,
} from './governance-policy.ts'
import {
  assertAbsolutePathInside,
  atomicWriteFile,
  durableUnlinkFile,
  ensureConfinedDirectory,
  isMissingPathError as isMissingFileError,
  readOptionalText,
  readRegularFileBounded,
} from './filesystem.ts'
import {
  canonicalJson,
  encodeKnowledgeWikiPromotionSealRequest,
  immutableReviewRow,
  readTrustedReceipt,
  readTrustedVerification,
  sha256,
  type KnowledgeWikiVerifierAuthority,
  type PromotionJournalSigningPayload,
  type PromotionOperationSigningPayload,
  type VerificationAuthoritySeal,
} from './verifier.ts'
import type { KnowledgeWikiPromotionSealRequest } from './verifier.ts'
import type {
  KnowledgeWikiMeasuredTrialReader,
  MeasuredTrialReviewBinding,
  VerifiedMeasuredTrial,
} from './measured-trial.ts'
import {
  appendKnowledgeEvent,
  createKnowledgeEvent,
  createKnowledgeRecord,
  detectKnowledgeConflicts,
  knowledgeSha256,
  knowledgeInjectionDecision,
  readKnowledgeEventLog,
  replayKnowledgeEvents,
  syncKnowledgeEventLog,
} from './knowledge-governance.ts'

const CANONICAL_REVIEW_ACTIONS = new Set(['Promote', 'Merge', 'Replace', 'Deduplicate'])
const BLOCKED_REVIEW_REASONS = new Set(['expired', 'conflict', 'scope-denied', 'acl-denied'])
const PROMOTION_JOURNAL_MAX_BYTES = 8 * 1024 * 1024

function isCanonicalReviewAction(value: string): value is MeasuredTrialReviewBinding['action'] {
  return CANONICAL_REVIEW_ACTIONS.has(value)
}

const REVIEW_OPENER_PREFIX_RE = /^---\s*REVIEW\s*:\s*/i
const REVIEW_CLOSER_RE = /^---\s*END\s+REVIEW\s*---\s*$/i

/** A parsed (not yet persisted) review item. */
export interface ParsedReview {
  readonly type: string
  readonly title: string
  readonly description: string
  /** Wiki-relative pages the review touches. */
  readonly affectedPages: string[]
  /** Suggested search queries. */
  readonly searchQueries: string[]
}

/**
 * Parse `---REVIEW: <type> | <title>---` blocks out of model output. The
 * block body may carry `description:`, `PAGES:` and `SEARCH:` lines; a
 * missing closer discards the block.
 * @param text - the stage-2 generation output.
 * @returns the parsed reviews in output order.
 */
export function parseReviewBlocks(text: string): ParsedReview[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const reviews: ParsedReview[] = []
  let current: { type: string; title: string; body: string[] } | null = null
  for (const line of lines) {
    if (current === null) {
      const opener = parseReviewOpener(line)
      if (opener !== null) current = { ...opener, body: [] }
      continue
    }
    if (REVIEW_CLOSER_RE.test(line)) {
      const body = current.body.join('\n')
      reviews.push({
        type: current.type,
        title: current.title,
        description: extractField(body, 'description'),
        affectedPages: extractListField(body, 'PAGES'),
        searchQueries: extractListField(body, 'SEARCH'),
      })
      current = null
      continue
    }
    current.body.push(line)
  }
  return reviews
}

/** Parse one REVIEW opener while keeping type/title mandatory. */
function parseReviewOpener(line: string): { type: string; title: string } | null {
  const prefix = REVIEW_OPENER_PREFIX_RE.exec(line)
  if (prefix === null) return null
  const suffixStart = line.lastIndexOf('---')
  if (suffixStart < prefix[0].length) return null
  const payload = line.slice(prefix[0].length, suffixStart).trim()
  const separator = payload.indexOf('|')
  if (separator < 0) return null
  const type = payload.slice(0, separator).trim() || 'suggestion'
  const title = payload.slice(separator + 1).trim() || 'Review'
  return { type, title }
}

/** First `key: value` line of a field (may span the rest of the body). */
function extractField(body: string, key: string): string {
  for (const line of body.split('\n')) {
    const field = parseFrontmatterField(line)
    if (field !== null && field.key.toLowerCase() === key.toLowerCase()) return field.value.trim()
  }
  return ''
}

/** `KEY:` items: a comma-separated inline list or `- item` block lines. */
function extractListField(body: string, key: string): string[] {
  let collecting = false
  const blockItems: string[] = []
  for (const line of body.split('\n')) {
    const field = parseFrontmatterField(line)
    if (field !== null && field.key.toLowerCase() === key.toLowerCase()) {
      if (field.value !== '') {
        return parseFrontmatterArray(field.value.startsWith('[') ? field.value : `[${field.value}]`)
      }
      collecting = true
      continue
    }
    if (!collecting) continue
    const item = line.trim()
    if (!item.startsWith('-')) break
    blockItems.push(item)
  }
  return parseFrontmatterArray(blockItems.join('\n'))
}

interface LoadedReviewItem {
  readonly all: WikiReviewItem[]
  readonly bytes: Buffer
  readonly index: number
  readonly item: WikiReviewItem
}

function resolveCandidateReviewPath(root: string, input: string): ReturnType<typeof resolveGovernedWikiPath> {
  const governed = resolveGovernedWikiPath(root, input, false)
  return governed?.relativePath.startsWith('_candidates/') === true ? governed : undefined
}

function resolvePlannedCandidateReviewPath(root: string, input: string): ReturnType<typeof resolveGovernedWikiPath> {
  try {
    const governed = resolveGovernedWikiPath(root, input, true)
    return governed?.relativePath.startsWith('_candidates/') === true ? governed : undefined
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOTDIR') return undefined
    throw error
  }
}

function resolveCanonicalReviewPath(
  root: string,
  input: string,
  allowMissing: boolean,
): ReturnType<typeof resolveGovernedWikiPath> {
  const governed = resolveGovernedWikiPath(root, input, allowMissing)
  return governed?.relativePath.startsWith('_candidates/') === true ? undefined : governed
}

/** Narrow one durable review row before its fields can direct a mutation. */
function isReviewItem(value: unknown): value is WikiReviewItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const id: unknown = Reflect.get(value, 'id')
  const title: unknown = Reflect.get(value, 'title')
  const type: unknown = Reflect.get(value, 'type')
  const resolved: unknown = Reflect.get(value, 'resolved')
  return typeof id === 'string' && typeof title === 'string' && typeof type === 'string' && typeof resolved === 'boolean'
}

/** Load the persisted review array through its durable JSON boundary. */
function loadReviewItems(reviewFile: string): { readonly all: WikiReviewItem[]; readonly bytes: Buffer } | undefined {
  const bytes = readReviewStore(reviewFile)
  if (bytes === undefined) return undefined
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (!Array.isArray(parsed) || !parsed.every(isReviewItem)) throw new Error('invalid knowledge review state')
  return { all: parsed, bytes }
}

/** Load one review item once, preserving callers' distinct decision policies. */
function loadReviewItem(reviewFile: string, reviewIdValue: string): LoadedReviewItem | undefined {
  const loaded = loadReviewItems(reviewFile)
  if (loaded === undefined) return undefined
  const { all, bytes } = loaded
  const index = all.findIndex(item => item.id === reviewIdValue)
  const item = index >= 0 ? all[index] : undefined
  return item === undefined ? undefined : { all, bytes, index, item }
}

/** Classified result of one advisory batch, with candidate rows left to their owner. */
export interface AdvisoryResolution {
  readonly resolvedCount: number
  readonly candidateIds: readonly string[]
}

/** Replace the durable review array atomically after an in-memory batch update. */
function writeReviewItemsAtomically(reviewFile: string, items: WikiReviewItem[]): void {
  writeReviewStore(reviewFile, encodeReviewStore(items))
}

const reviewAppendPlanBrand: unique symbol = Symbol('ReviewAppendPlan')

/** A preflighted review publication plan; its state is kept private to this module. */
export interface ReviewAppendPlan {
  readonly [reviewAppendPlanBrand]: true
}

interface PlannedCandidateReview {
  readonly path: string
  readonly absolutePath: string
  readonly content: string
  readonly bytes: Buffer
  readonly sourceHash: string
  readonly decision: GovernanceDecision
  readonly item: RegisteredCandidateReview
}

type NonEmpty<T> = [T, ...T[]]

interface ReviewAppendPlanState {
  readonly reviewFile: string
  readonly projectRoot: string
  readonly before: Buffer | undefined
  readonly baseItems: readonly WikiReviewItem[]
  readonly candidates: ReadonlyMap<string, NonEmpty<PlannedCandidateReview>>
  readonly allCandidateItems: ReadonlyMap<string, NonEmpty<RegisteredCandidateReview>>
  readonly advisoryAppended: number
}

const reviewAppendPlanStates = new WeakMap<ReviewAppendPlan, ReviewAppendPlanState>()

function knowledgeEventPath(reviewFile: string): string {
  return join(dirname(reviewFile), 'knowledge-events.jsonl')
}

/** Bind complete file bytes and presence across authority calls. */
function optionalRegularFileDigest(path: string, maxBytes: number): string | undefined {
  try {
    return sha256(readRegularFileBounded(path, maxBytes))
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

/** Bind source provenance to bytes when the source is inside the project. */
function sourceHashForCandidate(projectRoot: string, sourcePath: string | undefined): string {
  if (sourcePath === undefined) return createHash('sha256').update('unknown-source').digest('hex')
  const root = resolve(projectRoot)
  const absolute = resolve(root, sourcePath)
  const rel = relative(root, absolute)
  try {
    const stat = lstatSync(absolute)
    if (rel !== '' && !rel.startsWith(`..${sep}`) && !rel.includes(`${sep}..${sep}`)
      && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
      return createHash('sha256').update(readRegularFileBounded(absolute, 100 * 1024 * 1024)).digest('hex')
    }
  } catch {
    // URL, virtual research label, or absent source: bind its stable identity.
  }
  return createHash('sha256').update(sourcePath).digest('hex')
}

/** Append a lifecycle event after its owning review mutation has passed its hash checks. */
type HashBoundCandidateReview = WikiReviewItem & Required<Pick<
  WikiReviewItem,
  'candidatePath' | 'candidateHash'
>>
type RegisteredCandidateReview = HashBoundCandidateReview & Required<Pick<WikiReviewItem, 'sourceHash' | 'createdAt'>>
function appendKnowledgeLifecycleEvent(
  reviewFile: string,
  type: Exclude<Parameters<typeof createKnowledgeEvent>[0], 'knowledge/verified'>,
  item: HashBoundCandidateReview,
  payload: Readonly<Record<string, unknown>> = {},
): void {
  const scope = { projectId: dirname(dirname(reviewFile)), visibility: 'project' as const }
  const eventPayload: Readonly<Record<string, unknown>> = {
    ...payload,
    candidatePath: item.candidatePath,
    candidateHash: item.candidateHash,
    source: item.sourcePath ?? item.candidatePath,
  }
  writeKnowledgeLifecycleEvent(reviewFile, type, item, eventPayload, scope)
}

/** Seal one lifecycle payload through the existing immutable request and proof validator. */
function prepareSealedLifecyclePayload(
  eventType: 'knowledge/verified' | 'knowledge/promoted',
  knowledgeId: string,
  payload: Readonly<Record<string, unknown>>,
  authority: KnowledgeWikiVerifierAuthority,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const request = immutablePromotionSealRequest({
    schemaVersion: 1,
    domain: 'ark.knowledge-wiki',
    authorityId: authority.authorityId,
    operation: 'seal-knowledge-event',
    eventType,
    knowledgeId,
    payload,
  } as const satisfies Extract<KnowledgeWikiPromotionSealRequest, { operation: 'seal-knowledge-event' }>)
  const signingPayload = encodeKnowledgeWikiPromotionSealRequest(request)
  return Promise.resolve(authority.sealPromotion(request, signal)).then((returnedSeal) => {
    signal?.throwIfAborted()
    const seal = immutableAuthoritySeal(returnedSeal)
    if (seal === undefined || seal.authorityId !== authority.authorityId
      || !authority.validatePromotion(signingPayload, seal)) return undefined
    return { ...request.payload, authorityId: authority.authorityId, authoritySeal: seal }
  })
}

/** Authenticate the complete verification payload before publishing review projections. */
function prepareKnowledgeVerifiedPayload(
  item: HashBoundCandidateReview,
  payload: Readonly<Record<string, unknown>>,
  authority: KnowledgeWikiVerifierAuthority,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  signal?.throwIfAborted()
  return prepareSealedLifecyclePayload('knowledge/verified', `candidate:${item.id}`, {
    ...payload,
    candidatePath: item.candidatePath,
    candidateHash: item.candidateHash,
    source: item.sourcePath ?? item.candidatePath,
  }, authority, signal)
}

function writeKnowledgeLifecycleEvent(
  reviewFile: string,
  type: Parameters<typeof createKnowledgeEvent>[0],
  item: HashBoundCandidateReview,
  payload: Readonly<Record<string, unknown>>,
  scope = { projectId: dirname(dirname(reviewFile)), visibility: 'project' as const },
): void {
  const id = `candidate:${item.id}`
  const prior = readKnowledgeEventLog(knowledgeEventPath(reviewFile))
  const event = createKnowledgeEvent(type, id, scope, payload, {
    seq: prior.length,
    previousEventHash: prior.at(-1)?.eventHash ?? null,
    sourceHash: item.sourceHash ?? knowledgeSha256(item.sourcePath ?? item.candidatePath),
  })
  appendKnowledgeEvent(knowledgeEventPath(reviewFile), event)
}

function freezeJsonValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  for (const child of Object.values(value)) freezeJsonValue(child)
  return Object.freeze(value)
}

function immutablePromotionSealRequest<T extends KnowledgeWikiPromotionSealRequest>(request: T): T {
  const snapshot = JSON.parse(canonicalJson(request)) as KnowledgeWikiPromotionSealRequest
  return freezeJsonValue(snapshot) as T
}

function immutableAuthoritySeal(value: unknown): VerificationAuthoritySeal | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const authorityId = Object.getOwnPropertyDescriptor(value, 'authorityId')
  const proof = Object.getOwnPropertyDescriptor(value, 'proof')
  if (Reflect.ownKeys(value).length !== 2
    || authorityId?.enumerable !== true || authorityId.get !== undefined || authorityId.set !== undefined
    || proof?.enumerable !== true || proof.get !== undefined || proof.set !== undefined
    || typeof authorityId.value !== 'string' || authorityId.value.length === 0
    || typeof proof.value !== 'string' || proof.value.length === 0) return undefined
  return Object.freeze({ authorityId: authorityId.value, proof: proof.value })
}

function appendKnowledgeReviewEvent(
  reviewFile: string,
  type: Exclude<Parameters<typeof createKnowledgeEvent>[0], 'knowledge/promoted'>,
  reviewId: string,
  candidateHash: string,
  payload: Readonly<Record<string, unknown>> = {},
): void {
  writeKnowledgeReviewEvent(reviewFile, type, reviewId, candidateHash, { ...payload, candidateHash })
}

function appendKnowledgePromotedEvent(
  reviewId: string,
  candidateHash: string,
  payload: Readonly<Record<string, unknown>>,
  authority: KnowledgeWikiVerifierAuthority,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  signal?.throwIfAborted()
  return prepareSealedLifecyclePayload('knowledge/promoted', `candidate:${reviewId}`, { ...payload, candidateHash },
    authority, signal)
}

function hasKnowledgeReviewEvent(
  reviewFile: string,
  type: Parameters<typeof createKnowledgeEvent>[0],
  reviewId: string,
  candidateHash: string,
  eventPayload: Readonly<Record<string, unknown>>,
  authority?: KnowledgeWikiVerifierAuthority,
): boolean {
  const path = knowledgeEventPath(reviewFile)
  const prior = readKnowledgeEventLog(path, authority)
  const knowledgeId = `candidate:${reviewId}`
  const matching = prior.filter(event => event.type === type && event.knowledgeId === knowledgeId
    && event.payload.candidateHash === candidateHash)
  if (matching.length > 1) throw new Error('duplicate candidate lifecycle event')
  const scope = { projectId: dirname(dirname(reviewFile)), visibility: 'project' as const }
  if (matching.length === 1) {
    const existing = matching[0] as (typeof matching)[number]
    const expectedPayload = { ...eventPayload }
    const existingPayload = { ...existing.payload }
    // A valid authority may produce a different proof when a missing event is
    // repaired; every other payload field, including authorityId, is semantic.
    if (type === 'knowledge/promoted') {
      delete expectedPayload.authoritySeal
      delete existingPayload.authoritySeal
    }
    if (canonicalJson({ type: existing.type, knowledgeId: existing.knowledgeId, scope: existing.scope, payload: existingPayload })
      !== canonicalJson({ type, knowledgeId, scope, payload: expectedPayload })) {
      throw new Error('candidate lifecycle event conflicts with signed promotion journal')
    }
    return true
  }
  return false
}

function writeKnowledgeReviewEvent(
  reviewFile: string,
  type: Parameters<typeof createKnowledgeEvent>[0],
  reviewId: string,
  candidateHash: string,
  eventPayload: Readonly<Record<string, unknown>>,
  authority?: KnowledgeWikiVerifierAuthority,
): boolean {
  const path = knowledgeEventPath(reviewFile)
  if (hasKnowledgeReviewEvent(reviewFile, type, reviewId, candidateHash, eventPayload, authority)) {
    syncKnowledgeEventLog(path)
    return false
  }
  const prior = readKnowledgeEventLog(path, authority)
  const scope = { projectId: dirname(dirname(reviewFile)), visibility: 'project' as const }
  const event = createKnowledgeEvent(type, `candidate:${reviewId}`, scope, eventPayload, { seq: prior.length, previousEventHash: prior.at(-1)?.eventHash ?? null })
  appendKnowledgeEvent(path, event)
  return true
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

function readOptionalRegularFile(path: string): string | undefined {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe review transaction file: ${path}`)
    return readRegularFileBounded(path, PROMOTION_JOURNAL_MAX_BYTES).toString('utf8')
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

type PromotionOperation = PromotionOperationSigningPayload

function promotionOperation(
  transactionId: string,
  index: number,
  role: PromotionOperation['role'],
  path: string,
  before: string | undefined,
  after: string | undefined,
): PromotionOperation {
  const suffix = `${transactionId}-${index}`
  return {
    role,
    path,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    ...(after === undefined
      ? { tombstonePath: join(dirname(path), `.${basename(path)}.ark-wal-delete-${suffix}`) }
      : { stagingPath: join(dirname(path), `.${basename(path)}.ark-wal-stage-${suffix}`) }),
  }
}

type PromotionJournalCore = PromotionJournalSigningPayload

interface PromotionJournal extends PromotionJournalCore {
  readonly state: 'prepared' | 'committed' | 'rolled-back'
  readonly seal: VerificationAuthoritySeal
}

/** Serialize every state a prepared transaction may need before its first durable write. */
function promotionJournalMarkers(journal: PromotionJournal): Readonly<{
  prepared: string
  committed: string
  rolledBack: string
}> {
  const markers = {
    prepared: `${JSON.stringify(journal, null, 2)}\n`,
    committed: `${JSON.stringify({ ...journal, state: 'committed' }, null, 2)}\n`,
    rolledBack: `${JSON.stringify({ ...journal, state: 'rolled-back' }, null, 2)}\n`,
  }
  if (Object.values(markers).some(value => Buffer.byteLength(value, 'utf8') > PROMOTION_JOURNAL_MAX_BYTES)) {
    throw new Error(`promotion journal exceeds ${PROMOTION_JOURNAL_MAX_BYTES} byte recovery limit`)
  }
  return markers
}

function promotionJournalDirectory(reviewFile: string): string {
  return join(dirname(reviewFile), 'promotion-journal')
}

function promotionJournalPath(reviewFile: string, id: string): string {
  return join(promotionJournalDirectory(reviewFile), `${id}.json`)
}

function assertPromotionOperationConfined(
  operation: PromotionOperation,
  reviewFile: string,
  wikiRoot: string,
  archiveRoot: string,
): void {
  if (operation.role === 'candidate' || operation.role === 'canonical') {
    assertAbsolutePathInside(wikiRoot, operation.path)
  } else if (operation.role === 'candidate-archive' || operation.role === 'canonical-archive') {
    assertAbsolutePathInside(archiveRoot, operation.path)
  } else {
    assertAbsolutePathInside(dirname(reviewFile), operation.path)
  }
  for (const auxiliary of [operation.stagingPath, operation.tombstonePath]) {
    if (auxiliary === undefined) continue
    if (dirname(auxiliary) !== dirname(operation.path)) throw new Error('promotion auxiliary path changed parent')
  }
}

function writePromotionStage(path: string, content: string): void {
  if (pathEntryExists(path)) {
    const before = lstatSync(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new Error(`unsafe promotion stage at ${path}`)
    }
    const descriptor = openSync(path, (process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW)
    try {
      const opened = fstatSync(descriptor, { bigint: true })
      if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error(`promotion stage identity changed while opening: ${path}`)
      }
      if (opened.size > 8 * 1024 * 1024) throw new Error(`promotion stage conflict at ${path}`)
      const chunks: Buffer[] = []
      let total = 0
      while (true) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, 8 * 1024 * 1024 + 1 - total))
        const count = readSync(descriptor, chunk, 0, chunk.length, null)
        if (count === 0) break
        total += count
        if (total > 8 * 1024 * 1024) throw new Error(`promotion stage conflict at ${path}`)
        chunks.push(chunk.subarray(0, count))
      }
      const afterRead = fstatSync(descriptor, { bigint: true })
      const namedAfterRead = lstatSync(path, { bigint: true })
      if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino || afterRead.nlink !== 1n
        || afterRead.size !== opened.size || afterRead.mtimeNs !== opened.mtimeNs
        || namedAfterRead.dev !== opened.dev || namedAfterRead.ino !== opened.ino || namedAfterRead.nlink !== 1n
        || Buffer.concat(chunks, total).toString('utf8') !== content) {
        throw new Error(`promotion stage conflict at ${path}`)
      }
      fsyncSync(descriptor)
      const after = fstatSync(descriptor, { bigint: true })
      const named = lstatSync(path, { bigint: true })
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1n
        || named.dev !== opened.dev || named.ino !== opened.ino || named.nlink !== 1n) {
        throw new Error(`promotion stage identity changed while syncing: ${path}`)
      }
    } finally {
      closeSync(descriptor)
    }
    syncPromotionDirectory(dirname(path))
    return
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  syncPromotionDirectory(dirname(path))
}

function syncPromotionDirectory(directoryPath: string): void {
  const directory = openSync(directoryPath, constants.O_RDONLY)
  try {
    fsyncSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  } finally {
    closeSync(directory)
  }
}

function syncPromotionOperationDirectories(operations: readonly PromotionOperation[]): void {
  for (const directory of new Set(operations.map(operation => dirname(operation.path)))) {
    syncPromotionDirectory(directory)
  }
}

function promotionRejectedEventPayload(journal: PromotionJournal): Readonly<Record<string, unknown>> {
  const governance = journal.operations.filter(operation => operation.role === 'governance')
  if (governance.length !== 1) {
    throw new Error('promotion journal lacks its signed governance decision')
  }
  const operation = governance[0] as PromotionOperation
  const before = operation.before ?? ''
  const after = operation.after
  if (after === undefined) throw new Error('promotion journal lacks its signed governance decision')
  if (!after.startsWith(before)) throw new Error('promotion governance append changed prior entries')
  const appended = after.slice(before.length)
  if (!appended.endsWith('\n') || appended.slice(0, -1).includes('\n') || appended.length < 2) {
    throw new Error('promotion governance decision is not one appended entry')
  }
  let entry: unknown
  try { entry = JSON.parse(appended.slice(0, -1)) as unknown } catch {
    throw new Error('promotion governance decision is invalid')
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error('promotion governance decision is invalid')
  }
  const action: unknown = Reflect.get(entry, 'action')
  const appliedPath: unknown = Reflect.get(entry, 'appliedPath')
  const candidateArchives = journal.operations.filter(operation => operation.role === 'candidate-archive')
  if ((action !== 'Archive' && action !== 'Skip') || (journal.action === 'Skip' && action !== 'Skip')
    || typeof appliedPath !== 'string' || appliedPath.length === 0
    || candidateArchives.length !== 1 || candidateArchives[0]?.path !== appliedPath
    || Reflect.get(entry, 'reviewId') !== journal.reviewId
    || Reflect.get(entry, 'candidateHash') !== journal.candidateHash
    || Reflect.get(entry, 'targetPath') !== (journal.targetPath ?? '')
    || Reflect.get(entry, 'outcome') !== 'applied') {
    throw new Error('promotion governance decision does not bind the signed journal')
  }
  return { action, appliedPath, lifecycle: 'downgraded', candidateHash: journal.candidateHash }
}

function promotionLifecyclePayload(
  journal: PromotionJournal,
  promotedPayload?: Readonly<Record<string, unknown>>,
): { readonly type: 'knowledge/promoted' | 'knowledge/rejected'; readonly payload: Readonly<Record<string, unknown>> } {
  if (CANONICAL_REVIEW_ACTIONS.has(journal.action)) {
    return { type: 'knowledge/promoted', payload: promotedPayload as Readonly<Record<string, unknown>> }
  }
  return { type: 'knowledge/rejected', payload: promotionRejectedEventPayload(journal) }
}

function promotionCanonicalEventPayload(journal: PromotionJournal): Readonly<Record<string, unknown>> {
  if (!CANONICAL_REVIEW_ACTIONS.has(journal.action) || journal.targetPath === null
    || journal.measuredTrial === undefined || journal.measuredTrial === null) {
    throw new Error('promotion journal lacks its canonical measured-trial event binding')
  }
  return {
    action: journal.action,
    lifecycle: 'canonical',
    appliedPath: journal.targetPath,
    ...measuredTrialEventPayload(journal.measuredTrial),
    candidateHash: journal.candidateHash,
  }
}

function promotionCanonicalEventComparisonPayload(
  journal: PromotionJournal,
  authorityId: string,
): Readonly<Record<string, unknown>> {
  return { ...promotionCanonicalEventPayload(journal), authorityId }
}

function assertPromotionPostState(operations: readonly PromotionOperation[]): void {
  for (const operation of operations) {
    if (readOptionalText(operation.path, 8 * 1024 * 1024) !== operation.after) {
      throw new Error(`promotion post-commit mismatch at ${operation.path}`)
    }
    if (operation.stagingPath !== undefined && pathEntryExists(operation.stagingPath)) {
      throw new Error(`promotion post-commit stage remains at ${operation.stagingPath}`)
    }
    if (operation.tombstonePath !== undefined && pathEntryExists(operation.tombstonePath)) {
      throw new Error(`promotion post-commit tombstone remains at ${operation.tombstonePath}`)
    }
  }
}

function applyPromotionOperation(
  operation: PromotionOperation,
  checkpoint?: (phase: 'stage-written' | 'entry-renamed' | 'tombstone-unlinked') => void,
): void {
  const current = readOptionalText(operation.path, 8 * 1024 * 1024)
  if (operation.after === undefined) {
    const tombstone = operation.tombstonePath
    if (tombstone === undefined) throw new Error('promotion delete lacks a tombstone path')
    if (current === undefined) {
      const moved = readOptionalText(tombstone, 8 * 1024 * 1024)
      if (moved === undefined) return
      if (moved !== operation.before) throw new Error(`promotion tombstone conflict at ${tombstone}`)
      unlinkSync(tombstone)
      syncPromotionDirectory(dirname(operation.path))
      checkpoint?.('tombstone-unlinked')
      return
    }
    if (current !== operation.before) throw new Error(`promotion recovery conflict at ${operation.path}`)
    if (pathEntryExists(tombstone)) throw new Error(`promotion tombstone already exists: ${tombstone}`)
    renameSync(operation.path, tombstone)
    syncPromotionDirectory(dirname(operation.path))
    checkpoint?.('entry-renamed')
    if (readOptionalText(tombstone, 8 * 1024 * 1024) !== operation.before) {
      throw new Error(`promotion tombstone identity changed: ${tombstone}`)
    }
    unlinkSync(tombstone)
    syncPromotionDirectory(dirname(operation.path))
    checkpoint?.('tombstone-unlinked')
    return
  }
  if (current === operation.after) return
  if (current !== operation.before) throw new Error(`promotion recovery conflict at ${operation.path}`)
  const staging = operation.stagingPath
  if (staging === undefined) throw new Error('promotion write lacks a staging path')
  writePromotionStage(staging, operation.after)
  checkpoint?.('stage-written')
  const revalidated = readOptionalText(operation.path, 8 * 1024 * 1024)
  if (revalidated !== operation.before) throw new Error(`promotion target changed before rename: ${operation.path}`)
  renameSync(staging, operation.path)
  syncPromotionDirectory(dirname(operation.path))
  checkpoint?.('entry-renamed')
}

function rollbackPromotionOperation(operation: PromotionOperation): void {
  if (operation.tombstonePath !== undefined) {
    const tombstone = readOptionalText(operation.tombstonePath, 8 * 1024 * 1024)
    if (tombstone !== undefined) {
      if (tombstone !== operation.before || pathEntryExists(operation.path)) {
        throw new Error(`promotion rollback tombstone conflict at ${operation.tombstonePath}`)
      }
      renameSync(operation.tombstonePath, operation.path)
      syncPromotionDirectory(dirname(operation.path))
    }
  }
  const current = readOptionalText(operation.path, 8 * 1024 * 1024)
  // before === undefined marks an archive-create operation, which always
  // stages its content (see promotionOperation), so stagingPath is defined.
  if (operation.before === undefined) {
    if (current === undefined) {
      durableUnlinkFile(operation.stagingPath as string)
      return
    }
    if (operation.after !== undefined && current !== operation.after) {
      throw new Error(`promotion rollback conflict at ${operation.path}`)
    }
    durableUnlinkFile(operation.path)
    durableUnlinkFile(operation.stagingPath as string)
    return
  }
  if (current === operation.before) {
    if (operation.stagingPath !== undefined) durableUnlinkFile(operation.stagingPath)
    return
  }
  if (operation.after !== undefined && current !== operation.after) {
    throw new Error(`promotion rollback conflict at ${operation.path}`)
  }
  atomicWriteFile(operation.path, operation.before)
  if (operation.stagingPath !== undefined) durableUnlinkFile(operation.stagingPath)
}

function promotionJournalCore(journal: PromotionJournal): PromotionJournalCore {
  const { state: _state, seal: _seal, ...core } = journal
  return core
}

function validatePromotionJournalAuthority(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  journal: PromotionJournal,
): boolean {
  if (authority === undefined || journal.operationSetHash !== sha256(canonicalJson(journal.operations))) return false
  return authority.validatePromotion(canonicalJson(promotionJournalCore(journal)), journal.seal)
}

function revalidateJournalBeforeMutation(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  measuredTrialReader: KnowledgeWikiMeasuredTrialReader | undefined,
  reviewFile: string,
  journal: PromotionJournal,
): boolean {
  if (!validatePromotionJournalAuthority(authority, journal)) throw new Error('promotion journal authority validation failed')
  const reviewOperation = journal.operations.find(operation => operation.role === 'review')
  const candidateOperation = journal.operations.find(operation => operation.role === 'candidate')
  if (reviewOperation?.before === undefined || candidateOperation?.before === undefined) {
    throw new Error('promotion journal lacks immutable pre-state')
  }
  const reviews: unknown = JSON.parse(reviewOperation.before)
  if (!Array.isArray(reviews)) throw new Error('promotion journal review pre-state is invalid')
  const item = reviews.find(value =>
    typeof value === 'object' && value !== null && Reflect.get(value, 'id') === journal.reviewId) as WikiReviewItem | undefined
  if (item === undefined || item.candidateHash !== journal.candidateHash
    || createHash('sha256').update(candidateOperation.before).digest('hex') !== journal.candidateHash) {
    throw new Error('promotion journal candidate binding failed')
  }
  if (journal.action !== 'Archive' && journal.action !== 'Skip') {
    if (journal.receiptId === null || journal.receiptHash === null || journal.reviewHash === null
      || !CANONICAL_REVIEW_ACTIONS.has(journal.action)) {
      throw new Error('promotion journal receipt binding is incomplete')
    }
    const receipt = readTrustedReceipt(authority, reviewFile, journal.receiptId)
    if (receipt === undefined
      || receipt.result.result !== 'pass'
      || receipt.receiptHash !== journal.receiptHash
      || receipt.request.reviewHash !== journal.reviewHash
      || receipt.request.reviewHash !== sha256(canonicalJson(immutableReviewRow(item)))
      || receipt.request.governanceAction !== journal.action
      || receipt.request.candidateHash !== journal.candidateHash
      || receipt.request.candidatePath !== item.candidatePath
      || receipt.request.targetPath !== journal.targetPath
      || item.targetPath !== journal.targetPath) {
      throw new Error('promotion journal verified receipt binding failed')
    }
    const targetOperation = journal.operations.find(operation => operation.role === 'canonical')
    const recordedTrial = journal.measuredTrial
    // An authentic semantic-only legacy journal still requires rollback;
    // only a currently authenticated measured trial can complete Canonical writes.
    if (measuredTrialReader === undefined || measuredTrialReader.authorityId === receipt.result.authorityId
      || recordedTrial === undefined || recordedTrial === null
      || !isCanonicalReviewAction(journal.action)
      || targetOperation === undefined || targetOperation.after === undefined) return false
    const binding: MeasuredTrialReviewBinding = Object.freeze({
      reviewHash: receipt.request.reviewHash,
      semanticReceiptHash: receipt.receiptHash,
      candidatePath: item.candidatePath,
      candidateHash: item.candidateHash,
      action: journal.action,
      targetPath: journal.targetPath,
      targetBeforeHashOrVerifiedAbsence: targetOperation.before === undefined
        ? 'verified-absence'
        : sha256(targetOperation.before),
    })
    const measured = measuredTrialReader.read(recordedTrial.trialHash, binding)
    if (!isBoundMeasuredTrial(measuredTrialReader, measured, recordedTrial.trialHash, binding)
      || !measured.eligibleForReview || measured.utilityScore <= 0
      || canonicalJson(candidateTrialProjection(measured, true)) !== canonicalJson(item.verification?.trial)
      || canonicalJson(measuredTrialJournalProjection(measured)) !== canonicalJson(recordedTrial)
      || measured.targetAfterHash !== sha256(targetOperation.after)
      || measured.targetAfterBytes.toString('utf8') !== targetOperation.after) return false
  }
  for (const operation of journal.operations) {
    const current = readOptionalText(operation.path, 8 * 1024 * 1024)
    if (current !== operation.before && current !== operation.after) {
      throw new Error(`promotion journal divergent state at ${operation.path}`)
    }
    if (operation.stagingPath !== undefined) {
      const staged = readOptionalText(operation.stagingPath, 8 * 1024 * 1024)
      if (staged !== undefined && staged !== operation.after) {
        throw new Error(`promotion journal divergent stage at ${operation.stagingPath}`)
      }
    }
    if (operation.tombstonePath !== undefined) {
      const tombstone = readOptionalText(operation.tombstonePath, 8 * 1024 * 1024)
      if (tombstone !== undefined && tombstone !== operation.before) {
        throw new Error(`promotion journal divergent tombstone at ${operation.tombstonePath}`)
      }
    }
  }
  return true
}

function commitPromotionJournal(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  measuredTrialReader: KnowledgeWikiMeasuredTrialReader | undefined,
  reviewFile: string,
  wikiRoot: string,
  archiveRoot: string,
  journal: PromotionJournal,
  promotedPayload?: Readonly<Record<string, unknown>>,
): void {
  const markers = promotionJournalMarkers(journal)
  if (!revalidateJournalBeforeMutation(authority, measuredTrialReader, reviewFile, journal)) {
    throw new Error('promotion journal lacks an authenticated measured-trial receipt')
  }
  for (const operation of journal.operations) assertPromotionOperationConfined(operation, reviewFile, wikiRoot, archiveRoot)
  ensureConfinedDirectory(dirname(reviewFile), 'promotion-journal')
  const path = promotionJournalPath(reviewFile, journal.id)
  const lifecycle = promotionLifecyclePayload(journal, promotedPayload)
  hasKnowledgeReviewEvent(reviewFile, lifecycle.type, journal.reviewId, journal.candidateHash, lifecycle.payload, authority)
  const preparedJournal = markers.prepared
  atomicWriteFile(path, preparedJournal)
  authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
    phase: 'journal-persisted',
    operationIndex: -1,
  })
  const applied: PromotionOperation[] = []
  let attempted = 0
  let lifecycleAppendAttempted = false
  try {
    for (const [operationIndex, operation] of journal.operations.entries()) {
      attempted = operationIndex + 1
      applyPromotionOperation(operation, (phase) => {
        authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
          phase,
          operationIndex,
        })
      })
      applied.push(operation)
      authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
        phase: 'operation-applied',
        operationIndex,
      })
    }
    syncPromotionOperationDirectories(journal.operations)
    assertPromotionPostState(journal.operations)
    lifecycleAppendAttempted = true
    writeKnowledgeReviewEvent(reviewFile, lifecycle.type, journal.reviewId, journal.candidateHash, lifecycle.payload, authority)
    authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
      phase: 'before-commit-marker',
      operationIndex: journal.operations.length,
    })
    assertPromotionPostState(journal.operations)
    syncPromotionOperationDirectories(journal.operations)
    if (readOptionalRegularFile(path) !== preparedJournal) throw new Error('promotion journal changed before commit marker')
    atomicWriteFile(path, markers.committed)
  } catch (error) {
    // Once the event append is attempted, a write or fsync error may have left
    // a complete event visible. Recovery must finish the signed WAL instead.
    if (lifecycleAppendAttempted) throw error
    const rollbackErrors: unknown[] = []
    const rollbackOperations = journal.operations.slice(0, Math.max(applied.length, attempted)).reverse()
    for (const operation of rollbackOperations) {
      try { rollbackPromotionOperation(operation) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    }
    if (rollbackErrors.length === 0) {
      try { syncPromotionOperationDirectories(rollbackOperations) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    }
    if (rollbackErrors.length === 0) {
      atomicWriteFile(path, markers.rolledBack)
      try {
        appendKnowledgeReviewEvent(reviewFile, 'knowledge/rolled_back', journal.reviewId, journal.candidateHash, {
          lifecycle: 'rolled_back',
          transactionId: journal.id,
        })
      } catch {
        // The promotion journal is the source of truth for recovery; an event
        // append failure must not mask the original transaction error.
      }
      throw error
    }
    throw new AggregateError([error, ...rollbackErrors], 'candidate review transaction failed and rollback was incomplete')
  }
}

/**
 * Finish prepared decisions, repair authenticated committed lifecycle gaps, or fail closed on divergent bytes.
 * @param authority - Trusted verifier that revalidates the journal before mutation.
 * @param reviewFile - Review file whose sibling directory owns promotion journals.
 * @param wikiRoot - Canonical Wiki root used to confine Candidate and target paths.
 * @param archiveRoot - Archive root used to confine archived Candidate paths.
 * @param measuredTrialReader - Optional independent reader used to revalidate canonical promotion evidence.
 * @param shouldContinue - Service generation fence rechecked after signing; false skips this journal.
 * @param signal - Optional project-generation signal forwarded to event signing; cancellation leaves the journal for retry.
 * @returns Number of journals completed, repaired, or safely rolled back; complete historical decisions return zero.
 * @throws On invalid authority, conflicting event or file bytes, or I/O failure;
 *         published event or marker bytes can remain visible for retry.
 */
export async function recoverCandidateReviewTransactions(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reviewFile: string,
  wikiRoot: string,
  archiveRoot: string,
  measuredTrialReader?: KnowledgeWikiMeasuredTrialReader,
  shouldContinue: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<number> {
  const directory = promotionJournalDirectory(reviewFile)
  let entries: string[]
  try {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe promotion journal directory')
    entries = readdirSync(directory).filter(name => name.endsWith('.json')).sort()
  } catch (error) {
    if (isMissingFileError(error)) return 0
    throw error
  }
  let recovered = 0
  for (const name of entries) {
    signal?.throwIfAborted()
    if (!shouldContinue()) continue
    const path = join(directory, name)
    const journalBytes = readRegularFileBounded(path, PROMOTION_JOURNAL_MAX_BYTES)
    const journalDigest = sha256(journalBytes)
    const raw: unknown = JSON.parse(journalBytes.toString('utf8'))
    if (typeof raw !== 'object' || raw === null || Reflect.get(raw, 'schemaVersion') !== 1) continue
    const rawOperations: unknown = Reflect.get(raw, 'operations')
    if (!Array.isArray(rawOperations)) continue
    const journal = raw as PromotionJournal
    if (!/^[A-Za-z0-9._:-]+$/u.test(journal.id)) continue
    // Empty schema-1 settlement placeholders predate signed transaction WALs.
    if (journal.operations.length === 0) continue
    for (const operation of journal.operations) assertPromotionOperationConfined(operation, reviewFile, wikiRoot, archiveRoot)
    if (journal.state === 'committed') {
      if (!validatePromotionJournalAuthority(authority, journal)) {
        throw new Error('promotion journal authority validation failed')
      }
      const authenticatedAuthority = authority as KnowledgeWikiVerifierAuthority
      const lifecycleType = CANONICAL_REVIEW_ACTIONS.has(journal.action) ? 'knowledge/promoted' : 'knowledge/rejected'
      let expectedPayload: Readonly<Record<string, unknown>>
      if (lifecycleType === 'knowledge/promoted') {
        expectedPayload = promotionCanonicalEventComparisonPayload(journal, authenticatedAuthority.authorityId)
      } else {
        expectedPayload = promotionRejectedEventPayload(journal)
      }
      const eventPath = knowledgeEventPath(reviewFile)
      const eventBefore = optionalRegularFileDigest(eventPath, 64 * 1024 * 1024)
      if (hasKnowledgeReviewEvent(reviewFile, lifecycleType, journal.reviewId, journal.candidateHash,
        expectedPayload, authority)) {
        if (!shouldContinue()) continue
        syncKnowledgeEventLog(eventPath)
        continue
      }
      if (!revalidateJournalBeforeMutation(authority, measuredTrialReader, reviewFile, journal)) {
        throw new Error('committed promotion journal lacks an authenticated measured-trial receipt')
      }
      syncPromotionOperationDirectories(journal.operations)
      assertPromotionPostState(journal.operations)
      let payload = expectedPayload
      if (lifecycleType === 'knowledge/promoted') {
        let signed: Readonly<Record<string, unknown>> | undefined
        try {
          signed = await appendKnowledgePromotedEvent(journal.reviewId, journal.candidateHash,
            promotionCanonicalEventPayload(journal), authenticatedAuthority, signal)
        } catch (error) {
          if (signal?.aborted) return recovered
          throw error
        }
        if (signed === undefined) throw new Error('promotion event signing failed during committed recovery')
        payload = signed
        if (!revalidateJournalBeforeMutation(authority, measuredTrialReader, reviewFile, journal)) {
          throw new Error('committed promotion journal changed during event signing')
        }
        assertPromotionPostState(journal.operations)
      }
      signal?.throwIfAborted()
      if (!shouldContinue()) continue
      if (optionalRegularFileDigest(eventPath, 64 * 1024 * 1024) !== eventBefore
        || optionalRegularFileDigest(path, PROMOTION_JOURNAL_MAX_BYTES) !== journalDigest) {
        throw new Error('committed promotion journal or event state changed during recovery')
      }
      syncPromotionOperationDirectories(journal.operations)
      assertPromotionPostState(journal.operations)
      const appended = writeKnowledgeReviewEvent(reviewFile, lifecycleType, journal.reviewId,
        journal.candidateHash, payload, authority)
      assertPromotionPostState(journal.operations)
      if (appended) recovered += 1
      continue
    }
    if (journal.state !== 'prepared') continue
    const markers = promotionJournalMarkers(journal)
    let canComplete = revalidateJournalBeforeMutation(authority, measuredTrialReader, reviewFile, journal)
    if (!canComplete) {
      for (const operation of [...journal.operations].reverse()) rollbackPromotionOperation(operation)
      syncPromotionOperationDirectories([...journal.operations].reverse())
      atomicWriteFile(path, markers.rolledBack)
      try {
        appendKnowledgeReviewEvent(reviewFile, 'knowledge/rolled_back', journal.reviewId, journal.candidateHash, {
          lifecycle: 'rolled_back',
          transactionId: journal.id,
          reason: 'missing-authenticated-measured-trial',
        })
      } catch {
        // The signed journal and restored operations remain the recovery authority.
      }
      recovered += 1
      continue
    }
    let promotedPayload: Readonly<Record<string, unknown>> | undefined
    let lifecycleEventAlreadyPresent = false
    const eventPath = knowledgeEventPath(reviewFile)
    const eventBefore = optionalRegularFileDigest(eventPath, 64 * 1024 * 1024)
    if (CANONICAL_REVIEW_ACTIONS.has(journal.action)) {
      const authenticatedAuthority = authority as KnowledgeWikiVerifierAuthority
      const eventPayload = promotionCanonicalEventPayload(journal)
      if (hasKnowledgeReviewEvent(reviewFile, 'knowledge/promoted', journal.reviewId, journal.candidateHash,
        promotionCanonicalEventComparisonPayload(journal, authenticatedAuthority.authorityId), authenticatedAuthority)) {
        syncKnowledgeEventLog(eventPath)
        lifecycleEventAlreadyPresent = true
      } else {
        try {
          promotedPayload = await appendKnowledgePromotedEvent(journal.reviewId, journal.candidateHash,
            eventPayload, authenticatedAuthority, signal)
        } catch (error) {
          if (signal?.aborted) return recovered
          throw error
        }
        if (promotedPayload === undefined) throw new Error('promotion event signing failed during recovery')
      }
      canComplete = revalidateJournalBeforeMutation(authority, measuredTrialReader, reviewFile, journal)
        && optionalRegularFileDigest(eventPath, 64 * 1024 * 1024) === eventBefore
        && optionalRegularFileDigest(path, PROMOTION_JOURNAL_MAX_BYTES) === journalDigest
      if (!canComplete) throw new Error('promotion journal or event state changed during recovery signing')
    }
    const lifecycle = lifecycleEventAlreadyPresent
      ? undefined
      : promotionLifecyclePayload(journal, promotedPayload)
    if (lifecycle !== undefined) {
      hasKnowledgeReviewEvent(reviewFile, lifecycle.type, journal.reviewId, journal.candidateHash,
        lifecycle.payload, authority)
    }
    signal?.throwIfAborted()
    if (!shouldContinue()) continue
    for (const operation of journal.operations) applyPromotionOperation(operation)
    syncPromotionOperationDirectories(journal.operations)
    assertPromotionPostState(journal.operations)
    // A matching event left by an earlier attempt was synced above. If absent,
    // append it before making the committed marker visible.
    if (lifecycle !== undefined) {
      writeKnowledgeReviewEvent(reviewFile, lifecycle.type, journal.reviewId, journal.candidateHash,
        lifecycle.payload, authority)
    }
    authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
      phase: 'before-commit-marker',
      operationIndex: journal.operations.length,
    })
    assertPromotionPostState(journal.operations)
    if (optionalRegularFileDigest(path, PROMOTION_JOURNAL_MAX_BYTES) !== journalDigest) {
      throw new Error('promotion journal changed before commit marker')
    }
    atomicWriteFile(path, markers.committed)
    recovered += 1
  }
  return recovered
}

/**
 * Classify all requested rows, then atomically resolve the eligible advisory subset once.
 * @param reviewFile - absolute review JSON path.
 * @param reviewIds - review ids requested by the caller.
 * @param action - persisted resolution action.
 * @returns resolved advisory count and candidate ids for the candidate owner.
 */
export function resolveAdvisoryReviewBatch(
  reviewFile: string,
  reviewIds: string[],
  action: string,
): AdvisoryResolution {
  const loaded = loadReviewItems(reviewFile)
  if (loaded === undefined) return { resolvedCount: 0, candidateIds: [] }
  const { all } = loaded
  const requested = new Set(reviewIds)
  const classified = new Set<string>()
  const candidateIds: string[] = []
  let resolvedCount = 0
  for (const [index, item] of all.entries()) {
    if (!requested.has(item.id) || classified.has(item.id)) continue
    classified.add(item.id)
    if (item.reviewKind === 'candidate') {
      candidateIds.push(item.id)
      continue
    }
    if (item.resolved) continue
    all[index] = { ...item, resolved: true, resolvedAction: action }
    resolvedCount += 1
  }
  if (resolvedCount > 0) writeReviewItemsAtomically(reviewFile, all)
  return { resolvedCount, candidateIds }
}

/**
 * Resolve persisted non-candidate review items while preserving the count-only caller contract.
 * @param reviewFile - absolute review JSON path.
 * @param reviewIds - review identifiers requested by the caller.
 * @param action - resolution action to persist for eligible advisory rows.
 * @returns the number of advisory rows resolved.
 */
export function resolveAdvisoryReviews(reviewFile: string, reviewIds: string[], action: string): number {
  return resolveAdvisoryReviewBatch(reviewFile, reviewIds, action).resolvedCount
}

/**
 * Append reviews to the review file, deduped by deterministic id. The review
 * store is a bounded JSON array; malformed existing state is rejected and left intact.
 * @param reviewFile - absolute path of `.llm-wiki/review.json`.
 * @param sourcePath - absolute path of the source that produced the reviews.
 * @param reviews - parsed reviews to persist.
 * @returns how many reviews were newly appended.
 */
export function appendReviews(reviewFile: string, sourcePath: string, reviews: ParsedReview[]): number {
  if (reviews.length === 0) return 0
  return commitReviewAppend(prepareReviewAppend(reviewFile, dirname(dirname(reviewFile)), sourcePath, reviews, []))
    .advisoryAppended
}

/**
 * Register written candidate pages as real, hash-bound approval items.
 * @param reviewFile - The review file input.
 * @param projectRoot - The project root input.
 * @param sourcePath - The source path input.
 * @param writtenPaths - The written paths input.
 * @returns The value produced by append candidate reviews.
 */
export function appendCandidateReviews(
  reviewFile: string,
  projectRoot: string,
  sourcePath: string | undefined,
  writtenPaths: string[],
): number {
  const candidates: Array<{ path: string; content: string }> = []
  for (const writtenPath of writtenPaths) {
    const candidate = resolveCandidateReviewPath(join(projectRoot, 'wiki'), writtenPath.replace(/^wiki\//u, ''))
    if (candidate === undefined) continue
    const content = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString('utf8')
    candidates.push({ path: `wiki/${candidate.relativePath}`, content })
  }
  return commitReviewAppend(prepareReviewAppend(reviewFile, projectRoot, sourcePath, [], candidates)).candidateAppended
}

/** Prepare one complete advisory and candidate review projection before publication.
 * @param reviewFile - Absolute path of `.llm-wiki/review.json`.
 * @param projectRoot - Project root used for candidate governance and source binding.
 * @param sourcePath - Candidate provenance path used to bind source bytes.
 * @param advisoryReviews - Parsed model review blocks to append by deterministic id.
 * @param candidateInputs - Candidate paths and exact final contents, including merges. Repeated paths
 * describe alternative contents for one publication.
 * @param advisorySourcePath - Optional advisory provenance path; defaults to `sourcePath`.
 * @returns Opaque plan whose largest possible successful-candidate subset fits the byte bound.
 * @throws On invalid stored state, unsafe candidate paths, or any possible result exceeding the byte bound.
 */
export function prepareReviewAppend(
  reviewFile: string,
  projectRoot: string,
  sourcePath: string | undefined,
  advisoryReviews: readonly ParsedReview[],
  candidateInputs: readonly { readonly path: string; readonly content: string }[],
  advisorySourcePath = sourcePath,
): ReviewAppendPlan {
  const before = readReviewStore(reviewFile)
  const existing = before === undefined ? [] : parseReviewItems(before)
  const baseItems = [...existing]
  const now = Date.now()
  let advisoryAppended = 0
  for (const review of advisoryReviews) {
    const id = reviewId(review)
    if (baseItems.some(item => item.id === id)) continue
    baseItems.push({
      id,
      title: review.title,
      type: review.type,
      ...(review.description === '' ? {} : { description: review.description }),
      ...(advisorySourcePath === undefined ? {} : { sourcePath: advisorySourcePath }),
      affectedPages: [...review.affectedPages],
      options: [{ action: 'Skip', label: 'Skip' }],
      reviewKind: 'advisory',
      resolved: false,
      createdAt: now,
      searchQueries: [...review.searchQueries],
    } satisfies WikiReviewItem)
    advisoryAppended += 1
  }

  const provenancePath = sourcePath?.trim() === '' ? undefined : sourcePath
  const candidateBase = [...baseItems]
  const plannedCandidates = new Map<string, NonEmpty<PlannedCandidateReview>>()
  const allCandidateItems = new Map<string, NonEmpty<RegisteredCandidateReview>>()
  for (const input of candidateInputs) {
    const candidate = resolvePlannedCandidateReviewPath(join(projectRoot, 'wiki'), input.path.replace(/^wiki\//u, ''))
    if (candidate === undefined) continue
    const candidatePath = candidate.relativePath
    const bytes = Buffer.from(input.content, 'utf8')
    if (bytes.length > 5 * 1024 * 1024) throw new Error(`candidate exceeds 5242880 bytes: ${candidate.absolutePath}`)
    const content = bytes.toString('utf8')
    const candidateHash = createHash('sha256').update(bytes).digest('hex')
    const id = `candidate-${createHash('sha256').update(candidatePath).digest('hex').slice(0, 16)}`
    const title = (/^title:\s*(.+)$/mu.exec(content)?.[1] ?? basename(candidatePath, '.md'))
      .trim()
      .replace(/^['"]|['"]$/gu, '')
    const governance = decideCandidateGovernance(
      join(projectRoot, 'wiki'), candidatePath, content, canonicalTarget(candidatePath),
    )
    const targetPath = governance.targetPath
    const prior = candidateBase.find(candidateItem => candidateItem.id === id)
    const sourceHash = sourceHashForCandidate(projectRoot, provenancePath)
    const item: RegisteredCandidateReview = {
      id,
      title,
      type: 'candidate-approval',
      description: `候选：${candidatePath}${targetPath ? ` → ${targetPath}` : '（自治隔离）'}；自治决定：${governance.action}；置信度：${governance.confidence.toFixed(2)}；评分：${governance.score}/10；${governance.reasons.join('；')}`,
      ...(provenancePath === undefined ? {} : { sourcePath: provenancePath }),
      affectedPages: [candidatePath],
      options: [{ action: 'Archive', label: '归档候选' }],
      resolved: false,
      createdAt: Date.now(),
      reviewKind: 'candidate',
      candidatePath,
      candidateHash,
      sourceHash,
      verification: {
        status: 'pending', candidateHash, methods: [], evidence: [], receipts: [], confidence: 0, successCount: 0, failureCount: 0,
      },
      ...(targetPath ? { targetPath } : {}),
    }
    const plannedCandidate = {
      path: candidatePath, absolutePath: candidate.absolutePath, content, bytes, sourceHash, decision: governance, item,
    }
    const planned = plannedCandidates.get(candidatePath)
    if (planned === undefined) plannedCandidates.set(candidatePath, [plannedCandidate])
    else planned.push(plannedCandidate)
    if (prior?.candidateHash === candidateHash && !prior.resolved) continue
    const variants = allCandidateItems.get(candidatePath)
    if (variants === undefined) allCandidateItems.set(candidatePath, [item])
    else if (!variants.some(variant => variant.candidateHash === item.candidateHash)) variants.push(item)
  }

  const worstRows = [...candidateBase]
  const fullRows = [...candidateBase]
  for (const [path, variants] of allCandidateItems) {
    const item = variants.reduce((longest, current) =>
      reviewArrayItemBytes(current) > reviewArrayItemBytes(longest) ? current : longest)
    const existingIndex = candidateBase.findIndex(candidateItem => candidateItem.id === item.id)
    const old = existingIndex < 0 ? undefined : candidateBase[existingIndex]
    if (old === undefined || reviewArrayItemBytes(item) > reviewArrayItemBytes(old)) {
      if (existingIndex < 0) worstRows.push(item)
      else worstRows[existingIndex] = item
    }
    const pathCandidates = plannedCandidates.get(path) as NonEmpty<PlannedCandidateReview>
    const lastCandidate = pathCandidates.at(-1) as PlannedCandidateReview
    const allSuccessfulItem = lastCandidate.item
    if (existingIndex < 0) fullRows.push(allSuccessfulItem)
    else fullRows[existingIndex] = allSuccessfulItem
  }
  encodeReviewStore(worstRows)
  encodeReviewStore(fullRows)

  const plan = Object.freeze({}) as ReviewAppendPlan
  reviewAppendPlanStates.set(plan, {
    reviewFile,
    projectRoot,
    before: before === undefined ? undefined : Buffer.from(before),
    baseItems: candidateBase,
    candidates: plannedCandidates,
    allCandidateItems,
    advisoryAppended,
  })
  return plan
}

/** Commit the preflighted projection after candidate writes succeed.
 * @param plan - Opaque plan from `prepareReviewAppend`.
 * @param successfulCandidatePaths - Successfully published paths; omitted means every planned path succeeded.
 * @returns Advisory and candidate row counts persisted.
 * @throws If the review snapshot or selected candidate/source bytes changed after preflight.
 */
export function commitReviewAppend(
  plan: ReviewAppendPlan,
  successfulCandidatePaths?: readonly string[],
): { readonly advisoryAppended: number; readonly candidateAppended: number } {
  const prepared = reviewAppendPlanStates.get(plan)
  if (prepared === undefined) throw new Error('invalid review append plan')
  const current = readReviewStore(prepared.reviewFile)
  if ((current === undefined) !== (prepared.before === undefined)
    || (current !== undefined && prepared.before !== undefined && !current.equals(prepared.before))) {
    throw new Error('review state changed after append preflight')
  }
  const selected: Array<readonly [string, NonEmpty<PlannedCandidateReview>]> = successfulCandidatePaths === undefined
    ? [...prepared.candidates.entries()]
    : [...new Set(successfulCandidatePaths.map((path) => {
      const candidate = resolveCandidateReviewPath(join(prepared.projectRoot, 'wiki'), path.replace(/^wiki\//u, ''))
      if (candidate === undefined || !prepared.candidates.has(candidate.relativePath)) {
        throw new Error('candidate path was not included in review append preflight')
      }
      return candidate.relativePath
    }))].map(path => [path, prepared.candidates.get(path) as NonEmpty<PlannedCandidateReview>] as const)
  const items = [...prepared.baseItems]
  const observed: PlannedCandidateReview[] = []
  for (const [path, candidates] of selected) {
    const firstCandidate = candidates[0]
    const currentPath = resolveCandidateReviewPath(join(prepared.projectRoot, 'wiki'), path)
    if (currentPath === undefined || currentPath.absolutePath !== firstCandidate.absolutePath
      || candidates.some(candidate => candidate.absolutePath !== currentPath.absolutePath)) {
      throw new Error('candidate path changed after review append preflight')
    }
    const actual = readRegularFileBounded(currentPath.absolutePath, 5 * 1024 * 1024)
    const candidate = candidates.find(value => value.bytes.equals(actual))
    if (candidate === undefined
      || sourceHashForCandidate(prepared.projectRoot, candidate.item.sourcePath) !== candidate.sourceHash) {
      throw new Error('candidate or source changed after review append preflight')
    }
    const decision = decideCandidateGovernance(
      join(prepared.projectRoot, 'wiki'), path, candidate.content, canonicalTarget(path),
    )
    if (canonicalJson(decision) !== canonicalJson(candidate.decision)) {
      throw new Error('candidate governance changed after review append preflight')
    }
    const item = prepared.allCandidateItems.get(path)?.find(value => value.candidateHash === candidate.item.candidateHash)
    const priorIndex = item === undefined ? -1 : prepared.baseItems.findIndex(candidateItem => candidateItem.id === item.id)
    const prior = priorIndex < 0 ? undefined : prepared.baseItems[priorIndex]
    if (item !== undefined && (prior === undefined || prior.candidateHash !== item.candidateHash || prior.resolved)) {
      const index = items.findIndex(candidateItem => candidateItem.id === item.id)
      if (index < 0) items.push(item)
      else items[index] = item
      observed.push(candidate)
    }
  }

  if (prepared.advisoryAppended > 0 || observed.length > 0) {
    writeReviewStore(prepared.reviewFile, encodeReviewStore(items))
  }
  for (const candidate of observed) {
    appendCandidateKnowledgeEvents(prepared.reviewFile, prepared.projectRoot, candidate.item, candidate.content)
  }
  if (observed.length > 0) appendCandidateConflictEvents(prepared.reviewFile, items)
  return { advisoryAppended: prepared.advisoryAppended, candidateAppended: observed.length }
}

function parseReviewItems(bytes: Buffer): WikiReviewItem[] {
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (!Array.isArray(parsed) || !parsed.every(isReviewItem)) throw new Error('invalid knowledge review state')
  return parsed
}

function reviewArrayItemBytes(item: WikiReviewItem): number {
  const encoded = JSON.stringify(item, null, 2)
  return Buffer.byteLength(encoded, 'utf8') + (encoded.split('\n').length * 2)
}

function appendCandidateKnowledgeEvents(
  reviewFile: string,
  projectRoot: string,
  item: RegisteredCandidateReview,
  content: string,
): void {
  const record = createKnowledgeRecord({
    id: `candidate:${item.id}`, content, claimKey: item.title.trim().toLocaleLowerCase(),
    source: item.candidatePath, evidenceRefs: [item.sourcePath ?? item.candidatePath], sourceHash: item.sourceHash,
    scope: { projectId: projectRoot, visibility: 'project' },
    createdAt: new Date(item.createdAt).toISOString(),
    expiresAt: new Date(item.createdAt + 30 * 86_400_000).toISOString(), lifecycle: 'candidate',
  })
  appendKnowledgeLifecycleEvent(reviewFile, 'knowledge/observed', item, { record })
  appendKnowledgeLifecycleEvent(reviewFile, 'knowledge/candidate', item, { record })
}

function appendCandidateConflictEvents(reviewFile: string, items: readonly WikiReviewItem[]): void {
  const state = replayKnowledgeEvents(readKnowledgeEventLog(knowledgeEventPath(reviewFile)))
  for (const record of state.records.values()) {
    const conflicts = detectKnowledgeConflicts(record, state.records.values())
    if (conflicts.length === 0) continue
    const review = items.find(item => item.id === record.id.replace(/^candidate:/u, ''))
    if (review === undefined || review.candidateHash === undefined) continue
    appendKnowledgeReviewEvent(reviewFile, 'knowledge/conflict', review.id, review.candidateHash, { conflictIds: conflicts })
  }
}

/**
 * Authenticate a verification event and revalidate its inputs before publishing review projections.
 * Candidate and Canonical bytes are unchanged; later projection I/O failures are not a multi-file rollback.
 * @param authority - Trusted verifier used to authenticate and bind the receipt.
 * @param reviewFile - The review file input.
 * @param wikiRoot - The wiki root input.
 * @param reviewIdValue - The review id value input.
 * @param receiptId - Receipt id created by the trusted verifier owner.
 * @param action - Governance action that the receipt must authenticate.
 * @param signal - Optional owner cancellation signal checked after asynchronous signing.
 * @param shouldContinue - Owner fence checked before the first projection write.
 * @returns Whether the current receipt and event seal were accepted and all projection writes completed.
 * @throws On authority errors, malformed persisted state, or projection I/O failures.
 */
export async function recordCandidateVerification(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reviewFile: string,
  wikiRoot: string,
  reviewIdValue: string,
  receiptId: unknown,
  action: CandidateVerification['action'],
  signal?: AbortSignal,
  shouldContinue: () => boolean = () => true,
): Promise<boolean> {
  if (typeof receiptId !== 'string' || action === undefined) return false
  const loaded = loadReviewItem(reviewFile, reviewIdValue)
  if (loaded === undefined) return false
  const { all, bytes: reviewBefore, index, item } = loaded
  if (item.reviewKind !== 'candidate' || item.resolved || !item.candidatePath || !item.candidateHash) return false
  const candidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath)
  if (candidate === undefined) return false
  const candidateBefore = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024)
  const actualHash = sha256(candidateBefore)
  if (actualHash !== item.candidateHash) return false
  const eventPath = knowledgeEventPath(reviewFile)
  const eventsBefore = optionalRegularFileDigest(eventPath, 64 * 1024 * 1024)
  const governedEvents = readKnowledgeEventLog(eventPath, authority)
  const governed = replayKnowledgeEvents(governedEvents).records.get(`candidate:${item.id}`)
  if (governed !== undefined && (governed.verificationStatus === 'expired' || governed.verificationStatus === 'conflict')) return false
  const trusted = readTrustedVerification(
    authority,
    reviewFile,
    wikiRoot,
    item,
    receiptId,
    action,
  )
  if (trusted === undefined) return false
  const receiptPath = join(dirname(reviewFile), 'verification-receipts', `${trusted.receipt.id}.json`)
  const receiptBefore = optionalRegularFileDigest(receiptPath, 2 * 1024 * 1024)
  if (receiptBefore === undefined) return false
  const nextVerification = trusted.verification
  const verificationAuthorityId = nextVerification.authorityId
  const lastVerifiedAt = nextVerification.lastVerifiedAt
  const createdAt = new Date(item.createdAt ?? Date.now()).toISOString()
  const fallbackRecord = createKnowledgeRecord({
    id: `candidate:${item.id}`,
    content: candidateBefore.toString('utf8'),
    claimKey: item.title.trim().toLocaleLowerCase(),
    source: item.candidatePath,
    sourceHash: item.sourceHash ?? knowledgeSha256(item.sourcePath ?? item.candidatePath),
    scope: { projectId: dirname(dirname(reviewFile)), visibility: 'project' },
    evidenceRefs: [item.sourcePath ?? item.candidatePath],
    verificationStatus: 'candidate',
    confidence: 0,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 30 * 86_400_000).toISOString(),
    lifecycle: 'candidate',
  })
  const hashBoundItem = {
    ...item,
    candidatePath: item.candidatePath,
    candidateHash: item.candidateHash,
  }
  const verifiedPayload = await prepareKnowledgeVerifiedPayload(hashBoundItem, {
    record: fallbackRecord,
    verificationStatus: 'verified',
    trust: 'medium',
    authority: verificationAuthorityId,
    confidence: nextVerification.confidence,
    lastVerifiedAt,
    evidenceRefs: nextVerification.receipts.map(receipt => receipt.id),
  }, trusted.authority, signal)
  if (verifiedPayload === undefined) return false
  signal?.throwIfAborted()
  if (!shouldContinue()) return false
  const revalidated = readTrustedVerification(trusted.authority, reviewFile, wikiRoot, item, receiptId, action)
  if (revalidated === undefined || revalidated.receipt.receiptHash !== trusted.receipt.receiptHash
    || canonicalJson(revalidated.verification) !== canonicalJson(nextVerification)) return false
  const currentCandidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath)
  if (currentCandidate === undefined
    || !readRegularFileBounded(currentCandidate.absolutePath, 5 * 1024 * 1024).equals(candidateBefore)
    || !readRegularFileBounded(reviewFile, 8 * 1024 * 1024).equals(reviewBefore)
    || optionalRegularFileDigest(eventPath, 64 * 1024 * 1024) !== eventsBefore
    || optionalRegularFileDigest(receiptPath, 2 * 1024 * 1024) !== receiptBefore) return false
  signal?.throwIfAborted()
  if (!shouldContinue()) return false
  // Semantic outcomes do not authorize Canonical actions without a measured trial.
  all[index] = {
    ...item,
    verification: nextVerification,
    options: [{ action: 'Archive', label: '归档候选' }],
  }
  writeReviewItemsAtomically(reviewFile, all)
  appendGovernanceLog(reviewFile, {
    timestamp: new Date().toISOString(),
    policyVersion: governancePolicyVersion(),
    reviewId: reviewIdValue,
    action: 'Verify',
    actor: nextVerification.verifiedBy,
    outcome: nextVerification.status,
    candidateHash: actualHash,
    methods: nextVerification.methods,
    evidence: nextVerification.evidence,
    receipts: nextVerification.receipts.map(receipt => ({
      id: receipt.id,
      receiptHash: receipt.receiptHash,
      environmentHash: receipt.environmentHash,
      result: receipt.result,
      gitCommit: receipt.gitCommit,
    })),
    confidence: nextVerification.confidence,
  })
  writeKnowledgeLifecycleEvent(reviewFile, 'knowledge/verified', hashBoundItem, verifiedPayload)
  return true
}

function trustedSemanticVerification(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reviewFile: string,
  wikiRoot: string,
  item: WikiReviewItem,
  action: MeasuredTrialReviewBinding['action'],
): ReturnType<typeof readTrustedVerification> {
  const verification = item.verification
  if (verification?.status !== 'passed' || verification.action !== action || verification.reviewHash === undefined) return undefined
  const reference = verification.receipts.at(-1)
  if (reference === undefined || reference.result !== 'pass') return undefined
  const trusted = readTrustedVerification(authority, reviewFile, wikiRoot, item, reference.id, action)
  if (trusted === undefined || trusted.receipt.receiptHash !== reference.receiptHash
    || trusted.verification.reviewHash !== verification.reviewHash) return undefined
  return trusted
}

interface MeasuredTrialTargetState {
  readonly hashOrVerifiedAbsence: string
}

function measuredTrialTargetState(
  wikiRoot: string,
  targetPath: string,
  action: MeasuredTrialReviewBinding['action'],
): MeasuredTrialTargetState | undefined {
  const target = resolveCanonicalReviewPath(wikiRoot, targetPath, true)
  if (target === undefined) return undefined
  try {
    const stat = lstatSync(target.absolutePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || action === 'Promote') return undefined
    const bytes = readRegularFileBounded(target.absolutePath, 5 * 1024 * 1024)
    return { hashOrVerifiedAbsence: sha256(bytes) }
  } catch (error) {
    if (!isMissingFileError(error) || action !== 'Promote') return undefined
    return { hashOrVerifiedAbsence: 'verified-absence' }
  }
}

function measuredTrialBinding(
  semantic: NonNullable<ReturnType<typeof trustedSemanticVerification>>,
  action: MeasuredTrialReviewBinding['action'],
  target: MeasuredTrialTargetState,
): MeasuredTrialReviewBinding {
  // The semantic owner rebuilt and matched the exact canonical-action request.
  // Canonical action compatibility requires a target path at that boundary.
  const request = semantic.receipt.request
  return Object.freeze({
    reviewHash: request.reviewHash,
    semanticReceiptHash: semantic.receipt.receiptHash,
    candidatePath: request.candidatePath,
    candidateHash: request.candidateHash,
    action,
    targetPath: request.targetPath as string,
    targetBeforeHashOrVerifiedAbsence: target.hashOrVerifiedAbsence,
  })
}

function isBoundMeasuredTrial(
  reader: KnowledgeWikiMeasuredTrialReader,
  trial: VerifiedMeasuredTrial | undefined,
  trialHash: string,
  binding: MeasuredTrialReviewBinding,
): trial is VerifiedMeasuredTrial {
  if (trial === undefined || trial.authorityId !== reader.authorityId || trial.trialHash !== trialHash
    || !/^[a-f0-9]{64}$/u.test(trialHash) || !/^[a-f0-9]{64}$/u.test(trial.proposalHash)
    || !/^[a-f0-9]{64}$/u.test(trial.targetAfterHash)
    || typeof trial.eligibleForReview !== 'boolean'
    || trial.candidatePath !== binding.candidatePath || trial.candidateHash !== binding.candidateHash
    || trial.action !== binding.action || trial.targetPath !== binding.targetPath
    || trial.targetBeforeHashOrVerifiedAbsence !== binding.targetBeforeHashOrVerifiedAbsence
    || !Buffer.isBuffer(trial.targetAfterBytes) || trial.targetAfterBytes.length > 5 * 1024 * 1024
    || !Buffer.from(trial.targetAfterBytes.toString('utf8'), 'utf8').equals(trial.targetAfterBytes)
    || sha256(trial.targetAfterBytes) !== trial.targetAfterHash
    || !Number.isSafeInteger(trial.retrievalHits) || trial.retrievalHits < 0
    || !Number.isSafeInteger(trial.successfulUses) || trial.successfulUses < 0
    || !Number.isSafeInteger(trial.userCorrections) || trial.userCorrections < 0
    || !Number.isFinite(trial.utilityScore)
    || !Number.isFinite(Date.parse(trial.startedAt)) || !Number.isFinite(Date.parse(trial.endedAt))
    || Date.parse(trial.endedAt) < Date.parse(trial.startedAt)
    || !Array.isArray(trial.evidenceRefs) || trial.evidenceRefs.length === 0
    || !trial.evidenceRefs.every((reference: unknown) =>
      typeof reference === 'string' && /^[a-f0-9]{64}$/u.test(reference))) return false
  return true
}

function candidateTrialProjection(value: VerifiedMeasuredTrial, eligible: boolean): CandidateTrial {
  return {
    status: eligible ? 'passed' : 'failed',
    trialHash: value.trialHash,
    authorityId: value.authorityId,
    evidence: [...value.evidenceRefs],
    retrievalHits: value.retrievalHits,
    successfulUses: value.successfulUses,
    userCorrections: value.userCorrections,
    utilityScore: value.utilityScore,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
  }
}

function measuredTrialJournalProjection(
  value: VerifiedMeasuredTrial,
): NonNullable<PromotionJournalCore['measuredTrial']> {
  return {
    trialHash: value.trialHash,
    authorityId: value.authorityId,
    proposalHash: value.proposalHash,
    targetAfterHash: value.targetAfterHash,
    evidenceRefs: [...value.evidenceRefs],
    retrievalHits: value.retrievalHits,
    successfulUses: value.successfulUses,
    userCorrections: value.userCorrections,
    utilityScore: value.utilityScore,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
  }
}

function measuredTrialEventPayload(
  value: NonNullable<PromotionJournalCore['measuredTrial']>,
): Readonly<Record<string, unknown>> {
  return {
    trialHash: value.trialHash,
    proposalHash: value.proposalHash,
    targetAfterHash: value.targetAfterHash,
    measuredTrialAuthorityId: value.authorityId,
    evidenceRefs: [...value.evidenceRefs],
    retrievalHits: value.retrievalHits,
    successfulUses: value.successfulUses,
    userCorrections: value.userCorrections,
    utilityScore: value.utilityScore,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
  }
}

interface AuthorizedCandidateTrial {
  readonly semantic: NonNullable<ReturnType<typeof trustedSemanticVerification>>
  readonly binding: MeasuredTrialReviewBinding
  readonly measured: VerifiedMeasuredTrial
}

function readAuthorizedCandidateTrial(
  authority: KnowledgeWikiVerifierAuthority,
  reader: KnowledgeWikiMeasuredTrialReader | undefined,
  reviewFile: string,
  wikiRoot: string,
  item: WikiReviewItem,
  action: MeasuredTrialReviewBinding['action'],
): AuthorizedCandidateTrial | undefined {
  if (reader === undefined || item.verification?.trial?.status !== 'passed') return undefined
  const semantic = trustedSemanticVerification(authority, reviewFile, wikiRoot, item, action)
  if (semantic === undefined || reader.authorityId === semantic.receipt.result.authorityId) return undefined
  const before = measuredTrialTargetState(wikiRoot, semantic.receipt.request.targetPath as string, action)
  if (before === undefined) return undefined
  const binding = measuredTrialBinding(semantic, action, before)
  const storedTrial = item.verification.trial
  const measured = reader.read(storedTrial.trialHash, binding)
  if (!isBoundMeasuredTrial(reader, measured, storedTrial.trialHash, binding)
    || !measured.eligibleForReview || measured.utilityScore <= 0
    || canonicalJson(candidateTrialProjection(measured, true)) !== canonicalJson(storedTrial)) return undefined
  return { semantic, binding, measured }
}

/** Authenticate and record a paired measured-use trial without changing Candidate or Canonical bytes.
 * @param authority - Verifier authority that validates the semantic receipt and seals the journal.
 * @param reader - Independent measured-trial authority and content-addressed artifact resolver.
 * @param reviewFile - Candidate review journal to update.
 * @param wikiRoot - Wiki root containing the candidate and measured target.
 * @param reviewIdValue - Stable review identifier for the candidate.
 * @param action - Canonical review action bound into the trial.
 * @param trialHash - Content hash of the authenticated trial artifact.
 * @param actor - Actor label recorded in the governance event.
 * @returns Authenticated eligibility and blockers for this trial.
 */
export function recordCandidateMeasuredTrial(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reader: KnowledgeWikiMeasuredTrialReader | undefined,
  reviewFile: string,
  wikiRoot: string,
  reviewIdValue: string,
  action: MeasuredTrialReviewBinding['action'],
  trialHash: string,
  actor = 'human',
): CandidateMeasuredTrialResult {
  if (authority === undefined) return { authenticated: false, eligibleForReview: false, errorCode: 'verifier-authority-unavailable' }
  if (reader === undefined) return { authenticated: false, eligibleForReview: false, errorCode: 'measured-trial-authority-unavailable' }
  if (!CANONICAL_REVIEW_ACTIONS.has(action)) {
    return { authenticated: false, eligibleForReview: false, errorCode: 'measured-trial-invalid' }
  }
  const reviewBefore = readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString('utf8')
  const loaded = loadReviewItem(reviewFile, reviewIdValue)
  if (loaded === undefined || loaded.item.reviewKind !== 'candidate') {
    return { authenticated: false, eligibleForReview: false, errorCode: 'review-not-found' }
  }
  const { all, index, item } = loaded
  const semantic = trustedSemanticVerification(authority, reviewFile, wikiRoot, item, action)
  if (semantic === undefined) return { authenticated: false, eligibleForReview: false, errorCode: 'semantic-verification-required' }
  const currentVerification = item.verification as CandidateVerification
  if (reader.authorityId === semantic.receipt.result.authorityId) {
    return { authenticated: false, eligibleForReview: false, errorCode: 'measured-trial-invalid' }
  }
  const before = measuredTrialTargetState(wikiRoot, semantic.receipt.request.targetPath as string, action)
  if (before === undefined) return { authenticated: false, eligibleForReview: false, errorCode: 'measured-trial-invalid' }
  const binding = measuredTrialBinding(semantic, action, before)
  const measured = reader.read(trialHash, binding)
  if (!isBoundMeasuredTrial(reader, measured, trialHash, binding)) {
    return { authenticated: false, eligibleForReview: false, errorCode: 'measured-trial-invalid' }
  }
  const candidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath as string)
  if (candidate === undefined || sha256(readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024)) !== item.candidateHash
    || measuredTrialTargetState(wikiRoot, binding.targetPath, action)?.hashOrVerifiedAbsence !== before.hashOrVerifiedAbsence
    || readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString('utf8') !== reviewBefore) {
    return { authenticated: false, eligibleForReview: false, errorCode: 'review-changed' }
  }
  const eligible = measured.eligibleForReview && measured.utilityScore > 0
  const trial = candidateTrialProjection(measured, eligible)
  all[index] = {
    ...item,
    verification: { ...currentVerification, trial },
    options: eligible
      ? [{ action, label: action === 'Promote' ? '按实测晋级' : `按实测${action}更新` }]
      : [{ action: 'Archive', label: '归档候选' }],
  }
  writeReviewItemsAtomically(reviewFile, all)
  appendGovernanceLog(reviewFile, {
    timestamp: new Date().toISOString(),
    policyVersion: governancePolicyVersion(),
    reviewId: reviewIdValue,
    action: 'MeasuredTrial',
    actor: actor || reader.authorityId,
    outcome: eligible ? 'authenticated-utility-lift' : 'authenticated-no-utility-lift',
    candidateHash: item.candidateHash,
    trialHash: trial.trialHash,
    proposalHash: measured.proposalHash,
    authorityId: reader.authorityId,
    evidence: trial.evidence,
    retrievalHits: trial.retrievalHits,
    successfulUses: trial.successfulUses,
    userCorrections: trial.userCorrections,
    utilityScore: trial.utilityScore,
  })
  return {
    authenticated: true,
    eligibleForReview: eligible,
    trial,
    ...(eligible ? {} : { errorCode: 'utility-not-improved' as const }),
  }
}

/**
 * Apply a hash-bound candidate decision. Null means this is an advisory item.
 * @param authority - Trusted verifier that authenticates the bound receipt and promotion journal.
 * @param reviewFile - The review file input.
 * @param projectRoot - The project root input.
 * @param wikiRoot - The wiki root input.
 * @param archiveRoot - The archive root input.
 * @param reviewIdValue - The review id value input.
 * @param action - The action input.
 * @param actor - The actor input.
 * @param measuredTrialReader - Independent reader required to revalidate canonical trial evidence.
 * @param shouldContinue - Service generation fence rechecked after signing; false prevents commit.
 * @param signal - Optional project-generation signal forwarded to event and WAL signing; checked before commit.
 * @returns The value produced by apply candidate review.
 */
export async function applyCandidateReview(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reviewFile: string,
  projectRoot: string,
  wikiRoot: string,
  archiveRoot: string,
  reviewIdValue: string,
  action: string,
  actor = 'human',
  measuredTrialReader?: KnowledgeWikiMeasuredTrialReader,
  shouldContinue: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<boolean | null> {
  signal?.throwIfAborted()
  if (authority === undefined) return false
  const loaded = loadReviewItem(reviewFile, reviewIdValue)
  if (loaded === undefined) return false
  const { all, index, item } = loaded
  if (item.reviewKind !== 'candidate') return null
  const authorizedTrial = CANONICAL_REVIEW_ACTIONS.has(action)
    ? readAuthorizedCandidateTrial(
      authority,
      measuredTrialReader,
      reviewFile,
      wikiRoot,
      item,
      action as MeasuredTrialReviewBinding['action'],
    )
    : undefined
  if (CANONICAL_REVIEW_ACTIONS.has(action) && authorizedTrial === undefined) return false
  if (item.resolved || !item.candidatePath || !item.candidateHash) return false
  const candidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath)
  if (candidate === undefined) return false
  const content = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString('utf8')
  const actualHash = createHash('sha256').update(content).digest('hex')
  if (actualHash !== item.candidateHash) return false

  // A passing receipt is necessary but not sufficient: an independently
  // expired or conflicting knowledge record cannot be promoted from a stale
  // review mirror. Legacy rows without an event projection remain governed by
  // the existing hash-bound verifier contract.
  const governedEvents = readKnowledgeEventLog(knowledgeEventPath(reviewFile))
  const eventBeforeDigest = optionalRegularFileDigest(knowledgeEventPath(reviewFile), 64 * 1024 * 1024)
  const governed = replayKnowledgeEvents(governedEvents).records.get(`candidate:${item.id}`)
  if (governed !== undefined) {
    const decision = knowledgeInjectionDecision(governed, {
      projectId: projectRoot,
      workspaceId: projectRoot,
    })
    if (BLOCKED_REVIEW_REASONS.has(decision.reason)) return false
  }

  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const resolvedAt = now.getTime()
  let appliedPath = ''
  let previousCanonicalHash = ''
  let targetPath = ''
  let targetAbsolutePath = ''
  let targetBefore: string | undefined
  let targetAfter: string | undefined
  let archivedCanonical = ''
  let archivedCanonicalContent = ''
  if (action === 'Merge' || action === 'Replace' || action === 'Deduplicate') {
    // actionIsCompatible already rejected these actions without a target before
    // the verification could pass, so the target path is present here.
    const target = resolveCanonicalReviewPath(wikiRoot, item.targetPath as string, false)
    if (target === undefined) return false
    const canonicalBefore = readRegularFileBounded(target.absolutePath, 5 * 1024 * 1024).toString('utf8')
    const canonicalHash = createHash('sha256').update(canonicalBefore).digest('hex')
    const trial = authorizedTrial as AuthorizedCandidateTrial
    if (trial.binding.targetBeforeHashOrVerifiedAbsence !== canonicalHash) return false
    previousCanonicalHash = canonicalHash
    archivedCanonicalContent = canonicalBefore
    archivedCanonical = join(
      archiveRoot,
      'wiki-governance',
      today,
      basename(projectRoot),
      canonicalHash.slice(0, 12),
      'canonical-before-update',
      target.relativePath,
    )
    targetBefore = canonicalBefore
    targetAfter = trial.measured.targetAfterBytes.toString('utf8')
    targetAbsolutePath = target.absolutePath
    targetPath = target.relativePath
    appliedPath = target.relativePath
  } else if (action === 'Promote') {
    const target = resolveCanonicalReviewPath(wikiRoot, item.targetPath as string, true)
    if (target === undefined || pathEntryExists(target.absolutePath)) return false
    const trial = authorizedTrial as AuthorizedCandidateTrial
    // Promote authorization already captured verified absence in its immutable binding.
    targetAfter = trial.measured.targetAfterBytes.toString('utf8')
    targetAbsolutePath = target.absolutePath
    targetPath = target.relativePath
    appliedPath = target.relativePath
  } else if (action !== 'Archive' && action !== 'Skip') {
    return false
  }

  const archived = join(
    archiveRoot,
    'wiki-governance',
    today,
    basename(projectRoot),
    actualHash.slice(0, 12),
    candidate.relativePath,
  )
  if (!appliedPath) appliedPath = archived
  const resolvedItems = [...all]
  resolvedItems[index] = {
    ...item,
    resolved: true,
    resolvedAction: action === 'Promote' || action === 'Merge' || action === 'Replace' || action === 'Deduplicate' ? action : 'Archive',
    appliedPath,
    resolvedAt,
  }
  const governanceEntry = {
    timestamp: now.toISOString(),
    policyVersion: governancePolicyVersion(),
    reviewId: reviewIdValue,
    action,
    actor,
    outcome: 'applied',
    candidateHash: actualHash,
    previousCanonicalHash,
    targetPath: item.targetPath ?? '',
    appliedPath,
  }

  const governanceLog = join(dirname(reviewFile), 'governance.jsonl')
  const reviewBefore = readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString('utf8')
  const governanceLogBefore = readOptionalRegularFile(governanceLog)
  const reviewAfter = JSON.stringify(resolvedItems, null, 2)
  const governanceLogAfter = `${governanceLogBefore ?? ''}${JSON.stringify(governanceEntry)}\n`
  if (targetAfter !== undefined) {
    const revalidatedTarget = resolveCanonicalReviewPath(wikiRoot, targetPath, targetBefore === undefined)
    if (revalidatedTarget === undefined || revalidatedTarget.absolutePath !== targetAbsolutePath) {
      throw new Error(`canonical target changed during review transaction: ${targetPath}`)
    }
    if (targetBefore === undefined) {
      if (pathEntryExists(targetAbsolutePath)) {
        throw new Error(`canonical target appeared during review transaction: ${targetPath}`)
      }
    } else if (readRegularFileBounded(targetAbsolutePath, 5 * 1024 * 1024).toString('utf8') !== targetBefore) {
      throw new Error(`canonical target changed during review transaction: ${targetPath}`)
    }
  }
  const currentCandidatePath = resolveCandidateReviewPath(wikiRoot, item.candidatePath)
  if (currentCandidatePath === undefined || currentCandidatePath.absolutePath !== candidate.absolutePath) {
    throw new Error(`candidate path changed during review transaction: ${item.candidatePath}`)
  }
  const currentCandidate = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString('utf8')
  if (createHash('sha256').update(currentCandidate).digest('hex') !== actualHash) {
    throw new Error(`candidate content changed during review transaction: ${item.candidatePath}`)
  }
  if (readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString('utf8') !== reviewBefore) {
    throw new Error('review state changed during review transaction')
  }
  if (readOptionalRegularFile(governanceLog) !== governanceLogBefore) {
    throw new Error('governance log changed during review transaction')
  }
  if (pathEntryExists(archived)) throw new Error(`candidate archive already exists: ${archived}`)
  if (archivedCanonical !== '' && pathEntryExists(archivedCanonical)) {
    throw new Error(`canonical archive already exists: ${archivedCanonical}`)
  }

  const transactionId = `promotion-${createHash('sha256')
    .update(`${reviewIdValue}\0${actualHash}\0${resolvedAt}`)
    .digest('hex')
    .slice(0, 24)}`
  const operations: PromotionOperation[] = []
  if (archivedCanonical !== '') {
    operations.push(promotionOperation(
      transactionId, operations.length, 'canonical-archive', archivedCanonical, undefined, archivedCanonicalContent,
    ))
  }
  operations.push(promotionOperation(
    transactionId, operations.length, 'candidate-archive', archived, undefined, currentCandidate,
  ))
  if (targetAfter !== undefined) {
    operations.push(promotionOperation(
      transactionId, operations.length, 'canonical', targetAbsolutePath, targetBefore, targetAfter,
    ))
  }
  operations.push(
    promotionOperation(
      transactionId, operations.length, 'review', reviewFile, reviewBefore, reviewAfter,
    ),
    promotionOperation(
      transactionId, operations.length + 1, 'governance', governanceLog, governanceLogBefore, governanceLogAfter,
    ),
    promotionOperation(
      transactionId, operations.length + 2, 'candidate', candidate.absolutePath, currentCandidate, undefined,
    ),
  )
  const core: PromotionJournalCore = {
    schemaVersion: 1,
    id: transactionId,
    reviewId: reviewIdValue,
    candidateHash: actualHash,
    createdAt: now.toISOString(),
    action: CANONICAL_REVIEW_ACTIONS.has(action) ? action : 'Archive',
    targetPath: item.targetPath ?? null,
    reviewHash: authorizedTrial?.semantic.receipt.request.reviewHash ?? null,
    receiptId: authorizedTrial?.semantic.receipt.id ?? null,
    receiptHash: authorizedTrial?.semantic.receipt.receiptHash ?? null,
    measuredTrial: authorizedTrial === undefined
      ? null
      : measuredTrialJournalProjection(authorizedTrial.measured),
    operationSetHash: sha256(canonicalJson(operations)),
    operations,
  }
  const journalRequest = immutablePromotionSealRequest({
    schemaVersion: 1,
    domain: 'ark.knowledge-wiki',
    authorityId: authority.authorityId,
    operation: 'seal-promotion-wal',
    journal: core,
  } as const satisfies Extract<KnowledgeWikiPromotionSealRequest, { operation: 'seal-promotion-wal' }>)
  const journalSigningPayload = encodeKnowledgeWikiPromotionSealRequest(journalRequest)
  const eventPayload = {
    action,
    appliedPath,
    lifecycle: CANONICAL_REVIEW_ACTIONS.has(action) ? 'canonical' : 'downgraded',
    ...(authorizedTrial === undefined ? {} : measuredTrialEventPayload(measuredTrialJournalProjection(authorizedTrial.measured))),
  }
  const promotedPayload = CANONICAL_REVIEW_ACTIONS.has(action)
    ? await appendKnowledgePromotedEvent(item.id, actualHash, eventPayload, authority, signal)
    : undefined
  if (CANONICAL_REVIEW_ACTIONS.has(action) && promotedPayload === undefined) return false
  signal?.throwIfAborted()
  const returnedSeal = await authority.sealPromotion(journalRequest, signal)
  signal?.throwIfAborted()
  const seal = immutableAuthoritySeal(returnedSeal)
  if (seal === undefined || seal.authorityId !== authority.authorityId) return false
  if (!authority.validatePromotion(journalSigningPayload, seal)) return false
  // Signing may pause; compare every transaction input again before its first write.
  const currentAuthorizedTrial = CANONICAL_REVIEW_ACTIONS.has(action)
    ? readAuthorizedCandidateTrial(authority, measuredTrialReader, reviewFile, wikiRoot, item, action as MeasuredTrialReviewBinding['action'])
    : undefined
  const walPath = promotionJournalPath(reviewFile, transactionId)
  const postSignCandidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath)
  const revalidatedTarget = targetPath === '' ? undefined : resolveCanonicalReviewPath(wikiRoot, targetPath, targetBefore === undefined)
  const targetStillBound = targetPath === '' || (revalidatedTarget !== undefined
    && revalidatedTarget.absolutePath === targetAbsolutePath
    && (targetBefore === undefined
      ? !pathEntryExists(targetAbsolutePath)
      : readRegularFileBounded(targetAbsolutePath, 5 * 1024 * 1024).toString('utf8') === targetBefore))
  if (readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString('utf8') !== reviewBefore
    || readOptionalRegularFile(governanceLog) !== governanceLogBefore
    || optionalRegularFileDigest(knowledgeEventPath(reviewFile), 64 * 1024 * 1024) !== eventBeforeDigest
    || postSignCandidate === undefined || postSignCandidate.absolutePath !== candidate.absolutePath
    || readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString('utf8') !== currentCandidate
    || (authorizedTrial !== undefined && (currentAuthorizedTrial === undefined
      || canonicalJson(measuredTrialJournalProjection(currentAuthorizedTrial.measured))
        !== canonicalJson(measuredTrialJournalProjection(authorizedTrial.measured))))
    || !targetStillBound
    || pathEntryExists(archived)
    || (archivedCanonical !== '' && pathEntryExists(archivedCanonical))
    || pathEntryExists(walPath)) return false
  signal?.throwIfAborted()
  if (!shouldContinue()) return false
  commitPromotionJournal(authority, measuredTrialReader, reviewFile, wikiRoot, archiveRoot, {
    ...core,
    state: 'prepared',
    seal,
  }, promotedPayload)
  return true
}

function canonicalTarget(candidatePath: string): string | undefined {
  if (candidatePath.startsWith('_candidates/sessions/')) return `concepts/${basename(candidatePath)}`
  if (candidatePath.startsWith('_candidates/research/')) return `_evidence/research/${basename(candidatePath)}`
  if (candidatePath.startsWith('_candidates/ingest/')) {
    const rel = candidatePath.slice('_candidates/ingest/'.length)
    if (/^(concepts|entities|findings|research|methodology)\//u.test(rel)) return rel
  }
  return undefined
}


function appendGovernanceLog(reviewFile: string, entry: Record<string, unknown>): void {
  const logFile = join(dirname(reviewFile), 'governance.jsonl')
  const prior = readOptionalRegularFile(logFile) ?? ''
  atomicWriteFile(logFile, `${prior}${JSON.stringify(entry)}\n`)
}

/** Deterministic review id: `review-` + FNV-1a hex over type/title/description. */
function reviewId(review: ParsedReview): string {
  const source = `${review.type}\u0000${review.title}\u0000${review.description}`
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `review-${(hash >>> 0).toString(16).padStart(8, '0')}`
}
