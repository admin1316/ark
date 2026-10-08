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
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseFrontmatterArray, parseFrontmatterField } from './frontmatter-utils.ts'
import type { CandidateVerification, WikiReviewItem } from './types.ts'
import { prepareCanonicalTarget } from './canonical-merge.ts'
import { decideCandidateGovernance, governancePolicyVersion, resolveGovernedWikiPath } from './governance-policy.ts'
import {
  assertAbsolutePathInside,
  atomicWriteFile,
  durableUnlinkFile,
  ensureAbsoluteDirectory,
  ensureConfinedDirectory,
  isMissingPathError as isMissingFileError,
  readOptionalText,
  readRegularFileBounded,
  syncDirectory,
  syncRegularFile,
} from './filesystem.ts'
import {
  canonicalJson,
  immutableReviewRow,
  readTrustedReceipt,
  readTrustedVerification,
  sha256,
  type KnowledgeWikiVerifierAuthority,
  type TrustedVerificationReceipt,
  type VerificationAuthoritySeal,
} from './verifier.ts'
import {
  appendKnowledgeEvent,
  createKnowledgeEvent,
  createKnowledgeRecord,
  detectKnowledgeConflicts,
  knowledgeSha256,
  knowledgeInjectionDecision,
  readKnowledgeEventLog,
  replayKnowledgeEvents,
} from './knowledge-governance.ts'

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
  readonly index: number
  readonly item: WikiReviewItem
}

function resolveCandidateReviewPath(root: string, input: string): ReturnType<typeof resolveGovernedWikiPath> {
  const governed = resolveGovernedWikiPath(root, input, false)
  return governed?.relativePath.startsWith('_candidates/') === true ? governed : undefined
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
function loadReviewItems(reviewFile: string): WikiReviewItem[] | undefined {
  try {
    const parsed: unknown = JSON.parse(readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString('utf8'))
    if (!Array.isArray(parsed) || !parsed.every(isReviewItem)) throw new Error('invalid knowledge review state')
    return parsed
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

/** Load one review item once, preserving callers' distinct decision policies. */
function loadReviewItem(reviewFile: string, reviewIdValue: string): LoadedReviewItem | undefined {
  const all = loadReviewItems(reviewFile)
  if (all === undefined) return undefined
  const index = all.findIndex(item => item.id === reviewIdValue)
  const item = index >= 0 ? all[index] : undefined
  return item === undefined ? undefined : { all, index, item }
}

/** Classified result of one advisory batch, with candidate rows left to their owner. */
export interface AdvisoryResolution {
  readonly resolvedCount: number
  readonly candidateIds: readonly string[]
}

/** Replace the durable review array atomically after an in-memory batch update. */
function writeReviewItemsAtomically(reviewFile: string, items: WikiReviewItem[]): void {
  atomicWriteFile(reviewFile, `${JSON.stringify(items, null, 2)}\n`)
}

function knowledgeEventPath(reviewFile: string): string {
  return join(dirname(reviewFile), 'knowledge-events.jsonl')
}

/** Bind source provenance to bytes when the source is inside the project. */
function sourceHashForCandidate(projectRoot: string, sourcePath: string | undefined): string {
  if (sourcePath === undefined || sourcePath.trim() === '') return createHash('sha256').update('unknown-source').digest('hex')
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
function appendKnowledgeLifecycleEvent(
  reviewFile: string,
  type: Parameters<typeof createKnowledgeEvent>[0],
  item: WikiReviewItem,
  payload: Readonly<Record<string, unknown>> = {},
  authority?: KnowledgeWikiVerifierAuthority,
): void {
  if (!item.candidatePath || !item.candidateHash) return
  const scope = { projectId: dirname(dirname(reviewFile)), visibility: 'project' as const }
  const id = `candidate:${item.id}`
  const prior = readKnowledgeEventLog(knowledgeEventPath(reviewFile))
  let eventPayload: Readonly<Record<string, unknown>> = {
    ...payload,
    candidatePath: item.candidatePath,
    candidateHash: item.candidateHash,
    source: item.sourcePath ?? item.candidatePath,
  }
  if (type === 'knowledge/verified') {
    if (authority === undefined) throw new Error('knowledge verification event lacks authority')
    const seal = authority.sealPromotion(canonicalJson({ type, knowledgeId: id, payload: eventPayload }))
    eventPayload = { ...eventPayload, authorityId: authority.authorityId, authoritySeal: seal }
  }
  const event = createKnowledgeEvent(type, id, scope, eventPayload, {
    seq: prior.length,
    previousEventHash: prior.at(-1)?.eventHash ?? null,
    sourceHash: item.sourceHash ?? knowledgeSha256(item.sourcePath ?? item.candidatePath),
  })
  appendKnowledgeEvent(knowledgeEventPath(reviewFile), event)
}

function appendKnowledgeReviewEvent(
  reviewFile: string,
  type: Parameters<typeof createKnowledgeEvent>[0],
  reviewId: string,
  candidateHash: string,
  payload: Readonly<Record<string, unknown>> = {},
  authority?: KnowledgeWikiVerifierAuthority,
): void {
  const path = knowledgeEventPath(reviewFile)
  const prior = readKnowledgeEventLog(path)
  if (prior.some(event => event.type === type && event.knowledgeId === `candidate:${reviewId}`
    && event.payload.candidateHash === candidateHash)) {
    syncRegularFile(path)
    syncDirectory(dirname(path))
    return
  }
  const scope = { projectId: dirname(dirname(reviewFile)), visibility: 'project' as const }
  let eventPayload: Readonly<Record<string, unknown>> = {
    ...payload,
    candidateHash,
  }
  if (type === 'knowledge/promoted') {
    if (authority === undefined) throw new Error('knowledge promotion event lacks authority')
    const id = `candidate:${reviewId}`
    const seal = authority.sealPromotion(canonicalJson({ type, knowledgeId: id, payload: eventPayload }))
    eventPayload = { ...eventPayload, authorityId: authority.authorityId, authoritySeal: seal }
  }
  const event = createKnowledgeEvent(type, `candidate:${reviewId}`, scope, eventPayload, { seq: prior.length, previousEventHash: prior.at(-1)?.eventHash ?? null })
  appendKnowledgeEvent(path, event)
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
    return readRegularFileBounded(path, 8 * 1024 * 1024).toString('utf8')
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

type PromotionPathRole = 'candidate' | 'candidate-archive' | 'canonical' | 'canonical-archive' | 'review' | 'governance'

interface PromotionOperation {
  readonly role: PromotionPathRole
  readonly path: string
  readonly before?: string
  readonly after?: string
  readonly stagingPath?: string
  readonly tombstonePath?: string
}

/**
 * Derive the existing sibling staging/tombstone names for one transaction operation.
 * @param transactionId - Fixed transaction identity.
 * @param index - Operation's zero-based tuple position.
 * @param role - Existing operation path role.
 * @param path - Exact final operation path.
 * @param before - Captured previous bytes, or absence.
 * @param after - Captured resulting bytes, or deletion.
 * @returns Original v1 operation shape with its deterministic auxiliary path.
 */
export function promotionOperation(
  transactionId: string,
  index: number,
  role: PromotionPathRole,
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

interface PromotionJournalCore {
  readonly schemaVersion: 1
  readonly id: string
  readonly reviewId: string
  readonly candidateHash: string
  readonly createdAt: string
  readonly action: string
  readonly targetPath: string | null
  readonly reviewHash: string | null
  readonly receiptId: string | null
  readonly receiptHash: string | null
  readonly operationSetHash: string
  readonly operations: PromotionOperation[]
}

interface PromotionJournal extends PromotionJournalCore {
  readonly state: 'prepared' | 'committed' | 'rolled-back'
  readonly seal: VerificationAuthoritySeal
}

function promotionJournalDirectory(reviewFile: string): string {
  return join(dirname(reviewFile), 'promotion-journal')
}

function promotionJournalPath(reviewFile: string, id: string): string {
  return join(promotionJournalDirectory(reviewFile), `${id}.json`)
}

/**
 * Check an operation's existing role root and sibling auxiliary parents.
 * @param operation - Operation to check without mutation.
 * @param reviewFile - Owned review file selecting metadata's root.
 * @param wikiRoot - Owned Wiki root for candidate and canonical operations.
 * @param archiveRoot - Owned archive root for archive operations.
 * @throws On a path outside its role root or an auxiliary with a different parent.
 */
export function assertPromotionOperationConfined(
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

/**
 * Derive the archive path shared by existing review production and historical proof checks.
 * @param archiveRoot - Actual archive owner root.
 * @param projectRoot - Actual project root whose basename appears in the path.
 * @param createdAt - Fixed transaction audit time; only its UTC day is used.
 * @param contentHash - Exact archived content hash.
 * @param relativePath - Confined candidate or canonical path relative to the Wiki root.
 * @param kind - Candidate archive or the existing canonical pre-update subdirectory.
 * @returns The original archive path formula, without creating a directory or file.
 */
export function governanceArchivePath(
  archiveRoot: string,
  projectRoot: string,
  createdAt: string,
  contentHash: string,
  relativePath: string,
  kind: 'candidate' | 'canonical-before-update',
): string {
  return join(
    archiveRoot, 'wiki-governance', createdAt.slice(0, 10), basename(projectRoot), contentHash.slice(0, 12),
    ...(kind === 'canonical-before-update' ? ['canonical-before-update'] : []), relativePath,
  )
}

/**
 * Derive the existing immutable transaction ID from review, candidate and audit time.
 * @param reviewId - Original review identity.
 * @param candidateHash - Exact original candidate byte hash.
 * @param createdAt - Fixed transaction audit timestamp.
 * @returns Original promotion ID; it supplies no proof or write authority.
 */
export function promotionTransactionId(reviewId: string, candidateHash: string, createdAt: string): string {
  return `promotion-${createHash('sha256').update(`${reviewId}\0${candidateHash}\0${Date.parse(createdAt)}`).digest('hex').slice(0, 24)}`
}

function writePromotionStage(path: string, content: string): void {
  if (pathEntryExists(path)) {
    if (readOptionalText(path, 8 * 1024 * 1024) !== content) throw new Error(`promotion stage conflict at ${path}`)
    syncRegularFile(path)
    syncDirectory(dirname(path))
    return
  }
  ensureAbsoluteDirectory(dirname(path))
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  syncDirectory(dirname(path))
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
      if (moved === undefined) {
        syncDirectory(dirname(operation.path))
        return
      }
      if (moved !== operation.before) throw new Error(`promotion tombstone conflict at ${tombstone}`)
      unlinkSync(tombstone)
      checkpoint?.('tombstone-unlinked')
      syncDirectory(dirname(operation.path))
      return
    }
    if (current !== operation.before) throw new Error(`promotion recovery conflict at ${operation.path}`)
    if (pathEntryExists(tombstone)) throw new Error(`promotion tombstone already exists: ${tombstone}`)
    renameSync(operation.path, tombstone)
    checkpoint?.('entry-renamed')
    syncDirectory(dirname(operation.path))
    if (readOptionalText(tombstone, 8 * 1024 * 1024) !== operation.before) {
      throw new Error(`promotion tombstone identity changed: ${tombstone}`)
    }
    unlinkSync(tombstone)
    checkpoint?.('tombstone-unlinked')
    syncDirectory(dirname(operation.path))
    return
  }
  if (current === operation.after) {
    syncRegularFile(operation.path)
    syncDirectory(dirname(operation.path))
    return
  }
  if (current !== operation.before) throw new Error(`promotion recovery conflict at ${operation.path}`)
  const staging = operation.stagingPath
  if (staging === undefined) throw new Error('promotion write lacks a staging path')
  writePromotionStage(staging, operation.after)
  checkpoint?.('stage-written')
  const revalidated = readOptionalText(operation.path, 8 * 1024 * 1024)
  if (revalidated !== operation.before) throw new Error(`promotion target changed before rename: ${operation.path}`)
  renameSync(staging, operation.path)
  checkpoint?.('entry-renamed')
  syncDirectory(dirname(operation.path))
}

function rollbackPromotionOperation(operation: PromotionOperation): void {
  if (operation.tombstonePath !== undefined) {
    const tombstone = readOptionalText(operation.tombstonePath, 8 * 1024 * 1024)
    if (tombstone !== undefined) {
      if (tombstone !== operation.before || pathEntryExists(operation.path)) {
        throw new Error(`promotion rollback tombstone conflict at ${operation.tombstonePath}`)
      }
      renameSync(operation.tombstonePath, operation.path)
      syncDirectory(dirname(operation.path))
    }
  }
  const current = readOptionalText(operation.path, 8 * 1024 * 1024)
  // before === undefined marks an archive-create operation, which always
  // stages its content (see promotionOperation), so stagingPath is defined.
  if (operation.before === undefined) {
    if (current === undefined) {
      durableUnlinkFile(operation.stagingPath as string)
      syncDirectory(dirname(operation.path))
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
    syncRegularFile(operation.path)
    syncDirectory(dirname(operation.path))
    return
  }
  if (current !== operation.after) {
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

/** Recover the original Archive/Skip disposition from the sealed append operation. */
function archiveReviewEventPayload(journal: PromotionJournalCore): {
  readonly action: 'Archive' | 'Skip'
  readonly appliedPath: string
  readonly lifecycle: 'downgraded'
} {
  const governance = journal.operations.find(operation => operation.role === 'governance')
  const archived = journal.operations.find(operation => operation.role === 'candidate-archive')
  const before = governance?.before ?? ''
  if (governance?.after === undefined || !governance.after.startsWith(before) || archived === undefined) {
    throw new Error('Archive journal lifecycle binding failed')
  }
  const entry: unknown = JSON.parse(governance.after.slice(before.length))
  if (typeof entry !== 'object' || entry === null
    || (Reflect.get(entry, 'action') !== 'Archive' && Reflect.get(entry, 'action') !== 'Skip')
    || Reflect.get(entry, 'reviewId') !== journal.reviewId
    || Reflect.get(entry, 'candidateHash') !== journal.candidateHash
    || Reflect.get(entry, 'outcome') !== 'applied'
    || Reflect.get(entry, 'appliedPath') !== archived.path) {
    throw new Error('Archive journal lifecycle binding failed')
  }
  return { action: Reflect.get(entry, 'action') as 'Archive' | 'Skip', appliedPath: archived.path, lifecycle: 'downgraded' }
}

function revalidateJournalBeforeMutation(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reviewFile: string,
  wikiRoot: string,
  journal: PromotionJournal,
): void {
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
  if (journal.action !== 'Archive') {
    if (journal.receiptId === null || journal.receiptHash === null || journal.reviewHash === null
      || !['Promote', 'Merge', 'Replace', 'Deduplicate'].includes(journal.action)) {
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
    throw new Error('canonical promotion requires independently measured trial evidence')
  }
  if (journal.operations.some(operation => operation.role === 'canonical' || operation.role === 'canonical-archive')) {
    throw new Error('canonical promotion requires independently measured trial evidence')
  }
  const roles: PromotionPathRole[] = ['candidate-archive', 'review', 'governance', 'candidate']
  const archived = journal.operations[0]
  const governance = journal.operations[2]
  const candidate = typeof item.candidatePath === 'string' ? resolveGovernedWikiPath(wikiRoot, item.candidatePath, true) : undefined
  if (journal.operations.length !== roles.length || journal.operations.some((operation, index) => operation.role !== roles[index])
    || candidate === undefined || !candidate.relativePath.startsWith('_candidates/')
    || candidateOperation.path !== candidate.absolutePath || candidateOperation.after !== undefined
    || reviewOperation.path !== reviewFile || reviewOperation.after === undefined
    || governance?.path !== join(dirname(reviewFile), 'governance.jsonl')
    || archived?.before !== undefined || archived?.after !== candidateOperation.before
    || new Set(journal.operations.map(operation => resolve(operation.path))).size !== roles.length) {
    throw new Error('Archive journal operation identity mismatch')
  }
  const disposition = archiveReviewEventPayload(journal)
  const expectedReviews = reviews.map((value: unknown) => value === item ? {
    ...item, resolved: true, resolvedAction: 'Archive', appliedPath: disposition.appliedPath, resolvedAt: Date.parse(journal.createdAt),
  } : value)
  if (canonicalJson(JSON.parse(reviewOperation.after) as unknown) !== canonicalJson(expectedReviews)) {
    throw new Error('Archive journal resolved review binding failed')
  }
  for (const [index, operation] of journal.operations.entries()) {
    if (operation.after === undefined && operation.tombstonePath === undefined) throw new Error('promotion delete lacks a tombstone path')
    if (operation.after !== undefined && operation.stagingPath === undefined) throw new Error('promotion write lacks a staging path')
    for (const auxiliary of [operation.stagingPath, operation.tombstonePath]) {
      if (auxiliary !== undefined && dirname(auxiliary) !== dirname(operation.path)) {
        throw new Error('promotion auxiliary path changed parent')
      }
    }
    const expected = promotionOperation(journal.id, index, operation.role, operation.path, operation.before, operation.after)
    if (operation.stagingPath !== expected.stagingPath || operation.tombstonePath !== expected.tombstonePath) {
      throw new Error('Archive journal auxiliary identity mismatch')
    }
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
}

function commitPromotionJournal(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reviewFile: string,
  wikiRoot: string,
  archiveRoot: string,
  journal: PromotionJournal,
): void {
  revalidateJournalBeforeMutation(authority, reviewFile, wikiRoot, journal)
  for (const operation of journal.operations) assertPromotionOperationConfined(operation, reviewFile, wikiRoot, archiveRoot)
  ensureConfinedDirectory(dirname(reviewFile), 'promotion-journal')
  const path = promotionJournalPath(reviewFile, journal.id)
  atomicWriteFile(path, `${JSON.stringify(journal, null, 2)}\n`)
  authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
    phase: 'journal-persisted',
    operationIndex: -1,
  })
  const applied: PromotionOperation[] = []
  let attempted = 0
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
    for (const operation of journal.operations) {
      const current = readOptionalText(operation.path, 8 * 1024 * 1024)
      if (current !== operation.after) throw new Error(`promotion post-commit mismatch at ${operation.path}`)
    }
    authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
      phase: 'before-commit-marker',
      operationIndex: journal.operations.length,
    })
    atomicWriteFile(path, `${JSON.stringify({ ...journal, state: 'committed' }, null, 2)}\n`)
  } catch (error) {
    const rollbackErrors: unknown[] = []
    const rollbackOperations = journal.operations.slice(0, Math.max(applied.length, attempted)).reverse()
    for (const operation of rollbackOperations) {
      try { rollbackPromotionOperation(operation) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    }
    if (rollbackErrors.length === 0) {
      try {
        atomicWriteFile(path, `${JSON.stringify({ ...journal, state: 'rolled-back' }, null, 2)}\n`)
      } catch (markerError) {
        throw new AggregateError([error, markerError], 'candidate review transaction failed and rollback marker was not durable')
      }
      try {
        appendKnowledgeReviewEvent(reviewFile, 'knowledge/rolled_back', journal.reviewId, journal.candidateHash, {
          lifecycle: 'rolled_back',
          transactionId: journal.id,
        }, authority)
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
 * Finish prepared Archive transactions and repair missing committed Archive lifecycle events after a crash.
 * Canonical actions lack measured-trial authority.
 * @param authority - Trusted verifier that revalidates the journal before mutation.
 * @param reviewFile - Review file whose sibling directory owns promotion journals.
 * @param wikiRoot - Canonical Wiki root used to confine Candidate and target paths.
 * @param archiveRoot - Archive root used to confine archived Candidate paths.
 * @returns Number of prepared journals completed and marked committed.
 */
export function recoverCandidateReviewTransactions(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reviewFile: string,
  wikiRoot: string,
  archiveRoot: string,
): number {
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
    const path = join(directory, name)
    const raw: unknown = JSON.parse(readRegularFileBounded(path, 8 * 1024 * 1024).toString('utf8'))
    if (typeof raw !== 'object' || raw === null || Reflect.get(raw, 'schemaVersion') !== 1) continue
    const journal = raw as PromotionJournal
    if (!/^[A-Za-z0-9._:-]+$/u.test(journal.id) || !Array.isArray(journal.operations)) continue
    if (journal.state === 'committed' && journal.action === 'Archive') {
      const eventPath = knowledgeEventPath(reviewFile)
      const events = readKnowledgeEventLog(eventPath)
      if (events.some(event => event.type === 'knowledge/rejected' && event.knowledgeId === `candidate:${journal.reviewId}`
        && event.payload.candidateHash === journal.candidateHash)) {
        syncRegularFile(path)
        syncDirectory(dirname(path))
        syncRegularFile(eventPath)
        syncDirectory(dirname(eventPath))
        continue
      }
    } else if (journal.state === 'rolled-back') {
      syncRegularFile(path)
      syncDirectory(dirname(path))
      continue
    } else if (journal.state !== 'prepared') continue
    revalidateJournalBeforeMutation(authority, reviewFile, wikiRoot, journal)
    for (const operation of journal.operations) assertPromotionOperationConfined(operation, reviewFile, wikiRoot, archiveRoot)
    if (journal.state === 'prepared') {
      for (const operation of journal.operations) applyPromotionOperation(operation)
    }
    // Journal state is not sealed. A committed marker alone cannot attest that
    // every operation reached its post-state before a terminal event is emitted.
    for (const operation of journal.operations) {
      if (readOptionalText(operation.path, 8 * 1024 * 1024) !== operation.after) {
        throw new Error(`promotion post-commit mismatch at ${operation.path}`)
      }
      if (operation.after !== undefined) syncRegularFile(operation.path)
      syncDirectory(dirname(operation.path))
    }
    syncRegularFile(path)
    syncDirectory(dirname(path))
    if (journal.state === 'prepared') {
      atomicWriteFile(path, `${JSON.stringify({ ...journal, state: 'committed' }, null, 2)}\n`)
      recovered += 1
    }
    if (journal.action === 'Archive') {
      appendKnowledgeReviewEvent(
        reviewFile, 'knowledge/rejected', journal.reviewId, journal.candidateHash, archiveReviewEventPayload(journal), authority,
      )
    }
    if (journal.action === 'Promote' || journal.action === 'Merge' || journal.action === 'Replace' || journal.action === 'Deduplicate') {
      try {
        const canonical = journal.operations.find(operation => operation.role === 'canonical')
        if (canonical?.after === undefined) throw new Error('promotion journal lacks canonical bytes')
        appendKnowledgeReviewEvent(reviewFile, 'knowledge/promoted', journal.reviewId, journal.candidateHash, {
          action: journal.action,
          lifecycle: 'canonical',
          contentHash: sha256(canonical.after),
          ...(journal.targetPath === null ? {} : { appliedPath: journal.targetPath }),
        }, authority)
      } catch {
        // The committed promotion WAL remains the recovery authority.
      }
    }
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
  const all = loadReviewItems(reviewFile)
  if (all === undefined) return { resolvedCount: 0, candidateIds: [] }
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

function readReviewItems(reviewFile: string): WikiReviewItem[] {
  try {
    const parsed = JSON.parse(readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString('utf8')) as unknown
    if (!Array.isArray(parsed) || !parsed.every(isReviewItem)) throw new Error('invalid knowledge review state')
    return parsed
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    return []
  }
}

/**
 * Append reviews to the review file, deduped by deterministic id. The file
 * is an append-only JSON array; a malformed existing file is rebuilt with
 * only the new reviews (the unparseable content is already unreadable).
 * @param reviewFile - absolute path of `.llm-wiki/review.json`.
 * @param sourcePath - absolute path of the source that produced the reviews.
 * @param reviews - parsed reviews to persist.
 * @returns how many reviews were newly appended.
 */
export function appendReviews(reviewFile: string, sourcePath: string, reviews: ParsedReview[]): number {
  if (reviews.length === 0) return 0
  const existing = readReviewItems(reviewFile)
  const now = Date.now()
  const byId = new Map(existing.map(item => [item.id, item]))
  let appended = 0
  for (const review of reviews) {
    const id = reviewId(review)
    if (byId.has(id)) continue
    byId.set(id, {
      id,
      title: review.title,
      type: review.type,
      ...(review.description === '' ? {} : { description: review.description }),
      sourcePath,
      affectedPages: review.affectedPages,
      options: [
        { action: 'Skip', label: 'Skip' },
      ],
      reviewKind: 'advisory',
      resolved: false,
      createdAt: now,
      searchQueries: review.searchQueries,
    } satisfies WikiReviewItem)
    appended += 1
  }
  writeReviewItemsAtomically(reviewFile, [...byId.values()])
  return appended
}

/**
 * Register each candidate path/content revision once, retaining earlier review decisions.
 * @param reviewFile - The review file input.
 * @param projectRoot - The project root input.
 * @param sourcePath - The source path input.
 * @param writtenPaths - The written paths input.
 * @returns The value produced by append candidate reviews.
 */
export function appendCandidateReviews(
  reviewFile: string,
  projectRoot: string,
  sourcePath: string,
  writtenPaths: string[],
): number {
  const existing = readReviewItems(reviewFile)
  const byId = new Map(existing.map(item => [item.id, item]))
  const observed: Array<{ item: WikiReviewItem; content: string }> = []
  let changed = 0
  for (const writtenPath of writtenPaths) {
    const candidate = resolveCandidateReviewPath(join(projectRoot, 'wiki'), writtenPath.replace(/^wiki\//u, ''))
    if (candidate === undefined) continue
    const candidatePath = candidate.relativePath
    const content = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString('utf8')
    const candidateHash = createHash('sha256').update(content).digest('hex')
    if ([...byId.values()].some(item => item.reviewKind === 'candidate'
      && item.candidatePath === candidatePath && item.candidateHash === candidateHash)) continue
    const id = `candidate-${sha256(`${candidatePath}\0${candidateHash}`)}`
    const title = (/^title:\s*(.+)$/mu.exec(content)?.[1] ?? basename(candidatePath, '.md'))
      .trim()
      .replace(/^["']|["']$/gu, '')
    const suggestedTarget = canonicalTarget(candidatePath)
    const governance = decideCandidateGovernance(join(projectRoot, 'wiki'), candidatePath, content, suggestedTarget)
    const targetPath = governance.targetPath
    const nextItem: WikiReviewItem = {
      id,
      title,
      type: 'candidate-approval',
      description: `候选：${candidatePath}${targetPath ? ` → ${targetPath}` : '（自治隔离）'}；自治决定：${governance.action}；置信度：${governance.confidence.toFixed(2)}；评分：${governance.score}/10；${governance.reasons.join('；')}`,
      sourcePath,
      affectedPages: [candidatePath],
      options: [{ action: 'Archive', label: '归档候选' }],
      resolved: false,
      createdAt: Date.now(),
      reviewKind: 'candidate',
      candidatePath,
      candidateHash,
      sourceHash: sourceHashForCandidate(projectRoot, sourcePath),
      verification: {
        status: 'pending',
        candidateHash,
        methods: [],
        evidence: [],
        receipts: [],
        confidence: 0,
        successCount: 0,
        failureCount: 0,
      },
      ...(targetPath ? { targetPath } : {}),
    }
    byId.set(id, nextItem)
    observed.push({ item: nextItem, content })
    changed += 1
  }
  if (changed > 0) {
    writeReviewItemsAtomically(reviewFile, [...byId.values()])
    for (const { item, content } of observed) {
      const record = createKnowledgeRecord({
        id: `candidate:${item.id}`,
        content,
        claimKey: item.title.trim().toLocaleLowerCase(),
        // Keep the durable item address in `source`; original provenance stays
        // in the review/sourcePath and evidence refs.
        source: item.candidatePath ?? item.id,
        evidenceRefs: [item.sourcePath ?? item.candidatePath ?? item.id],
        // `candidateHash` binds the mutable candidate bytes. `sourceHash`
        // identifies provenance and intentionally hashes the source identity
        // separately, so an edited candidate cannot masquerade as source data.
        sourceHash: item.sourceHash ?? knowledgeSha256(item.sourcePath ?? item.candidatePath ?? item.id),
        scope: { projectId: projectRoot, visibility: 'project' },
        createdAt: new Date(item.createdAt ?? Date.now()).toISOString(),
        expiresAt: new Date((item.createdAt ?? Date.now()) + 30 * 86_400_000).toISOString(),
        lifecycle: 'candidate',
      })
      appendKnowledgeLifecycleEvent(reviewFile, 'knowledge/observed', item, { record })
      appendKnowledgeLifecycleEvent(reviewFile, 'knowledge/candidate', item, { record })
    }
    // Once all new candidates are in the log, identify divergent claims in
    // the same scope. Conflict events make both records non-injectable until
    // an explicit review resolves the ambiguity.
    const state = replayKnowledgeEvents(readKnowledgeEventLog(knowledgeEventPath(reviewFile)))
    for (const record of state.records.values()) {
      const conflicts = detectKnowledgeConflicts(record, state.records.values())
      if (conflicts.length === 0) continue
      const review = [...byId.values()].find(item => item.id === record.id.replace(/^candidate:/u, ''))
      if (review === undefined || review.candidateHash === undefined) continue
      appendKnowledgeReviewEvent(reviewFile, 'knowledge/conflict', review.id, review.candidateHash, { conflictIds: conflicts })
    }
  }
  return changed
}

/**
 * Record independent, hash-bound verification without changing Candidate or Canonical files.
 * @param authority - Trusted verifier used to authenticate and bind the receipt.
 * @param reviewFile - The review file input.
 * @param wikiRoot - The wiki root input.
 * @param reviewIdValue - The review id value input.
 * @param receiptId - Receipt id created by the trusted verifier owner.
 * @param action - Governance action that the receipt must authenticate.
 * @returns The value produced by record candidate verification.
 */
export function recordCandidateVerification(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reviewFile: string,
  wikiRoot: string,
  reviewIdValue: string,
  receiptId: unknown,
  action: CandidateVerification['action'],
): boolean {
  if (typeof receiptId !== 'string' || action === undefined) return false
  const loaded = loadReviewItem(reviewFile, reviewIdValue)
  if (loaded === undefined) return false
  const { all, index, item } = loaded
  if (item.reviewKind !== 'candidate' || item.resolved || !item.candidatePath || !item.candidateHash) return false
  const candidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath)
  if (candidate === undefined) return false
  const actualHash = createHash('sha256')
    .update(readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024))
    .digest('hex')
  if (actualHash !== item.candidateHash) return false
  const governedEvents = readKnowledgeEventLog(knowledgeEventPath(reviewFile))
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
  const nextVerification = trusted.verification
  // Semantic checks do not measure actual reuse or utility. A passing receipt
  // cannot authorize a canonical action until independent trial evidence exists.
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
  const createdAt = new Date(item.createdAt ?? Date.now()).toISOString()
  const fallbackRecord = createKnowledgeRecord({
    id: `candidate:${item.id}`,
    content: readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString('utf8'),
    claimKey: item.title.trim().toLocaleLowerCase(),
    source: item.candidatePath,
    sourceHash: item.sourceHash ?? knowledgeSha256(item.sourcePath ?? item.candidatePath),
    contentHash: actualHash,
    scope: { projectId: dirname(dirname(reviewFile)), visibility: 'project' },
    evidenceRefs: [item.sourcePath ?? item.candidatePath],
    verificationStatus: 'candidate',
    confidence: 0,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 30 * 86_400_000).toISOString(),
    lifecycle: 'candidate',
  })
  appendKnowledgeLifecycleEvent(reviewFile, 'knowledge/verified', item, {
    record: fallbackRecord,
    verificationStatus: 'verified',
    trust: 'medium',
    authority: nextVerification.authorityId ?? 'independent-verifier',
    confidence: nextVerification.confidence,
    lastVerifiedAt: nextVerification.lastVerifiedAt ?? new Date().toISOString(),
    evidenceRefs: nextVerification.receipts.map(receipt => receipt.id),
  }, authority)
  return true
}

/**
 * Apply Archive or Skip to a hash-bound candidate; canonical actions require unavailable measured-trial evidence.
 * Null means this is an advisory item.
 * @param authority - Trusted verifier that authenticates the bound receipt and promotion journal.
 * @param reviewFile - The review file input.
 * @param projectRoot - The project root input.
 * @param wikiRoot - The wiki root input.
 * @param archiveRoot - The archive root input.
 * @param reviewIdValue - The review id value input.
 * @param action - The action input.
 * @param actor - The actor input.
 * @returns The value produced by apply candidate review.
 */
export function applyCandidateReview(
  authority: KnowledgeWikiVerifierAuthority | undefined,
  reviewFile: string,
  projectRoot: string,
  wikiRoot: string,
  archiveRoot: string,
  reviewIdValue: string,
  action: string,
  actor = 'human',
): boolean | null {
  if (authority === undefined) return false
  const loaded = loadReviewItem(reviewFile, reviewIdValue)
  if (loaded === undefined) return false
  const { all, index, item } = loaded
  if (item.reviewKind !== 'candidate') return null
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
  const governed = replayKnowledgeEvents(governedEvents).records.get(`candidate:${item.id}`)
  if (governed !== undefined) {
    const decision = knowledgeInjectionDecision(governed, {
      projectId: projectRoot,
      workspaceId: projectRoot,
    })
    if (decision.reason === 'expired' || decision.reason === 'conflict' || decision.reason === 'scope-denied' || decision.reason === 'acl-denied') return false
  }

  const canonicalActions = new Set(['Promote', 'Merge', 'Replace', 'Deduplicate'])
  let verifiedReceipt: TrustedVerificationReceipt | undefined
  if (canonicalActions.has(action)) {
    const verification = item.verification
    if (actor === 'governance-agent') return false
    if (!verification || verification.status !== 'passed' || verification.candidateHash !== actualHash) return false
    if (verification.action !== action) return false
    const receiptId = verification.receipts.length === 1 ? verification.receipts[0]?.id : undefined
    if (receiptId === undefined) return false
    const trusted = readTrustedVerification(
      authority,
      reviewFile,
      wikiRoot,
      item,
      receiptId,
      action,
    )
    if (trusted === undefined
      || trusted.verification.receipts[0]?.receiptHash !== verification.receipts[0]?.receiptHash) return false
    verifiedReceipt = trusted.receipt
  }
  // The current receipt authenticates semantic checks, not a measured trial.
  // Legacy trial mirrors cannot authorize any canonical write.
  if (canonicalActions.has(action)) return false

  const now = new Date()
  const reviewedAt = now.toISOString()
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
    previousCanonicalHash = canonicalHash
    archivedCanonicalContent = canonicalBefore
    archivedCanonical = governanceArchivePath(
      archiveRoot, projectRoot, reviewedAt, canonicalHash, target.relativePath, 'canonical-before-update',
    )
    targetBefore = canonicalBefore
    targetAfter = prepareCanonicalTarget({
      action, candidateContent: content, targetPath: target.relativePath,
      targetBefore: canonicalBefore, reviewedAt, actor,
    })
    targetAbsolutePath = target.absolutePath
    targetPath = target.relativePath
    appliedPath = target.relativePath
  } else if (action === 'Promote') {
    const target = resolveCanonicalReviewPath(wikiRoot, item.targetPath as string, true)
    if (target === undefined || pathEntryExists(target.absolutePath)) return false
    targetAfter = prepareCanonicalTarget({
      action, candidateContent: content, targetPath: target.relativePath,
      targetBefore: undefined, reviewedAt, actor,
    })
    targetAbsolutePath = target.absolutePath
    targetPath = target.relativePath
    appliedPath = target.relativePath
  } else if (action !== 'Archive' && action !== 'Skip') {
    return false
  }

  const archived = governanceArchivePath(archiveRoot, projectRoot, reviewedAt, actualHash, candidate.relativePath, 'candidate')
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
    timestamp: reviewedAt,
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
  const revalidatedCandidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath)
  if (revalidatedCandidate === undefined || revalidatedCandidate.absolutePath !== candidate.absolutePath) {
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

  const transactionId = promotionTransactionId(reviewIdValue, actualHash, reviewedAt)
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
    createdAt: reviewedAt,
    action: canonicalActions.has(action) ? action : 'Archive',
    targetPath: item.targetPath ?? null,
    reviewHash: verifiedReceipt?.request.reviewHash ?? null,
    receiptId: verifiedReceipt?.id ?? null,
    receiptHash: verifiedReceipt?.receiptHash ?? null,
    operationSetHash: sha256(canonicalJson(operations)),
    operations,
  }
  const seal = authority.sealPromotion(canonicalJson(core))
  if (seal.authorityId !== authority.authorityId || seal.proof === '') return false
  commitPromotionJournal(authority, reviewFile, wikiRoot, archiveRoot, {
    ...core,
    state: 'prepared',
    seal,
  })
  appendKnowledgeReviewEvent(
    reviewFile,
    canonicalActions.has(action) ? 'knowledge/promoted' : 'knowledge/rejected',
    item.id,
    actualHash,
    canonicalActions.has(action) ? {
      action, appliedPath, lifecycle: canonicalActions.has(action) ? 'canonical' : 'downgraded',
      ...(targetAfter === undefined ? {} : { contentHash: sha256(targetAfter) }),
    } : archiveReviewEventPayload(core),
    authority,
  )
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
