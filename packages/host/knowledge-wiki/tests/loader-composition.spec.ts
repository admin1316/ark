/**
 * Real YAML Loader composition with source services and factory-owned agents.
 * External checks are fixture-signed, and the historical admission below is
 * solely a read-boundary fixture: neither is a measured usage trial or model task.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as WikiTools from '@deepseek-ai/dsh-tool-knowledge-wiki'
import KnowledgeWikiService from '../src/index.ts'
import { readKnowledgeEventLog, replayKnowledgeEvents, shouldRetainKnowledge } from '../src/knowledge-governance.ts'
import { appendCandidateReviews } from '../src/reviews.ts'
import type { WikiReviewItem } from '../src/types.ts'
import { buildVerificationRequest, canonicalJson, sha256, validateLearningReceiptChain, type KnowledgeWikiVerifierAuthority } from '../src/verifier.ts'
import { seedHistoricalCanonicalKnowledge } from './historical-governed-fixture.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'
import { externalBoundariesFixture, type ExternalBoundaryCalls } from './fixtures/loader-external-boundaries.ts'

const durabilityIO = vi.hoisted(() => ({
  descriptors: new Map<number, string>(),
  failingParent: '',
  failAfterRejectedFileSync: false,
  trace: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args)
      durabilityIO.descriptors.set(descriptor, String(args[0]))
      return descriptor
    },
    closeSync: (descriptor: number) => {
      durabilityIO.descriptors.delete(descriptor)
      actual.closeSync(descriptor)
    },
    fsyncSync: (descriptor: number) => {
      const path = durabilityIO.descriptors.get(descriptor)!
      if (path === durabilityIO.failingParent) {
        durabilityIO.trace.push('directory-fsync-denied')
        throw Object.assign(new Error('fixture composed directory fsync failure'), { code: 'EIO' })
      }
      actual.fsyncSync(descriptor)
      if (durabilityIO.failAfterRejectedFileSync && path.endsWith('knowledge-events.jsonl')
        && actual.readFileSync(path, 'utf8').includes('"knowledge/rejected"')) {
        durabilityIO.failingParent = dirname(path)
      }
    },
  }
})

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  durabilityIO.failingParent = ''
  durabilityIO.failAfterRejectedFileSync = false
  durabilityIO.trace = []
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Load every production owner through actual YAML, resolving source modules. */
async function boot(
  projectRoot: string,
  calls: ExternalBoundaryCalls,
  authority: KnowledgeWikiVerifierAuthority = verifierAuthority(),
  configuredVerifier?: string,
): Promise<Context> {
  const configPath = join(projectRoot, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'fixture:knowledge-wiki-external-boundaries'",
    "- name: '@deepseek-ai/cordis-plugin-timer'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(join(projectRoot, 'session-logs'))}`,
    '    compression: none',
    '    packChunks: false',
    ...(configuredVerifier === undefined ? [] : ["- name: '@deepseek-ai/dsh-subprocess-local'"]),
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-knowledge-wiki'",
    '  config:',
    `    mainRoot: ${JSON.stringify(projectRoot)}`,
    `    wikiRoot: ${JSON.stringify(join(projectRoot, 'wiki'))}`,
    "    credential: ''",
    ...(configuredVerifier === undefined ? [] : [`    knowledgeVerifierConfig: ${JSON.stringify(configuredVerifier)}`]),
    "- name: '@deepseek-ai/dsh-tool-knowledge-wiki'",
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(projectRoot).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['fixture:knowledge-wiki-external-boundaries', externalBoundariesFixture(authority, calls)],
    ['@deepseek-ai/cordis-plugin-timer', Timer],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-knowledge-wiki', KnowledgeWikiService],
    ['@deepseek-ai/dsh-tool-knowledge-wiki', WikiTools],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)).toEqual([])
  return ctx
}

function execute(ctx: Context, agent: Agent, name: string, args: unknown, callId: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal, callId: CallId(callId),
    name, arguments: args, agent,
  })
}

const HISTORICAL_READ_PATH = 'concepts/historical-loader-retention.md'
const HISTORICAL_READ_BYTES = `---
type: concept
status: canonical
title: Historical Loader retention
sources: ["fixture:historical-read-only"]
---

# Historical Loader retention

This fixture represents an already admitted page solely to exercise authenticated
read and journal retention boundaries. It supplies no measured usage trial,
provider task result or independent learning evidence.
`

const CANDIDATE_BYTES = `---
type: engineering_pattern
status: candidate
origin: ingest
title: Loader generic check
sources: ["raw/evidence/loader-generic-check.md"]
related: ["concepts/governance"]
---

# Loader generic check

## 原则

A generic semantic check authenticates the exact candidate and source bytes. It
does not establish that the knowledge improved a task or passed a measured trial.

## 适用条件

Keep generated knowledge isolated from canonical pages until an authenticated
actual-use trial exists. A content check alone must not claim task improvement.

## 验证证据

This external fixture signs a passing source review. No model or provider runs,
no task is measured and no trial success or counterfactual advantage is asserted.
`

describe('Knowledge Wiki real keyless YAML Loader composition', () => {
  it('uses the configured managed child through the real Wiki service and retains check-only denial', async () => {
    root = await mkdtemp(join(tmpdir(), 'wiki-loader-managed-verifier-'))
    const wikiRoot = join(root, 'wiki')
    const candidatePath = '_candidates/ingest/concepts/loader-managed-verifier.md'
    const reviewFile = join(root, '.llm-wiki', 'review.json')
    const candidateFile = join(wikiRoot, candidatePath)
    mkdirSync(dirname(candidateFile), { recursive: true })
    writeFileSync(candidateFile, CANDIDATE_BYTES)
    expect(appendCandidateReviews(reviewFile, root, 'fixture:managed-child', [`wiki/${candidatePath}`])).toBe(1)
    const review = (JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[])[0]!
    const sourceOwner = verifierAuthority()
    const request = buildVerificationRequest(sourceOwner, wikiRoot, review, 'Promote')!
    expect(request).toBeDefined()
    const keys = generateKeyPairSync('ed25519')
    const unsigned = {
      authorityId: 'fixture-managed-child', requestHash: sha256(canonicalJson(request)), result: 'pass',
      methods: ['integration_test'], outcomes: [{ name: 'managed-source-check', result: 'pass', evidence: ['fixture source check only'] }],
      issuedAt: new Date().toISOString(),
    }
    const result = { ...unsigned, proof: sign(null, Buffer.from(canonicalJson(unsigned)), keys.privateKey).toString('base64') }
    const script = join(root, 'verifier.mjs')
    writeFileSync(script, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(result))}));\n`)
    const config = JSON.stringify({
      authorityId: unsigned.authorityId, executable: process.execPath, args: [script], timeoutMs: 5000,
      sourceIdentity: sourceOwner.sourceIdentity(),
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    })
    const calls: ExternalBoundaryCalls = { verifier: 0, credentials: 0, llm: 0 }
    const ctx = await boot(root, calls, sourceOwner, config)
    const service = ctx.get('knowledgeWiki') as KnowledgeWikiService
    expect(ctx.get('subprocess')).toBeInstanceOf(LocalSubprocessRuntime)
    await expect(service.verifyCandidate({ reviewId: review.id, action: 'Promote' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, result: 'pass' })
    await expect(service.resolveReview({ reviewId: review.id, action: 'Promote' })).resolves.toBe(false)
    expect(existsSync(join(wikiRoot, 'concepts/loader-managed-verifier.md'))).toBe(false)
    expect(calls).toEqual({ verifier: 0, credentials: 0, llm: 0 })
    console.info('COMPOSED_MANAGED_VERIFIER_TRANSCRIPT', 'configured child accepted; injected verifier/model/credential untouched; measured-trial/canonical denied')
  })

  it.skipIf(process.platform === 'win32')('denies post-rename flush failure and completes Archive through cold composed recovery without duplicate events', async () => {
    root = await mkdtemp(join(tmpdir(), 'wiki-loader-directory-durability-'))
    const projectRoot = root
    const wikiRoot = join(projectRoot, 'wiki')
    const reviewFile = join(projectRoot, '.llm-wiki', 'review.json')
    const eventPath = join(projectRoot, '.llm-wiki', 'knowledge-events.jsonl')
    const candidatePath = '_candidates/ingest/concepts/loader-durability.md'
    const candidateFile = join(wikiRoot, candidatePath)
    const calls: ExternalBoundaryCalls = { verifier: 0, credentials: 0, llm: 0 }
    const authority: KnowledgeWikiVerifierAuthority = {
      ...verifierAuthority(),
      checkpointPromotion(_payload, checkpoint) {
        if (checkpoint.phase === 'entry-renamed' && checkpoint.operationIndex === 3) {
          durabilityIO.failingParent = dirname(candidateFile)
        }
      },
    }
    mkdirSync(wikiRoot, { recursive: true })
    let ctx = await boot(projectRoot, calls, authority)
    let service = ctx.get('knowledgeWiki') as KnowledgeWikiService
    expect(await service.writePage({ path: candidatePath, content: CANDIDATE_BYTES })).toMatchObject({ ok: true })
    expect(appendCandidateReviews(reviewFile, projectRoot, 'fixture:durability', [`wiki/${candidatePath}`])).toBe(1)
    const review = (await service.reviews({ status: 'unresolved' })).find(item => item.candidatePath === candidatePath)!
    const before = readFileSync(reviewFile, 'utf8')
    await expect(service.resolveReview({ reviewId: review.id, action: 'Archive' })).rejects.toThrow('rollback was incomplete')
    expect(readFileSync(reviewFile, 'utf8')).toBe(before)
    expect(readFileSync(candidateFile, 'utf8')).toBe(CANDIDATE_BYTES)
    const directory = join(dirname(reviewFile), 'promotion-journal')
    const wal = join(directory, readdirSync(directory).find(name => name.endsWith('.json'))!)
    expect(JSON.parse(readFileSync(wal, 'utf8'))).toMatchObject({ state: 'prepared' })
    expect(readKnowledgeEventLog(eventPath).filter(event =>
      event.type === 'knowledge/rejected' || event.type === 'knowledge/rolled_back')).toEqual([])
    durabilityIO.trace.push('resolve-denied-prepared-wal-retained')
    durabilityIO.failingParent = ''
    await ctx.fiber.dispose()

    // Recovery reaches the terminal append, whose bytes become visible before
    // its parent flush fails. A second cold attempt must repeat that barrier.
    durabilityIO.failAfterRejectedFileSync = true
    await expect(boot(projectRoot, calls)).rejects.toThrow('fixture composed directory fsync failure')
    expect(JSON.parse(readFileSync(wal, 'utf8'))).toMatchObject({ state: 'committed' })
    expect(readKnowledgeEventLog(eventPath).filter(event => event.type === 'knowledge/rejected')).toHaveLength(1)
    await expect(boot(projectRoot, calls)).rejects.toThrow('fixture composed directory fsync failure')
    durabilityIO.trace.push('visible-terminal-event-retry-denied')
    const eventBytes = readFileSync(eventPath)
    durabilityIO.failingParent = ''
    durabilityIO.failAfterRejectedFileSync = false
    await ctx.fiber.dispose()
    ctx = await boot(projectRoot, calls)
    service = ctx.get('knowledgeWiki') as KnowledgeWikiService
    expect(await service.reviews({ status: 'unresolved' })).toEqual([])
    expect(readFileSync(eventPath)).toEqual(eventBytes)
    expect(existsSync(candidateFile)).toBe(false)
    expect(existsSync(join(wikiRoot, 'concepts/loader-durability.md'))).toBe(false)
    const resolved = (await service.reviews({ status: 'resolved' })).find(item => item.id === review.id)!
    expect(resolved).toMatchObject({ resolved: true, resolvedAction: 'Archive' })
    expect(readFileSync(resolved.appliedPath!, 'utf8')).toBe(CANDIDATE_BYTES)
    expect(calls).toEqual({ verifier: 0, credentials: 0, llm: 0 })
    durabilityIO.trace.push('cold-recovery-one-archive-no-canonical-no-external-calls')
    console.info('COMPOSED_DIRECTORY_DURABILITY_TRANSCRIPT', JSON.stringify(durabilityIO.trace))
  }, 30_000)

  it('denies check-only promotion and keeps durable user feedback observational across composed restarts', async () => {
    root = await mkdtemp(join(tmpdir(), 'wiki-loader-composition-'))
    const projectRoot = root
    const wikiRoot = join(projectRoot, 'wiki')
    const reviewFile = join(projectRoot, '.llm-wiki', 'review.json')
    const sourcePath = 'raw/evidence/loader-generic-check.md'
    const candidatePath = '_candidates/ingest/concepts/loader-generic-check.md'
    const targetPath = 'concepts/loader-generic-check.md'
    const historical = seedHistoricalCanonicalKnowledge({
      projectRoot, wikiRoot, path: HISTORICAL_READ_PATH, content: HISTORICAL_READ_BYTES,
    })
    const calls: ExternalBoundaryCalls = { verifier: 0, credentials: 0, llm: 0 }
    let ctx = await boot(projectRoot, calls)
    let service = ctx.get('knowledgeWiki') as KnowledgeWikiService
    const owner = await ctx.agents.create({
      sessionId: SessionId('loader-knowledge-owner'), meta: { cwd: projectRoot },
    })
    expect(ctx.sessions.get(owner.agent.id)).toBe(owner.agent.session)
    // This real YAML path has only the existing semantic authority. It must
    // report learning unavailable before resolving a purported trial artifact.
    const semanticAuthority = ctx.get('knowledgeWikiVerifierAuthority') as KnowledgeWikiVerifierAuthority | undefined
    expect(validateLearningReceiptChain(semanticAuthority, {
      algorithm: 'sha256', digest: sha256('absent measured trial'), bytes: 0, mediaType: 'application/json',
    })).toEqual({ status: 'unavailable', errorCode: 'learning-owner-unavailable' })
    expect(calls).toEqual({ verifier: 0, credentials: 0, llm: 0 })

    // World setup uses the actual candidate writer and review producer, with
    // explicit source evidence. It does not claim an LLM ingest task occurred.
    mkdirSync(dirname(join(projectRoot, sourcePath)), { recursive: true })
    writeFileSync(join(projectRoot, sourcePath), 'Fixture source: checks are not measured actual-use trials.\n')
    expect(await service.writePage({ path: candidatePath, content: CANDIDATE_BYTES }))
      .toMatchObject({ ok: true })
    expect(appendCandidateReviews(reviewFile, projectRoot, sourcePath, [`wiki/${candidatePath}`])).toBe(1)
    const review = (await service.reviews({ status: 'unresolved' }))
      .find(item => item.candidatePath === candidatePath)!
    expect(review).toBeDefined()
    const verified = await execute(ctx, owner.agent, 'wiki_verify_candidate', {
      reviewId: review.id, action: 'Promote',
    }, 'loader-generic-verification')
    expect(verified.isError).toBe(false)
    expect(verified.value).toMatchObject({ ok: true, result: 'pass' })
    const checked = (await service.reviews({ status: 'unresolved' }))
      .find(item => item.id === review.id)!
    expect(checked.verification).toMatchObject({ status: 'passed', successCount: 1, failureCount: 0 })
    expect(checked.verification?.trial).toBeUndefined()
    expect(checked.options?.map(option => option.action)).toEqual(['Archive'])
    const reviewBefore = readFileSync(reviewFile, 'utf8')
    await expect(service.resolveReview({ reviewId: review.id, action: 'Promote' })).resolves.toBe(false)
    expect(readFileSync(reviewFile, 'utf8')).toBe(reviewBefore)
    expect(readFileSync(join(wikiRoot, candidatePath), 'utf8')).toBe(CANDIDATE_BYTES)
    expect(existsSync(join(wikiRoot, targetPath))).toBe(false)
    const canonicalRead = await execute(ctx, owner.agent, 'wiki_read', { path: targetPath }, 'loader-canonical-denied')
    expect(canonicalRead.isError).toBe(true)
    const checkedEvents = readKnowledgeEventLog(historical.eventPath, verifierAuthority())
    const candidateEvents = checkedEvents.filter(event => event.knowledgeId === `candidate:${review.id}`)
    expect(candidateEvents.filter(event => event.type === 'knowledge/verified')).toHaveLength(1)
    expect(candidateEvents.some(event => event.type === 'knowledge/promoted')).toBe(false)
    expect(replayKnowledgeEvents(checkedEvents).records.get(`candidate:${review.id}`))
      .toMatchObject({ successfulUses: 0, utilityScore: 0, retrievalHits: 0 })

    const read = await execute(ctx, owner.agent, 'wiki_read', { path: HISTORICAL_READ_PATH }, 'loader-historical-read-1')
    expect(read.isError).toBe(false)
    expect(read.value).toMatchObject({ path: HISTORICAL_READ_PATH, content: HISTORICAL_READ_BYTES })
    const injected = owner.agent.session.events.findLast(event => event.type === 'knowledge/injected')
    expect(injected).toMatchObject({ data: {
      knowledgeId: historical.knowledgeId, tool: 'wiki_read', callId: 'loader-historical-read-1',
      scope: { sessionId: owner.agent.id, projectId: projectRoot, workspaceId: projectRoot },
      sourceContentHash: sha256(HISTORICAL_READ_BYTES), value: read.content,
    } })
    await ctx.sessions.flush(owner.agent.session)
    expect((await ctx.sessionPersistence.load(owner.agent.id)).events).toEqual(owner.agent.session.events)
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await service.recordKnowledgeOutcome({ paths: [HISTORICAL_READ_PATH], outcome: 'successful' })).toBe(1)
    }
    writeFileSync(join(projectRoot, '.llm-wiki', 'knowledge-utility.json'), JSON.stringify({
      [HISTORICAL_READ_PATH]: {
        path: HISTORICAL_READ_PATH, retrievalHits: 999, successfulUses: 999, userCorrections: 0, utilityScore: 999,
      },
    }))
    await ctx.fiber.dispose()
    ctx = await boot(projectRoot, calls)
    service = ctx.get('knowledgeWiki') as KnowledgeWikiService
    const resumed = await ctx.agents.resume({ resumeSessionId: owner.agent.id, agentOptions: {} })
    expect(resumed.agent.session.events.slice(0, owner.agent.session.events.length)).toEqual(owner.agent.session.events)
    expect(resumed.agent.session.events.at(-1)?.type).toBe('session/end-seed')
    expect((await service.knowledgeUtility()).find(item => item.path === HISTORICAL_READ_PATH))
      .toMatchObject({ retrievalHits: 1, successfulUses: 0, utilityScore: 0 })

    // Unsigned pages and foreign session cwd must not enter the model boundary.
    const unsignedPath = 'concepts/unsigned-loader-page.md'
    writeFileSync(join(wikiRoot, unsignedPath), '# Unsigned fixture\n')
    const unsignedRead = await execute(ctx, resumed.agent, 'wiki_read', { path: unsignedPath }, 'loader-unsigned-denied')
    expect(unsignedRead.isError).toBe(true)
    const foreign = await ctx.agents.create({
      sessionId: SessionId('loader-foreign-owner'), meta: { cwd: join(projectRoot, 'foreign') },
    })
    const foreignRead = await execute(ctx, foreign.agent, 'wiki_read', { path: HISTORICAL_READ_PATH }, 'loader-foreign-denied')
    expect(foreignRead.isError).toBe(true)
    expect(foreign.agent.session.events.some(event => event.type === 'knowledge/injected')).toBe(false)

    const secondRead = await execute(ctx, resumed.agent, 'wiki_read', { path: HISTORICAL_READ_PATH }, 'loader-historical-read-2')
    expect(secondRead.isError).toBe(false)
    expect(await service.recordKnowledgeOutcome({ paths: [HISTORICAL_READ_PATH], outcome: 'successful' })).toBe(1)
    const thirdRead = await execute(ctx, resumed.agent, 'wiki_read', { path: HISTORICAL_READ_PATH }, 'loader-historical-read-3')
    expect(thirdRead.isError).toBe(false)
    const events = readKnowledgeEventLog(historical.eventPath, verifierAuthority())
    const record = replayKnowledgeEvents(events).records.get(historical.knowledgeId)!
    expect(record).toMatchObject({ retrievalHits: 3, successfulUses: 0, utilityScore: 0 })
    expect(shouldRetainKnowledge(record)).toBe(false)
    const feedback = events.filter(event => event.knowledgeId === historical.knowledgeId && event.payload.outcome === 'successful')
    expect(feedback).toHaveLength(3)
    expect(feedback.every(event => event.payload.outcomeSource === 'user-feedback' && event.payload.authoritySeal === undefined)).toBe(true)
    const injectedBeforeDenial = resumed.agent.session.events.filter(event => event.type === 'knowledge/injected').length
    const retainedRead = await execute(ctx, resumed.agent, 'wiki_read', { path: HISTORICAL_READ_PATH }, 'loader-retention-denied')
    expect(retainedRead.isError).toBe(true)
    expect(resumed.agent.session.events.filter(event => event.type === 'knowledge/injected')).toHaveLength(injectedBeforeDenial)
    expect((await execute(ctx, resumed.agent, 'wiki_search', { query: 'Historical Loader retention' }, 'loader-retention-search')).value)
      .toMatchObject({ hits: [] })
    expect(readFileSync(join(wikiRoot, HISTORICAL_READ_PATH), 'utf8')).toBe(HISTORICAL_READ_BYTES)
    await ctx.sessions.flush(resumed.agent.session)
    const durable = await ctx.sessionPersistence.load(resumed.agent.id)
    expect(durable.events).toEqual(resumed.agent.session.events)
    expect(durable.events.filter(event => event.type === 'knowledge/injected' && event.data.tool === 'wiki_read'))
      .toHaveLength(3)
    expect(calls).toEqual({ verifier: 1, credentials: 0, llm: 0 })
  }, 30_000)

  it.each([false, true])('denies competing source owners through real composed tools and restart (reverse=%s)', async (reverse) => {
    root = await mkdtemp(join(tmpdir(), 'wiki-loader-source-identity-'))
    const projectRoot = root
    const wikiRoot = join(projectRoot, 'wiki')
    for (const knowledgeId of reverse ? ['second-owner', 'first-owner'] : ['first-owner', 'second-owner']) {
      seedHistoricalCanonicalKnowledge({
        projectRoot, wikiRoot, path: HISTORICAL_READ_PATH, content: HISTORICAL_READ_BYTES, knowledgeId,
      })
    }
    const calls: ExternalBoundaryCalls = { verifier: 0, credentials: 0, llm: 0 }
    let ctx = await boot(projectRoot, calls)
    let owner = await ctx.agents.create({
      sessionId: SessionId('loader-source-identity-owner'), meta: { cwd: projectRoot },
    })
    owner.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Check that competing knowledge owners cannot supply a tool result.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const retainedState = () => ['wiki', '.llm-wiki', 'jiuzhang-tarballs'].map((name) => {
      const directory = join(projectRoot, name)
      return {
        name, exists: existsSync(directory),
        entries: existsSync(directory) ? readdirSync(directory, { recursive: true, withFileTypes: true }).map((entry) => {
          const path = join(entry.parentPath, entry.name)
          return { path: relative(directory, path), directory: entry.isDirectory(),
            content: entry.isFile() ? readFileSync(path) : undefined }
        }).sort((left, right) => left.path.localeCompare(right.path)) : [],
      }
    })
    const before = retainedState()
    for (let pass = 0; pass < 2; pass++) {
      for (const [name, args] of [
        ['wiki_read', { path: HISTORICAL_READ_PATH }],
        ['wiki_search', { query: 'Historical Loader retention' }],
        ['wiki_files', {}], ['wiki_graph', {}], ['wiki_reviews', {}],
      ] as const) {
        const result = await execute(ctx, owner.agent, name, args, `ambiguous-${pass}-${name}`)
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result.content)).toContain('ambiguous knowledge source ownership')
        expect(JSON.stringify(result.content)).not.toContain(HISTORICAL_READ_BYTES)
      }
      expect(owner.agent.session.events.filter(event => event.type === 'knowledge/retrieved'
        || event.type === 'knowledge/injected')).toEqual([])
      expect(retainedState()).toEqual(before)
      await ctx.sessions.flush(owner.agent.session)
      expect((await ctx.sessionPersistence.load(owner.agent.id)).events).toEqual(owner.agent.session.events)
      if (pass === 0) {
        const resumeSessionId = owner.agent.id
        await ctx.fiber.dispose()
        ctx = await boot(projectRoot, calls)
        owner = await ctx.agents.resume({ resumeSessionId, agentOptions: {} })
      }
    }
    expect(retainedState()).toEqual(before)
    expect(calls).toEqual({ verifier: 0, credentials: 0, llm: 0 })
  }, 30_000)

  it('preserves a recreated candidate when composed Archive rollback and cold recovery reject divergence', async () => {
    root = await mkdtemp(join(tmpdir(), 'wiki-loader-archive-conflict-'))
    const projectRoot = root
    const wikiRoot = join(projectRoot, 'wiki')
    const reviewFile = join(projectRoot, '.llm-wiki', 'review.json')
    const eventPath = join(projectRoot, '.llm-wiki', 'knowledge-events.jsonl')
    const archiveRoot = join(projectRoot, 'jiuzhang-tarballs', 'archive')
    const candidatePath = '_candidates/ingest/concepts/loader-archive-conflict.md'
    const candidateFile = join(wikiRoot, candidatePath)
    const recreated = 'Third-party candidate bytes written after the Archive deletion.\n'
    const calls: ExternalBoundaryCalls = { verifier: 0, credentials: 0, llm: 0 }
    let checkpoints = 0
    const authority: KnowledgeWikiVerifierAuthority = {
      ...verifierAuthority(),
      checkpointPromotion(payload, checkpoint) {
        if (checkpoint.phase !== 'tombstone-unlinked' || checkpoint.operationIndex !== 3) return
        const journal = JSON.parse(payload) as { operations: Array<{ role: string; path: string }> }
        const candidate = journal.operations.find(operation => operation.role === 'candidate')
        expect(candidate?.path).toBe(candidateFile)
        writeFileSync(candidateFile, recreated, { flag: 'wx' })
        checkpoints++
        throw new Error('fixture Archive checkpoint failure')
      },
    }
    mkdirSync(wikiRoot, { recursive: true })
    const ctx = await boot(projectRoot, calls, authority)
    const service = ctx.get('knowledgeWiki') as KnowledgeWikiService
    const sourcePath = 'raw/evidence/loader-generic-check.md'
    mkdirSync(dirname(join(projectRoot, sourcePath)), { recursive: true })
    writeFileSync(join(projectRoot, sourcePath), 'Fixture source for an Archive rollback conflict.\n')
    expect(await service.writePage({ path: candidatePath, content: CANDIDATE_BYTES })).toMatchObject({ ok: true })
    expect(appendCandidateReviews(reviewFile, projectRoot, sourcePath, [`wiki/${candidatePath}`])).toBe(1)
    const review = (await service.reviews({ status: 'unresolved' })).find(item => item.candidatePath === candidatePath)!
    expect(review).toBeDefined()
    const reviewBefore = readFileSync(reviewFile)
    const eventsBefore = readFileSync(eventPath)
    const governanceFile = join(projectRoot, '.llm-wiki', 'governance.jsonl')
    expect(existsSync(governanceFile)).toBe(false)

    const resolution = service.resolveReview({ reviewId: review.id, action: 'Archive' })
    await expect(resolution).rejects.toThrow('rollback was incomplete')
    await expect(resolution).rejects.toMatchObject({
      errors: [
        { message: 'fixture Archive checkpoint failure' },
        { message: `promotion rollback conflict at ${candidateFile}` },
      ],
    })
    expect(checkpoints).toBe(1)
    expect(readFileSync(candidateFile, 'utf8')).toBe(recreated)
    expect(readFileSync(reviewFile)).toEqual(reviewBefore)
    expect(readFileSync(eventPath)).toEqual(eventsBefore)
    expect(existsSync(governanceFile)).toBe(false)
    const journalDirectory = join(projectRoot, '.llm-wiki', 'promotion-journal')
    const journals = readdirSync(journalDirectory)
    expect(journals).toHaveLength(1)
    const journal = JSON.parse(readFileSync(join(journalDirectory, journals[0]!), 'utf8')) as {
      state: string
      action: string
      operations: Array<{ role: string; path: string }>
    }
    expect(journal).toMatchObject({ state: 'prepared', action: 'Archive' })
    const archived = journal.operations.find(operation => operation.role === 'candidate-archive')!
    expect(archived).toBeDefined()
    expect(existsSync(archived.path)).toBe(false)
    expect(readKnowledgeEventLog(eventPath, verifierAuthority()).filter(event =>
      event.type === 'knowledge/rejected' || event.type === 'knowledge/rolled_back'))
      .toHaveLength(0)

    const retainedState = () => [wikiRoot, dirname(reviewFile), archiveRoot].map(directory => ({
      directory,
      entries: readdirSync(directory, { recursive: true, withFileTypes: true }).map((entry) => {
        const path = join(entry.parentPath, entry.name)
        return {
          path: relative(directory, path), directory: entry.isDirectory(),
          content: entry.isFile() ? readFileSync(path) : undefined,
        }
      }).sort((left, right) => left.path.localeCompare(right.path)),
    }))
    expect(retainedState()[2]!.entries.every(entry => entry.directory)).toBe(true)
    await ctx.fiber.dispose()
    const beforeCold = retainedState()
    const coldBoot = boot(projectRoot, calls)
    await expect(coldBoot).rejects.toThrow('failed to apply loader entry')
    await expect(coldBoot).rejects.toThrow('@deepseek-ai/dsh-knowledge-wiki')
    await expect(coldBoot).rejects.toThrow('promotion journal divergent state')
    expect(retainedState()).toEqual(beforeCold)
    expect(calls).toEqual({ verifier: 0, credentials: 0, llm: 0 })
  }, 30_000)
})
