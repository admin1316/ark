import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import * as plugin from '../src/index.ts'

const contexts: Context[] = []
const temporaryRoots: string[] = []
const signal = new AbortController().signal
let calls = 0

type FakeHit = { path: string; score: number; provenance?: NonNullable<FakePage['provenance']> }
type FakeEntry = { path: string; isDir?: boolean; children?: FakeEntry[]; provenance?: NonNullable<FakePage['provenance']> }
type FakePage = {
  path: string
  content: string
  provenance?: {
    knowledgeId: string
    sourceHash: string
    contentHash?: string
    scope: { projectId: string; visibility: 'project' }
    trust: 'medium'
    authority: string
    evidenceRefs: string[]
    verificationStatus: 'verified'
    expiresAt: string | null
    conflicts: string[]
  }
}
type FakeNode = {
  id: string
  label: string
  type?: string
  nodeType?: string
  path?: string
  linkCount: number
  community?: number
  cluster?: string | null
}
type FakeEdge = { source: string; target: string; weight: number }
type FakeGraph = {
  nodes: FakeNode[]
  edges: FakeEdge[]
  provenance?: Record<string, NonNullable<FakePage['provenance']>>
}
type FakeReview = {
  id: string
  title: string
  type: string
  description?: string
  resolved?: boolean
  reviewKind?: string
  candidatePath?: string
  provenance?: FakePage['provenance']
}

class FakeWiki extends Service {
  readonly search = vi.fn<(request: { query: string; topK?: number }) => Promise<FakeHit[]>>().mockResolvedValue([])
  readonly list = vi.fn<() => Promise<FakeEntry[]>>().mockResolvedValue([])
  readonly pageContent = vi.fn<(request: { path: string }) => Promise<FakePage>>().mockResolvedValue({ path: '', content: '' })
  readonly graph = vi.fn<() => Promise<FakeGraph>>().mockResolvedValue({ nodes: [], edges: [] })
  readonly reviews = vi.fn<(request: { status?: string; limit?: number }) => Promise<FakeReview[]>>().mockResolvedValue([])
  readonly modelSearch = vi.fn((request: { query: string; topK?: number }) => this.search(request))
  readonly modelList = vi.fn(() => this.list())
  readonly modelPageContent = vi.fn((request: { path: string }) => this.pageContent(request))
  readonly modelGraph = vi.fn(() => this.graph().then(graph => ({ ...graph, provenance: graph.provenance ?? {} })))
  readonly modelReviews = vi.fn((request: { status?: string; limit?: number }) => this.reviews(request))
  readonly ingestQueueAdd = vi.fn().mockResolvedValue({ tasks: [], running: false, cancelled: false })
  readonly verifyCandidate = vi.fn().mockResolvedValue({ ok: false, evidence: [], errorCode: 'review-not-found' })
  readonly proposeKnowledgeRepair = vi.fn().mockResolvedValue({ ok: false, errorCode: 'source-not-verified' })

  constructor(ctx: Context) {
    super(ctx, 'knowledgeWiki')
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function setup(withService = true): Promise<{ ctx: Context; service?: FakeWiki }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  let service: FakeWiki | undefined
  if (withService) {
    await ctx.plugin(FakeWiki)
    service = ctx.get('knowledgeWiki') as FakeWiki
  }
  await ctx.plugin(plugin)
  return service === undefined ? { ctx } : { ctx, service }
}

function execute(ctx: Context, name: string, args: unknown): Promise<ToolExecutionResult> {
  const id = SessionId(`wiki-test-${++calls}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: Date.now(), cwd: process.cwd() })
  const agent = { id, session } as unknown as Agent
  return ctx.tools.execute({ signal, callId: CallId(`wiki-${calls}`), name, arguments: args, agent })
}

function executeForAgent(ctx: Context, agent: Agent, name: string, args: unknown): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ signal, callId: CallId(`wiki-${++calls}`), name, arguments: args, agent })
}

function text(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('Knowledge Wiki tool catalog', () => {
  it('registers the eight tools and prompt guidance', async () => {
    const { ctx } = await setup()
    expect(plugin.name).toBe('tool-knowledge-wiki')
    expect(plugin.inject).toEqual(['tools', 'systemPrompt'])
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('wiki_')).sort())
      .toEqual(['wiki_files', 'wiki_graph', 'wiki_ingest', 'wiki_propose_repair', 'wiki_read', 'wiki_reviews', 'wiki_search', 'wiki_verify_candidate'])
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'tool:knowledge-wiki')
    expect(section?.text).toContain('wiki_search')
  })

  it('fails every operation clearly when the service is unavailable', async () => {
    const { ctx } = await setup(false)
    for (const [name, args] of [
      ['wiki_search', { query: 'q' }],
      ['wiki_files', {}],
      ['wiki_read', { path: 'entities/a.md' }],
      ['wiki_graph', {}],
      ['wiki_reviews', {}],
      ['wiki_ingest', { input: 'raw/a.md' }],
      ['wiki_propose_repair', { sourcePath: 'concepts/a.md', title: 'Fix', correctedRule: 'Correct rule' }],
      ['wiki_verify_candidate', { reviewId: 'candidate-1', action: 'Promote' }],
    ] as const) {
      const result = await execute(ctx, name, args)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('knowledgeWiki service unavailable')
    }
  })

  it('requires a complete Wiki page injection in the same session before staging a repair', async () => {
    const { ctx, service } = await setup()
    const page = {
      path: 'concepts/a.md',
      content: '# A\n\nVerified page.\n',
      provenance: {
        knowledgeId: 'candidate:a',
        sourceHash: 'a'.repeat(64),
        contentHash: 'b'.repeat(64),
        scope: { projectId: process.cwd(), visibility: 'project' as const },
        trust: 'medium' as const,
        authority: 'test-verifier',
        evidenceRefs: ['receipt:a'],
        verificationStatus: 'verified' as const,
        expiresAt: null,
        conflicts: [],
      },
    }
    service!.modelPageContent.mockResolvedValue(page)
    service!.proposeKnowledgeRepair.mockResolvedValue({
      ok: true,
      candidatePath: '_candidates/ingest/concepts/a.md',
      reviewId: 'candidate-repair-a',
      candidateHash: 'c'.repeat(64),
    })
    const id = SessionId('wiki-repair-session')
    const session = Session.create(id, [], { version: 0, id, createdAt: Date.now(), cwd: process.cwd() })
    const agent = { id, session } as unknown as Agent
    const args = { sourcePath: page.path, title: 'Corrected A', correctedRule: 'Use the verified rule.' }

    const beforeRead = await executeForAgent(ctx, agent, 'wiki_propose_repair', args)
    expect(beforeRead.isError).toBe(true)
    expect(service!.proposeKnowledgeRepair).not.toHaveBeenCalled()

    const read = await executeForAgent(ctx, agent, 'wiki_read', { path: page.path })
    expect(read.isError).toBe(false)
    const afterRead = await executeForAgent(ctx, agent, 'wiki_propose_repair', args)
    expect(afterRead.value).toEqual({
      ok: true,
      candidatePath: '_candidates/ingest/concepts/a.md',
      reviewId: 'candidate-repair-a',
      candidateHash: 'c'.repeat(64),
    })
    expect(service!.proposeKnowledgeRepair).toHaveBeenCalledWith({
      ...args,
      expectedSourceContentHash: page.provenance.contentHash,
    }, expect.objectContaining({ sessionId: 'wiki-repair-session', projectId: process.cwd() }))

    service!.proposeKnowledgeRepair.mockResolvedValueOnce({ ok: false })
    const unclassifiedFailure = await executeForAgent(ctx, agent, 'wiki_propose_repair', args)
    expect(text(unclassifiedFailure)).toContain('Correction was not staged: unknown-error.')
  })

  it('requires a session project for model tools and permits a session without an actor id', async () => {
    const { ctx, service } = await setup()
    const missingSessionId = SessionId('wiki-no-session')
    const noSession = { id: missingSessionId } as unknown as Agent
    const noSessionResult = await executeForAgent(ctx, noSession, 'wiki_search', { query: 'q' })
    expect(noSessionResult.isError).toBe(true)
    expect(text(noSessionResult)).toContain('knowledge scope unavailable')
    for (const [name, args] of [
      ['wiki_read', { path: 'concepts/a.md' }],
      ['wiki_graph', {}],
      ['wiki_reviews', {}],
      ['wiki_propose_repair', { sourcePath: 'concepts/a.md', title: 'Fix', correctedRule: 'Correct rule' }],
    ] as const) {
      const result = await executeForAgent(ctx, noSession, name, args)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('knowledge scope unavailable')
    }

    const missingCwdId = SessionId('wiki-no-cwd')
    const noCwdSession = Session.create(missingCwdId, [], {
      version: 0, id: missingCwdId, createdAt: Date.now(),
    })
    const noCwd = await executeForAgent(ctx, { id: missingCwdId, session: noCwdSession } as Agent, 'wiki_files', {})
    expect(noCwd.isError).toBe(true)
    expect(text(noCwd)).toContain('knowledge scope unavailable')

    const actorlessId = SessionId('wiki-no-actor')
    const actorlessSession = Session.create(actorlessId, [], {
      version: 0, id: actorlessId, createdAt: Date.now(), cwd: process.cwd(),
    })
    const actorless = await executeForAgent(ctx, { session: actorlessSession } as Agent, 'wiki_search', { query: 'none' })
    expect(actorless.isError).toBe(false)
    expect(service?.search).toHaveBeenLastCalledWith({ query: 'none', topK: 8 })
  })

  it('rejects correction evidence from another session and from an injection without source bytes', async () => {
    const { ctx, service } = await setup()
    const page: FakePage = {
      path: 'concepts/a.md',
      content: '# A\n\nVerified page.\n',
      provenance: {
        knowledgeId: 'candidate:a',
        sourceHash: 'a'.repeat(64),
        contentHash: 'b'.repeat(64),
        scope: { projectId: process.cwd(), visibility: 'project' },
        trust: 'medium',
        authority: 'test-verifier',
        evidenceRefs: ['receipt:a'],
        verificationStatus: 'verified',
        expiresAt: null,
        conflicts: [],
      },
    }
    service!.modelPageContent.mockResolvedValue(page)

    const sourceId = SessionId('wiki-provenance-source-session')
    const sourceSession = Session.create(sourceId, [], {
      version: 0, id: sourceId, createdAt: Date.now(), cwd: process.cwd(),
    })
    const sourceAgent = { id: sourceId, session: sourceSession } as unknown as Agent
    expect((await executeForAgent(ctx, sourceAgent, 'wiki_read', { path: page.path })).isError).toBe(false)

    const replayId = SessionId('wiki-provenance-replay-session')
    const replaySession = Session.create(replayId, [], {
      version: 0, id: replayId, createdAt: Date.now(), cwd: process.cwd(),
    })
    for (const event of sourceSession.events) {
      if (event.type === 'knowledge/retrieved') replaySession.append('knowledge/retrieved', event.data)
      if (event.type === 'knowledge/injected') replaySession.append('knowledge/injected', event.data)
    }
    replaySession.append('knowledge/retrieved', {
      knowledgeId: 'candidate:a',
      path: page.path,
      resultHash: 'c'.repeat(64),
      tool: 'wiki_read',
      callId: 'blocked-read',
      scope: { sessionId: String(replayId), projectId: process.cwd(), workspaceId: process.cwd() },
      kind: 'page',
      allowed: false,
      reason: 'unverified',
    })
    const replayAgent = { id: replayId, session: replaySession } as unknown as Agent
    const args = { sourcePath: page.path, title: 'Correction', correctedRule: 'The direct user rule.' }
    const foreign = await executeForAgent(ctx, replayAgent, 'wiki_propose_repair', args)
    expect(foreign.isError).toBe(true)
    expect(text(foreign)).toContain('read the complete verified Wiki page')

    const noHashId = SessionId('wiki-provenance-no-hash-session')
    const noHashSession = Session.create(noHashId, [], {
      version: 0, id: noHashId, createdAt: Date.now(), cwd: process.cwd(),
    })
    const provenanceWithoutHash: NonNullable<typeof page.provenance> = { ...page.provenance! }
    delete provenanceWithoutHash.contentHash
    service!.modelPageContent.mockResolvedValueOnce({
      ...page,
      provenance: provenanceWithoutHash,
    })
    const noHashAgent = { id: noHashId, session: noHashSession } as unknown as Agent
    expect((await executeForAgent(ctx, noHashAgent, 'wiki_read', { path: page.path })).isError).toBe(false)
    const noHash = await executeForAgent(ctx, noHashAgent, 'wiki_propose_repair', args)
    expect(noHash.isError).toBe(true)
    expect(text(noHash)).toContain('read the complete verified Wiki page')
    expect(service!.proposeKnowledgeRepair).not.toHaveBeenCalled()
  })

  it('searches and renders both empty and ranked results', async () => {
    const { ctx, service } = await setup()
    service?.search.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { path: 'entities/a.md', score: 0.75 },
      { path: 'concepts/b.md', score: 0.5 },
    ])
    expect(text(await execute(ctx, 'wiki_search', { query: 'none' }))).toBe('No matches found.')
    const ranked = await execute(ctx, 'wiki_search', { query: 'match' })
    expect(text(ranked)).toContain('- entities/a.md (score 0.75)')
    expect(service?.search).toHaveBeenLastCalledWith({ query: 'match', topK: 8 })
  })

  it('records retrieved and injected Wiki values on the calling session', async () => {
    const { ctx, service } = await setup()
    service?.pageContent.mockResolvedValue({
      path: 'entities/a.md',
      content: 'verified page',
      provenance: {
        knowledgeId: 'candidate:candidate-123',
        sourceHash: 'a'.repeat(64),
        scope: { projectId: process.cwd(), visibility: 'project' },
        trust: 'medium',
        authority: 'fixture-verifier',
        evidenceRefs: ['receipt-1'],
        verificationStatus: 'verified',
        expiresAt: null,
        conflicts: [],
      },
    })
    const id = SessionId('wiki-session')
    const session = Session.create(id, [], { version: 0, id, createdAt: Date.now(), cwd: process.cwd() })
    const agent = { id, session } as unknown as Agent
    const result = await executeForAgent(ctx, agent, 'wiki_read', { path: 'entities/a.md' })
    expect(result.isError).toBe(false)
    expect(session.events.filter(event => event.type === 'knowledge/retrieved')).toHaveLength(1)
    expect(session.events.filter(event => event.type === 'knowledge/injected')).toHaveLength(1)
    const injected = session.events.find(event => event.type === 'knowledge/injected')
    const data = injected?.data as Record<string, unknown> | undefined
    expect(data?.path).toBe('entities/a.md')
    expect(data?.knowledgeId).toBe('candidate:candidate-123')
    expect(data?.tool).toBe('wiki_read')
    expect(typeof data?.callId).toBe('string')
    expect(data?.value).toEqual([{ type: 'text', text: '# entities/a.md\n\nverified page' }])
    expect((data?.scope as { sessionId?: string; projectId?: string } | undefined)?.sessionId).toBe('wiki-session')
    expect((data?.scope as { sessionId?: string; projectId?: string } | undefined)?.projectId).toBe(process.cwd())
  })

  it('keeps provenance bound to its execution when concurrent sessions reuse a call ID', async () => {
    const { ctx, service } = await setup()
    service?.pageContent.mockImplementation(async ({ path }) => ({
      path,
      content: path,
      provenance: {
        knowledgeId: `candidate:${path.includes('alpha') ? 'alpha' : 'beta'}`,
        sourceHash: path.includes('alpha') ? 'a'.repeat(64) : 'b'.repeat(64),
        scope: { projectId: process.cwd(), visibility: 'project' },
        trust: 'medium',
        authority: 'fixture-verifier',
        evidenceRefs: [path],
        verificationStatus: 'verified',
        expiresAt: null,
        conflicts: [],
      },
    }))

    let releaseBarrier = () => {}
    const bothCallsReachedPostExecute = new Promise<void>((resolve) => { releaseBarrier = resolve })
    let postExecuteCount = 0
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name !== 'wiki_read') return next()
      postExecuteCount += 1
      if (postExecuteCount === 2) releaseBarrier()
      return bothCallsReachedPostExecute.then(() => next())
    })

    const sessionFor = (id: string) => {
      const sessionId = SessionId(id)
      const session = Session.create(sessionId, [], {
        version: 0, id: sessionId, createdAt: Date.now(), cwd: process.cwd(),
      })
      return { session, agent: { id: sessionId, session } as unknown as Agent }
    }
    const alpha = sessionFor('wiki-collision-alpha')
    const beta = sessionFor('wiki-collision-beta')
    const run = (agent: Agent, path: string) => ctx.tools.execute({
      signal,
      callId: CallId('wiki-reused-call-id'),
      name: 'wiki_read',
      arguments: { path },
      agent,
    })

    const [alphaResult, betaResult] = await Promise.all([
      run(alpha.agent, 'concepts/alpha.md'),
      run(beta.agent, 'concepts/beta.md'),
    ])
    expect(alphaResult.isError).toBe(false)
    expect(betaResult.isError).toBe(false)
    const alphaInjected = alpha.session.events.filter(event => event.type === 'knowledge/injected')
    const betaInjected = beta.session.events.filter(event => event.type === 'knowledge/injected')
    expect(alphaInjected.map(event => event.data.knowledgeId)).toEqual(['candidate:alpha'])
    expect(betaInjected.map(event => event.data.knowledgeId)).toEqual(['candidate:beta'])
    expect(alphaInjected[0]?.data.value).toEqual(alphaResult.content)
    expect(betaInjected[0]?.data.value).toEqual(betaResult.content)
    expect(alphaInjected[0]?.data.scope.sessionId).toBe('wiki-collision-alpha')
    expect(betaInjected[0]?.data.scope.sessionId).toBe('wiki-collision-beta')
  })

  it('keeps a rendered injection on the Session that owned the tool execution', async () => {
    const { ctx, service } = await setup()
    service?.pageContent.mockResolvedValue({
      path: 'entities/session-owner.md',
      content: 'session-owned result',
      provenance: {
        knowledgeId: 'candidate:session-owner',
        sourceHash: 'c'.repeat(64),
        scope: { projectId: process.cwd(), visibility: 'project' },
        trust: 'medium',
        authority: 'fixture-verifier',
        evidenceRefs: ['receipt-session-owner'],
        verificationStatus: 'verified',
        expiresAt: null,
        conflicts: [],
      },
    })
    const original = SessionId('wiki-session-owner-original')
    const destination = SessionId('wiki-session-owner-destination')
    const originalSession = Session.create(original, [], {
      version: 0, id: original, createdAt: Date.now(), cwd: process.cwd(),
    })
    const destinationSession = Session.create(destination, [], {
      version: 0, id: destination, createdAt: Date.now(), cwd: process.cwd(),
    })
    const agent = { id: original, session: originalSession } as unknown as Agent
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === 'wiki_read' && exec.agent !== undefined) {
        Reflect.set(exec.agent, 'session', destinationSession)
      }
      return next()
    })

    const result = await ctx.tools.execute({
      signal,
      callId: CallId('wiki-session-owner-call'),
      name: 'wiki_read',
      arguments: { path: 'entities/session-owner.md' },
      agent,
    })
    expect(result.isError).toBe(false)
    const originalInjected = originalSession.events.filter(event => event.type === 'knowledge/injected')
    const destinationInjected = destinationSession.events.filter(event => event.type === 'knowledge/injected')
    expect(originalInjected).toHaveLength(1)
    expect(originalInjected[0]?.data.scope.sessionId).toBe(String(original))
    expect(originalInjected[0]?.data.value).toEqual(result.content)
    expect(destinationInjected).toHaveLength(0)
  })

  it('cold-replays every model-visible Wiki result and its provenance from Zstandard session storage', async () => {
    const { ctx, service } = await setup()
    const persistenceRoot = mkdtempSync(join(tmpdir(), 'wiki-session-replay-'))
    temporaryRoots.push(persistenceRoot)
    const provenance = (knowledgeId: string): NonNullable<FakePage['provenance']> => ({
      knowledgeId,
      sourceHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64),
      scope: { projectId: process.cwd(), visibility: 'project' },
      trust: 'medium',
      authority: 'fixture-verifier',
      evidenceRefs: [`receipt-${knowledgeId}`],
      verificationStatus: 'verified',
      expiresAt: null,
      conflicts: [],
    })
    service?.modelSearch.mockResolvedValue([{
      path: 'concepts/search.md', score: 0.9, provenance: provenance('candidate:search'),
    }])
    service?.modelList.mockResolvedValue([{
      path: 'concepts/files.md', provenance: provenance('candidate:files'),
    }])
    service?.modelPageContent.mockResolvedValue({
      path: 'concepts/page.md', content: 'verified page', provenance: provenance('candidate:page'),
    })
    service?.modelGraph.mockResolvedValue({
      nodes: [{ id: 'graph-node', label: 'Graph node', type: 'concept', path: 'concepts/graph.md', linkCount: 1 }],
      edges: [],
      provenance: { 'graph-node': provenance('candidate:graph') },
    })
    service?.modelReviews.mockResolvedValue([{
      id: 'review-one', title: 'Review one', type: 'candidate', provenance: provenance('candidate:reviews'),
    }])
    const id = SessionId('wiki-zstd-replay')
    const session = Session.create(id, [], { version: 0, id, createdAt: Date.now(), cwd: process.cwd() })
    const agent = { id, session } as unknown as Agent
    const toolCalls = [
      ['wiki_search', { query: 'knowledge' }],
      ['wiki_files', {}],
      ['wiki_read', { path: 'concepts/page.md' }],
      ['wiki_graph', {}],
      ['wiki_reviews', {}],
    ] as const
    const results = new Map<string, ToolExecutionResult>()
    for (const [name, args] of toolCalls) {
      const result = await executeForAgent(ctx, agent, name, args)
      expect(result.isError).toBe(false)
      results.set(name, result)
    }
    const expectedKnowledgeEvents = session.events.filter(event =>
      event.type === 'knowledge/retrieved' || event.type === 'knowledge/injected')
    expect(expectedKnowledgeEvents.filter(event => event.type === 'knowledge/retrieved')).toHaveLength(8)
    const expectedInjections = expectedKnowledgeEvents.flatMap(event =>
      event.type === 'knowledge/injected' ? [event] : [])
    expect(expectedInjections).toHaveLength(5)
    const expectedTools = toolCalls.map(([name]) => name)
    expect(new Set(expectedInjections.map(event => event.data.tool))).toEqual(new Set(expectedTools))
    for (const name of expectedTools) {
      const result = results.get(name)
      expect(result).toBeDefined()
      const toolInjections = expectedInjections.filter(event => event.data.tool === name)
      expect(toolInjections.length).toBeGreaterThan(0)
      for (const injection of toolInjections) {
        expect(injection.data.value).toEqual(result?.content)
        expect(injection.data.authority).toBe('fixture-verifier')
        const retrieval = expectedKnowledgeEvents.find(event => event.type === 'knowledge/retrieved'
          && event.data.callId === injection.data.callId
          && event.data.knowledgeId === injection.data.knowledgeId)
        expect(retrieval).toBeDefined()
      }
    }

    const writer = new Context()
    contexts.push(writer)
    await writer.plugin(SessionStore)
    await writer.plugin(JsonlSessionPersistence, { root: persistenceRoot })
    await writer.sessionPersistence.create(session.header)
    await writer.sessionPersistence.append(session.id, session.events)
    const storedLog = writer.sessionPersistence.locate(session.header)
    if (storedLog === undefined) throw new Error('expected the persisted Wiki session log to be locatable')
    expect(storedLog.path).toMatch(/\.jsonl\.zstd$/u)
    expect(existsSync(storedLog.path)).toBe(true)
    await writer.fiber.dispose()
    contexts.splice(contexts.indexOf(writer), 1)

    const reader = new Context()
    contexts.push(reader)
    await reader.plugin(SessionStore)
    await reader.plugin(JsonlSessionPersistence, { root: persistenceRoot })
    const loaded = await reader.sessionPersistence.load(id)
    const restored = Session.fromRestore(loaded.meta.id, loaded.events, loaded.meta)
    const replayedKnowledgeEvents = restored.events.filter(event =>
      event.type === 'knowledge/retrieved' || event.type === 'knowledge/injected')
    expect(replayedKnowledgeEvents).toEqual(expectedKnowledgeEvents)
    const replayedInjections = replayedKnowledgeEvents.flatMap(event =>
      event.type === 'knowledge/injected' ? [event] : [])
    expect(new Set(replayedInjections.map(event => event.data.tool))).toEqual(new Set(expectedTools))
    for (const injection of replayedInjections) {
      expect(injection.data.scope).toEqual({ sessionId: String(id), projectId: process.cwd(), workspaceId: process.cwd() })
      expect(injection.data.sourceHash).toBe('b'.repeat(64))
      expect(injection.data.evidenceRefs).toHaveLength(1)
      expect(Array.isArray(injection.data.value)).toBe(true)
      expect(injection.data.resultHash).toMatch(/^[a-f0-9]{64}$/u)
    }
  })

  it('ignores a stray successful Wiki result that has no session owner', async () => {
    const { ctx } = await setup()
    const execution = {
      callId: CallId('wiki-unowned-result'),
      name: 'wiki_search',
      agent: undefined,
    }
    const result = { isError: false, content: [], value: { hits: [] } }
    expect(() => { ctx.emit('tools/result', execution as never, result as never) }).not.toThrow()
  })

  it('lists at most sixty paths while reporting the full total', async () => {
    const { ctx, service } = await setup()
    service?.list.mockResolvedValue(Array.from({ length: 61 }, (_, index) => ({ path: `concepts/${index}.md` })))
    const result = await execute(ctx, 'wiki_files', {})
    expect(result.value).toMatchObject({ total: 61 })
    expect((result.value as { files: string[] }).files).toHaveLength(60)
    expect(text(result)).toContain('61 files total. First 60')
  })

  it('reads pages, reports missing content, and bounds model-visible text', async () => {
    const { ctx, service } = await setup()
    service?.pageContent.mockResolvedValueOnce({ path: 'entities/missing.md', content: '' })
    const missing = await execute(ctx, 'wiki_read', { path: 'entities/missing.md' })
    expect(missing.isError).toBe(true)

    service?.pageContent.mockResolvedValueOnce({ path: 'entities/short.md', content: 'short' })
    const short = await execute(ctx, 'wiki_read', { path: 'entities/short.md' })
    expect(short.value).toEqual({ path: 'entities/short.md', content: 'short', truncated: false })
    expect(text(short)).not.toContain('内容已截断')

    service?.pageContent.mockResolvedValueOnce({ path: 'concepts/long.md', content: 'x'.repeat(8001) })
    const long = await execute(ctx, 'wiki_read', { path: 'concepts/long.md' })
    expect((long.value as { content: string }).content).toHaveLength(8000)
    expect(text(long)).toContain('内容已截断')

    for (const unsafe of ['wiki/entities/a.md', '../a.md', '/entities/a.md', 'entities\\a.md']) {
      const rejected = await execute(ctx, 'wiki_read', { path: unsafe })
      expect(rejected.isError).toBe(true)
      expect(text(rejected)).toContain('path must')
    }
  })

  it('filters graph nodes and keeps only edges between returned nodes', async () => {
    const { ctx, service } = await setup()
    service?.graph.mockResolvedValue({
      nodes: [
        { id: 'alpha-id', label: 'Alpha', type: 'entity', path: 'entities/a.md', linkCount: 2, community: 1 },
        { id: 'needle-id', label: 'Beta', type: 'entity', linkCount: 1, community: 1 },
        { id: 'other', label: 'Other', type: 'concept', path: 'concepts/o.md', linkCount: 1, community: 2 },
      ],
      edges: [
        { source: 'alpha-id', target: 'needle-id', weight: 2 },
        { source: 'alpha-id', target: 'other', weight: 1 },
      ],
    })
    const filtered = await execute(ctx, 'wiki_graph', { query: 'needle', nodeType: 'entity', limit: 1000 })
    expect(filtered.value).toEqual({
      nodes: [expect.objectContaining({ id: 'needle-id' })],
      edges: [],
    })
    expect(text(filtered)).toContain('Beta (entity, 1 links)')

    const all = await execute(ctx, 'wiki_graph', {})
    expect((all.value as { nodes: unknown[] }).nodes).toHaveLength(3)
    expect(text(all)).toContain('Alpha (entity, 2 links, entities/a.md)')
    expect(text(all)).toContain('alpha-id ↔ needle-id (w=2)')

    const noType = await execute(ctx, 'wiki_graph', { query: '', nodeType: 'missing', limit: 1 })
    expect(noType.value).toEqual({ nodes: [], edges: [] })
  })

  it('records item-level provenance for graph nodes and candidate reviews', async () => {
    const { ctx, service } = await setup()
    const provenance = (knowledgeId: string): NonNullable<FakePage['provenance']> => ({
      knowledgeId,
      sourceHash: 'a'.repeat(64),
      scope: { projectId: process.cwd(), visibility: 'project' },
      trust: 'medium',
      authority: 'fixture-verifier',
      evidenceRefs: [`receipt:${knowledgeId}`],
      verificationStatus: 'verified',
      expiresAt: null,
      conflicts: [],
    })
    const alpha = provenance('candidate:alpha')
    const beta = provenance('candidate:beta')
    service?.modelGraph.mockResolvedValue({
      nodes: [
        { id: 'alpha', label: 'Alpha', type: 'concept', path: 'concepts/alpha.md', linkCount: 0 },
        { id: 'beta', label: 'Beta', type: 'concept', path: 'concepts/beta.md', linkCount: 0 },
      ],
      edges: [],
      provenance: { alpha, beta },
    })
    service?.reviews.mockResolvedValue([
      { id: 'review-alpha', title: 'Alpha review', type: 'candidate', reviewKind: 'candidate', provenance: alpha },
      { id: 'review-beta', title: 'Beta review', type: 'candidate', reviewKind: 'candidate', provenance: beta },
    ])
    const id = SessionId('wiki-provenance-session')
    const session = Session.create(id, [], { version: 0, id, createdAt: Date.now(), cwd: process.cwd() })
    const agent = { id, session } as unknown as Agent

    const graph = await executeForAgent(ctx, agent, 'wiki_graph', {})
    expect(graph.isError).toBe(false)
    const graphRetrieved = session.events.filter((event) => {
      const data = event.data as Record<string, unknown>
      return event.type === 'knowledge/retrieved' && data.kind === 'graph'
    })
    const graphInjected = session.events.filter((event) => {
      const data = event.data as Record<string, unknown>
      return event.type === 'knowledge/injected' && data.kind === 'graph'
    })
    expect(graphRetrieved).toHaveLength(3)
    expect(graphInjected.map(event => (event.data as Record<string, unknown>).knowledgeId).sort())
      .toEqual(['candidate:alpha', 'candidate:beta'])
    expect(graphInjected.map(event => (event.data as Record<string, unknown>).path))
      .toEqual(['tool:wiki_graph:candidate:alpha', 'tool:wiki_graph:candidate:beta'])

    const reviews = await executeForAgent(ctx, agent, 'wiki_reviews', {})
    expect(reviews.isError).toBe(false)
    const reviewRetrieved = session.events.filter((event) => {
      const data = event.data as Record<string, unknown>
      return event.type === 'knowledge/retrieved' && data.kind === 'reviews'
    })
    const reviewInjected = session.events.filter((event) => {
      const data = event.data as Record<string, unknown>
      return event.type === 'knowledge/injected' && data.kind === 'reviews'
    })
    expect(reviewRetrieved).toHaveLength(3)
    expect(reviewInjected.map(event => (event.data as Record<string, unknown>).knowledgeId).sort())
      .toEqual(['candidate:alpha', 'candidate:beta'])
  })

  it('renders unresolved reviews with optional descriptions', async () => {
    const { ctx, service } = await setup()
    service?.reviews.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: '1', title: 'Conflict', type: 'contradiction', description: 'd'.repeat(150) },
      { id: '2', title: 'Missing', type: 'missing' },
    ])
    expect(text(await execute(ctx, 'wiki_reviews', {}))).toBe('No unresolved review items.')
    const result = await execute(ctx, 'wiki_reviews', {})
    expect(result.value).toEqual({ reviews: [
      { id: '1', title: 'Conflict', type: 'contradiction', description: 'd'.repeat(150) },
      { id: '2', title: 'Missing', type: 'missing' },
    ] })
    expect(text(result)).toContain('[contradiction] Conflict — ' + 'd'.repeat(140))
    expect(service?.reviews).toHaveBeenLastCalledWith({ status: 'unresolved', limit: 30 })
  })

  it('routes all ingestion through the durable queue owner', async () => {
    const { ctx, service } = await setup()
    service?.ingestQueueAdd.mockResolvedValue({
      tasks: [{ id: 7, input: 'HTTPS://example.test/a', status: 'pending' }],
      running: true,
      cancelled: false,
    })
    const result = await execute(ctx, 'wiki_ingest', { input: 'HTTPS://example.test/a' })
    expect(result.value).toEqual({
      tasks: [{ id: 7, input: 'HTTPS://example.test/a', status: 'pending' }],
      running: true,
    })
    expect(text(result)).toBe('- #7 pending: HTTPS://example.test/a')
    expect(service?.ingestQueueAdd).toHaveBeenCalledWith({ inputs: ['HTTPS://example.test/a'] })
  })

  it('routes Candidate verification only through the trusted service owner', async () => {
    const { ctx, service } = await setup()
    service?.verifyCandidate.mockResolvedValue({ ok: true, receiptId: 'candidate-r1', result: 'pass', evidence: ['PASS'] })
    const result = await execute(ctx, 'wiki_verify_candidate', { reviewId: 'candidate-1', action: 'Promote' })
    expect(result.value).toMatchObject({ ok: true, receiptId: 'candidate-r1' })
    expect(service?.verifyCandidate).toHaveBeenCalledWith(
      { reviewId: 'candidate-1', action: 'Promote' },
      expect.any(AbortSignal),
    )
    const missingAction = await execute(ctx, 'wiki_verify_candidate', { reviewId: 'candidate-1' })
    expect(missingAction.isError).toBe(true)
  })

  it('reports an empty ingestion queue without inventing a task', async () => {
    const { ctx, service } = await setup()
    const result = await execute(ctx, 'wiki_ingest', { input: 'raw/already-queued.md' })
    expect(result.value).toEqual({ tasks: [], running: false })
    expect(text(result)).toBe('No task was queued.')
    expect(service?.ingestQueueAdd).toHaveBeenCalledExactlyOnceWith({ inputs: ['raw/already-queued.md'] })
  })

  it.each([undefined, '', 'review-not-found'])('renders a negative verification without claiming authority, errorCode=%s', async (errorCode) => {
    const { ctx, service } = await setup()
    const outcome = { ok: false, evidence: [], ...(errorCode === undefined ? {} : { errorCode }) }
    service?.verifyCandidate.mockResolvedValue(outcome)

    const result = await execute(ctx, 'wiki_verify_candidate', { reviewId: 'missing', action: 'Promote' })

    expect(result.value).toEqual(outcome)
    expect(text(result)).toBe(errorCode ? `Candidate verification failed: ${errorCode}` : 'Candidate verification failed.')
    expect(service?.verifyCandidate).toHaveBeenCalledExactlyOnceWith(
      { reviewId: 'missing', action: 'Promote' }, expect.any(AbortSignal),
    )
  })
})
