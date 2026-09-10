import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendCandidateReviews,
  recordCandidateVerification,
  recoverCandidateReviewTransactions,
} from '../src/reviews.ts'
import { issueTestReceipt, verifierAuthority } from './verifier-authority-fixture.ts'

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
  const authority = verifierAuthority()
  const receiptId = issueTestReceipt(authority, reviewFile, wikiRoot, row.id, 'Promote')
  expect(recordCandidateVerification(
    authority, reviewFile, wikiRoot, row.id, receiptId, 'Promote',
  )).toBe(true)
  return { root, wikiRoot, candidate, reviewFile, archiveRoot, reviewId: row.id }
}

describe('authenticated promotion WAL real crash phases', () => {
  it.each([
    'journal-persisted:-1',
    'stage-written:0',
    'entry-renamed:0',
    'stage-written:1',
    'entry-renamed:1',
    'stage-written:2',
    'entry-renamed:2',
    'stage-written:3',
    'entry-renamed:3',
    'entry-renamed:4',
    'tombstone-unlinked:4',
    'before-commit-marker:5',
  ])('recovers after SIGKILL at %s', (checkpoint) => {
    const item = fixture()
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
    expect(result.signal).toBe('SIGKILL')
    expect(recoverCandidateReviewTransactions(
      verifierAuthority(), item.reviewFile, item.wikiRoot, item.archiveRoot,
    )).toBe(1)
    expect(readFileSync(join(item.wikiRoot, 'concepts', 'crash.md'), 'utf8')).toContain('status: canonical')
    expect(() => readFileSync(item.candidate, 'utf8')).toThrow()
    const journalDirectory = join(dirname(item.reviewFile), 'promotion-journal')
    const journal = JSON.parse(readFileSync(
      join(journalDirectory, readdirSync(journalDirectory)[0]!),
      'utf8',
    )) as { state: string }
    expect(journal.state).toBe('committed')
  }, 20_000)
})
