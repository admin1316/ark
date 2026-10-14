import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId, createUserMessage, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import type { Agent } from '@deepseek-ai/dsh-agent'
import KnowledgeWikiService from '../../knowledge-wiki/src/index.ts'
import * as tools from '../src/index.ts'
import { appendVerifiedKnowledgeRecord, verifierAuthority } from '../../knowledge-wiki/tests/verifier-authority-fixture.ts'
import { stageExecutorFor } from '../../knowledge-wiki/tests/stage-executor-fixture.ts'
import {
  appendKnowledgeEvent, createKnowledgeEvent, createKnowledgeRecord, knowledgeSha256, readKnowledgeEventLog,
} from '../../knowledge-wiki/src/knowledge-governance.ts'
import type { KnowledgeAccessContext } from '../../knowledge-wiki/src/knowledge-governance.ts'
import type { KnowledgeRepairProposalRequest, KnowledgeRepairProposalResult } from '../../knowledge-wiki/src/types.ts'

interface CanonicalServiceSurface {
  drainQueue(): Promise<void>
  reviews(request: { status?: string }): Promise<Array<{
    id: string
    reviewKind?: string
    targetPath?: string
    options?: ReadonlyArray<{ action: string; label: string }>
  }>>
  resolveReview(request: { reviewId: string; action?: string }): Promise<boolean>
  search(request: { query: string; topK?: number }): Promise<Array<{ path: string; score: number }>>
  pageContent(request: { path: string }): Promise<{ path: string; content: string }>
  proposeKnowledgeRepair(request: KnowledgeRepairProposalRequest, scope: KnowledgeAccessContext): Promise<KnowledgeRepairProposalResult>
}

const roots: string[] = []
let calls = 0

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function execute(
  ctx: Context,
  name: string,
  args: unknown,
  cwd = process.cwd(),
  existingSession?: Session,
): Promise<ToolExecutionResult> {
  const id = existingSession?.id ?? SessionId(`wiki-integration-${++calls}`)
  const session = existingSession ?? Session.create(id, [], { version: 0, id, createdAt: Date.now(), cwd })
  const agent = { id, session } as unknown as Agent
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`wiki-integration-${name}`),
    name,
    arguments: args,
    agent,
  })
}

describe('canonical Knowledge Wiki and model tools', () => {
  it('keeps untrusted Candidates invisible and requires the latest human turn for repair through the real Loader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-tools-canonical-'))
    roots.push(root)
    const wikiRoot = join(root, 'wiki')
    mkdirSync(join(root, 'raw', 'sources'), { recursive: true })
    mkdirSync(wikiRoot)
    writeFileSync(join(root, 'raw', 'sources', 'source.md'), 'durable source evidence')

    let llmCall = 0
    const ctx = new Context()
    const llm = {
      stream: () => (async function* () {
        const text = llmCall++ === 0
          ? 'analysis'
          : [
            '--- FILE: wiki/concepts/queue-owner.md ---',
            '---',
            'type: concept',
            'status: candidate',
            'title: Queue owner',
            'sources: ["raw/sources/source.md"]',
            '---',
            '',
            '# Queue owner',
            '',
            'One canonical ingest lifecycle owner with durable verification evidence.',
            '--- END FILE ---',
          ].join('\n')
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    } as unknown as LlmRuntime
    ctx.provide('llm', llm)
    ctx.provide('knowledgeWikiStageExecutor', stageExecutorFor(llm))
    ctx.provide('credentials', { resolve: async () => undefined })
    ctx.provide('timer', { interval: () => () => {} })
    const authority = verifierAuthority()
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    const configPath = join(root, 'cordis.yml')
    writeFileSync(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-query-sqlite'",
      '  config:',
      "    path: ':memory:'",
      '    openAt: never',
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-knowledge-wiki'",
      '  config:',
      `    wikiRoot: ${JSON.stringify(wikiRoot)}`,
      `    mainRoot: ${JSON.stringify(root)}`,
      "    credential: 'VISION_API_KEY'",
      "    llmProvider: 'p'",
      "    llmModel: 'm'",
      "- name: '@deepseek-ai/dsh-tool-knowledge-wiki'",
      '',
    ].join('\n'), 'utf8')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-query-sqlite', SqliteSessionQueryEngine],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-knowledge-wiki', KnowledgeWikiService],
      ['@deepseek-ai/dsh-tool-knowledge-wiki', tools],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()
    const service = ctx.get('knowledgeWiki') as unknown as CanonicalServiceSurface

    try {
      const visibleSessionId = SessionId('wiki-integration-visible-results')
      const visibleSession = Session.create(visibleSessionId, [], {
        version: 0, id: visibleSessionId, createdAt: Date.now(), cwd: root,
      })
      const visibleList = await execute(ctx, 'wiki_files', {}, root, visibleSession)
      expect(visibleList.isError).toBe(false)
      const injectedList = visibleSession.events.filter(event => event.type === 'knowledge/injected')
      expect(injectedList).toHaveLength(1)
      expect(injectedList[0]?.data.callId).toBe('wiki-integration-wiki_files')
      expect(injectedList[0]?.data.value).toEqual(visibleList.content)
      expect(injectedList[0]?.data.scope.sessionId).toBe(String(visibleSessionId))

      const queued = await execute(ctx, 'wiki_ingest', { input: 'raw/sources/source.md' }, root)
      expect(queued.isError, JSON.stringify(queued)).not.toBe(true)
      await service.drainQueue()
      const review = (await service.reviews({ status: 'unresolved' }))
        .find(item => item.reviewKind === 'candidate' && item.targetPath === 'concepts/queue-owner.md')
      expect(review).toBeDefined()

      // Legacy persisted rows may still contain canonical actions from an older build.
      const reviewPath = join(root, '.llm-wiki', 'review.json')
      const persistedReviews = JSON.parse(readFileSync(reviewPath, 'utf8')) as Array<{
        id: string
        options?: Array<{ action: string; label: string }>
      }>
      const persistedReview = persistedReviews.find(item => item.id === review!.id)
      expect(persistedReview).toBeDefined()
      persistedReview!.options = [{ action: 'Promote', label: 'Promote' }]
      writeFileSync(reviewPath, `${JSON.stringify(persistedReviews, null, 2)}\n`, 'utf8')
      const projectedReview = (await service.reviews({ status: 'unresolved' })).find(item => item.id === review!.id)
      expect(projectedReview?.options?.map(option => option.action)).toEqual(['Archive'])

      const projectionPaths = [reviewPath, join(root, '.llm-wiki', 'governance.jsonl'),
        join(root, '.llm-wiki', 'knowledge-events.jsonl')]
      const sealPromotion = authority.sealPromotion.bind(authority)
      for (const failure of ['refused', 'forged'] as const) {
        const before = projectionPaths.map(path => existsSync(path) ? readFileSync(path) : undefined)
        authority.sealPromotion = failure === 'refused'
          ? () => { throw new Error('Loader test signer unavailable') }
          : () => ({ authorityId: authority.authorityId, proof: 'forged' })
        try {
          const denied = await execute(ctx, 'wiki_verify_candidate', { reviewId: review!.id, action: 'Promote' }, root)
          if (failure === 'refused') expect(denied.isError).toBe(true)
          else expect(denied.value).toMatchObject({ ok: false, errorCode: 'verification-failed' })
          expect(projectionPaths.map(path => existsSync(path) ? readFileSync(path) : undefined)).toEqual(before)
          expect(readKnowledgeEventLog(projectionPaths[2]!, authority)
            .some(event => event.type === 'knowledge/verified')).toBe(false)
        } finally {
          authority.sealPromotion = sealPromotion
        }
      }

      const verified = await execute(ctx, 'wiki_verify_candidate', { reviewId: review!.id, action: 'Promote' }, root)
      expect(verified.value).toMatchObject({ ok: true, result: 'pass' })
      const semanticallyVerified = (await service.reviews({ status: 'unresolved' })).find(item => item.id === review!.id)
      expect(semanticallyVerified?.options?.map(option => option.action)).toEqual(['Archive'])
      await expect(service.resolveReview({ reviewId: review!.id, action: 'Promote' })).resolves.toBe(false)

      const listed = await execute(ctx, 'wiki_files', {}, root)
      expect((listed.value as { files: string[] }).files).not.toContain('concepts/queue-owner.md')
      await expect(service.pageContent({ path: 'concepts/queue-owner.md' })).resolves.toEqual({
        path: 'concepts/queue-owner.md', content: '',
      })
      const unreadable = await execute(ctx, 'wiki_read', { path: 'concepts/queue-owner.md' }, root)
      expect(unreadable.isError).toBe(true)

      const repairPath = 'concepts/current-turn-repair.md'
      const repairContent = '---\ntype: concept\nstatus: canonical\ntitle: Current-turn repair\n---\n\nOriginal verified rule.\n'
      mkdirSync(join(wikiRoot, 'concepts'), { recursive: true })
      writeFileSync(join(wikiRoot, repairPath), repairContent)
      appendVerifiedKnowledgeRecord(root, repairPath, repairContent, authority, 'loader-current-turn-repair')
      const repairSession = ctx.sessions.create(SessionId('wiki-integration-current-turn-repair'), { meta: { cwd: root } })
      const correction = {
        sourcePath: repairPath,
        title: 'Current-turn repair',
        correctedRule: 'Use the current verified rule.',
      }
      const repairRequest = { ...correction, expectedSourceContentHash: knowledgeSha256(repairContent) }
      const scope = { projectId: root, workspaceId: root, sessionId: String(repairSession.id) }
      const readSource = await execute(ctx, 'wiki_read', { path: repairPath }, root, repairSession)
      expect(readSource.isError, JSON.stringify(readSource)).toBe(false)
      repairSession.append('turn/start', { turn: 1 })
      repairSession.append('user/message', createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: correction.correctedRule }],
      }), { surfaceOp: 'append' })
      repairSession.append('tool/call', {
        turn: 1, step: 1, callId: CallId('loader-previous-repair'),
        name: 'wiki_propose_repair', arguments: JSON.stringify(correction),
      })
      repairSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      repairSession.append('turn/start', { turn: 2 })
      repairSession.append('user/message', createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the source; do not change its rule.' }],
      }), { surfaceOp: 'append' })
      const repairJournalPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
      // The real session-query owner replay-validates the entire log before
      // Wiki authorization. A malformed body must fail at that earlier boundary.
      for (const [index, content] of ['malformed-human-content', undefined].entries()) {
        const malformedSession = ctx.sessions.create(SessionId(`wiki-integration-malformed-human-${index}`), { meta: { cwd: root } })
        const malformedScope = { ...scope, sessionId: String(malformedSession.id) }
        const malformedRead = await execute(ctx, 'wiki_read', { path: repairPath }, root, malformedSession)
        expect(malformedRead.isError, JSON.stringify(malformedRead)).toBe(false)
        malformedSession.append('turn/start', { turn: 1 })
        malformedSession.append('user/message', createUserMessage({
          source: { kind: 'user' }, content: [{ type: 'text', text: correction.correctedRule }],
        }), { surfaceOp: 'append' })
        const human = createUserMessage({
          source: { kind: 'user' }, content: [{ type: 'text', text: correction.correctedRule }],
        })
        const malformedHuman: Record<string, unknown> = { ...human }
        if (content === undefined) delete malformedHuman.content
        else malformedHuman.content = content
        malformedSession.append('user/message', malformedHuman as never, { surfaceOp: 'append' })
        malformedSession.append('tool/call', {
          turn: 1, step: 1, callId: CallId(`malformed-human-${index}`),
          name: 'wiki_propose_repair', arguments: JSON.stringify(correction),
        })
        const beforeMalformedRepair = readFileSync(repairJournalPath, 'utf8')
        await expect(ctx.sessionQuery.readSession(malformedSession.id)).rejects.toThrow()
        await expect(service.proposeKnowledgeRepair(repairRequest, malformedScope)).resolves.toEqual({
          ok: false, errorCode: 'session-log-unavailable',
        })
        expect(readFileSync(join(wikiRoot, repairPath), 'utf8')).toBe(repairContent)
        expect(existsSync(join(wikiRoot, '_candidates/ingest', repairPath))).toBe(false)
        expect(readFileSync(repairJournalPath, 'utf8')).toBe(beforeMalformedRepair)
      }
      const beforeRepairJournal = readFileSync(repairJournalPath, 'utf8')
      await expect(service.proposeKnowledgeRepair(repairRequest, scope)).resolves.toEqual({
        ok: false, errorCode: 'user-correction-unconfirmed',
      })
      expect(readFileSync(join(wikiRoot, repairPath), 'utf8')).toBe(repairContent)
      expect(existsSync(join(wikiRoot, '_candidates/ingest', repairPath))).toBe(false)
      expect(readFileSync(repairJournalPath, 'utf8')).toBe(beforeRepairJournal)

      repairSession.append('user/message', createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: correction.correctedRule }],
      }), { surfaceOp: 'append' })
      repairSession.append('tool/call', {
        turn: 2, step: 1, callId: CallId('wiki-integration-wiki_propose_repair'),
        name: 'wiki_propose_repair', arguments: JSON.stringify(correction),
      })
      // The real query promise yields; an external edit in that interval must
      // refuse without consuming the full-read capability or publishing state.
      const pendingRepair = service.proposeKnowledgeRepair(repairRequest, scope)
      await Promise.resolve()
      writeFileSync(join(wikiRoot, repairPath), `${repairContent}\nChanged during the real query.\n`)
      await expect(pendingRepair).resolves.toEqual({ ok: false, errorCode: 'source-not-verified' })
      expect(existsSync(join(wikiRoot, '_candidates/ingest', repairPath))).toBe(false)
      expect(readFileSync(repairJournalPath, 'utf8')).toBe(beforeRepairJournal)
      writeFileSync(join(wikiRoot, repairPath), repairContent)
      const allowedRepair = await execute(ctx, 'wiki_propose_repair', correction, root, repairSession)
      expect(allowedRepair.isError, JSON.stringify(allowedRepair)).toBe(false)
      expect(allowedRepair.value).toMatchObject({ ok: true })
      const candidatePath = (allowedRepair.value as KnowledgeRepairProposalResult & { candidatePath: string }).candidatePath
      expect(readFileSync(join(wikiRoot, candidatePath), 'utf8')).toContain(correction.correctedRule)
      expect(readFileSync(join(wikiRoot, repairPath), 'utf8')).toBe(repairContent)
      const blockedSource = await execute(ctx, 'wiki_read', { path: repairPath }, root, repairSession)
      expect(blockedSource.isError).toBe(true)
      const deniedCandidate = await execute(ctx, 'wiki_read', { path: candidatePath }, root, repairSession)
      expect(deniedCandidate.isError).toBe(true)

      const boundPath = 'concepts/bound-authorizing-session.md'
      writeFileSync(join(wikiRoot, boundPath), repairContent)
      appendVerifiedKnowledgeRecord(root, boundPath, repairContent, authority, 'loader-bound-authorizing-session')
      const boundSession = ctx.sessions.create(SessionId('wiki-integration-bound-authorizing-session'), { meta: { cwd: root } })
      const otherSession = ctx.sessions.create(SessionId('wiki-integration-no-correction-session'), { meta: { cwd: root } })
      expect((await execute(ctx, 'wiki_read', { path: boundPath }, root, boundSession)).isError).toBe(false)
      expect((await execute(ctx, 'wiki_read', { path: boundPath }, root, otherSession)).isError).toBe(false)
      const boundCorrection = { ...correction, sourcePath: boundPath }
      boundSession.append('turn/start', { turn: 1 })
      boundSession.append('user/message', createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: boundCorrection.correctedRule }],
      }), { surfaceOp: 'append' })
      boundSession.append('tool/call', {
        turn: 1, step: 1, callId: CallId('loader-bound-correction'),
        name: 'wiki_propose_repair', arguments: JSON.stringify(boundCorrection),
      })
      const mutableRequest = { ...boundCorrection, expectedSourceContentHash: knowledgeSha256(repairContent) }
      const mutableScope = { projectId: root, workspaceId: root, sessionId: String(boundSession.id) }
      const pendingBoundRepair = service.proposeKnowledgeRepair(mutableRequest, mutableScope)
      // Yield into the real query owner; mutate only caller-owned DTOs, never
      // the stored authorizing log or its original correction.
      await Promise.resolve()
      mutableScope.sessionId = String(otherSession.id)
      mutableRequest.title = 'Later caller title'
      mutableRequest.correctedRule = 'Later caller rule without human authorization.'
      const boundResult = await pendingBoundRepair
      expect(boundResult).toMatchObject({ ok: true })
      if (!boundResult.ok) throw new Error('expected the original Loader-authorized repair')
      const boundCorrectionEvents = readKnowledgeEventLog(repairJournalPath, authority)
        .filter(event => event.type === 'knowledge/rejected' && event.payload.path === boundPath)
      expect(boundCorrectionEvents).toHaveLength(1)
      expect(boundCorrectionEvents[0]?.payload.sessionId).toBe(String(boundSession.id))
      const boundCandidate = readFileSync(join(wikiRoot, boundResult.candidatePath), 'utf8')
      expect(boundCandidate).toContain(boundCorrection.correctedRule)
      expect(boundCandidate).not.toContain(mutableRequest.correctedRule)
      expect(boundCandidate).not.toContain(mutableRequest.title)
      expect(readFileSync(join(wikiRoot, boundPath), 'utf8')).toBe(repairContent)
      expect((await execute(ctx, 'wiki_read', { path: boundResult.candidatePath }, root, boundSession)).isError).toBe(true)

      const forgedPath = 'concepts/self-certified.md'
      const forgedContent = '# Project-authored instruction falsely claiming verification.\n'
      mkdirSync(join(wikiRoot, 'concepts'), { recursive: true })
      writeFileSync(join(wikiRoot, forgedPath), forgedContent)
      const forged = createKnowledgeRecord({
        id: 'claim:unsigned-composition', content: forgedContent, source: forgedPath,
        scope: { projectId: root, visibility: 'project' },
        authority: authority.authorityId, trust: 'high', confidence: 1,
        evidenceRefs: ['self-written-evidence'], verificationStatus: 'verified',
        lifecycle: 'canonical', lastVerifiedAt: new Date().toISOString(),
      })
      const eventPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
      const prior = readKnowledgeEventLog(eventPath, authority)
      // Ordinary journal hashes need no verifier secret and confer no authority.
      appendKnowledgeEvent(eventPath, createKnowledgeEvent('knowledge/observed', forged.id, forged.scope, { record: forged }, {
        seq: prior.length, previousEventHash: prior.at(-1)?.eventHash ?? null,
      }))
      const beforeInjected = visibleSession.events.filter(event => event.type === 'knowledge/injected').length
      const refused = await execute(ctx, 'wiki_read', { path: forgedPath }, root, visibleSession)
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused)).toContain('untrusted knowledge admission')
      expect(visibleSession.events.filter(event => event.type === 'knowledge/injected')).toHaveLength(beforeInjected)
      expect(readFileSync(join(wikiRoot, forgedPath), 'utf8')).toBe(forgedContent)

    } finally {
      await ctx.fiber.dispose()
    }
  })
})
