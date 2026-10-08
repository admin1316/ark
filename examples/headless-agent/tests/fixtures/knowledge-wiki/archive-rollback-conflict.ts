/** Actual Archive service consumer with a fixture-only failure and third-party writer. */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type KnowledgeWikiService from '@deepseek-ai/dsh-knowledge-wiki'
import { readKnowledgeEventLog, replayKnowledgeEvents } from '@deepseek-ai/dsh-knowledge-wiki'
import { appendCandidateReviews } from '../../../../../packages/host/knowledge-wiki/src/reviews.ts'
import { canonicalJson, sha256 } from '../../../../../packages/host/knowledge-wiki/src/verifier.ts'
import { verifierAuthority } from '../../../../../packages/host/knowledge-wiki/tests/verifier-authority-fixture.ts'

export const ARCHIVE_CONFLICT_PATH = '_candidates/ingest/concepts/archive-rollback-conflict.md'
export const ARCHIVE_RECREATED_BYTES = 'Third-party candidate bytes written after the Archive deletion.\n'
const CANDIDATE_BYTES = '---\ntype: concept\nstatus: candidate\norigin: ingest\ntitle: Archive rollback conflict\nsources: ["raw/evidence/archive-rollback-conflict.md"]\n---\n\n# Archive rollback conflict\n\nFixture for preserving a concurrent writer during failed Archive rollback. No measured task benefit is asserted.\n'
const SOURCE_BYTES = 'Fixture source for an Archive rollback conflict. No model or provider runs.\n'
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const OWNED_ROOTS = ['wiki', '.llm-wiki', 'jiuzhang-tarballs'] as const
const BASELINE = '.dsh/wiki-archive-rollback-before-cold.json'

/** Seed only the isolated source; candidate creation goes through the real Loader service. */
export function seedArchiveRollbackSnapshot(root: string): void {
  mkdirSync(join(root, 'wiki'), { recursive: true })
  mkdirSync(join(root, 'raw/evidence'), { recursive: true })
  writeFileSync(join(root, 'raw/evidence/archive-rollback-conflict.md'), SOURCE_BYTES)
}

/** Complete owned-root inventory, including empty directories and exact file bytes. */
export function archiveRollbackInventory(root: string) {
  return OWNED_ROOTS.map((owner) => {
    const directory = join(root, owner)
    assert.equal(lstatSync(directory).isDirectory(), true)
    return {
      owner,
      entries: readdirSync(directory, { recursive: true, withFileTypes: true }).map((entry) => {
        assert.ok(entry.isFile() || entry.isDirectory())
        const path = join(entry.parentPath, entry.name)
        return { path: relative(directory, path).split('\\').join('/'), directory: entry.isDirectory(),
          ...entry.isFile() ? { bytes: readFileSync(path).toString('base64') } : {} }
      }).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))),
    }
  })
}

/** Raw world oracle; no signature, event, or content bytes are normalized. */
export function assertArchiveRollbackWorld(requestedRoot: string): void {
  const root = realpathSync(requestedRoot)
  const inventory = archiveRollbackInventory(root)
  const candidate = join(root, 'wiki', ARCHIVE_CONFLICT_PATH)
  const golden = join(REPO_ROOT, 'snapshots/session/wiki-archive-rollback-conflict/wiki-pages.expected', ARCHIVE_CONFLICT_PATH)
  assert.deepEqual(readFileSync(candidate), readFileSync(golden))
  assert.equal(readFileSync(candidate, 'utf8'), ARCHIVE_RECREATED_BYTES)
  const candidateParts = ARCHIVE_CONFLICT_PATH.split('/')
  assert.deepEqual(inventory[0]!.entries.map(entry => [entry.path, entry.directory]),
    candidateParts.map((_, index) => [candidateParts.slice(0, index + 1).join('/'), index < candidateParts.length - 1]))
  const reviewFile = join(root, '.llm-wiki/review.json')
  const rows = JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<{
    id: string
    candidatePath: string
    candidateHash: string
    resolved: boolean
    resolvedAction?: string
  }>
  assert.equal(rows.length, 1)
  const review = rows[0]!
  assert.equal(review.candidatePath, ARCHIVE_CONFLICT_PATH)
  assert.equal(review.candidateHash, sha256(CANDIDATE_BYTES))
  assert.equal(review.resolved, false)
  assert.equal(review.resolvedAction, undefined)
  const journalRoot = join(root, '.llm-wiki/promotion-journal')
  const journals = readdirSync(journalRoot)
  assert.equal(journals.length, 1)
  const wal = JSON.parse(readFileSync(join(journalRoot, journals[0]!), 'utf8')) as {
    state: string
    action: string
    operationSetHash: string
    operations: Array<{ role: string; path: string; before?: string; after?: string }>
    seal: { authorityId: string; proof: string }
  }
  assert.equal(wal.state, 'prepared')
  assert.equal(wal.action, 'Archive')
  assert.deepEqual(wal.operations.map(operation => operation.role), ['candidate-archive', 'review', 'governance', 'candidate'])
  assert.equal(wal.operations[3]!.path, candidate)
  assert.equal(wal.operations[3]!.before, CANDIDATE_BYTES)
  assert.equal(wal.operations[3]!.after, undefined)
  assert.equal(wal.operationSetHash, sha256(canonicalJson(wal.operations)))
  const { state: _state, seal, ...core } = wal
  assert.equal(verifierAuthority().validatePromotion(canonicalJson(core), seal), true)
  assert.equal(existsSync(wal.operations[0]!.path), false)
  const archiveParts = relative(join(root, 'jiuzhang-tarballs'), dirname(wal.operations[0]!.path)).split(sep)
  assert.deepEqual(inventory[2]!.entries.map(entry => [entry.path, entry.directory]),
    archiveParts.map((_, index) => [archiveParts.slice(0, index + 1).join('/'), true]))
  assert.deepEqual(inventory[1]!.entries.map(entry => [entry.path, entry.directory]), [
    ['knowledge-events.jsonl', false], ['promotion-journal', true], [`promotion-journal/${journals[0]}`, false], ['review.json', false],
  ])
  const events = readKnowledgeEventLog(join(root, '.llm-wiki/knowledge-events.jsonl'), verifierAuthority())
  assert.deepEqual(events.map(event => [event.type, event.knowledgeId]), [
    ['knowledge/observed', `candidate:${review.id}`], ['knowledge/candidate', `candidate:${review.id}`],
  ])
  const projection = replayKnowledgeEvents(events)
  for (const record of projection.records.values()) {
    assert.equal(record.successfulUses, 0)
    assert.equal(record.utilityScore, 0)
  }
  for (const event of events) assert.deepEqual(event.scope, { projectId: root, visibility: 'project' })
  assert.deepEqual(inventory, JSON.parse(readFileSync(join(root, BASELINE), 'utf8')))
}

export const name = 'wiki-archive-rollback-conflict-snapshot-lifecycle'
export const inject = ['knowledgeWiki']

async function prepareChecks(ctx: Context): Promise<void> {
  const root = process.cwd()
  const wiki = ctx.get('knowledgeWiki') as KnowledgeWikiService
  assert.equal((await wiki.writePage({ path: ARCHIVE_CONFLICT_PATH, content: CANDIDATE_BYTES })).ok, true)
  const reviewFile = join(root, '.llm-wiki/review.json')
  assert.equal(appendCandidateReviews(reviewFile, root, 'raw/evidence/archive-rollback-conflict.md', [`wiki/${ARCHIVE_CONFLICT_PATH}`]), 1)
  const review = (await wiki.reviews({ status: 'unresolved' }))[0]!
  assert.equal(review.candidatePath, ARCHIVE_CONFLICT_PATH)
  const reviewBefore = readFileSync(reviewFile)
  const eventBefore = readFileSync(join(root, '.llm-wiki/knowledge-events.jsonl'))
  await assert.rejects(wiki.resolveReview({ reviewId: review.id, action: 'Archive' }), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.message, 'candidate review transaction failed and rollback was incomplete')
    assert.deepEqual(error.errors.map(item => (item as Error).message), [
      'fixture Archive checkpoint failure', `promotion rollback conflict at ${join(root, 'wiki', ARCHIVE_CONFLICT_PATH)}`,
    ])
    return true
  })
  assert.deepEqual(readFileSync(reviewFile), reviewBefore)
  assert.deepEqual(readFileSync(join(root, '.llm-wiki/knowledge-events.jsonl')), eventBefore)
  assert.equal((await wiki.reviews({ status: 'unresolved' }))[0]!.resolved, false)
  assert.deepEqual(await wiki.modelReviews({}, { projectId: root, workspaceId: root, sessionId: 'fixture-scope-check' }), [])
  assert.deepEqual(await wiki.knowledgeUtility(), [])
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, BASELINE), JSON.stringify(archiveRollbackInventory(root)))
  assertArchiveRollbackWorld(root)
  ctx.provide('knowledgeWikiSnapshotReady', true)
}

export function apply(ctx: Context): void {
  void prepareChecks(ctx).catch((error: unknown) => {
    process.stderr.write(String(error) + '\n')
    ctx.get('appExit')?.(1)
  })
}
