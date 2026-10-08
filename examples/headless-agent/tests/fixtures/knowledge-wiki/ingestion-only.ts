/** Ingestion-only deployment: real media queue effects and one independently seeded low-trust candidate. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type KnowledgeWikiService from '@deepseek-ai/dsh-knowledge-wiki'
import {
  canKnowledgeChangePolicy, knowledgeInjectionDecision, readKnowledgeEventLog, replayKnowledgeEvents,
} from '@deepseek-ai/dsh-knowledge-wiki'
import { appendCandidateReviews } from '../../../../../packages/host/knowledge-wiki/src/reviews.ts'

const SOURCE = 'raw/sources/ingestion-only.png'
const MEDIA = '_candidates/ingest/media/ingestion-only.png'
const CANDIDATE = '_candidates/ingest/concepts/ingestion-only.md'
const EVIDENCE = 'raw/evidence/ingestion-only.md'
const CANDIDATE_BYTES = '---\ntype: concept\nstatus: candidate\norigin: ingest\ntitle: Unverified ingestion evidence\nsources: ["raw/evidence/ingestion-only.md"]\n---\n\n# Unverified ingestion evidence\n\nA queue receipt alone does not establish a reusable claim or measured task benefit.\n'
const EVENTS = '.llm-wiki/knowledge-events.jsonl'
const REVIEWS = '.llm-wiki/review.json'
const BASELINE = '.dsh/wiki-ingestion-only-before.json'
const WARNING = '视觉说明生成失败（检查 apiKey/网络）'
const SCENARIO_ROOT = fileURLToPath(new URL('../../../../../snapshots/session/wiki-ingestion-only/', import.meta.url))

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function files(root: string, owner: string): string[] {
  const directory = join(root, owner)
  assert.equal(lstatSync(directory).isDirectory(), true)
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true })
  assert.ok(entries.every(entry => entry.isFile() || entry.isDirectory()))
  const result = entries.filter(entry => entry.isFile()).map(entry => relative(directory,
    join(entry.parentPath, entry.name)).split('\\').join('/')).sort()
  const directories = new Set<string>()
  for (const path of result) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'))
  }
  assert.deepEqual(entries.filter(entry => entry.isDirectory()).map(entry => relative(directory,
    join(entry.parentPath, entry.name)).split('\\').join('/')).sort(), [...directories].sort())
  return result
}

/** Seed a production-created unsigned Candidate separately from the image ingestion exercised by the task.
 * @param requestedRoot - Isolated scenario workspace; committed goldens own all raw input bytes.
 * @returns Nothing; the original review/event bytes are retained for the external oracle.
 */
export function seedIngestionOnlySnapshot(requestedRoot: string): void {
  const root = realpathSync(requestedRoot)
  assert.equal(readdirSync(root).includes('raw'), false)
  for (const path of [SOURCE, EVIDENCE]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), readFileSync(join(SCENARIO_ROOT, 'raw.expected', path.slice(4))))
  }
  mkdirSync(dirname(join(root, 'wiki', CANDIDATE)), { recursive: true })
  writeFileSync(join(root, 'wiki', CANDIDATE), CANDIDATE_BYTES)
  assert.equal(appendCandidateReviews(join(root, REVIEWS), root, EVIDENCE, [`wiki/${CANDIDATE}`]), 1)
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, BASELINE), JSON.stringify(Object.fromEntries([EVENTS, REVIEWS]
    .map(path => [path, readFileSync(join(root, path)).toString('base64')]))))
}

/** Assert complete raw Wiki state, a durable terminal queue, and unchanged unverified knowledge.
 * @param requestedRoot - Isolated workspace after the real CLI process exits.
 * @returns Nothing; any unexpected file, mutation, trust change, or queue result throws.
 */
export function assertIngestionOnlyWorld(requestedRoot: string): void {
  const root = realpathSync(requestedRoot)
  const rawFiles = files(SCENARIO_ROOT, 'raw.expected')
  assert.deepEqual(rawFiles, [EVIDENCE.slice(4), SOURCE.slice(4)].sort())
  assert.deepEqual(files(root, 'raw'), rawFiles)
  for (const path of rawFiles) {
    assert.deepEqual(readFileSync(join(root, 'raw', path)), readFileSync(join(SCENARIO_ROOT, 'raw.expected', path)))
  }
  const baseline = JSON.parse(readFileSync(join(root, BASELINE), 'utf8')) as Record<string, string>
  for (const path of [EVENTS, REVIEWS]) {
    assert.deepEqual(readFileSync(join(root, path)), Buffer.from(baseline[path]!, 'base64'))
  }
  assert.deepEqual(files(root, 'wiki'), [CANDIDATE, MEDIA].sort())
  assert.equal(readFileSync(join(root, 'wiki', CANDIDATE), 'utf8'), CANDIDATE_BYTES)
  const sourceBytes = readFileSync(join(root, SOURCE))
  assert.deepEqual(readFileSync(join(root, 'wiki', MEDIA)), sourceBytes)
  assert.deepEqual(files(root, '.llm-wiki'), [
    'ingest-cache.json', 'ingest-queue.json', 'knowledge-events.jsonl', 'review.json',
  ])
  assert.equal(readdirSync(root).includes('jiuzhang-tarballs'), false)
  const queue = JSON.parse(readFileSync(join(root, '.llm-wiki/ingest-queue.json'), 'utf8')) as Array<Record<string, unknown>>
  assert.equal(queue.length, 1)
  const task = queue[0]!
  assert.deepEqual(Object.keys(task).sort(), [
    'completedAt', 'createdAt', 'id', 'ingestedHash', 'input', 'leaseStartedAt', 'projectGeneration',
    'projectRoot', 'runId', 'status', 'warnings', 'wikiRoot', 'written',
  ].sort())
  assert.equal(task.id, 1)
  assert.equal(task.input, 'ingestion-only.png')
  assert.equal(task.status, 'done')
  assert.equal(task.projectRoot, root)
  assert.equal(task.wikiRoot, join(root, 'wiki'))
  assert.equal(task.projectGeneration, 0)
  assert.deepEqual(task.written, [MEDIA])
  assert.deepEqual(task.warnings, [WARNING])
  assert.equal(task.ingestedHash, hash(sourceBytes))
  assert.match(String(task.runId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(typeof task.createdAt, 'number')
  assert.equal(typeof task.leaseStartedAt, 'number')
  assert.equal(typeof task.completedAt, 'number')
  assert.ok(Number(task.createdAt) <= Number(task.leaseStartedAt))
  assert.ok(Number(task.leaseStartedAt) <= Number(task.completedAt))
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.llm-wiki/ingest-cache.json'), 'utf8')),
    { 'ingestion-only.png': hash(sourceBytes) })
  const events = readKnowledgeEventLog(join(root, EVENTS))
  assert.deepEqual(events.map(event => event.type), ['knowledge/observed', 'knowledge/candidate'])
  const state = replayKnowledgeEvents(events)
  assert.equal(state.records.size, 1)
  const record = [...state.records.values()][0]!
  assert.equal(record.source, CANDIDATE)
  assert.equal(record.content, CANDIDATE_BYTES)
  assert.equal(record.lifecycle, 'candidate')
  assert.equal(record.trust, 'low')
  assert.equal(record.authority, 'untrusted-observation')
  assert.equal(record.verificationStatus, 'candidate')
  assert.equal(record.confidence, 0)
  assert.equal(record.lastVerifiedAt, null)
  assert.equal(record.retrievalHits, 0)
  assert.equal(record.successfulUses, 0)
  assert.equal(record.utilityScore, 0)
  assert.deepEqual(knowledgeInjectionDecision(record, { projectId: root, workspaceId: root }),
    { allowed: false, reason: 'unverified' })
  assert.equal(canKnowledgeChangePolicy(record), false)
  const reviews = JSON.parse(readFileSync(join(root, REVIEWS), 'utf8')) as Array<Record<string, unknown>>
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0]!.resolved, false)
  const verification = reviews[0]!.verification as Record<string, unknown>
  assert.equal(verification.status, 'pending')
  assert.deepEqual(verification.receipts, [])
}

export const name = 'wiki-ingestion-only-snapshot-gate'
export const inject = ['knowledgeWiki']

declare module '@deepseek-ai/cordis' { interface Context { knowledgeWikiIngestionOnlyReady: boolean } }

/** Gate the shipped runner on the actual absence of authority and the unchanged service denial.
 * @param ctx - Real CLI Loader context with its production Knowledge Wiki service.
 * @returns Resolves after direct verifier/read/promotion calls fail closed without durable mutation.
 */
export async function apply(ctx: Context): Promise<void> {
  assert.equal(ctx.get('knowledgeWikiVerifierAuthority'), undefined)
  const root = realpathSync(process.cwd())
  const wiki = ctx.get('knowledgeWiki') as KnowledgeWikiService
  const reviews = JSON.parse(readFileSync(join(root, REVIEWS), 'utf8')) as Array<{ id: string }>
  const baseline = JSON.parse(readFileSync(join(root, BASELINE), 'utf8')) as Record<string, string>
  await assert.rejects(wiki.modelPageContent({ path: CANDIDATE }, {
    projectId: root, workspaceId: root, sessionId: 'ingestion-only-service-denial',
  }), { message: 'knowledge verifier authority is unavailable' })
  assert.deepEqual(await wiki.verifyCandidate({ reviewId: reviews[0]!.id, action: 'Promote' },
    new AbortController().signal), { ok: false, evidence: [], errorCode: 'verifier-authority-unavailable' })
  assert.equal(await wiki.resolveReview({ reviewId: reviews[0]!.id, action: 'Promote' }), false)
  for (const path of [EVENTS, REVIEWS]) {
    assert.deepEqual(readFileSync(join(root, path)), Buffer.from(baseline[path]!, 'base64'))
  }
  ctx.provide('knowledgeWikiIngestionOnlyReady', true)
}
