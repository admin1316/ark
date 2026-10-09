import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { readKnowledgeEventLog, replayKnowledgeEvents } from '../src/knowledge-governance.ts'
import {
  appendCandidateReviews,
  recoverCandidateReviewTransactions,
} from '../src/reviews.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []
const worker = fileURLToPath(new URL('./fixtures/promotion-crash-worker.ts', import.meta.url))

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-real-crash-'))
  roots.push(root)
  const wikiRoot = join(root, 'wiki')
  const candidatePath = '_candidates/sessions/crash.md'
  const candidate = join(wikiRoot, candidatePath)
  const reviewFile = join(root, '.llm-wiki', 'review.json')
  const archiveRoot = join(root, 'archive')
  mkdirSync(dirname(candidate), { recursive: true })
  writeFileSync(candidate, [
    '---',
    'type: concept',
    'status: candidate',
    'origin: ingest',
    'title: Crash recovery',
    'sources: ["repo:ark/crash-fixture"]',
    'related: ["concepts/recovery"]',
    '---',
    '',
    '# Crash recovery',
    '',
    'Fixture-only candidate for an authorized Archive transaction.',
  ].join('\n'))
  appendCandidateReviews(reviewFile, root, 'crash-fixture', [`wiki/${candidatePath}`])
  const row = (JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<{ id: string }>)[0]!
  return { root, wikiRoot, candidate, reviewFile, archiveRoot, reviewId: row.id }
}

function runWorker(item: ReturnType<typeof fixture>, checkpoint: string, action = 'Archive', recreatedCandidate?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', worker], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WIKI_CRASH_CHECKPOINT: checkpoint,
      WIKI_REVIEW_FILE: item.reviewFile,
      WIKI_PROJECT_ROOT: item.root,
      WIKI_ROOT: item.wikiRoot,
      WIKI_ARCHIVE_ROOT: item.archiveRoot,
      WIKI_REVIEW_ID: item.reviewId,
      WIKI_REVIEW_ACTION: action,
      WIKI_RECREATED_CANDIDATE: recreatedCandidate,
    },
    encoding: 'utf8',
    timeout: 10_000,
  })
}

describe('Archive WAL real crash phases', () => {
  it.each([
    'journal-persisted:-1',
    'stage-written:0',
    'entry-renamed:0',
    'stage-written:1',
    'entry-renamed:1',
    'stage-written:2',
    'entry-renamed:2',
    'entry-renamed:3',
    'tombstone-unlinked:3',
    'before-commit-marker:4',
    'committed-before-lifecycle',
    'committed-after-lifecycle',
    'committed-lifecycle-append-error',
  ])('recovers Archive lifecycle after worker interruption at %s', (checkpoint) => {
    const item = fixture()
    const candidateBefore = readFileSync(item.candidate, 'utf8')
    const result = runWorker(item, checkpoint)
    // The crash contract is "the worker died mid-Archive", not the POSIX
    // signal identity: Windows TerminateProcess reports no signal name.
    if (checkpoint === 'committed-lifecycle-append-error') {
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('fixture lifecycle append failure')
    } else if (process.platform === 'win32') {
      expect(result.signal === null || result.signal === 'SIGKILL').toBe(true)
    } else {
      expect(result.signal).toBe('SIGKILL')
    }
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    const journalDirectory = join(dirname(item.reviewFile), 'promotion-journal')
    const journalPath = join(journalDirectory, readdirSync(journalDirectory)[0]!)
    const prepared = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      state: string
      action: string
      operations: Array<{ role: string }>
    }
    const committedBeforeCrash = checkpoint.startsWith('committed-')
    expect(prepared).toMatchObject({ state: committedBeforeCrash ? 'committed' : 'prepared', action: 'Archive' })
    expect(prepared.operations.map(operation => operation.role))
      .toEqual(['candidate-archive', 'review', 'governance', 'candidate'])
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    expect(readKnowledgeEventLog(eventPath).filter(event => event.type === 'knowledge/rejected'))
      .toHaveLength(checkpoint === 'committed-after-lifecycle' ? 1 : 0)
    expect(recoverCandidateReviewTransactions(
      verifierAuthority(), item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(committedBeforeCrash ? 0 : 1)
    const row = (JSON.parse(readFileSync(item.reviewFile, 'utf8')) as Array<{
      resolved: boolean
      resolvedAction: string
      appliedPath: string
      candidateHash: string
    }>)[0]!
    expect(row).toMatchObject({ resolved: true, resolvedAction: 'Archive' })
    expect(readFileSync(row.appliedPath, 'utf8')).toBe(candidateBefore)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'crash.md'))).toBe(false)
    expect(existsSync(item.candidate)).toBe(false)
    expect(JSON.parse(readFileSync(journalPath, 'utf8')) as { state: string }).toMatchObject({ state: 'committed' })
    const events = readKnowledgeEventLog(eventPath)
    expect(events.filter(event => event.type === 'knowledge/rejected')).toMatchObject([{
      knowledgeId: `candidate:${item.reviewId}`,
      payload: { action: 'Archive', appliedPath: row.appliedPath, lifecycle: 'downgraded', candidateHash: row.candidateHash },
    }])
    expect(replayKnowledgeEvents(events).records.get(`candidate:${item.reviewId}`))
      .toMatchObject({ verificationStatus: 'rejected', lifecycle: 'downgraded' })
    const eventBytes = readFileSync(eventPath, 'utf8')
    expect(recoverCandidateReviewTransactions(
      verifierAuthority(), item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(0)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventBytes)
  }, 20_000)

  it('preserves the signed Skip disposition when recovering its committed Archive journal', () => {
    const item = fixture()
    const result = runWorker(item, 'committed-before-lifecycle', 'Skip')
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(recoverCandidateReviewTransactions(
      verifierAuthority(), item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(0)
    const events = readKnowledgeEventLog(join(dirname(item.reviewFile), 'knowledge-events.jsonl'))
    expect(events.filter(event => event.type === 'knowledge/rejected')).toMatchObject([{
      knowledgeId: `candidate:${item.reviewId}`, payload: { action: 'Skip', lifecycle: 'downgraded' },
    }])
    expect(replayKnowledgeEvents(events).records.get(`candidate:${item.reviewId}`))
      .toMatchObject({ verificationStatus: 'rejected', lifecycle: 'downgraded' })
  }, 20_000)

  it('does not accept an unsigned committed marker while Archive operations remain unapplied', () => {
    const item = fixture()
    const result = runWorker(item, 'journal-persisted:-1')
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    const directory = join(dirname(item.reviewFile), 'promotion-journal')
    const path = join(directory, readdirSync(directory)[0]!)
    const journal = JSON.parse(readFileSync(path, 'utf8')) as { state: string }
    writeFileSync(path, JSON.stringify({ ...journal, state: 'committed' }))
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const candidateBefore = readFileSync(item.candidate, 'utf8')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const eventsBefore = readFileSync(eventPath, 'utf8')
    const journalBefore = readFileSync(path, 'utf8')
    expect(() => recoverCandidateReviewTransactions(
      verifierAuthority(), item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toThrow('promotion post-commit mismatch')
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(item.candidate, 'utf8')).toBe(candidateBefore)
    expect(readFileSync(eventPath, 'utf8')).toBe(eventsBefore)
    expect(readFileSync(path, 'utf8')).toBe(journalBefore)
  }, 20_000)

  it.each(['entry-renamed:3', 'before-commit-marker:4'])('rolls back Archive after a worker error at %s', (checkpoint) => {
    const item = fixture()
    const candidateBefore = readFileSync(item.candidate, 'utf8')
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    const result = runWorker(item, `rollback:${checkpoint}`)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('fixture Archive checkpoint failure')
    expect(readFileSync(item.candidate, 'utf8')).toBe(candidateBefore)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(existsSync(join(item.wikiRoot, 'concepts', 'crash.md'))).toBe(false)
    const directory = join(dirname(item.reviewFile), 'promotion-journal')
    const journal = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]!), 'utf8')) as {
      state: string
      action: string
      operations: Array<{ role: string; path: string }>
    }
    expect(journal).toMatchObject({ state: 'rolled-back', action: 'Archive' })
    const events = readKnowledgeEventLog(join(dirname(item.reviewFile), 'knowledge-events.jsonl'))
    expect(events.filter(event => event.type === 'knowledge/rejected')).toHaveLength(0)
    expect(events.filter(event => event.type === 'knowledge/rolled_back')).toHaveLength(1)
    const archived = journal.operations.find(operation => operation.role === 'candidate-archive')!
    expect(existsSync(archived.path)).toBe(false)
    expect(recoverCandidateReviewTransactions(
      verifierAuthority(), item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(0)
  }, 20_000)

  it('preserves a recreated candidate when interrupted Archive rollback and recovery reject divergence', () => {
    const item = fixture()
    const recreated = 'Third-party candidate bytes written after the Archive deletion.\n'
    const result = runWorker(item, 'rollback:tombstone-unlinked:3', 'Archive', recreated)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(readFileSync(item.candidate, 'utf8')).toBe(recreated)
    expect(result.stderr).toContain('rollback was incomplete')
    expect(result.stderr).toContain('promotion rollback conflict')
    const directory = join(dirname(item.reviewFile), 'promotion-journal')
    const journalPath = join(directory, readdirSync(directory)[0]!)
    expect(JSON.parse(readFileSync(journalPath, 'utf8')) as { state: string; action: string })
      .toMatchObject({ state: 'prepared', action: 'Archive' })
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    expect(readKnowledgeEventLog(eventPath).filter(event =>
      event.type === 'knowledge/rejected' || event.type === 'knowledge/rolled_back'))
      .toHaveLength(0)
    const paths = [item.candidate, item.reviewFile, journalPath, eventPath]
    const beforeRecovery = paths.map(path => readFileSync(path))
    expect(() => recoverCandidateReviewTransactions(
      verifierAuthority(), item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toThrow('promotion journal divergent state')
    expect(paths.map(path => readFileSync(path))).toEqual(beforeRecovery)
  }, 20_000)
})
