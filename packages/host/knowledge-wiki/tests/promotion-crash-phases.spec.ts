import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { appendCandidateReviews, recoverCandidateReviewTransactions } from '../src/reviews.ts'
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
    'Independent verification, exact operation binding, and durable recovery evidence.',
  ].join('\n'))
  appendCandidateReviews(reviewFile, root, 'crash-fixture', [`wiki/${candidatePath}`])
  const row = (JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<{ id: string }>)[0]!
  return { root, wikiRoot, candidate, reviewFile, archiveRoot, reviewId: row.id }
}

describe('candidate Archive WAL real crash phases', () => {
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
  ])('recovers after SIGKILL at %s', async (checkpoint) => {
    const item = fixture()
    const candidateBefore = readFileSync(item.candidate, 'utf8')
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', worker], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WIKI_CRASH_CHECKPOINT: checkpoint,
        WIKI_REVIEW_FILE: item.reviewFile,
        WIKI_PROJECT_ROOT: item.root,
        WIKI_ROOT: item.wikiRoot,
        WIKI_ARCHIVE_ROOT: item.archiveRoot,
        WIKI_REVIEW_ID: item.reviewId,
      },
      encoding: 'utf8',
      timeout: 10_000,
    })
    // The crash contract is "the worker died mid-promotion", not the POSIX
    // signal identity: Windows TerminateProcess reports no signal name.
    if (process.platform === 'win32') {
      expect(result.signal === null || result.signal === 'SIGKILL').toBe(true)
    } else {
      expect(result.signal).toBe('SIGKILL')
    }
    expect(await recoverCandidateReviewTransactions(
      verifierAuthority(), item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(1)
    expect(() => readFileSync(item.candidate, 'utf8')).toThrow()
    const archived = join(
      item.archiveRoot,
      'wiki-governance',
      new Date().toISOString().slice(0, 10),
      basename(item.root),
      createHash('sha256').update(candidateBefore).digest('hex').slice(0, 12),
      '_candidates', 'sessions', 'crash.md',
    )
    expect(readFileSync(archived, 'utf8')).toContain('Independent verification')
    const journalDirectory = join(dirname(item.reviewFile), 'promotion-journal')
    const journal = JSON.parse(readFileSync(
      join(journalDirectory, readdirSync(journalDirectory)[0]!),
      'utf8',
    )) as { state: string }
    expect(journal.state).toBe('committed')
    const eventPath = join(dirname(item.reviewFile), 'knowledge-events.jsonl')
    const rejectedEvents = (): Array<{ type: string; payload: Record<string, unknown> }> =>
      readFileSync(eventPath, 'utf8').trimEnd().split('\n')
        .map(line => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
        .filter(event => event.type === 'knowledge/rejected')
    expect(rejectedEvents()).toHaveLength(1)
    expect(rejectedEvents()[0]!.payload).toMatchObject({ action: 'Archive', lifecycle: 'downgraded' })
    expect(await recoverCandidateReviewTransactions(
      verifierAuthority(), item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(0)
    expect(rejectedEvents()).toHaveLength(1)
  }, 20_000)
})
