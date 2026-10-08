import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { KnowledgeModelProvenance } from '../../knowledge-wiki/src/index.ts'
import * as plugin from '../src/index.ts'

const contexts: Context[] = []
const signal = new AbortController().signal
let calls = 0

type FakeHit = { path: string; score: number }
type FakeEntry = { path: string; isDir?: boolean; children?: FakeEntry[] }
type FakePage = { path: string; content: string }
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
type FakeGraph = { nodes: FakeNode[]; edges: FakeEdge[] }
type FakeReview = {
  id: string
  title: string
  type: string
  description?: string
  resolved?: boolean
  reviewKind?: string
  candidatePath?: string
  provenance?: KnowledgeModelProvenance
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
  readonly modelGraph = vi.fn(() => this.graph().then(graph => ({ ...graph, provenance: {} })))
  readonly modelReviews = vi.fn((request: { status?: string; limit?: number }) => this.reviews(request))
  readonly ingestQueueAdd = vi.fn().mockResolvedValue({ tasks: [], running: false, cancelled: false })
  readonly verifyCandidate = vi.fn().mockResolvedValue({ ok: false, evidence: [], errorCode: 'review-not-found' })

  constructor(ctx: Context) {
    super(ctx, 'knowledgeWiki')
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
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
  it('registers the seven tools and prompt guidance', async () => {
    const { ctx } = await setup()
    expect(plugin.name).toBe('tool-knowledge-wiki')
    expect(plugin.inject).toEqual(['tools', 'systemPrompt'])
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('wiki_')).sort())
      .toEqual(['wiki_files', 'wiki_graph', 'wiki_ingest', 'wiki_read', 'wiki_reviews', 'wiki_search', 'wiki_verify_candidate'])
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
      ['wiki_verify_candidate', { reviewId: 'candidate-1', action: 'Promote' }],
    ] as const) {
      const result = await execute(ctx, name, args)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('knowledgeWiki service unavailable')
    }
  })

  it('denies every model read without an authoritative session working directory', async () => {
    const { ctx, service } = await setup()
    const id = SessionId('wiki-no-working-directory')
    const session = Session.create(id, [], { version: 0, id, createdAt: Date.now() })
    const agent = { id, session } as unknown as Agent
    for (const [name, args] of [
      ['wiki_search', { query: 'claim' }], ['wiki_files', {}],
      ['wiki_read', { path: 'concepts/claim.md' }], ['wiki_graph', {}], ['wiki_reviews', {}],
    ] as const) {
      const result = await executeForAgent(ctx, agent, name, args)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('knowledge scope unavailable')
    }
    expect(service?.modelSearch).not.toHaveBeenCalled()
    expect(service?.modelList).not.toHaveBeenCalled()
    expect(service?.modelPageContent).not.toHaveBeenCalled()
    expect(service?.modelGraph).not.toHaveBeenCalled()
    expect(service?.modelReviews).not.toHaveBeenCalled()
    expect(session.events.filter(event => event.type.startsWith('knowledge/'))).toEqual([])
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
    service?.pageContent.mockResolvedValue({ path: 'entities/a.md', content: 'verified page' })
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
    expect(data?.tool).toBe('wiki_read')
    expect(typeof data?.callId).toBe('string')
    expect(data?.value).toEqual([{ type: 'text', text: '# entities/a.md\n\nverified page' }])
    expect((data?.scope as { sessionId?: string; projectId?: string } | undefined)?.sessionId).toBe('wiki-session')
    expect((data?.scope as { sessionId?: string; projectId?: string } | undefined)?.projectId).toBe(process.cwd())
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

  it('renders unresolved reviews with optional descriptions', async () => {
    const { ctx, service } = await setup()
    service?.reviews.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: '1', title: 'Conflict', type: 'contradiction', description: 'd'.repeat(150) },
      { id: '2', title: 'Missing', type: 'missing' },
    ])
    expect(text(await execute(ctx, 'wiki_reviews', {}))).toBe('No unresolved review items are visible to this session.')
    const result = await execute(ctx, 'wiki_reviews', {})
    expect(result.value).toEqual({ reviews: [
      { id: '1', title: 'Conflict', type: 'contradiction', description: 'd'.repeat(150) },
      { id: '2', title: 'Missing', type: 'missing' },
    ] })
    expect(text(result)).toContain('[contradiction] Conflict — ' + 'd'.repeat(140))
    expect(service?.reviews).toHaveBeenLastCalledWith({ status: 'unresolved', limit: 30 })
  })

  it('logs graph and review provenance against the exact rendered output and deduplicates one knowledge identity', async () => {
    const { ctx, service } = await setup()
    const id = SessionId('wiki-provenance-projection')
    const session = Session.create(id, [], { version: 0, id, createdAt: Date.now(), cwd: process.cwd() })
    const agent = { id, session } as unknown as Agent
    const provenance: KnowledgeModelProvenance = {
      knowledgeId: 'independently-verified-claim', sourceHash: 'a'.repeat(64),
      contentHash: 'b'.repeat(64), scope: { projectId: process.cwd(), visibility: 'project' },
      trust: 'medium', authority: 'trusted-verifier', evidenceRefs: ['receipt'],
      verificationStatus: 'verified', expiresAt: null, conflicts: [],
    }
    service?.modelGraph.mockResolvedValue({
      nodes: [
        { id: 'one', label: 'First', path: 'concepts/first.md', linkCount: 1, type: 'concept' },
        { id: 'two', label: 'Second', path: 'concepts/second.md', linkCount: 1, type: 'concept' },
      ],
      edges: [{ source: 'one', target: 'two', weight: 1 }],
      provenance: { one: provenance, two: provenance },
    })
    const graph = await executeForAgent(ctx, agent, 'wiki_graph', {})
    expect(graph.isError).toBe(false)
    const graphInjected = session.events.filter(event => event.type === 'knowledge/injected')
    expect(graphInjected).toHaveLength(1)
    expect(graphInjected[0]?.data).toMatchObject({
      knowledgeId: provenance.knowledgeId, sourceHash: provenance.sourceHash,
      sourceContentHash: provenance.contentHash, value: graph.content,
      evidenceRefs: ['receipt'], verificationStatus: 'verified',
    })

    service?.reviews.mockResolvedValue([{ id: 'review', title: 'Evidence review', type: 'suggestion', provenance }])
    const reviews = await executeForAgent(ctx, agent, 'wiki_reviews', {})
    expect(reviews.isError).toBe(false)
    const reviewInjected = session.events.filter(event => event.type === 'knowledge/injected').at(-1)
    expect(reviewInjected?.data).toMatchObject({
      knowledgeId: provenance.knowledgeId, sourceHash: provenance.sourceHash, value: reviews.content,
    })
    expect(session.events.filter(event => event.type === 'knowledge/retrieved')).toHaveLength(5)
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
