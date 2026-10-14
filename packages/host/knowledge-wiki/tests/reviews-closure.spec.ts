import {
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendCandidateReviews,
  applyCandidateReview as applyCandidateReviewWithAuthority,
  recoverCandidateReviewTransactions,
  recordCandidateMeasuredTrial,
  recordCandidateVerification as recordCandidateVerificationWithAuthority,
} from '../src/reviews.ts'
import {
  canonicalJson,
  immutableReviewRow,
  readTrustedReceipt,
  sha256,
  type KnowledgeWikiVerifierAuthority,
  type KnowledgeWikiPromotionSealRequest,
  type PromotionJournalSigningPayload,
  type PromotionCheckpoint,
  type VerificationAuthoritySeal,
} from '../src/verifier.ts'
import type { WikiReviewItem } from '../src/types.ts'
import type { KnowledgeWikiMeasuredTrialReader, VerifiedMeasuredTrial } from '../src/measured-trial.ts'
import { appendKnowledgeEvent, createKnowledgeEvent, readKnowledgeEventLog } from '../src/knowledge-governance.ts'
import { issueTestReceipt, verifierAuthority } from './verifier-authority-fixture.ts'

// Directory-fsync fault injection: a real Windows runner cannot fsync directory
// handles (EPERM), and a damaged one can fail with other errno codes. The fault
// is inert unless a test activates it.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const fsFault = vi.hoisted(() => ({
  readdirFailurePath: undefined as string | undefined,
  readdirFailureCalls: 0,
  mode: 'none' as 'none' | 'eperm' | 'eio',
  fileOncePath: undefined as string | undefined,
  fileOnceFlags: undefined as number | undefined,
  replaceBeforeOpenPath: undefined as string | undefined,
  replaceAfterFileSyncPath: undefined as string | undefined,
  growBeforeReadPath: undefined as string | undefined,
  replacementContent: undefined as string | undefined,
  directoryFailureCountdown: undefined as number | undefined,
  appendEventAtDirectorySync: undefined as { directory: string; path: string; line: string } | undefined,
  precisionChange: undefined as { path: string; operation: 'open' | 'read' | 'sync'; metadata: { ino?: bigint; mtimeNs?: bigint } } | undefined,
}))
const directoryFds = vi.hoisted(() => new Set<number>())
const directoryFdPaths = vi.hoisted(() => new Map<number, string>())
const fileFdPaths = vi.hoisted(() => new Map<number, string>())
const fileFdFlags = vi.hoisted(() => new Map<number, number>())
const namedInodeChanges = vi.hoisted(() => new Set<string>())
const preciseStageMetadata = vi.hoisted(() => new Map<string, { ino?: bigint; mtimeNs?: bigint }>())
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  function observed<T extends ReturnType<typeof actual.fstatSync>>(stat: T, path: string): T {
    const metadata = preciseStageMetadata.get(path)
    if (metadata === undefined) return stat
    const values: { ino?: number | bigint; mtimeNs?: bigint; mtimeMs?: number | bigint } = {}
    if (metadata.ino !== undefined) values.ino = typeof stat.ino === 'bigint' ? metadata.ino : Number(metadata.ino)
    if (metadata.mtimeNs !== undefined) {
      if (typeof stat.ino === 'bigint') { values.mtimeNs = metadata.mtimeNs; values.mtimeMs = metadata.mtimeNs / 1_000_000n }
      else values.mtimeMs = Number(metadata.mtimeNs) / 1_000_000
    }
    return Object.assign(Object.create(stat), values) as T
  }
  function changePrecision(operation: 'open' | 'read' | 'sync', path: string | undefined): void {
    const change = fsFault.precisionChange
    if (change?.operation !== operation || change.path !== path) return
    fsFault.precisionChange = undefined
    preciseStageMetadata.set(change.path, change.metadata)
  }
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const found = actual.lstatSync(...args)
      const stat = found === undefined ? found : observed(found, String(args[0]))
      if (stat === undefined) return stat
      return namedInodeChanges.has(String(args[0]))
        ? Object.assign(Object.create(stat) as typeof stat, { ino: typeof stat.ino === 'bigint' ? stat.ino + 1n : stat.ino + 1 })
        : stat
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => observed(actual.fstatSync(...args), fileFdPaths.get(args[0]) ?? ''),
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      actual.renameSync(...args)
      const originalPath = String(args[0]), nextPath = String(args[1])
      const metadata = preciseStageMetadata.get(originalPath)
      if (metadata !== undefined) {
        // Inode metadata follows the real rename into the rollback tombstone.
        preciseStageMetadata.delete(originalPath)
        preciseStageMetadata.set(nextPath, metadata)
      }
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (String(args[0]) === fsFault.readdirFailurePath) {
        fsFault.readdirFailureCalls += 1
        throw Object.assign(new Error('EACCES: promotion journal directory unavailable'), { code: 'EACCES' })
      }
      return actual.readdirSync(...args)
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const requestedPath = String(args[0])
      changePrecision('open', requestedPath)
      if (fsFault.replaceBeforeOpenPath === requestedPath) {
        fsFault.replaceBeforeOpenPath = undefined
        // Keep the old inode allocated until its replacement exists (Linux may reuse it).
        const retained = `${requestedPath}.replaced-inode`
        actual.renameSync(requestedPath, retained)
        actual.writeFileSync(requestedPath, fsFault.replacementContent ?? '', 'utf8')
        actual.unlinkSync(retained)
        fsFault.replacementContent = undefined
      }
      const fd = actual.openSync(...args)
      try {
        if (actual.statSync(String(args[0])).isDirectory()) {
          directoryFds.add(fd)
          directoryFdPaths.set(fd, String(args[0]))
        } else {
          fileFdPaths.set(fd, String(args[0]))
          fileFdFlags.set(fd, Number(args[1]))
        }
      } catch { /* not stat-able */ }
      return fd
    },
    closeSync: (fd: number) => {
      directoryFds.delete(fd)
      directoryFdPaths.delete(fd)
      fileFdPaths.delete(fd)
      fileFdFlags.delete(fd)
      actual.closeSync(fd)
    },
    fsyncSync: (descriptor: number) => {
      const flags = fileFdFlags.get(descriptor)
      if (process.platform === 'win32' && flags !== undefined
        && (flags & (actual.constants.O_RDWR | actual.constants.O_WRONLY)) === 0) {
        throw Object.assign(new Error('EPERM: read-only file cannot be flushed'), { code: 'EPERM' })
      }
      if (fsFault.mode !== 'none' && directoryFds.has(descriptor)) {
        const code = fsFault.mode === 'eperm' ? 'EPERM' : 'EIO'
        throw Object.assign(new Error(`${code}: fsync fault`), { code })
      }
      if (directoryFds.has(descriptor) && fsFault.directoryFailureCountdown !== undefined) {
        if (fsFault.directoryFailureCountdown === 0) {
          fsFault.directoryFailureCountdown = undefined
          throw Object.assign(new Error('EIO: selected directory fsync fault'), { code: 'EIO' })
        }
        fsFault.directoryFailureCountdown -= 1
      }
      if (fsFault.fileOncePath !== undefined && fileFdPaths.get(descriptor) === fsFault.fileOncePath) {
        fsFault.fileOncePath = undefined
        fsFault.fileOnceFlags = flags
        throw Object.assign(new Error('EIO: staged-file fsync fault'), { code: 'EIO' })
      }
      const syncedPath = fileFdPaths.get(descriptor)
      const directoryInjection = fsFault.appendEventAtDirectorySync
      if (directoryInjection !== undefined && directoryFdPaths.get(descriptor) === directoryInjection.directory) {
        fsFault.appendEventAtDirectorySync = undefined
        actual.appendFileSync(directoryInjection.path, directoryInjection.line, 'utf8')
      }
      actual.fsyncSync(descriptor)
      changePrecision('sync', syncedPath)
      if (syncedPath !== undefined && fsFault.replaceAfterFileSyncPath === syncedPath) {
        fsFault.replaceAfterFileSyncPath = undefined
        if (process.platform === 'win32') namedInodeChanges.add(syncedPath)
        else {
          const content = actual.readFileSync(syncedPath)
          const retained = `${syncedPath}.replaced-inode`
          actual.renameSync(syncedPath, retained)
          actual.writeFileSync(syncedPath, content)
          actual.unlinkSync(retained)
        }
      }
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const path = fileFdPaths.get(args[0])
      changePrecision('read', path)
      if (path !== undefined && fsFault.growBeforeReadPath === path) {
        fsFault.growBeforeReadPath = undefined
        actual.appendFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61))
      }
      return actual.readSync(...args)
    },
  }
})

const roots: string[] = []
const authority = verifierAuthority()
const LEGACY_FIXTURE_SECRET = Buffer.from('knowledge-wiki-independent-verifier-fixture-v2')
const STOP_AFTER_JOURNAL = new Error('stop after journal persistence')
const PROMOTION_JOURNAL_MAX_BYTES = 8 * 1024 * 1024

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  namedInodeChanges.clear()
  preciseStageMetadata.clear()
  fsFault.precisionChange = undefined
  fsFault.readdirFailurePath = undefined
  fsFault.readdirFailureCalls = 0
  fsFault.mode = 'none'
  fsFault.fileOncePath = undefined
  fsFault.fileOnceFlags = undefined
  fsFault.replaceBeforeOpenPath = undefined
  fsFault.replaceAfterFileSyncPath = undefined
  fsFault.growBeforeReadPath = undefined
  fsFault.replacementContent = undefined
  fsFault.directoryFailureCountdown = undefined
  fsFault.appendEventAtDirectorySync = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'wiki-review-closure-'))
  roots.push(value)
  return value
}

function candidate(title = 'Closure candidate'): string {
  return `---
type: concept
status: candidate
origin: ingest
title: ${title}
sources: ["repo:ark/docs/architecture.md"]
related: ["concepts/closure"]
---

# ${title}

## 原则

A stable method, its validation evidence, its boundary, and its rollback point.

## 适用条件

Use this when the independent verification gate has already passed.

## 验证证据

测试通过并完成实际请求验收和回滚点检查。
`
}

function candidateAtByteLength(targetBytes: number, filler = 'x'): string {
  const fillerBytes = Buffer.byteLength(filler, 'utf8')
  if (fillerBytes < 1) throw new Error('candidate filler must be non-empty')
  const prefix = [
    '---',
    'type: concept',
    'status: candidate',
    'origin: ingest',
    'title: WAL marker size boundary',
    'sources: ["repo:ark/docs/architecture.md"]',
    'related: ["concepts/governance"]',
    '---',
    '',
    '# WAL marker size boundary',
    '',
    '## 原则',
    '',
  ].join('\n')
  const suffix = [
    '',
    '',
    '## 适用条件',
    '',
    'Use when the verification gate passes.',
    '',
    '## 验证证据',
    '',
    '测试通过并完成实际请求验收和回滚点检查。',
    '',
  ].join('\n')
  const fillBytes = targetBytes - Buffer.byteLength(prefix, 'utf8') - Buffer.byteLength(suffix, 'utf8')
  if (fillBytes < 1) throw new Error('target candidate size is too small')
  const repeated = Math.floor(fillBytes / fillerBytes)
  const remainder = fillBytes - repeated * fillerBytes
  const value = `${prefix}${filler.repeat(repeated)}${'x'.repeat(remainder)}${suffix}`
  if (Buffer.byteLength(value, 'utf8') !== targetBytes) throw new Error('candidate byte target mismatch')
  return value
}

function markerLengthsAuthority(observed: { prepared?: number; committed?: number; rolledBack?: number }): KnowledgeWikiVerifierAuthority {
  return {
    ...authority,
    sealPromotion(request) {
      const seal = authority.sealPromotion(request)
      if (seal instanceof Promise) throw new Error('test verifier unexpectedly returned an asynchronous seal')
      if (request.operation !== 'seal-promotion-wal') return seal
      const journal = { ...request.journal, state: 'prepared', seal }
      observed.prepared = Buffer.byteLength(`${JSON.stringify(journal, null, 2)}\n`, 'utf8')
      observed.committed = Buffer.byteLength(`${JSON.stringify({ ...journal, state: 'committed' }, null, 2)}\n`, 'utf8')
      observed.rolledBack = Buffer.byteLength(`${JSON.stringify({ ...journal, state: 'rolled-back' }, null, 2)}\n`, 'utf8')
      return seal
    },
  }
}

interface Fixture {
  root: string
  wikiRoot: string
  archiveRoot: string
  reviewFile: string
  candidatePath: string
  candidateFull: string
  reviewId: string
}

function fixture(candidatePath = '_candidates/sessions/closure.md', content = candidate()): Fixture {
  const projectRoot = root()
  const wikiRoot = join(projectRoot, 'wiki')
  const candidateFull = join(wikiRoot, candidatePath)
  const reviewFile = join(projectRoot, '.llm-wiki', 'review.json')
  mkdirSync(dirname(candidateFull), { recursive: true })
  writeFileSync(candidateFull, content, 'utf8')
  expect(appendCandidateReviews(reviewFile, projectRoot, 'raw/closure.md', [`wiki/${candidatePath}`])).toBe(1)
  const reviewId = readItems(reviewFile)[0]!.id
  return {
    root: projectRoot,
    wikiRoot,
    archiveRoot: join(projectRoot, 'archive'),
    reviewFile,
    candidatePath,
    candidateFull,
    reviewId,
  }
}

function readItems(reviewFile: string): WikiReviewItem[] {
  return JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[]
}

function writeItems(reviewFile: string, items: WikiReviewItem[]): void {
  writeFileSync(reviewFile, JSON.stringify(items, null, 2), 'utf8')
}

function removePromotedEvent(item: Fixture): string {
  const path = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
  const kept = lines.filter(line => (JSON.parse(line) as { type: string }).type !== 'knowledge/promoted')
  expect(kept).toHaveLength(lines.length - 1)
  writeFileSync(path, `${kept.join('\n')}\n`, 'utf8')
  return path
}

/** Bind an authentic passing receipt for one candidate under test. */
async function verify(item: Fixture, action: 'Promote' | 'Merge' = 'Promote'): Promise<void> {
  const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, action)
  expect(await recordCandidateVerificationWithAuthority(
    authority, item.reviewFile, item.wikiRoot, item.reviewId, receiptId, action,
  )).toBe(true)
}

async function apply(
  item: Fixture,
  acting: KnowledgeWikiVerifierAuthority = authority,
  action = 'Promote',
  actor = 'human',
  measuredTrialReader?: KnowledgeWikiMeasuredTrialReader,
): Promise<boolean | null> {
  return applyCandidateReviewWithAuthority(
    acting, item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, action, actor,
    measuredTrialReader,
  )
}

function measuredTrialReader(): {
  readonly reader: KnowledgeWikiMeasuredTrialReader
  readonly trialHash: string
  readonly targetAfter: Buffer
} {
  const authorityId = 'closure-independent-measured-trial'
  const trialHash = 'a'.repeat(64)
  const targetAfter = Buffer.from('---\ntype: concept\nstatus: canonical\ntitle: measured candidate\n---\n\nverified paired-trial content\n')
  const reader: KnowledgeWikiMeasuredTrialReader = {
    authorityId,
    read(hash, binding): VerifiedMeasuredTrial | undefined {
      if (hash !== trialHash) return undefined
      return {
        authorityId,
        trialHash,
        proposalHash: 'c'.repeat(64),
        grantId: 'grant-closure-1',
        candidatePath: binding.candidatePath,
        candidateHash: binding.candidateHash,
        action: binding.action,
        targetPath: binding.targetPath,
        targetBeforeHashOrVerifiedAbsence: binding.targetBeforeHashOrVerifiedAbsence,
        targetAfterHash: sha256(targetAfter),
        targetAfterBytes: Buffer.from(targetAfter),
        eligibleForReview: true,
        evidenceRefs: ['d'.repeat(64)],
        retrievalHits: 2,
        successfulUses: 1,
        userCorrections: 0,
        utilityScore: 0.5,
        startedAt: '2026-10-11T10:00:00.000Z',
        endedAt: '2026-10-11T10:02:00.000Z',
      }
    },
  }
  return { reader, trialHash, targetAfter }
}

async function prepareCanonicalPromotion(item: Fixture) {
  await verify(item)
  const measured = measuredTrialReader()
  expect(recordCandidateMeasuredTrial(
    authority, measured.reader, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote', measured.trialHash,
  )).toMatchObject({ authenticated: true, eligibleForReview: true })
  return measured
}

/** Authority whose promotion checkpoint performs one deterministic external mutation. */
function checkpointAuthority(
  hook: (core: JournalCore, checkpoint: PromotionCheckpoint) => void,
): KnowledgeWikiVerifierAuthority {
  const base = verifierAuthority()
  return {
    ...base,
    checkpointPromotion(payload, checkpoint) {
      hook(JSON.parse(payload) as JournalCore, checkpoint)
    },
  }
}

interface JournalOperation {
  readonly role: string
  readonly path: string
  readonly before?: string
  readonly after?: string
  readonly stagingPath?: string
  readonly tombstonePath?: string
}

interface JournalCore {
  schemaVersion: number
  id: string
  reviewId: string
  candidateHash: string
  createdAt: string
  action: string
  targetPath: string | null
  reviewHash: string | null
  receiptId: string | null
  receiptHash: string | null
  operationSetHash: string
  operations: JournalOperation[]
}

interface JournalRecord extends JournalCore {
  state: string
  seal: VerificationAuthoritySeal
}

function journalDirectory(item: Fixture): string {
  return join(dirname(item.reviewFile), 'promotion-journal')
}

function journalFiles(item: Fixture): string[] {
  return readdirSync(journalDirectory(item)).filter(name => name.endsWith('.json')).sort()
}

function readJournal(item: Fixture): JournalRecord {
  const name = journalFiles(item)[0]
  if (name === undefined) throw new Error('no promotion journal was persisted')
  return JSON.parse(readFileSync(join(journalDirectory(item), name), 'utf8')) as JournalRecord
}

function operationOf(journal: { readonly operations: readonly JournalOperation[] }, role: string): JournalOperation {
  const operation = journal.operations.find(value => value.role === role)
  if (operation === undefined) throw new Error(`journal has no ${role} operation`)
  return operation
}

/** Run one permitted Archive decision until its journal is durable, then leave it prepared. */
async function interruptAtJournalPersistence(item: Fixture, action: 'Archive'): Promise<JournalRecord> {
  const stopping = checkpointAuthority((_core, checkpoint) => {
    if (checkpoint.phase === 'journal-persisted') throw STOP_AFTER_JOURNAL
  })
  await expect(apply(item, stopping, action)).rejects.toThrow(STOP_AFTER_JOURNAL)
  const journal = readJournal(item)
  expect(journal.state).toBe('prepared')
  return journal
}

/** Replace the prepared journal with a re-sealed variant, modelling a legacy or damaged WAL. */
function resealJournal(
  item: Fixture,
  journal: JournalRecord,
  mutate: (core: JournalCore) => void,
  state: 'prepared' | 'committed' = 'prepared',
): void {
  const { state: _state, seal: _seal, ...fields } = journal
  const core: JournalCore = { ...fields, operations: fields.operations.map(operation => ({ ...operation })) }
  mutate(core)
  core.operationSetHash = sha256(canonicalJson(core.operations))
  const name = journalFiles(item)[0]
  if (name === undefined) throw new Error('no promotion journal was persisted')
  writeFileSync(
    join(journalDirectory(item), name),
    JSON.stringify({ ...core, state, seal: {
      authorityId: authority.authorityId,
      proof: createHmac('sha256', LEGACY_FIXTURE_SECRET).update(canonicalJson(core)).digest('hex'),
    } }),
    'utf8',
  )
}

/** Every write-ahead staging and tombstone entry still present under one project root. */
function walLeftovers(projectRoot: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.name.includes('.ark-wal-')) found.push(full)
      else if (entry.isDirectory()) walk(full)
    }
  }
  if (existsSync(projectRoot)) walk(projectRoot)
  return found
}

async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected the promotion transaction to fail')
}

/** Error messages carried by an aggregate incomplete-rollback failure. */
function aggregateMessages(error: unknown): string[] {
  if (!(error instanceof AggregateError)) throw new Error('expected an aggregate incomplete-rollback failure')
  const values: readonly unknown[] = error.errors
  return values.map((value) => {
    if (value instanceof Error) return value.message
    return typeof value
  })
}

describe('canonical mutation gates and durable target selection', () => {
  it('keeps canonical bytes untouched when no measured trial authority is provisioned', async () => {
    const withoutStatus = [
      '---',
      'type: concept',
      'origin: ingest',
      'title: Closure stamping',
      'sources: ["repo:ark/docs/architecture.md"]',
      'related: ["concepts/closure"]',
      '---',
      '',
      '# Closure stamping',
      '',
      '## 原则',
      '',
      'Canonical pages carry an explicit status and an approval stamp on admission.',
      '',
      '## 适用条件',
      '',
      'Use this when a candidate is admitted without an explicit status field.',
      '',
      '## 验证证据',
      '',
      'Independent verification supplies the admission evidence and the rollback point.',
      '',
    ].join('\n')
    const item = fixture('_candidates/sessions/closure.md', withoutStatus)
    await verify(item)

    expect(await apply(item)).toBe(false)

    const target = readItems(item.reviewFile)[0]!.targetPath
    if (target === undefined) throw new Error('promotion recorded no canonical target')
    expect(existsSync(join(item.wikiRoot, target))).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(journalDirectory(item))).toBe(false)
  })

  it('archives a verified candidate whose durable target resolves inside the candidate namespace', async () => {
    const item = fixture()
    const candidateTarget = '_candidates/topics/linked.md'
    mkdirSync(dirname(join(item.wikiRoot, candidateTarget)), { recursive: true })
    writeFileSync(join(item.wikiRoot, candidateTarget), candidate('Linked'), 'utf8')
    const rows = readItems(item.reviewFile)
    writeItems(item.reviewFile, [{ ...rows[0]!, targetPath: candidateTarget }])

    await verify(item, 'Merge')

    const row = readItems(item.reviewFile)[0]!
    expect(row.verification?.status).toBe('passed')
    expect(row.options?.map(option => option.action)).toEqual(['Archive'])
    expect(row.resolved).toBe(false)
  })

  it('refuses a canonical action whose durable target resolves inside the candidate namespace', async () => {
    const merge = fixture()
    const candidateTarget = '_candidates/topics/linked.md'
    mkdirSync(dirname(join(merge.wikiRoot, candidateTarget)), { recursive: true })
    writeFileSync(join(merge.wikiRoot, candidateTarget), candidate('Linked'), 'utf8')
    const mergeRows = readItems(merge.reviewFile)
    writeItems(merge.reviewFile, [{ ...mergeRows[0]!, targetPath: candidateTarget }])
    await verify(merge, 'Merge')
    const mergeReviewBefore = readFileSync(merge.reviewFile, 'utf8')

    expect(await apply(merge, authority, 'Merge')).toBe(false)
    expect(readFileSync(merge.reviewFile, 'utf8')).toBe(mergeReviewBefore)
    expect(existsSync(merge.candidateFull)).toBe(true)
    expect(readItems(merge.reviewFile)[0]!.resolved).toBe(false)

    const promote = fixture()
    const promoteRows = readItems(promote.reviewFile)
    writeItems(promote.reviewFile, [{ ...promoteRows[0]!, targetPath: '_candidates/topics/absent.md' }])
    await verify(promote, 'Promote')
    const promoteReviewBefore = readFileSync(promote.reviewFile, 'utf8')

    expect(await apply(promote)).toBe(false)
    expect(readFileSync(promote.reviewFile, 'utf8')).toBe(promoteReviewBefore)
    expect(existsSync(promote.candidateFull)).toBe(true)
    expect(existsSync(join(promote.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(existsSync(journalDirectory(promote))).toBe(false)
  })
})

describe('candidate verification preconditions', () => {
  it('refuses unavailable, ineligible, unconfined, and stale rows without side effects', async () => {
    const missing = join(root(), 'review.json')
    expect(await recordCandidateVerificationWithAuthority(
      authority, missing, '/wiki', 'review-unknown', 'verification-unknown', 'Promote',
    )).toBe(false)
    expect(existsSync(join(dirname(missing), 'verification-receipts'))).toBe(false)

    const advisory = fixture()
    const advisoryRows = readItems(advisory.reviewFile)
    writeItems(advisory.reviewFile, [{ ...advisoryRows[0]!, reviewKind: 'advisory' }])
    expect(await recordCandidateVerificationWithAuthority(
      authority, advisory.reviewFile, advisory.wikiRoot, advisory.reviewId, 'verification-unknown', 'Promote',
    )).toBe(false)
    expect(readItems(advisory.reviewFile)[0]!.verification?.status).toBe('pending')

    const unconfined = fixture()
    const unconfinedRows = readItems(unconfined.reviewFile)
    writeItems(unconfined.reviewFile, [{ ...unconfinedRows[0]!, candidatePath: 'concepts/not-candidate.md' }])
    expect(await recordCandidateVerificationWithAuthority(
      authority, unconfined.reviewFile, unconfined.wikiRoot, unconfined.reviewId, 'verification-unknown', 'Promote',
    )).toBe(false)
    expect(readItems(unconfined.reviewFile)[0]!.verification?.status).toBe('pending')

    const stale = fixture()
    writeFileSync(stale.candidateFull, `${readFileSync(stale.candidateFull, 'utf8')}\nchanged\n`, 'utf8')
    expect(await recordCandidateVerificationWithAuthority(
      authority, stale.reviewFile, stale.wikiRoot, stale.reviewId, 'verification-unknown', 'Promote',
    )).toBe(false)
    expect(readItems(stale.reviewFile)[0]!.verification?.status).toBe('pending')
  })
})

describe('promotion authorization seal', () => {
  it('refuses an Archive transaction the authority cannot seal for itself', async () => {
    const forgeSeals: Array<[string, KnowledgeWikiVerifierAuthority]> = [
      ['a foreign authority id', {
        ...authority,
        sealPromotion: (): VerificationAuthoritySeal => ({ authorityId: 'foreign-authority', proof: 'forged' }),
      }],
      ['an empty proof', {
        ...authority,
        sealPromotion: (): VerificationAuthoritySeal => ({ authorityId: authority.authorityId, proof: '' }),
      }],
    ]

    for (const [label, sealing] of forgeSeals) {
      const item = fixture()
      await verify(item)
      const reviewBefore = readFileSync(item.reviewFile, 'utf8')
      const sealPromotion = vi.fn((request: KnowledgeWikiPromotionSealRequest) => Promise.resolve(sealing.sealPromotion(request)))

      expect(await apply(item, { ...sealing, sealPromotion }, 'Archive'), label).toBe(false)
      expect(sealPromotion, label).toHaveBeenCalledTimes(1)
      expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
      expect(existsSync(item.candidateFull)).toBe(true)
      expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
      expect(existsSync(journalDirectory(item))).toBe(false)
    }
  })
})

describe('promotion journal serialized recovery bound', () => {
  it('commits a large valid UTF-8 WAL whose every marker remains readable', async () => {
    const observed: { prepared?: number; committed?: number; rolledBack?: number } = {}
    const item = fixture('_candidates/sessions/large-archive.md', candidateAtByteLength(3.5 * 1024 * 1024))
    expect(await apply(item, markerLengthsAuthority(observed), 'Archive')).toBe(true)
    expect(observed.prepared).toBeLessThanOrEqual(PROMOTION_JOURNAL_MAX_BYTES)
    expect(observed.committed).toBeLessThanOrEqual(PROMOTION_JOURNAL_MAX_BYTES)
    expect(observed.rolledBack).toBeLessThanOrEqual(PROMOTION_JOURNAL_MAX_BYTES)
    const journalBytes = readFileSync(join(journalDirectory(item), journalFiles(item)[0]!))
    expect(journalBytes.length).toBe(observed.committed)
    expect(journalBytes.length).toBeLessThanOrEqual(PROMOTION_JOURNAL_MAX_BYTES)
    expect(readJournal(item).state).toBe('committed')
  }, 120_000)

  it('rejects escaped and multibyte UTF-8 WALs before creating any transaction effects', async () => {
    const oversizedCases = [
      ['known duplicated candidate copy', 'x'],
      ['JSON escaping and multibyte UTF-8 byte count', '界\\"\n'],
    ] as const
    for (const [label, filler] of oversizedCases) {
      const item = fixture('_candidates/sessions/oversized-archive.md', candidateAtByteLength(Math.floor(4.2 * 1024 * 1024), filler))
      const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
      const before = {
        candidate: readFileSync(item.candidateFull),
        review: readFileSync(item.reviewFile),
        events: readFileSync(eventPath),
      }
      const observed: { prepared?: number; committed?: number; rolledBack?: number } = {}
      await expect(apply(item, markerLengthsAuthority(observed), 'Archive'), label)
        .rejects.toThrow(`promotion journal exceeds ${PROMOTION_JOURNAL_MAX_BYTES} byte recovery limit`)
      expect(observed.prepared, label).toBeGreaterThan(PROMOTION_JOURNAL_MAX_BYTES)
      expect(observed.rolledBack, label).toBeGreaterThan(PROMOTION_JOURNAL_MAX_BYTES)
      expect(sha256(readFileSync(item.candidateFull)), label).toBe(sha256(before.candidate))
      expect(sha256(readFileSync(item.reviewFile)), label).toBe(sha256(before.review))
      expect(sha256(readFileSync(eventPath)), label).toBe(sha256(before.events))
      expect(existsSync(join(item.wikiRoot, 'concepts', 'large-archive.md')), label).toBe(false)
      expect(existsSync(item.archiveRoot), label).toBe(false)
      expect(existsSync(journalDirectory(item)), label).toBe(false)
    }
  }, 120_000)

  it('reserves room for rolled-back when prepared and committed alone would fit', async () => {
    const baseBytes = Math.floor(3.5 * 1024 * 1024)
    const baseSizes: { prepared?: number; committed?: number; rolledBack?: number } = {}
    const base = fixture('_candidates/sessions/marker-boundary.md', candidateAtByteLength(baseBytes))
    expect(await apply(base, markerLengthsAuthority(baseSizes), 'Archive')).toBe(true)
    expect(baseSizes.rolledBack).toBeLessThanOrEqual(PROMOTION_JOURNAL_MAX_BYTES)

    const targetBytes = baseBytes + Math.floor((PROMOTION_JOURNAL_MAX_BYTES - baseSizes.rolledBack!) / 2) + 1
    const boundarySizes: { prepared?: number; committed?: number; rolledBack?: number } = {}
    const boundary = fixture('_candidates/sessions/marker-boundary.md', candidateAtByteLength(targetBytes))
    const before = {
      candidate: readFileSync(boundary.candidateFull),
      review: readFileSync(boundary.reviewFile),
      events: readFileSync(join(dirname(boundary.reviewFile), 'knowledge-events.jsonl')),
    }
    let boundaryError: unknown
    try {
      const result = await apply(boundary, markerLengthsAuthority(boundarySizes), 'Archive')
      if (result === true) throw new Error(`boundary unexpectedly committed: ${JSON.stringify({ targetBytes, ...boundarySizes })}`)
    } catch (error) {
      boundaryError = error
    }
    expect(boundaryError).toMatchObject({
      message: `promotion journal exceeds ${PROMOTION_JOURNAL_MAX_BYTES} byte recovery limit`,
    })
    expect(boundarySizes.prepared).toBeLessThanOrEqual(PROMOTION_JOURNAL_MAX_BYTES)
    expect(boundarySizes.committed).toBeLessThanOrEqual(PROMOTION_JOURNAL_MAX_BYTES)
    expect(boundarySizes.rolledBack).toBeGreaterThan(PROMOTION_JOURNAL_MAX_BYTES)
    expect(sha256(readFileSync(boundary.candidateFull))).toBe(sha256(before.candidate))
    expect(sha256(readFileSync(boundary.reviewFile))).toBe(sha256(before.review))
    expect(sha256(readFileSync(join(dirname(boundary.reviewFile), 'knowledge-events.jsonl')))).toBe(sha256(before.events))
    expect(existsSync(boundary.archiveRoot)).toBe(false)
    expect(existsSync(journalDirectory(boundary))).toBe(false)
  }, 120_000)
})

describe('promotion journal recovery boundaries', () => {
  it('reports no recovery work for an absent or already committed journal', async () => {
    const fresh = fixture()
    expect(await recoverCandidateReviewTransactions(
      authority, fresh.reviewFile, fresh.wikiRoot, fresh.archiveRoot,
    )).toBe(0)
    expect(existsSync(journalDirectory(fresh))).toBe(false)

    const committed = fixture()
    expect(await apply(committed, authority, 'Archive')).toBe(true)
    expect(readJournal(committed).state).toBe('committed')
    expect(await recoverCandidateReviewTransactions(
      authority, committed.reviewFile, committed.wikiRoot, committed.archiveRoot,
    )).toBe(0)
  })

  it('leaves a matched committed lifecycle event untouched after its generation fence closes', async () => {
    const item = fixture()
    expect(await apply(item, authority, 'Archive')).toBe(true)
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const journalPath = join(journalDirectory(item), journalFiles(item)[0]!)
    const before = [readFileSync(eventPath), readFileSync(journalPath), readFileSync(item.reviewFile)]

    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot, undefined, () => false,
    )).toBe(0)
    expect([readFileSync(eventPath), readFileSync(journalPath), readFileSync(item.reviewFile)]).toEqual(before)
  })

  it('replays a committed Archive without duplicating its lifecycle event', async () => {
    const item = fixture()
    expect(await apply(item, authority, 'Archive')).toBe(true)
    const journal = readJournal(item)
    const journalPath = join(journalDirectory(item), journalFiles(item)[0]!)
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const rejectedCount = readFileSync(eventPath, 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as { type: string })
      .filter(event => event.type === 'knowledge/rejected').length
    expect(rejectedCount).toBe(1)

    writeFileSync(journalPath, JSON.stringify({ ...journal, state: 'prepared' }), 'utf8')
    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(1)
    expect(readJournal(item).state).toBe('committed')
    const recoveredCount = readFileSync(eventPath, 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as { type: string })
      .filter(event => event.type === 'knowledge/rejected').length
    expect(recoveredCount).toBe(1)
  })

  it('repairs a signed committed schema-1 Archive whose lifecycle event is missing', async () => {
    const item = fixture()
    expect(await apply(item, authority, 'Archive')).toBe(true)
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const prior = readFileSync(eventPath, 'utf8').trimEnd().split('\n')
    const withoutRejected = prior.filter(line => (JSON.parse(line) as { type: string }).type !== 'knowledge/rejected')
    expect(withoutRejected).toHaveLength(prior.length - 1)
    writeFileSync(eventPath, `${withoutRejected.join('\n')}\n`, 'utf8')

    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(1)
    const repaired = readFileSync(eventPath, 'utf8').trimEnd().split('\n')
      .map(line => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter(event => event.type === 'knowledge/rejected')
    expect(repaired).toHaveLength(1)
    expect(repaired[0]!.payload).toMatchObject({
      action: 'Archive', lifecycle: 'downgraded', candidateHash: readJournal(item).candidateHash,
      appliedPath: readItems(item.reviewFile)[0]!.appliedPath,
    })
    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(0)
    expect(readFileSync(eventPath, 'utf8').trimEnd().split('\n')).toHaveLength(repaired.length + withoutRejected.length)
  })

  it('rejects a valid event-chain entry whose Archive semantics contradict the signed journal', async () => {
    const item = fixture()
    expect(await apply(item, authority, 'Archive')).toBe(true)
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const prior = readKnowledgeEventLog(eventPath, authority)
    const archived = prior.at(-1)
    if (archived === undefined || archived.type !== 'knowledge/rejected') throw new Error('Archive lifecycle event is absent')
    const priorEvents = prior.slice(0, -1)
    const payload = { ...archived.payload, appliedPath: `${String(archived.payload.appliedPath)}-other` }
    const conflicting = createKnowledgeEvent(
      archived.type,
      archived.knowledgeId,
      archived.scope,
      payload,
      { seq: priorEvents.length, previousEventHash: priorEvents.at(-1)?.eventHash ?? null },
    )
    writeFileSync(eventPath, `${priorEvents.map(event => JSON.stringify(event)).join('\n')}\n${JSON.stringify(conflicting)}\n`, 'utf8')
    const eventBefore = readFileSync(eventPath, 'utf8')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')

    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('candidate lifecycle event conflicts with signed promotion journal')
    expect(readFileSync(eventPath, 'utf8')).toBe(eventBefore)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(existsSync(item.candidateFull)).toBe(false)
  })

  it('refuses duplicate authenticated lifecycle events instead of treating them as one completion', async () => {
    const item = fixture()
    expect(await apply(item, authority, 'Archive')).toBe(true)
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const prior = readKnowledgeEventLog(eventPath, authority)
    const archived = prior.at(-1)
    if (archived === undefined || archived.type !== 'knowledge/rejected') throw new Error('Archive lifecycle event is absent')
    appendKnowledgeEvent(eventPath, createKnowledgeEvent(
      archived.type,
      archived.knowledgeId,
      archived.scope,
      archived.payload,
      { seq: prior.length, previousEventHash: archived.eventHash },
    ))
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const eventBefore = readFileSync(eventPath, 'utf8')

    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('duplicate candidate lifecycle event')
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventBefore)
    expect(readJournal(item).state).toBe('committed')
  })

  it('does not pin current review bytes to a previously completed committed Archive', async () => {
    const item = fixture()
    expect(await apply(item, authority, 'Archive')).toBe(true)
    const laterPath = '_candidates/sessions/later.md'
    const laterFull = join(item.wikiRoot, laterPath)
    mkdirSync(dirname(laterFull), { recursive: true })
    writeFileSync(laterFull, candidate('Later candidate'), 'utf8')
    expect(appendCandidateReviews(item.reviewFile, item.root, 'raw/later.md', [`wiki/${laterPath}`])).toBe(1)
    expect(readItems(item.reviewFile)).toHaveLength(2)

    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(0)
    expect(readItems(item.reviewFile)).toHaveLength(2)
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    expect(readFileSync(eventPath, 'utf8').trimEnd().split('\n')
      .map(line => JSON.parse(line) as { type: string })
      .filter(event => event.type === 'knowledge/rejected')).toHaveLength(1)
  })

  it('recovers Skip from its signed governance append instead of the normalized WAL action', async () => {
    const item = fixture()
    expect(await apply(item, authority, 'Skip')).toBe(true)
    const journal = readJournal(item)
    expect(journal.action).toBe('Archive')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const rejected = readFileSync(eventPath, 'utf8').trimEnd().split('\n')
      .map(line => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .find(event => event.type === 'knowledge/rejected')
    expect(rejected?.payload).toMatchObject({
      action: 'Skip',
      appliedPath: readItems(item.reviewFile)[0]!.appliedPath,
      candidateHash: journal.candidateHash,
    })
  })

  it('rejects a signed Archive WAL whose appliedPath contradicts its candidate archive operation', async () => {
    const item = fixture()
    const journal = await interruptAtJournalPersistence(item, 'Archive')
    const archivePath = operationOf(journal, 'candidate-archive').path
    resealJournal(item, journal, (core) => {
      core.operations = core.operations.map((operation) => {
        if (operation.role !== 'governance' || operation.after === undefined) return operation
        const prior = operation.before ?? ''
        const appended = operation.after.slice(prior.length)
        const entry = JSON.parse(appended.slice(0, -1)) as Record<string, unknown>
        return { ...operation, after: `${prior}${JSON.stringify({ ...entry, appliedPath: `${String(entry.appliedPath)}-other` })}\n` }
      })
    })
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const governancePath = join(dirname(item.reviewFile), 'governance.jsonl')
    const governanceBefore = existsSync(governancePath) ? readFileSync(governancePath, 'utf8') : undefined
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const eventsBefore = readFileSync(eventPath, 'utf8')

    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('promotion governance decision does not bind the signed journal')
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(existsSync(archivePath)).toBe(false)
    expect(existsSync(governancePath) ? readFileSync(governancePath, 'utf8') : undefined).toBe(governanceBefore)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventsBefore)
  })

  it('rejects signed Archive WALs that cannot recover one unique governance decision', async () => {
    const invalidCases: Array<{
      readonly name: string
      readonly error: string
      readonly mutate: (core: JournalCore) => void
    }> = [
      {
        name: 'missing governance operation',
        error: 'promotion journal lacks its signed governance decision',
        mutate(core) { core.operations = core.operations.filter(operation => operation.role !== 'governance') },
      },
      {
        name: 'missing appended state',
        error: 'promotion journal lacks its signed governance decision',
        mutate(core) {
          core.operations = core.operations.map((operation) => {
            if (operation.role !== 'governance') return operation
            const { after: _after, ...withoutAfter } = operation
            return withoutAfter
          })
        },
      },
      {
        name: 'changed prior bytes',
        error: 'promotion governance append changed prior entries',
        mutate(core) {
          core.operations = core.operations.map(operation => operation.role === 'governance'
            ? { ...operation, before: 'prior-record\n', after: 'not-the-prior-bytes\n' }
            : operation)
        },
      },
      {
        name: 'multiple appended rows',
        error: 'promotion governance decision is not one appended entry',
        mutate(core) {
          core.operations = core.operations.map((operation) => {
            if (operation.role !== 'governance' || operation.after === undefined) return operation
            const prior = operation.before ?? ''
            const appended = operation.after.slice(prior.length)
            return { ...operation, after: `${prior}${appended}${appended}` }
          })
        },
      },
      {
        name: 'primitive row',
        error: 'promotion governance decision is invalid',
        mutate(core) {
          core.operations = core.operations.map(operation => operation.role === 'governance'
            ? { ...operation, after: `${operation.before ?? ''}${JSON.stringify('not-an-object')}\n` }
            : operation)
        },
      },
      {
        name: 'invalid JSON row',
        error: 'promotion governance decision is invalid',
        mutate(core) {
          core.operations = core.operations.map(operation => operation.role === 'governance'
            ? { ...operation, after: `${operation.before ?? ''}{invalid-json}\n` }
            : operation)
        },
      },
    ]
    for (const scenario of invalidCases) {
      const item = fixture()
      expect(await apply(item, authority, 'Archive')).toBe(true)
      const journal = readJournal(item)
      const archivePath = operationOf(journal, 'candidate-archive').path
      resealJournal(item, journal, scenario.mutate, 'committed')
      const reviewBefore = readFileSync(item.reviewFile, 'utf8')
      const archivedBefore = readFileSync(archivePath, 'utf8')
      const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
      const eventBefore = readFileSync(eventPath, 'utf8')

      await expect(recoverCandidateReviewTransactions(
        authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
      ), scenario.name).rejects.toThrow(scenario.error)
      expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
      expect(readFileSync(archivePath, 'utf8')).toBe(archivedBefore)
      expect(existsSync(item.candidateFull)).toBe(false)
      expect(readFileSync(eventPath, 'utf8')).toBe(eventBefore)
      expect(readJournal(item).state).toBe('committed')
    }
  })

  it('refuses to repair a committed Archive event when the signed WAL or after-state is invalid', async () => {
    const invalidSeal = fixture()
    expect(await apply(invalidSeal, authority, 'Archive')).toBe(true)
    const invalidJournal = readJournal(invalidSeal)
    const invalidPath = join(journalDirectory(invalidSeal), journalFiles(invalidSeal)[0]!)
    writeFileSync(invalidPath, JSON.stringify({ ...invalidJournal, seal: { authorityId: authority.authorityId, proof: 'invalid' } }), 'utf8')
    const invalidEventPath = join(dirname(invalidSeal.reviewFile), 'knowledge-events.jsonl')
    const invalidLines = readFileSync(invalidEventPath, 'utf8').trimEnd().split('\n')
      .filter(line => (JSON.parse(line) as { type: string }).type !== 'knowledge/rejected')
    writeFileSync(invalidEventPath, `${invalidLines.join('\n')}\n`, 'utf8')
    await expect(recoverCandidateReviewTransactions(
      authority, invalidSeal.reviewFile, invalidSeal.wikiRoot, invalidSeal.archiveRoot,
    )).rejects.toThrow('promotion journal authority validation failed')

    const divergent = fixture()
    expect(await apply(divergent, authority, 'Archive')).toBe(true)
    const divergentEventPath = join(dirname(divergent.reviewFile), 'knowledge-events.jsonl')
    const divergentLines = readFileSync(divergentEventPath, 'utf8').trimEnd().split('\n')
      .filter(line => (JSON.parse(line) as { type: string }).type !== 'knowledge/rejected')
    writeFileSync(divergentEventPath, `${divergentLines.join('\n')}\n`, 'utf8')
    writeFileSync(divergent.candidateFull, 'unexpected replacement\n', 'utf8')
    await expect(recoverCandidateReviewTransactions(
      authority, divergent.reviewFile, divergent.wikiRoot, divergent.archiveRoot,
    )).rejects.toThrow('promotion journal divergent state')
  })

  it('recovers a prepared Archive without creating a canonical promotion event', async () => {
    const item = fixture()
    const stopping = checkpointAuthority((_core, checkpoint) => {
      if (checkpoint.phase === 'journal-persisted') throw STOP_AFTER_JOURNAL
    })
    await expect(apply(item, stopping, 'Archive')).rejects.toThrow(STOP_AFTER_JOURNAL)

    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(1)
    expect(existsSync(item.candidateFull)).toBe(false)
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const events = readFileSync(eventPath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { type: string })
    expect(events.some(event => event.type === 'knowledge/promoted')).toBe(false)
  })

  it.each(['native', 'win32'] as const)('syncs an already-matching staged inode before recovery can rename it (%s)', async (platform) => {
    if (platform === 'win32') Object.defineProperty(process, 'platform', { value: 'win32' })
    const item = fixture()
    const journal = await interruptAtJournalPersistence(item, 'Archive')
    const review = operationOf(journal, 'review')
    if (review.stagingPath === undefined || review.after === undefined) throw new Error('prepared review operation lacks its stage')
    writeFileSync(review.stagingPath, review.after, 'utf8')
    fsFault.fileOncePath = review.stagingPath
    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('staged-file fsync fault')
    expect(readJournal(item).state).toBe('prepared')
    expect(existsSync(review.stagingPath)).toBe(true)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)

    fsFault.mode = 'eio'
    try {
      await expect(recoverCandidateReviewTransactions(
        authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
      )).rejects.toThrow('EIO: fsync fault')
    } finally { fsFault.mode = 'none' }
    expect(readJournal(item).state).toBe('prepared')
    expect(existsSync(review.stagingPath)).toBe(true)

    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(1)
    expect(readJournal(item).state).toBe('committed')
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(true)
  })

  it('keeps POSIX stage flag dispatch bound to a mandatory flush failure', async () => {
    // This executes dispatch and denial on this host, not cross-platform
    // O_NOFOLLOW or read-only flush enforcement by the host kernel.
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const item = fixture(), reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const staging = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'journal-persisted') return
      const review = operationOf(core, 'review')
      if (review.stagingPath === undefined || review.after === undefined) throw new Error('prepared review operation lacks its stage')
      writeFileSync(review.stagingPath, review.after)
      fsFault.fileOncePath = review.stagingPath
    })
    await expect(apply(item, staging, 'Archive')).rejects.toThrow('staged-file fsync fault')
    expect(fsFault.fileOnceFlags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readJournal(item).state).toBe('rolled-back')
  })

  it('keeps an unsafe symlink stage from entering a promotion transaction', async () => {
    const item = fixture()
    const originalCandidate = sha256(readFileSync(item.candidateFull))
    const staging = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'journal-persisted') return
      const review = operationOf(core, 'review')
      if (review.stagingPath === undefined) throw new Error('prepared review operation lacks its stage')
      symlinkSync(item.candidateFull, review.stagingPath)
    })
    const error = await captureFailure(() => apply(item, staging, 'Archive'))
    expect(error).toBeInstanceOf(AggregateError)
    const messages = (error as AggregateError).errors.map(value => value instanceof Error ? value.message : String(value))
    if (!messages.some(message => message.includes('unsafe promotion stage'))) throw new Error(JSON.stringify(messages))
    const journal = readJournal(item)
    const review = operationOf(journal, 'review')
    const archive = operationOf(journal, 'candidate-archive')
    expect(journal.state).toBe('prepared')
    expect(review.stagingPath).toBeDefined()
    expect(existsSync(review.stagingPath!)).toBe(true)
    expect(existsSync(archive.path)).toBe(false)
    expect(sha256(readFileSync(item.candidateFull))).toBe(originalCandidate)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
  })

  it('retains a prepared journal when rollback namespace sync fails, then recovers it', async () => {
    const item = fixture()
    const checkpointFailure = new Error('stop after archive stage')
    const stopWithRollbackBarrierFault = checkpointAuthority((_core, checkpoint) => {
      if (checkpoint.phase !== 'stage-written' || checkpoint.operationIndex !== 0) return
      fsFault.directoryFailureCountdown = 1
      throw checkpointFailure
    })
    const error = await captureFailure(() => apply(item, stopWithRollbackBarrierFault, 'Archive'))
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map(value => value instanceof Error ? value.message : String(value)))
      .toEqual(expect.arrayContaining([checkpointFailure.message, 'EIO: selected directory fsync fault']))
    const journal = readJournal(item)
    const archive = operationOf(journal, 'candidate-archive')
    expect(journal.state).toBe('prepared')
    expect(existsSync(archive.path)).toBe(false)
    expect(archive.stagingPath).toBeDefined()
    expect(existsSync(archive.stagingPath!)).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)

    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(1)
    expect(readJournal(item).state).toBe('committed')
    expect(existsSync(archive.path)).toBe(true)
    expect(existsSync(item.candidateFull)).toBe(false)
  })

  it.each(['native', 'win32'] as const)('rejects oversized and replaced matching stages before applying a WAL operation (%s)', async (platform) => {
    if (platform === 'win32') Object.defineProperty(process, 'platform', { value: 'win32' })
    for (const mode of ['oversized', 'replaced', 'replaced-after-sync', 'grown-during-read'] as const) {
      const item = fixture()
      const reviewBefore = readFileSync(item.reviewFile, 'utf8')
      const staging = checkpointAuthority((core, checkpoint) => {
        if (checkpoint.phase !== 'journal-persisted') return
        const review = operationOf(core, 'review')
        if (review.stagingPath === undefined || review.after === undefined) throw new Error('prepared review operation lacks its stage')
        writeFileSync(review.stagingPath, mode === 'oversized' ? Buffer.alloc(8 * 1024 * 1024 + 1, 0x61) : review.after)
        if (mode === 'replaced') {
          fsFault.replaceBeforeOpenPath = review.stagingPath
          fsFault.replacementContent = review.after
        } else if (mode === 'replaced-after-sync') {
          fsFault.replaceAfterFileSyncPath = review.stagingPath
        } else if (mode === 'grown-during-read') {
          fsFault.growBeforeReadPath = review.stagingPath
        }
      })
      await expect(apply(item, staging, 'Archive'), mode).rejects.toThrow(
        mode === 'oversized' || mode === 'grown-during-read'
          ? 'promotion stage conflict'
          : mode === 'replaced' ? 'promotion stage identity changed while opening' : 'promotion stage identity changed while syncing',
      )
      expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
      expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
      expect(existsSync(item.candidateFull)).toBe(true)
      expect(readJournal(item).state).toBe('rolled-back')
    }
  })

  it.each(['open', 'read', 'sync'] as const)('refuses full-precision metadata changes in a matching promotion stage: %s', async (operation) => {
    const item = fixture(), reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const ino = 9007199254740992n, mtimeNs = 1_700_000_000_000_000_000n
    expect(Number(ino)).toBe(Number(ino + 1n))
    expect(Number(mtimeNs) / 1_000_000).toBe(Number(mtimeNs + 1n) / 1_000_000)
    const staging = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'journal-persisted') return
      const review = operationOf(core, 'review')
      if (review.stagingPath === undefined || review.after === undefined) throw new Error('prepared review operation lacks its stage')
      writeFileSync(review.stagingPath, review.after)
      preciseStageMetadata.set(review.stagingPath, { ino, mtimeNs })
      fsFault.precisionChange = { path: review.stagingPath, operation,
        metadata: operation === 'read' ? { ino, mtimeNs: mtimeNs + 1n } : { ino: ino + 1n, mtimeNs } }
    })
    await expect(apply(item, staging, 'Archive')).rejects.toThrow(operation === 'open'
      ? 'promotion stage identity changed while opening' : operation === 'read'
        ? 'promotion stage conflict' : 'promotion stage identity changed while syncing')
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readJournal(item).state).toBe('rolled-back')
  })

  it('repairs a committed canonical Promote only with its authenticated measured-trial fixture', async () => {
    const item = fixture()
    const measured = await prepareCanonicalPromotion(item)
    expect(await apply(item, authority, 'Promote', 'human', measured.reader)).toBe(true)
    const journal = readJournal(item)
    expect(journal.state).toBe('committed')
    const target = readItems(item.reviewFile)[0]!.targetPath
    if (target === undefined) throw new Error('canonical Promote did not bind a target')
    const targetFull = join(item.wikiRoot, target)
    expect(readFileSync(targetFull)).toEqual(measured.targetAfter)

    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const before = readFileSync(eventPath, 'utf8').trimEnd().split('\n')
    const promoted = before.filter(line => (JSON.parse(line) as { type: string }).type === 'knowledge/promoted')
    expect(promoted).toHaveLength(1)
    writeFileSync(eventPath, `${before.filter(line => (JSON.parse(line) as { type: string }).type !== 'knowledge/promoted').join('\n')}\n`, 'utf8')

    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot, measured.reader,
    )).toBe(1)
    const repaired = readFileSync(eventPath, 'utf8').trimEnd().split('\n')
      .map(line => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter(event => event.type === 'knowledge/promoted')
    expect(repaired).toHaveLength(1)
    expect(repaired[0]!.payload).toMatchObject({ candidateHash: journal.candidateHash, action: 'Promote' })
    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot, measured.reader,
    )).toBe(0)
  })

  it('rejects committed canonical Promote journals that omit a target or measured trial binding', async () => {
    for (const missing of ['target', 'trial'] as const) {
      const item = fixture()
      const measured = await prepareCanonicalPromotion(item)
      expect(await apply(item, authority, 'Promote', 'human', measured.reader)).toBe(true)
      const journal = readJournal(item)
      resealJournal(item, journal, (core) => {
        if (missing === 'target') core.targetPath = null
        else (core as JournalCore & { measuredTrial?: unknown }).measuredTrial = null
      }, 'committed')
      const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
      const before = [readFileSync(eventPath), readFileSync(item.reviewFile)]

      await expect(recoverCandidateReviewTransactions(
        authority, item.reviewFile, item.wikiRoot, item.archiveRoot, measured.reader,
      ), missing).rejects.toThrow('promotion journal lacks its canonical measured-trial event binding')
      expect([readFileSync(eventPath), readFileSync(item.reviewFile)]).toEqual(before)
      expect(existsSync(item.candidateFull)).toBe(false)
    }
  })

  it('rejects committed canonical WALs that omit their target or measured trial', async () => {
    for (const missing of ['target', 'trial'] as const) {
      const item = fixture()
      const measured = await prepareCanonicalPromotion(item)
      expect(await apply(item, authority, 'Promote', 'human', measured.reader)).toBe(true)
      const journal = readJournal(item)
      resealJournal(item, journal, (core) => {
        if (missing === 'target') core.targetPath = null
        else (core as JournalCore & { measuredTrial?: unknown }).measuredTrial = null
      }, 'committed')
      const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
      const eventBefore = readFileSync(eventPath, 'utf8')
      const reviewBefore = readFileSync(item.reviewFile, 'utf8')

      await expect(recoverCandidateReviewTransactions(
        authority, item.reviewFile, item.wikiRoot, item.archiveRoot, measured.reader,
      ), missing).rejects.toThrow('promotion journal lacks its canonical measured-trial event binding')
      expect(readFileSync(eventPath, 'utf8')).toBe(eventBefore)
      expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
      expect(existsSync(item.candidateFull)).toBe(false)
    }
  })

  it('refuses committed canonical Promote repair after the measured target diverges', async () => {
    const item = fixture()
    const measured = await prepareCanonicalPromotion(item)
    expect(await apply(item, authority, 'Promote', 'human', measured.reader)).toBe(true)
    const target = readItems(item.reviewFile)[0]!.targetPath
    if (target === undefined) throw new Error('canonical Promote did not bind a target')
    const targetFull = join(item.wikiRoot, target)
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const lines = readFileSync(eventPath, 'utf8').trimEnd().split('\n')
    writeFileSync(eventPath, `${lines.filter(line => (JSON.parse(line) as { type: string }).type !== 'knowledge/promoted').join('\n')}\n`, 'utf8')
    writeFileSync(targetFull, 'divergent canonical bytes\n', 'utf8')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const eventBefore = readFileSync(eventPath, 'utf8')

    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot, measured.reader,
    )).rejects.toThrow('promotion journal divergent state')
    expect(readFileSync(targetFull, 'utf8')).toBe('divergent canonical bytes\n')
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventBefore)
  })

  it('requires the original authenticated measured-trial reader to repair a committed Promote', async () => {
    const item = fixture()
    const measured = await prepareCanonicalPromotion(item)
    expect(await apply(item, authority, 'Promote', 'human', measured.reader)).toBe(true)
    const target = readItems(item.reviewFile)[0]!.targetPath
    if (target === undefined) throw new Error('canonical Promote did not bind a target')
    const targetBefore = readFileSync(join(item.wikiRoot, target))
    const eventPath = removePromotedEvent(item)
    const eventBefore = readFileSync(eventPath, 'utf8')
    const journalBefore = readFileSync(join(journalDirectory(item), journalFiles(item)[0]!))

    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('committed promotion journal lacks an authenticated measured-trial receipt')
    expect(readFileSync(join(item.wikiRoot, target))).toEqual(targetBefore)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventBefore)
    expect(readFileSync(join(journalDirectory(item), journalFiles(item)[0]!))).toEqual(journalBefore)
  })

  it('refuses committed Promote repair when a valid signer wait invalidates trial eligibility', async () => {
    const item = fixture()
    const measured = await prepareCanonicalPromotion(item)
    expect(await apply(item, authority, 'Promote', 'human', measured.reader)).toBe(true)
    const eventPath = removePromotedEvent(item)
    const eventBefore = readFileSync(eventPath, 'utf8')
    const journalPath = join(journalDirectory(item), journalFiles(item)[0]!)
    const journalBefore = readFileSync(journalPath, 'utf8')
    const target = readItems(item.reviewFile)[0]!.targetPath
    if (target === undefined) throw new Error('canonical Promote did not bind a target')
    const targetPath = join(item.wikiRoot, target)
    const targetBefore = sha256(readFileSync(targetPath))
    let eligible = true
    const changingReader: KnowledgeWikiMeasuredTrialReader = {
      authorityId: measured.reader.authorityId,
      read(hash, binding) {
        const value = measured.reader.read(hash, binding)
        return value === undefined || eligible ? value : { ...value, eligibleForReview: false }
      },
    }
    let signed = false
    const signer: KnowledgeWikiVerifierAuthority = {
      ...authority,
      sealPromotion(request) {
        const seal = authority.sealPromotion(request)
        if (request.operation === 'seal-knowledge-event') {
          signed = true
          eligible = false
        }
        return seal
      },
    }

    await expect(recoverCandidateReviewTransactions(
      signer, item.reviewFile, item.wikiRoot, item.archiveRoot, changingReader,
    )).rejects.toThrow('committed promotion journal changed during event signing')
    expect(signed).toBe(true)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventBefore)
    expect(readFileSync(journalPath, 'utf8')).toBe(journalBefore)
    expect(sha256(readFileSync(targetPath))).toBe(targetBefore)
  })

  it('counts no new recovery when the exact promoted event appears at the final namespace sync', async () => {
    const item = fixture()
    const measured = await prepareCanonicalPromotion(item)
    expect(await apply(item, authority, 'Promote', 'human', measured.reader)).toBe(true)
    const eventPath = removePromotedEvent(item)
    let injected = false
    const racingSigner: KnowledgeWikiVerifierAuthority = {
      ...authority,
      sealPromotion(request) {
        const seal = authority.sealPromotion(request)
        if (request.operation !== 'seal-knowledge-event') return seal
        const prior = readKnowledgeEventLog(eventPath, authority)
        const event = createKnowledgeEvent(
          request.eventType,
          request.knowledgeId,
          { projectId: item.root, visibility: 'project' },
          { ...request.payload, authorityId: authority.authorityId, authoritySeal: seal },
          { seq: prior.length, previousEventHash: prior.at(-1)?.eventHash ?? null },
        )
        fsFault.appendEventAtDirectorySync = {
          directory: dirname(eventPath),
          path: eventPath,
          line: `${JSON.stringify(event)}\n`,
        }
        injected = true
        return seal
      },
    }

    expect(await recoverCandidateReviewTransactions(
      racingSigner, item.reviewFile, item.wikiRoot, item.archiveRoot, measured.reader,
    )).toBe(0)
    expect(injected).toBe(true)
    expect(fsFault.appendEventAtDirectorySync).toBeUndefined()
    const promoted = readKnowledgeEventLog(eventPath, authority).filter(event => event.type === 'knowledge/promoted')
    expect(promoted).toHaveLength(1)
    expect(readJournal(item).state).toBe('committed')
  })

  it('leaves a committed canonical Promote for retry when the event signer refuses', async () => {
    const item = fixture()
    const measured = await prepareCanonicalPromotion(item)
    expect(await apply(item, authority, 'Promote', 'human', measured.reader)).toBe(true)
    const eventPath = removePromotedEvent(item)
    const eventBefore = readFileSync(eventPath, 'utf8')
    const refusingSigner: KnowledgeWikiVerifierAuthority = {
      ...authority,
      sealPromotion: () => ({ authorityId: authority.authorityId, proof: '' }),
    }

    await expect(recoverCandidateReviewTransactions(
      refusingSigner, item.reviewFile, item.wikiRoot, item.archiveRoot, measured.reader,
    )).rejects.toThrow('promotion event signing failed during committed recovery')
    expect(readFileSync(eventPath, 'utf8')).toBe(eventBefore)
    expect(readJournal(item).state).toBe('committed')
  })

  it('skips a committed canonical event repair if its generation closes while signing', async () => {
    const item = fixture()
    const measured = await prepareCanonicalPromotion(item)
    expect(await apply(item, authority, 'Promote', 'human', measured.reader)).toBe(true)
    const eventPath = removePromotedEvent(item)
    const eventBefore = readFileSync(eventPath, 'utf8')
    let current = true
    const closingSigner: KnowledgeWikiVerifierAuthority = {
      ...authority,
      sealPromotion(request) {
        const seal = authority.sealPromotion(request)
        current = false
        return seal
      },
    }

    expect(await recoverCandidateReviewTransactions(
      closingSigner, item.reviewFile, item.wikiRoot, item.archiveRoot, measured.reader, () => current,
    )).toBe(0)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventBefore)
    expect(readJournal(item).state).toBe('committed')
  })

  it('rejects a committed canonical event repair if its WAL changes while signing', async () => {
    const item = fixture()
    const measured = await prepareCanonicalPromotion(item)
    expect(await apply(item, authority, 'Promote', 'human', measured.reader)).toBe(true)
    const eventPath = removePromotedEvent(item)
    const eventBefore = readFileSync(eventPath, 'utf8')
    const journalPath = join(journalDirectory(item), journalFiles(item)[0]!)
    const signingAuthority: KnowledgeWikiVerifierAuthority = {
      ...authority,
      sealPromotion(request) {
        const seal = authority.sealPromotion(request)
        writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}\n`, 'utf8')
        return seal
      },
    }

    await expect(recoverCandidateReviewTransactions(
      signingAuthority, item.reviewFile, item.wikiRoot, item.archiveRoot, measured.reader,
    )).rejects.toThrow('committed promotion journal or event state changed during recovery')
    expect(readFileSync(eventPath, 'utf8')).toBe(eventBefore)
    expect(readJournal(item).state).toBe('committed')
  })

  it('rejects a committed canonical event repair if the event log changes while signing', async () => {
    const item = fixture()
    const measured = await prepareCanonicalPromotion(item)
    expect(await apply(item, authority, 'Promote', 'human', measured.reader)).toBe(true)
    const eventPath = removePromotedEvent(item)
    const eventBefore = readFileSync(eventPath, 'utf8')
    const signingAuthority: KnowledgeWikiVerifierAuthority = {
      ...authority,
      sealPromotion(request) {
        const seal = authority.sealPromotion(request)
        writeFileSync(eventPath, `${eventBefore}\n`, 'utf8')
        return seal
      },
    }

    await expect(recoverCandidateReviewTransactions(
      signingAuthority, item.reviewFile, item.wikiRoot, item.archiveRoot, measured.reader,
    )).rejects.toThrow('committed promotion journal or event state changed during recovery')
    expect(readFileSync(eventPath, 'utf8')).toBe(`${eventBefore}\n`)
    expect(readJournal(item).state).toBe('committed')
  })

  it('waits for an external owner to remove a post-commit stage before committing the WAL', async () => {
    const item = fixture()
    await verify(item)
    let stagePath = ''
    const interference = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'before-commit-marker') return
      const review = operationOf(core, 'review')
      if (review.stagingPath === undefined || review.after === undefined) throw new Error('review stage is not bound')
      stagePath = review.stagingPath
      writeFileSync(stagePath, review.after, 'utf8')
    })

    await expect(apply(item, interference, 'Archive')).rejects.toThrow('promotion post-commit stage remains')
    expect(readJournal(item).state).toBe('prepared')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    expect(readFileSync(eventPath, 'utf8').match(/knowledge\/rejected/g)).toHaveLength(1)
    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('promotion post-commit stage remains')
    expect(readFileSync(eventPath, 'utf8').match(/knowledge\/rejected/g)).toHaveLength(1)

    unlinkSync(stagePath)
    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(1)
    expect(readJournal(item).state).toBe('committed')
    expect(readFileSync(eventPath, 'utf8').match(/knowledge\/rejected/g)).toHaveLength(1)
  })

  it('cleans a durable stale tombstone during prepared recovery without duplicating the event', async () => {
    const item = fixture()
    await verify(item)
    const interference = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'before-commit-marker') return
      const candidate = operationOf(core, 'candidate')
      if (candidate.tombstonePath === undefined || candidate.before === undefined) throw new Error('candidate tombstone is not bound')
      writeFileSync(candidate.tombstonePath, candidate.before, 'utf8')
    })

    await expect(apply(item, interference, 'Archive')).rejects.toThrow('promotion post-commit tombstone remains')
    expect(readJournal(item).state).toBe('prepared')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    expect(readFileSync(eventPath, 'utf8').match(/knowledge\/rejected/g)).toHaveLength(1)

    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(1)
    expect(readJournal(item).state).toBe('committed')
    expect(walLeftovers(item.root)).toEqual([])
    expect(readFileSync(eventPath, 'utf8').match(/knowledge\/rejected/g)).toHaveLength(1)
  })

  it('replays an event-complete normal commit when its prepared WAL changes at the marker checkpoint', async () => {
    const item = fixture()
    await verify(item)
    const interference = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'before-commit-marker') return
      const journalPath = join(journalDirectory(item), `${core.id}.json`)
      writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}\n`, 'utf8')
    })

    await expect(apply(item, interference, 'Archive')).rejects.toThrow('promotion journal changed before commit marker')
    expect(readJournal(item).state).toBe('prepared')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    expect(readFileSync(eventPath, 'utf8').match(/knowledge\/rejected/g)).toHaveLength(1)
    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(1)
    expect(readJournal(item).state).toBe('committed')
    expect(readFileSync(eventPath, 'utf8').match(/knowledge\/rejected/g)).toHaveLength(1)
  })

  it('refuses the prepared recovery marker when the signed WAL changes at its checkpoint', async () => {
    const item = fixture()
    await verify(item)
    const journal = await interruptAtJournalPersistence(item, 'Archive')
    const mutatingRecovery = checkpointAuthority((_core, checkpoint) => {
      if (checkpoint.phase !== 'before-commit-marker') return
      const journalPath = join(journalDirectory(item), `${journal.id}.json`)
      writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}\n`, 'utf8')
    })

    await expect(recoverCandidateReviewTransactions(
      mutatingRecovery, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('promotion journal changed before commit marker')
    expect(readJournal(item).state).toBe('prepared')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    expect(readFileSync(eventPath, 'utf8').match(/knowledge\/rejected/g)).toHaveLength(1)
    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(1)
    expect(readJournal(item).state).toBe('committed')
    expect(readFileSync(eventPath, 'utf8').match(/knowledge\/rejected/g)).toHaveLength(1)
  })

  it('rolls back a legacy prepared canonical WAL that has only a semantic verifier receipt', async () => {
    const item = fixture()
    const receiptId = issueTestReceipt(authority, item.reviewFile, item.wikiRoot, item.reviewId, 'Promote')
    const receipt = readTrustedReceipt(authority, item.reviewFile, receiptId)
    if (receipt === undefined) throw new Error('test verifier receipt is not authentic')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const targetPath = readItems(item.reviewFile)[0]!.targetPath!
    const targetFull = join(item.wikiRoot, targetPath)
    const transactionId = `promotion-${'a'.repeat(24)}`
    const canonicalAfter = 'legacy semantic-only canonical bytes\n'
    const candidateTombstone = join(dirname(item.candidateFull), '.closure.md.ark-wal-delete-legacy')
    const operations: JournalOperation[] = [
      {
        role: 'canonical', path: targetFull, after: canonicalAfter,
        stagingPath: join(dirname(targetFull), '.closure.md.ark-wal-stage-legacy'),
      },
      {
        role: 'review', path: item.reviewFile, before: reviewBefore, after: reviewBefore,
        stagingPath: join(dirname(item.reviewFile), '.review.json.ark-wal-stage-legacy'),
      },
      { role: 'candidate', path: item.candidateFull, before: candidateBefore, tombstonePath: candidateTombstone },
    ]
    const core: JournalCore = {
      schemaVersion: 1,
      id: transactionId,
      reviewId: item.reviewId,
      candidateHash: sha256(candidateBefore),
      createdAt: new Date().toISOString(),
      action: 'Promote',
      targetPath,
      reviewHash: receipt.request.reviewHash,
      receiptId: receipt.id,
      receiptHash: receipt.receiptHash,
      operationSetHash: sha256(canonicalJson(operations)),
      operations,
    }
    const directory = journalDirectory(item)
    mkdirSync(dirname(targetFull), { recursive: true })
    mkdirSync(directory, { recursive: true })
    writeFileSync(targetFull, canonicalAfter, 'utf8')
    unlinkSync(item.candidateFull)
    writeFileSync(candidateTombstone, candidateBefore, 'utf8')
    writeFileSync(join(directory, `${transactionId}.json`), JSON.stringify({
      ...core,
      state: 'prepared',
      seal: authority.sealPromotion({
        schemaVersion: 1, domain: 'ark.knowledge-wiki', authorityId: authority.authorityId,
        operation: 'seal-promotion-wal', journal: core as unknown as PromotionJournalSigningPayload,
      }),
    }), 'utf8')

    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(1)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(existsSync(targetFull)).toBe(false)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(existsSync(candidateTombstone)).toBe(false)
    expect(readJournal(item).state).toBe('rolled-back')
    expect(readFileSync(join(dirname(item.reviewFile), 'knowledge-events.jsonl'), 'utf8'))
      .toContain('missing-authenticated-measured-trial')
    expect(receipt.request.reviewHash).toBe(sha256(canonicalJson(immutableReviewRow(readItems(item.reviewFile)[0]!))))
  })

  it('does not publish a rolled-back marker until rollback operation directories sync', async () => {
    const item = fixture()
    const measured = await prepareCanonicalPromotion(item)
    const stopping = checkpointAuthority((_core, checkpoint) => {
      if (checkpoint.phase === 'journal-persisted') throw STOP_AFTER_JOURNAL
    })
    await expect(apply(item, stopping, 'Promote', 'human', measured.reader)).rejects.toThrow(STOP_AFTER_JOURNAL)
    mkdirSync(join(item.wikiRoot, 'concepts'), { recursive: true })
    mkdirSync(dirname(operationOf(readJournal(item), 'candidate-archive').path), { recursive: true })
    const untrustedReader: KnowledgeWikiMeasuredTrialReader = { ...measured.reader, authorityId: authority.authorityId }
    fsFault.mode = 'eio'
    try {
      await expect(recoverCandidateReviewTransactions(
        authority, item.reviewFile, item.wikiRoot, item.archiveRoot, untrustedReader,
      )).rejects.toThrow('EIO: fsync fault')
    } finally { fsFault.mode = 'none' }
    expect(readJournal(item).state).toBe('prepared')
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)

    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot, untrustedReader,
    )).toBe(1)
    expect(readJournal(item).state).toBe('rolled-back')
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('refuses a promotion journal path that is not an ordinary directory', async () => {
    const file = fixture()
    mkdirSync(journalDirectory(file), { recursive: true })
    rmSync(journalDirectory(file), { recursive: true, force: true })
    writeFileSync(journalDirectory(file), 'not a directory', 'utf8')
    await expect(recoverCandidateReviewTransactions(
      authority, file.reviewFile, file.wikiRoot, file.archiveRoot,
    )).rejects.toThrow('unsafe promotion journal directory')
    expect(readFileSync(journalDirectory(file), 'utf8')).toBe('not a directory')

    const linked = fixture()
    const outside = join(linked.root, 'outside-journal')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, journalDirectory(linked), 'dir')
    await expect(recoverCandidateReviewTransactions(
      authority, linked.reviewFile, linked.wikiRoot, linked.archiveRoot,
    )).rejects.toThrow('unsafe promotion journal directory')
    expect(readdirSync(outside)).toEqual([])
  })

  it('propagates a journal directory failure that is not a missing path', async () => {
    const item = fixture()
    mkdirSync(journalDirectory(item), { recursive: true })
    fsFault.readdirFailurePath = journalDirectory(item)
    try {
      const failure = await captureFailure(() => recoverCandidateReviewTransactions(
        authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
      ))
      expect(failure).toMatchObject({ code: 'EACCES' })
      expect(fsFault.readdirFailureCalls).toBe(1)
    } finally {
      fsFault.readdirFailurePath = undefined
    }
  })

  it('skips journal records that are not prepared schema-version 1 transactions', async () => {
    const item = fixture()
    const directory = journalDirectory(item)
    mkdirSync(directory, { recursive: true })
    const records = [
      '123',
      'null',
      '{"schemaVersion": 2, "id": "legacy", "state": "prepared", "operations": []}',
      '{"schemaVersion": 1, "id": "bad id!", "state": "prepared", "operations": []}',
      '{"schemaVersion": 1, "id": "settled", "state": "committed", "operations": []}',
      '{"schemaVersion": 1, "id": "malformed", "state": "prepared", "operations": "nope"}',
    ]
    for (const [index, record] of records.entries()) {
      writeFileSync(join(directory, `${index}.json`), record, 'utf8')
    }

    expect(await recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(0)
    for (const [index, record] of records.entries()) {
      expect(readFileSync(join(directory, `${index}.json`), 'utf8')).toBe(record)
    }
    expect(existsSync(item.candidateFull)).toBe(true)
  })
})

describe('legacy candidate decisions and authority ownership', () => {
  it('keeps hash-bound Archive available for legacy rows without lifecycle projections', async () => {
    const item = fixture()
    unlinkSync(join(dirname(item.reviewFile), 'knowledge-events.jsonl'))

    expect(await apply(item, authority, 'Archive')).toBe(true)
    expect(readItems(item.reviewFile)[0]).toMatchObject({ resolved: true, resolvedAction: 'Archive' })
    expect(existsSync(item.candidateFull)).toBe(false)
  })

  it('does not let the governance agent apply a human-only canonical promotion', async () => {
    const item = fixture()
    await verify(item)

    expect(await apply(item, authority, 'Promote', 'governance-agent')).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
  })
})

describe('prepared journal revalidation', () => {
  it('fails closed when a prepared journal file diverged from its recorded state', async () => {
    const item = fixture()
    await verify(item)
    const journal = await interruptAtJournalPersistence(item, 'Archive')
    const target = operationOf(journal, 'candidate-archive')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    mkdirSync(dirname(target.path), { recursive: true })
    writeFileSync(target.path, 'divergent canonical bytes', 'utf8')

    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow(/divergent state/u)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(readJournal(item).state).toBe('prepared')
  })

  it('fails closed when a prepared journal stage diverged from its recorded bytes', async () => {
    const item = fixture()
    await verify(item)
    const journal = await interruptAtJournalPersistence(item, 'Archive')
    const review = operationOf(journal, 'review')
    if (review.stagingPath === undefined) throw new Error('review operation has no staging path')
    writeFileSync(review.stagingPath, 'divergent stage bytes', 'utf8')

    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow(/divergent stage/u)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(review.before)
    expect(readJournal(item).state).toBe('prepared')
  })

  it('fails closed when a prepared journal tombstone diverged from its recorded bytes', async () => {
    const item = fixture()
    await verify(item)
    const journal = await interruptAtJournalPersistence(item, 'Archive')
    const candidateOperation = operationOf(journal, 'candidate')
    if (candidateOperation.tombstonePath === undefined) throw new Error('candidate operation has no tombstone path')
    writeFileSync(candidateOperation.tombstonePath, 'divergent tombstone bytes', 'utf8')

    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow(/divergent tombstone/u)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateOperation.before)
    expect(readJournal(item).state).toBe('prepared')
  })

  it('refuses to recover a prepared journal without an authority', async () => {
    const item = fixture()
    await verify(item)
    const journal = await interruptAtJournalPersistence(item, 'Archive')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')

    await expect(recoverCandidateReviewTransactions(
      undefined, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('promotion journal authority validation failed')
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(operationOf(journal, 'candidate').before)
    expect(readJournal(item).state).toBe('prepared')
  })

  it('refuses an authentically sealed journal without immutable pre-state', async () => {
    const item = fixture()
    await verify(item)
    const journal = await interruptAtJournalPersistence(item, 'Archive')
    const review = operationOf(journal, 'review')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')

    resealJournal(item, journal, (core) => {
      core.operations = core.operations.map(operation => operation.role === 'review'
        ? {
          role: operation.role,
          path: operation.path,
          ...(operation.after !== undefined ? { after: operation.after } : {}),
          ...(operation.stagingPath !== undefined ? { stagingPath: operation.stagingPath } : {}),
        }
        : operation)
    })
    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('promotion journal lacks immutable pre-state')
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(review.before).toBeDefined()
  })

  it('completes the promotion when the directory fsync fails with EPERM like windows', async () => {
    const item = fixture()
    await verify(item)
    await interruptAtJournalPersistence(item, 'Archive')
    fsFault.mode = 'eperm'
    try {
      await expect(recoverCandidateReviewTransactions(authority, item.reviewFile, item.wikiRoot, item.archiveRoot)).resolves.toBe(1)
      expect(readItems(item.reviewFile)[0]?.resolved).toBe(true)
    } finally { fsFault.mode = 'none' }
  })

  it('surfaces a non-EPERM directory fsync failure instead of completing the promotion', async () => {
    const item = fixture()
    await verify(item)
    await interruptAtJournalPersistence(item, 'Archive')
    fsFault.mode = 'eio'
    try {
      await expect(recoverCandidateReviewTransactions(authority, item.reviewFile, item.wikiRoot, item.archiveRoot))
        .rejects.toThrow('EIO: fsync fault')
    } finally { fsFault.mode = 'none' }
  })

  it('refuses an authentically sealed journal whose review pre-state is not an array', async () => {
    const item = fixture()
    await verify(item)
    const journal = await interruptAtJournalPersistence(item, 'Archive')

    resealJournal(item, journal, (core) => {
      core.operations = core.operations.map(operation =>
        operation.role === 'review' ? { ...operation, before: '{}' } : operation)
    })
    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('promotion journal review pre-state is invalid')
    expect(readJournal(item).state).toBe('prepared')
  })

  it('refuses an authentically sealed journal whose candidate binding does not hold', async () => {
    const missingRow = fixture()
    await verify(missingRow)
    const missingJournal = await interruptAtJournalPersistence(missingRow, 'Archive')
    resealJournal(missingRow, missingJournal, (core) => {
      core.operations = core.operations.map(operation =>
        operation.role === 'review' ? { ...operation, before: '[]' } : operation)
    })
    await expect(recoverCandidateReviewTransactions(
      authority, missingRow.reviewFile, missingRow.wikiRoot, missingRow.archiveRoot,
    )).rejects.toThrow('promotion journal candidate binding failed')

    const rebind = fixture()
    await verify(rebind)
    const rebindJournal = await interruptAtJournalPersistence(rebind, 'Archive')
    resealJournal(rebind, rebindJournal, (core) => {
      core.candidateHash = 'f'.repeat(64)
    })
    await expect(recoverCandidateReviewTransactions(
      authority, rebind.reviewFile, rebind.wikiRoot, rebind.archiveRoot,
    )).rejects.toThrow('promotion journal candidate binding failed')
    expect(existsSync(rebind.candidateFull)).toBe(true)
  })

  it('refuses an authentically sealed journal whose receipt binding is incomplete', async () => {
    const unbound = fixture()
    const unboundJournal = await interruptAtJournalPersistence(unbound, 'Archive')
    resealJournal(unbound, unboundJournal, (core) => {
      core.receiptId = null
      core.action = 'Promote'
    })
    await expect(recoverCandidateReviewTransactions(
      authority, unbound.reviewFile, unbound.wikiRoot, unbound.archiveRoot,
    )).rejects.toThrow('promotion journal receipt binding is incomplete')

    const unlisted = fixture()
    const unlistedJournal = await interruptAtJournalPersistence(unlisted, 'Archive')
    resealJournal(unlisted, unlistedJournal, (core) => {
      core.action = 'Skip'
    })
    await expect(recoverCandidateReviewTransactions(
      authority, unlisted.reviewFile, unlisted.wikiRoot, unlisted.archiveRoot,
    )).rejects.toThrow('promotion governance decision does not bind the signed journal')
    expect(readJournal(unlisted).state).toBe('prepared')
  })

  it('refuses a sealed journal whose auxiliary path left its operation parent', async () => {
    const item = fixture()
    await verify(item)
    const journal = await interruptAtJournalPersistence(item, 'Archive')
    resealJournal(item, journal, (core) => {
      core.operations = core.operations.map(operation => operation.role === 'candidate-archive'
        ? { ...operation, stagingPath: join(item.wikiRoot, '.ark-wal-stage-elsewhere') }
        : operation)
    })

    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('promotion auxiliary path changed parent')
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readJournal(item).state).toBe('prepared')
  })

  it('refuses a sealed journal whose delete operation lost its tombstone path', async () => {
    const item = fixture()
    await verify(item)
    const journal = await interruptAtJournalPersistence(item, 'Archive')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    resealJournal(item, journal, (core) => {
      const candidate = operationOf(core, 'candidate')
      const withoutTombstone: JournalOperation = {
        role: candidate.role,
        path: candidate.path,
        ...(candidate.before === undefined ? {} : { before: candidate.before }),
        ...(candidate.after === undefined ? {} : { after: candidate.after }),
        ...(candidate.stagingPath === undefined ? {} : { stagingPath: candidate.stagingPath }),
      }
      core.operations = [withoutTombstone, ...core.operations.filter(operation => operation.role !== 'candidate')]
    })

    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('promotion delete lacks a tombstone path')
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
  })

  it('refuses a sealed journal whose write operation lost its staging path', async () => {
    const item = fixture()
    await verify(item)
    const journal = await interruptAtJournalPersistence(item, 'Archive')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    resealJournal(item, journal, (core) => {
      const review = operationOf(core, 'review')
      const withoutStage: JournalOperation = {
        role: review.role,
        path: review.path,
        ...(review.before === undefined ? {} : { before: review.before }),
        ...(review.after === undefined ? {} : { after: review.after }),
        ...(review.tombstonePath === undefined ? {} : { tombstonePath: review.tombstonePath }),
      }
      core.operations = [withoutStage, ...core.operations.filter(operation => operation.role !== 'review')]
    })

    await expect(recoverCandidateReviewTransactions(
      authority, item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).rejects.toThrow('promotion write lacks a staging path')
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
  })
})

describe('promotion transaction interference', () => {
  it('refuses a stage entry that external bytes already occupy and rolls back cleanly', async () => {
    const item = fixture()
    await verify(item)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'journal-persisted') return
      const review = operationOf(core, 'review')
      if (review.stagingPath === undefined) throw new Error('review operation has no staging path')
      writeFileSync(review.stagingPath, 'conflicting stage bytes', 'utf8')
    })

    await expect(apply(item, mutating, 'Archive')).rejects.toThrow(/promotion stage conflict/u)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(readJournal(item).state).toBe('rolled-back')
    expect(walLeftovers(item.root)).toEqual([])
  })

  it('restores durable state when the candidate reappears before the commit marker', async () => {
    const item = fixture()
    await verify(item)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'operation-applied' || checkpoint.operationIndex !== core.operations.length - 1) return
      const candidateOperation = operationOf(core, 'candidate')
      if (candidateOperation.before === undefined) throw new Error('candidate operation has no pre-state')
      writeFileSync(candidateOperation.path, candidateOperation.before, 'utf8')
    })

    await expect(apply(item, mutating, 'Archive')).rejects.toThrow(/promotion post-commit mismatch/u)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(readJournal(item).state).toBe('rolled-back')
    expect(walLeftovers(item.root)).toEqual([])
  })

  it('reports an incomplete rollback when a divergent tombstone blocks the delete', async () => {
    const item = fixture()
    await verify(item)
    const mutating = checkpointAuthority((core, checkpoint) => {
      const candidateOperation = operationOf(core, 'candidate')
      if (checkpoint.phase !== 'operation-applied'
        || checkpoint.operationIndex !== core.operations.findIndex(operation => operation.role === 'governance')) return
      if (candidateOperation.tombstonePath === undefined) throw new Error('candidate operation has no tombstone path')
      unlinkSync(candidateOperation.path)
      writeFileSync(candidateOperation.tombstonePath, 'divergent tombstone bytes', 'utf8')
    })

    const failure = await captureFailure(() => apply(item, mutating, 'Archive'))
    expect(aggregateMessages(failure)).toEqual([
      expect.stringMatching(/promotion tombstone conflict at /u),
      expect.stringMatching(/promotion rollback tombstone conflict at /u),
    ])
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
  })

  it('reports an incomplete rollback when the delete tombstone already exists', async () => {
    const item = fixture()
    await verify(item)
    const mutating = checkpointAuthority((core, checkpoint) => {
      const candidateOperation = operationOf(core, 'candidate')
      if (checkpoint.phase !== 'operation-applied'
        || checkpoint.operationIndex !== core.operations.findIndex(operation => operation.role === 'governance')) return
      if (candidateOperation.tombstonePath === undefined || candidateOperation.before === undefined) {
        throw new Error('candidate operation has no delete pre-state')
      }
      writeFileSync(candidateOperation.tombstonePath, candidateOperation.before, 'utf8')
    })

    const failure = await captureFailure(() => apply(item, mutating, 'Archive'))
    expect(aggregateMessages(failure)).toEqual([
      expect.stringMatching(/promotion tombstone already exists: /u),
      expect.stringMatching(/promotion rollback tombstone conflict at /u),
    ])
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
  })

  it('reports an incomplete rollback when the tombstone identity changes under the transaction', async () => {
    const item = fixture()
    await verify(item)
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'entry-renamed'
        || checkpoint.operationIndex !== core.operations.findIndex(operation => operation.role === 'candidate')) return
      const candidateOperation = operationOf(core, 'candidate')
      if (candidateOperation.tombstonePath === undefined) throw new Error('candidate operation has no tombstone path')
      writeFileSync(candidateOperation.tombstonePath, 'tampered tombstone bytes', 'utf8')
    })

    const failure = await captureFailure(() => apply(item, mutating, 'Archive'))
    expect(aggregateMessages(failure)).toEqual([
      expect.stringMatching(/promotion tombstone identity changed: /u),
      expect.stringMatching(/promotion rollback tombstone conflict at /u),
    ])
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
  })

  it('restores a renamed candidate entry when its checkpoint fails', async () => {
    const item = fixture()
    await verify(item)
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const checkpointFailure = new Error('audit checkpoint unavailable')
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase === 'entry-renamed'
        && checkpoint.operationIndex === core.operations.findIndex(operation => operation.role === 'candidate')) {
        throw checkpointFailure
      }
    })

    await expect(apply(item, mutating, 'Archive')).rejects.toThrow(checkpointFailure)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(readJournal(item).state).toBe('rolled-back')
    expect(walLeftovers(item.root)).toEqual([])
  })

  it('fails closed when the canonical target diverges during the operation set', async () => {
    const item = fixture()
    await verify(item)
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'journal-persisted') return
      const target = operationOf(core, 'candidate-archive')
      mkdirSync(dirname(target.path), { recursive: true })
      writeFileSync(target.path, 'divergent canonical bytes', 'utf8')
    })

    const failure = await captureFailure(() => apply(item, mutating, 'Archive'))
    expect(aggregateMessages(failure)).toEqual([
      expect.stringMatching(/promotion recovery conflict at /u),
      expect.stringMatching(/promotion rollback conflict at /u),
    ])
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
  })

  it('fails closed when the governance log diverges during the operation set', async () => {
    const item = fixture()
    await verify(item)
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'journal-persisted') return
      writeFileSync(operationOf(core, 'governance').path, 'divergent governance bytes\n', 'utf8')
    })

    const failure = await captureFailure(() => apply(item, mutating, 'Archive'))
    expect(aggregateMessages(failure)).toEqual([
      expect.stringMatching(/promotion recovery conflict at /u),
      expect.stringMatching(/promotion rollback conflict at /u),
    ])
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
  })

  it('fails closed when staged bytes vanish before their rename', async () => {
    const item = fixture()
    await verify(item)
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'stage-written') return
      const operation = core.operations[checkpoint.operationIndex]
      if (operation?.role !== 'candidate-archive' || operation.stagingPath === undefined) return
      unlinkSync(operation.stagingPath)
    })

    await expect(apply(item, mutating, 'Archive')).rejects.toThrow(/ENOENT/u)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(existsSync(item.candidateFull)).toBe(true)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(readJournal(item).state).toBe('rolled-back')
    expect(walLeftovers(item.root)).toEqual([])
  })

  it('fails closed when the review bytes diverge after staging', async () => {
    const item = fixture()
    await verify(item)
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'stage-written') return
      const operation = core.operations[checkpoint.operationIndex]
      if (operation?.role !== 'review') return
      writeFileSync(operation.path, 'divergent review bytes', 'utf8')
    })

    const failure = await captureFailure(() => apply(item, mutating, 'Archive'))
    expect(aggregateMessages(failure)).toEqual([
      expect.stringMatching(/promotion target changed before rename: /u),
      expect.stringMatching(/promotion rollback conflict at /u),
    ])
    expect(readFileSync(item.reviewFile, 'utf8')).toBe('divergent review bytes')
    expect(existsSync(item.candidateFull)).toBe(true)
  })

  it('restores the candidate when its bytes diverge before the delete', async () => {
    const item = fixture()
    await verify(item)
    const candidateBefore = readFileSync(item.candidateFull, 'utf8')
    const mutating = checkpointAuthority((core, checkpoint) => {
      if (checkpoint.phase !== 'operation-applied'
        || checkpoint.operationIndex !== core.operations.findIndex(operation => operation.role === 'governance')) return
      writeFileSync(operationOf(core, 'candidate').path, 'tampered candidate bytes', 'utf8')
    })

    await expect(apply(item, mutating, 'Archive')).rejects.toThrow(/promotion recovery conflict at /u)
    expect(readFileSync(item.candidateFull, 'utf8')).toBe(candidateBefore)
    expect(readItems(item.reviewFile)[0]!.resolved).toBe(false)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'closure.md'))).toBe(false)
    expect(readJournal(item).state).toBe('rolled-back')
    expect(walLeftovers(item.root)).toEqual([])
  })
})
