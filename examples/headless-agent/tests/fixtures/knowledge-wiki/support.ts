/** Named Wiki snapshot fixture; only the verifier is replaced by an external test boundary. */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tool-knowledge-wiki'
import { Session, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type KnowledgeWikiService from '@deepseek-ai/dsh-knowledge-wiki'
import { readKnowledgeEventLog, replayKnowledgeEvents } from '@deepseek-ai/dsh-knowledge-wiki'
import { appendCandidateReviews } from '../../../../../packages/host/knowledge-wiki/src/reviews.ts'
import { canonicalJson, readTrustedReceipt, sha256 } from '../../../../../packages/host/knowledge-wiki/src/verifier.ts'
import { seedHistoricalCanonicalKnowledge } from '../../../../../packages/host/knowledge-wiki/tests/historical-governed-fixture.ts'
import { verifierAuthority } from '../../../../../packages/host/knowledge-wiki/tests/verifier-authority-fixture.ts'

const PATH = 'concepts/historical-snapshot.md'
const BYTES = '---\ntype: concept\nstatus: canonical\ntitle: Historical snapshot\nsources: ["fixture:historical-read-only"]\n---\n\n# Historical snapshot\n\nHistorical fixture for authenticated reading. No measured task benefit is asserted.\n'
const UNSIGNED_PATH = 'concepts/unsigned-snapshot.md'
const UNSIGNED_BYTES = '# Unsigned fixture\n'
const CANDIDATE_PATH = '_candidates/ingest/concepts/snapshot-check.md'
const CANDIDATE_BYTES = '---\ntype: engineering_pattern\nstatus: candidate\norigin: ingest\ntitle: Snapshot generic check\nsources: ["raw/evidence/snapshot-check.md"]\nrelated: ["concepts/governance"]\n---\n\n# Snapshot generic check\n\n## 原则\n\nA generic semantic check authenticates exact source bytes without proving measured task benefit.\n\n## 适用条件\n\nKeep generated knowledge isolated until an authenticated actual-use trial exists.\n\n## 验证证据\n\nThis fixture signs a source check only. It supplies no measured model usage or counterfactual task result.\n'
const CRASH_PATH = '_candidates/ingest/concepts/snapshot-crash.md'
const CRASH_BYTES = '---\ntype: concept\nstatus: candidate\norigin: ingest\ntitle: Snapshot Archive recovery\nsources: ["fixture:archive-recovery"]\nrelated: ["concepts/recovery"]\n---\n\n# Snapshot Archive recovery\n\nFixture for one interrupted Archive transaction.\n'
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const EVENT_REL = '.llm-wiki/knowledge-events.jsonl'

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

/** Seed historical admission and leave a real Archive worker at its durable pre-lifecycle crash boundary. */
export function seedWikiSnapshot(requestedRoot: string): void {
  const root = realpathSync(requestedRoot)
  const wikiRoot = join(root, 'wiki')
  seedHistoricalCanonicalKnowledge({ projectRoot: root, wikiRoot, path: PATH, content: BYTES })
  write(root, `wiki/${UNSIGNED_PATH}`, UNSIGNED_BYTES)
  write(root, 'raw/evidence/snapshot-check.md', 'Fixture: source checks are not measured actual-use trials.\n')
  write(root, `wiki/${CANDIDATE_PATH}`, CANDIDATE_BYTES)
  write(root, `wiki/${CRASH_PATH}`, CRASH_BYTES)
  const reviewFile = join(root, '.llm-wiki/review.json')
  assert.equal(appendCandidateReviews(reviewFile, root, 'raw/evidence/snapshot-check.md', [`wiki/${CANDIDATE_PATH}`]), 1)
  assert.equal(appendCandidateReviews(reviewFile, root, 'fixture:archive-recovery', [`wiki/${CRASH_PATH}`]), 1)
  const crash = (JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<{ id: string; candidatePath: string }>)
    .find(item => item.candidatePath === CRASH_PATH)!
  assert.ok(crash)
  const child = spawnSync(process.execPath, [join(REPO_ROOT, 'packages/host/knowledge-wiki/tests/fixtures/promotion-crash-worker.ts')], {
    cwd: REPO_ROOT, timeout: 10_000, encoding: 'utf8',
    env: { ...process.env, WIKI_CRASH_CHECKPOINT: 'committed-before-lifecycle', WIKI_REVIEW_FILE: reviewFile,
      WIKI_PROJECT_ROOT: root, WIKI_ROOT: wikiRoot, WIKI_ARCHIVE_ROOT: join(root, 'jiuzhang-tarballs/archive'),
      WIKI_REVIEW_ID: crash.id, WIKI_REVIEW_ACTION: 'Archive' },
  })
  assert.equal(child.error, undefined)
  assert.notEqual(child.status, 0)
  if (process.platform !== 'win32') assert.equal(child.signal, 'SIGKILL')
  assert.equal(readKnowledgeEventLog(join(root, EVENT_REL), verifierAuthority()).filter(event => event.type === 'knowledge/rejected').length, 0)
}

/** Check the complete fixture world after production Archive recovery, without normalizing raw signatures or event hashes. */
export function assertWikiWorld(requestedRoot: string): void {
  const root = realpathSync(requestedRoot)
  const wikiRoot = join(root, 'wiki')
  const goldenRoot = join(REPO_ROOT, 'snapshots/session/wiki-governance/wiki-pages.expected')
  const inventory = (directory: string) => {
    assert.equal(lstatSync(directory).isDirectory(), true)
    const entries = readdirSync(directory, { recursive: true, withFileTypes: true })
    assert.ok(entries.every(entry => entry.isFile() || entry.isDirectory()))
    return entries.map(entry => ({
      path: relative(directory, join(entry.parentPath, entry.name)).split('\\').join('/'), file: entry.isFile(),
    })).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  }
  const golden = inventory(goldenRoot)
  const files = golden.filter(entry => entry.file)
  assert.deepEqual(files.map(entry => entry.path), [CANDIDATE_PATH, PATH, UNSIGNED_PATH].sort())
  assert.deepEqual(inventory(wikiRoot), golden)
  for (const entry of files) {
    assert.deepEqual(readFileSync(join(wikiRoot, entry.path)), readFileSync(join(goldenRoot, entry.path)))
  }
  assert.equal(lstatSync(join(root, '.llm-wiki')).isDirectory(), true)
  assert.equal(lstatSync(join(root, 'jiuzhang-tarballs')).isDirectory(), true)
  const events = readKnowledgeEventLog(join(root, EVENT_REL), verifierAuthority())
  const rows = JSON.parse(readFileSync(join(root, '.llm-wiki/review.json'), 'utf8')) as Array<{
    id: string
    candidatePath: string
    candidateHash: string
    resolved: boolean
    resolvedAction?: string
    appliedPath?: string
  }>
  assert.equal(rows.length, 2)
  const generic = rows.find(row => row.candidatePath === CANDIDATE_PATH)!
  assert.ok(generic)
  assert.equal(generic.resolved, false)
  assert.equal(generic.candidateHash, sha256(CANDIDATE_BYTES))
  const crashed = rows.find(row => row.candidatePath === CRASH_PATH)!
  assert.ok(crashed)
  assert.equal(crashed.candidateHash, sha256(CRASH_BYTES))
  assert.equal(crashed.resolved, true)
  assert.equal(crashed.resolvedAction, 'Archive')
  assert.ok(crashed.appliedPath?.startsWith(join(root, 'jiuzhang-tarballs/archive') + '/'))
  assert.equal(readFileSync(crashed.appliedPath!, 'utf8'), CRASH_BYTES)
  const archiveEntries = readdirSync(join(root, 'jiuzhang-tarballs'), { recursive: true, withFileTypes: true })
  assert.ok(archiveEntries.every(entry => entry.isFile() || entry.isDirectory()))
  const archivedFiles = archiveEntries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  assert.deepEqual(archivedFiles, [crashed.appliedPath])
  const archiveRoot = join(root, 'jiuzhang-tarballs')
  const archiveParents = relative(archiveRoot, dirname(crashed.appliedPath!)).split(sep)
  assert.deepEqual(archiveEntries.filter(entry => entry.isDirectory())
    .map(entry => relative(archiveRoot, join(entry.parentPath, entry.name))).sort(),
  archiveParents.map((_, index) => join(...archiveParents.slice(0, index + 1))).sort())
  assert.equal(existsSync(join(root, `wiki/${CRASH_PATH}`)), false)
  const rejected = events.filter(event => event.type === 'knowledge/rejected')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0]!.knowledgeId, `candidate:${crashed.id}`)
  assert.equal(rejected[0]!.payload.appliedPath, crashed.appliedPath)
  assert.equal(rejected[0]!.payload.candidateHash, crashed.candidateHash)
  assert.equal(readFileSync(join(root, `wiki/${PATH}`), 'utf8'), BYTES)
  assert.equal(readFileSync(join(root, `wiki/${UNSIGNED_PATH}`), 'utf8'), UNSIGNED_BYTES)
  assert.equal(readFileSync(join(root, `wiki/${CANDIDATE_PATH}`), 'utf8'), CANDIDATE_BYTES)
  assert.equal(existsSync(join(root, 'wiki/concepts/snapshot-check.md')), false)
  const directory = join(root, '.llm-wiki/promotion-journal')
  assert.equal(readdirSync(directory).length, 1)
  const wal = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]!), 'utf8')) as {
    state: string
    action: string
    operations: Array<{ role: string }>
    operationSetHash: string
    seal: { authorityId: string; proof: string }
  }
  assert.equal(wal.state, 'committed')
  assert.equal(wal.action, 'Archive')
  assert.deepEqual(wal.operations.map(operation => operation.role), ['candidate-archive', 'review', 'governance', 'candidate'])
  const { state: _state, seal, ...core } = wal
  assert.equal(wal.operationSetHash, sha256(canonicalJson(wal.operations)))
  assert.equal(verifierAuthority().validatePromotion(canonicalJson(core), seal), true)
  assert.equal(events.length, readFileSync(join(root, EVENT_REL), 'utf8').trim().split('\n').length)
  const governance = readFileSync(join(root, '.llm-wiki/governance.jsonl'), 'utf8').trim().split('\n').map(line =>
    JSON.parse(line) as { action: string; reviewId: string; candidateHash: string; appliedPath: string; outcome?: string })
  const checked = existsSync(join(root, '.dsh/wiki-snapshot-warm.json'))
  const resumed = existsSync(join(root, '.dsh/wiki-snapshot-cold.json'))
  const historicalId = `historical-fixture:${PATH}`
  const genericId = `candidate:${generic.id}`
  const crashedId = `candidate:${crashed.id}`
  assert.deepEqual(events.map(event => [event.type, event.knowledgeId]), [
    ['knowledge/candidate', historicalId],
    ['knowledge/verified', historicalId],
    ['knowledge/promoted', historicalId],
    ['knowledge/observed', genericId],
    ['knowledge/candidate', genericId],
    ['knowledge/observed', crashedId],
    ['knowledge/candidate', crashedId],
    ['knowledge/rejected', crashedId],
    ...checked ? [['knowledge/verified', genericId], ['knowledge/retrieved', historicalId]] : [],
    ...resumed ? [['knowledge/injected', historicalId], ['knowledge/injected', historicalId]] : [],
  ])
  for (const event of events) assert.deepEqual(event.scope, { projectId: root, visibility: 'project' })
  assert.equal(governance.length, checked ? 2 : 1)
  if (checked) {
    const verification = governance[1]
    assert.ok(verification)
    assert.equal(verification.action, 'Verify')
    assert.equal(verification.candidateHash, sha256(CANDIDATE_BYTES))
    assert.equal(verification.outcome, 'passed')
  }
  const archive = governance[0]
  assert.ok(archive)
  assert.equal(archive.reviewId, crashed.id)
  assert.equal(archive.candidateHash, crashed.candidateHash)
  assert.equal(archive.appliedPath, crashed.appliedPath)
  const entries = readdirSync(join(root, '.llm-wiki'), { recursive: true, withFileTypes: true })
  assert.ok(entries.every(entry => entry.isFile() || entry.isDirectory()))
  const actual = entries
    .filter(entry => entry.isFile()).map(entry => relative(join(root, '.llm-wiki'), join(entry.parentPath, entry.name)).split('\\').join('/')).sort()
  const receiptDirectory = join(root, '.llm-wiki/verification-receipts')
  const receiptFiles = existsSync(receiptDirectory) ? readdirSync(receiptDirectory) : []
  const expected = ['governance.jsonl', 'knowledge-events.jsonl', 'review.json', `promotion-journal/${readdirSync(directory)[0]}`]
  if (existsSync(join(root, '.llm-wiki/knowledge-utility.json'))) {
    expected.push('knowledge-utility.json')
    const records = JSON.parse(readFileSync(join(root, '.llm-wiki/knowledge-utility.json'), 'utf8')) as Record<string, {
      path: string
      retrievalHits: number
      successfulUses: number
      userCorrections: number
      utilityScore: number
      lastRetrievedAt: string
      lastOutcomeAt?: string
    }>
    assert.deepEqual(Object.keys(records), [PATH])
    const utility = records[PATH]!
    const retrieval = events.find(event => event.type === 'knowledge/retrieved')!
    assert.deepEqual(utility, {
      path: PATH, retrievalHits: 1, successfulUses: 0, userCorrections: 0, utilityScore: 0,
      lastRetrievedAt: retrieval.payload.retrievalAt,
      ...utility.lastOutcomeAt === undefined ? {} : { lastOutcomeAt: utility.lastOutcomeAt },
    })
    if (utility.lastOutcomeAt !== undefined) {
      assert.equal(new Date(utility.lastOutcomeAt).toISOString(), utility.lastOutcomeAt)
      const outcomes = events.filter(event => event.type === 'knowledge/injected' && event.payload.outcomeSource === 'user-feedback')
      assert.deepEqual(outcomes.map(event => event.payload.outcome), ['successful', 'neutral'])
      assert.ok(outcomes.every(event => event.knowledgeId === `historical-fixture:${PATH}` && event.payload.path === PATH))
      assert.ok(utility.lastOutcomeAt >= outcomes[0]!.timestamp && utility.lastOutcomeAt <= outcomes[1]!.timestamp)
    }
    assert.equal(utility.lastOutcomeAt !== undefined, resumed)
  }
  for (const name of receiptFiles) {
    const receipt = readTrustedReceipt(verifierAuthority(), join(root, '.llm-wiki/review.json'), name.slice(0,-5))
    assert.ok(receipt)
    assert.equal(receipt.request.candidateHash, sha256(CANDIDATE_BYTES))
    assert.equal(receipt.request.candidatePath, CANDIDATE_PATH)
    assert.equal(receipt.request.governanceAction, 'Promote')
    assert.equal(receipt.result.result, 'pass')
    expected.push(`verification-receipts/${name}`)
  }
  assert.equal(receiptFiles.length, existsSync(join(root, '.dsh/wiki-snapshot-warm.json')) ? 1 : 0)
  assert.deepEqual(actual, expected.sort())
  assert.deepEqual(entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(),
    receiptFiles.length === 0 ? ['promotion-journal'] : ['promotion-journal', 'verification-receipts'])
}

export const name = 'wiki-governance-snapshot-lifecycle'
export const inject = ['knowledgeWiki', 'agents', 'agentLoop', 'sessionPersistence', 'sessions']
export interface Config { cold: boolean }

declare module '@deepseek-ai/cordis' { interface Context { knowledgeWikiSnapshotReady: boolean } }

async function prepareChecks(ctx: Context): Promise<void> {
  const root = process.cwd()
  const wiki = ctx.get('knowledgeWiki') as KnowledgeWikiService
  assertWikiWorld(root)
  const generic = (await wiki.reviews({ status: 'unresolved' })).find(row => row.candidatePath === CANDIDATE_PATH)!
  assert.ok(generic)
  const action = 'Promote'
  assert.deepEqual((await wiki.verifyCandidate({ reviewId: generic.id, action }, new AbortController().signal)).result, 'pass')
  const checked = (await wiki.reviews({ status: 'unresolved' })).find(row => row.id === generic.id)!
  assert.equal(checked.verification?.status, 'passed')
  assert.equal(checked.verification?.trial, undefined)
  assert.deepEqual(checked.options?.map(option => option.action), ['Archive'])
  const before = readFileSync(join(root, '.llm-wiki/review.json'), 'utf8')
  const eventBefore = readFileSync(join(root, EVENT_REL), 'utf8')
  assert.equal(await wiki.resolveReview({ reviewId: generic.id, action }), false)
  assert.equal(readFileSync(join(root, '.llm-wiki/review.json'), 'utf8'), before)
  assert.equal(readFileSync(join(root, EVENT_REL), 'utf8'), eventBefore)
  assert.equal(readFileSync(join(root, `wiki/${CANDIDATE_PATH}`), 'utf8'), CANDIDATE_BYTES)
  assert.equal(existsSync(join(root, 'wiki/concepts/snapshot-check.md')), false)
  const record = replayKnowledgeEvents(readKnowledgeEventLog(join(root, EVENT_REL), verifierAuthority())).records.get(`historical-fixture:${PATH}`)!
  assert.equal(record.successfulUses, 0)
  assert.equal(record.utilityScore, 0)
  write(root, '.dsh/wiki-snapshot-warm.json', JSON.stringify({ canonicalActionsDenied: 1, measuredTrials: 0, successfulUses: 0, utilityScore: 0, archiveTerminalEvents: 1 }))
}

async function cold(ctx: Context): Promise<void> {
  await ctx.get('loader')!.await()
  const root = process.cwd()
  assertWikiWorld(root)
  const before = readFileSync(join(root, EVENT_REL), 'utf8')
  const sessionFiles = readdirSync(join(root, '.dsh/sessions'), { recursive: true }).filter(path => String(path).endsWith('session.jsonl'))
  assert.equal(sessionFiles.length, 1)
  const raw = readFileSync(join(root, '.dsh/sessions', String(sessionFiles[0])), 'utf8')
  const header = JSON.parse(raw.split('\n')[0]!) as SessionHeader
  const durable = parseSessionLog(raw)
  const expected = Session.create(SessionId(header.id), durable, header).deriveMessages()
  const handle = await ctx.agents.resume({ resumeSessionId: SessionId(header.id), agentOptions: { provider:'deepseek-official',model:'deepseek-v4-flash' } })
  try {
    await handle.agent.whenIdle()
    assert.deepEqual(handle.agent.session.events.slice(0,durable.length), durable)
    assert.deepEqual(handle.agent.session.deriveMessages(), expected)
    const injection = durable.filter(event => event.type === 'knowledge/injected')
    assert.equal(injection.length, 1)
    assert.equal(injection[0]!.data.path, PATH)
    assert.equal(injection[0]!.data.sourceContentHash, sha256(BYTES))
    assert.equal(injection[0]!.data.scope.sessionId, header.id)
    assert.equal(injection[0]!.data.scope.projectId, root)
    const tool = durable.filter(event => event.type === 'tool/result')
    assert.equal(tool.length, 2)
    assert.equal(tool[0]!.data.message.content[0].type, 'tool-result')
    assert.equal(tool[0]!.data.message.content[0].isError, false)
    assert.equal(tool[1]!.data.message.content[0].isError, true)
    assert.deepEqual(injection[0]!.data.value, tool[0]!.data.message.content[0].content)
    const wiki = ctx.get('knowledgeWiki') as KnowledgeWikiService
    const utility = (await wiki.knowledgeUtility()).find(item => item.path === PATH)!
    assert.equal(utility.retrievalHits, 1)
    assert.equal(utility.successfulUses, 0)
    assert.equal(utility.utilityScore, 0)
    assert.equal(readFileSync(join(root, EVENT_REL), 'utf8'), before)
    assert.equal(await wiki.recordKnowledgeOutcome({ paths: [PATH], outcome: 'successful' }), 1)
    assert.equal(await wiki.recordKnowledgeOutcome({ paths: [PATH], outcome: 'neutral' }), 1)
    const feedback = (await wiki.knowledgeUtility()).find(item => item.path === PATH)!
    assert.equal(feedback.successfulUses, 0)
    assert.equal(feedback.utilityScore, 0)
    await ctx.sessions.flush(handle.agent.session)
  } finally {
    await handle.dispose()
  }
  write(root, '.dsh/wiki-snapshot-cold.json', JSON.stringify({ actualColdResume: true, durablePrefixEqual: true, modelMessagesEqual: true, injectionCount: 1, sourceContentHash: sha256(BYTES), archiveTerminalEvents: 1, successfulUses: 0, utilityScore: 0 }))
  ctx.get('appExit')!(0)
}

/** Gate the shipped one-shot runner on actual Wiki setup; a second process resumes only and never requests a model. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.cold) {
    void cold(ctx).catch((error: unknown) => { process.stderr.write(String(error) + '\n'); ctx.get('appExit')!(1) })
  } else {
    await prepareChecks(ctx)
    ctx.provide('knowledgeWikiSnapshotReady', true)
  }
}
