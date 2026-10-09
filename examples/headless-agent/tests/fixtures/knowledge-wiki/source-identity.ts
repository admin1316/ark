/** Historical duplicate owners exercised through the shipped Loader and persisted tool transcript. */
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type KnowledgeWikiService from '@deepseek-ai/dsh-knowledge-wiki'
import { readKnowledgeEventLog, replayKnowledgeEvents } from '@deepseek-ai/dsh-knowledge-wiki'
import { Session, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { seedHistoricalCanonicalKnowledge } from '../../../../../packages/host/knowledge-wiki/tests/historical-governed-fixture.ts'
import { verifierAuthority } from '../../../../../packages/host/knowledge-wiki/tests/verifier-authority-fixture.ts'
import { sha256 } from '../../../../../packages/host/knowledge-wiki/src/verifier.ts'

const PAGE_PATH = 'concepts/source-identity.md'
const PAGE_BYTES = '---\ntype: concept\nstatus: canonical\ntitle: Source identity fixture\nsources: ["fixture:historical-read-only"]\n---\n\n# Source identity fixture\n\nSOURCE_IDENTITY_BODY_MUST_NOT_REACH_THE_MODEL. Historical fixture only; no measured task benefit is asserted.\n'
const OWNER_IDS = ['historical-fixture:source-identity:first', 'historical-fixture:source-identity:second']
const OWNED_ROOTS = ['wiki', '.llm-wiki', 'jiuzhang-tarballs']
const BASELINE = '.dsh/wiki-source-identity-before.json'
const COLD_RESULT = '.dsh/wiki-source-identity-cold.json'
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const DENIAL = 'ambiguous knowledge source ownership'

/** Seed two fixture-signed historical ids with one exact source; no current promotion or measured trial runs. */
export function seedSourceIdentitySnapshot(requestedRoot: string): void {
  const root = realpathSync(requestedRoot)
  for (const knowledgeId of OWNER_IDS) {
    seedHistoricalCanonicalKnowledge({ projectRoot: root, wikiRoot: join(root, 'wiki'), path: PAGE_PATH,
      content: PAGE_BYTES, knowledgeId })
  }
  for (const directory of ['.dsh', '.llm-wiki/promotion-journal', '.llm-wiki/verification-receipts', 'jiuzhang-tarballs/archive']) {
    mkdirSync(join(root, directory), { recursive: true })
  }
  writeFileSync(join(root, '.llm-wiki/review.json'), '[]\n')
  writeFileSync(join(root, '.llm-wiki/governance.jsonl'), '')
  writeFileSync(join(root, '.llm-wiki/knowledge-utility.json'), JSON.stringify({
    [PAGE_PATH]: { path: PAGE_PATH, retrievalHits: 0, successfulUses: 0, userCorrections: 0, utilityScore: 0 },
  }) + '\n')
  writeFileSync(join(root, BASELINE), JSON.stringify(sourceIdentityInventory(root)))
  assertSourceIdentityWorld(root)
}

/** Inventory every owned directory and file with unnormalized raw bytes. */
function sourceIdentityInventory(root: string) {
  return OWNED_ROOTS.map((owner) => {
    const directory = join(root, owner)
    assert.equal(lstatSync(directory).isDirectory(), true)
    return { owner, entries: readdirSync(directory, { recursive: true, withFileTypes: true }).map((entry) => {
      assert.ok(entry.isFile() || entry.isDirectory())
      const path = join(entry.parentPath, entry.name)
      return { path: relative(directory, path).split('\\').join('/'), directory: entry.isDirectory(),
        ...entry.isFile() ? { bytes: readFileSync(path).toString('base64') } : {} }
    }).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))) }
  })
}

/** Assert exact setup bytes survive warm tools, outcome denials, and a cold process resume. */
export function assertSourceIdentityWorld(requestedRoot: string): void {
  const root = realpathSync(requestedRoot)
  assert.deepEqual(sourceIdentityInventory(root), JSON.parse(readFileSync(join(root, BASELINE), 'utf8')))
  const golden = join(REPO_ROOT, 'snapshots/session/wiki-source-identity/wiki-pages.expected', PAGE_PATH)
  assert.deepEqual(readFileSync(join(root, 'wiki', PAGE_PATH)), readFileSync(golden))
  assert.equal(readFileSync(golden, 'utf8'), PAGE_BYTES)
  const events = readKnowledgeEventLog(join(root, '.llm-wiki/knowledge-events.jsonl'), verifierAuthority())
  assert.deepEqual(events.map(event => [event.type, event.knowledgeId]), OWNER_IDS.flatMap(id => [
    ['knowledge/candidate', id], ['knowledge/verified', id], ['knowledge/promoted', id],
  ]))
  assert.equal(events.length, readFileSync(join(root, '.llm-wiki/knowledge-events.jsonl'), 'utf8').trim().split('\n').length)
  const records = [...replayKnowledgeEvents(events).records.values()]
  assert.deepEqual(records.map(record => record.id), OWNER_IDS)
  for (const record of records) {
    assert.equal(record.source, PAGE_PATH)
    assert.equal(record.content, PAGE_BYTES)
    assert.equal(record.contentHash, sha256(PAGE_BYTES))
    assert.equal(record.lifecycle, 'canonical')
    assert.equal(record.retrievalHits, 0)
    assert.equal(record.successfulUses, 0)
    assert.equal(record.utilityScore, 0)
  }
  for (const event of events) assert.deepEqual(event.scope, { projectId: root, visibility: 'project' })
}

export const name = 'wiki-source-identity-snapshot-lifecycle'
export const inject = ['knowledgeWiki', 'agents', 'sessions']
export interface Config { cold: boolean }

async function assertServiceDenials(ctx: Context): Promise<void> {
  const root = process.cwd()
  const wiki = ctx.get('knowledgeWiki') as KnowledgeWikiService
  assertSourceIdentityWorld(root)
  assert.deepEqual(await wiki.search({ query: 'source identity' }), [])
  assert.deepEqual(await wiki.pageContent({ path: PAGE_PATH }), { path: PAGE_PATH, content: '' })
  await assert.rejects(wiki.knowledgeUtility(), { message: DENIAL })
  for (const outcome of ['successful', 'corrected', 'neutral'] as const) {
    await assert.rejects(wiki.recordKnowledgeOutcome({ paths: [PAGE_PATH], outcome }), { message: DENIAL })
  }
  assertSourceIdentityWorld(root)
}

async function cold(ctx: Context): Promise<void> {
  await ctx.get('loader')!.await()
  await assertServiceDenials(ctx)
  const root = process.cwd()
  const files = readdirSync(join(root, '.dsh/sessions'), { recursive: true }).filter(path => String(path).endsWith('session.jsonl'))
  assert.equal(files.length, 1)
  const raw = readFileSync(join(root, '.dsh/sessions', String(files[0])), 'utf8')
  const header = JSON.parse(raw.split('\n')[0]!) as SessionHeader
  const durable = parseSessionLog(raw)
  const expected = Session.create(SessionId(header.id), durable, header).deriveMessages()
  const handle = await ctx.agents.resume({ resumeSessionId: SessionId(header.id),
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
  try {
    await handle.agent.whenIdle()
    assert.deepEqual(handle.agent.session.events.slice(0, durable.length), durable)
    assert.deepEqual(handle.agent.session.events.slice(durable.length).map(event => [event.type, event.data]), [['session/end-seed', {}]])
    assert.deepEqual(handle.agent.session.deriveMessages(), expected)
    assert.equal(durable.filter(event => event.type === 'knowledge/retrieved' || event.type === 'knowledge/injected').length, 0)
    const calls = durable.filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => event.data.name), ['wiki_search', 'wiki_read', 'wiki_files', 'wiki_graph', 'wiki_reviews'])
    const results = durable.filter(event => event.type === 'tool/result')
    assert.equal(results.length, calls.length)
    for (const [index, result] of results.entries()) {
      assert.equal(result.data.message.source.callId, calls[index]!.data.callId)
      assert.equal(result.data.message.content[0].type, 'tool-result')
      assert.equal(result.data.message.content[0].isError, true)
      assert.deepEqual(result.data.message.content[0].content, [{ type: 'text', text: `Error: ${DENIAL}` }])
    }
    assert.equal(JSON.stringify(expected).includes(PAGE_BYTES), false)
    assert.equal(JSON.stringify(expected).includes('SOURCE_IDENTITY_BODY_MUST_NOT_REACH_THE_MODEL'), false)
    await ctx.sessions.flush(handle.agent.session)
  } finally {
    await handle.dispose()
  }
  assertSourceIdentityWorld(root)
  writeFileSync(join(root, COLD_RESULT), JSON.stringify({ actualColdResume: true, durablePrefixEqual: true,
    modelMessagesEqual: true, deniedTools: 5, retrievalCount: 0, injectionCount: 0, successfulUses: 0, utilityScore: 0 }))
  ctx.get('appExit')!(0)
}

/** Gate the one-shot runner on the fixture oracle; cold mode resumes without a model request. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.cold) {
    void cold(ctx).catch((error: unknown) => { process.stderr.write(String(error) + '\n'); ctx.get('appExit')!(1) })
  } else {
    await assertServiceDenials(ctx)
    ctx.provide('knowledgeWikiSnapshotReady', true)
  }
}
