/**
 * Model-facing knowledge-base tools over the knowledgeWiki service: the
 * deployment chooses governed reads and verification or ingestion only.
 * No MCP bridge or desktop app is added. Tools register through the
 * harness tool system; every call resolves the knowledgeWiki service
 * lazily so the plugin loads even when the service is absent.
 * @module @deepseek-ai/dsh-tool-knowledge-wiki
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  KnowledgeAccessContext,
  WikiFileEntry,
  WikiGraphResult,
  WikiPageContent,
  WikiReviewItem,
  WikiSearchHit,
} from '@deepseek-ai/dsh-knowledge-wiki'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import './session-events.ts'

interface KnowledgeModelProvenance {
  readonly knowledgeId: string
  readonly contentHash?: string
  readonly sourceHash: string
  readonly trust: 'low' | 'medium' | 'high'
  readonly authority: string
  readonly evidenceRefs: readonly string[]
  readonly verificationStatus: 'observed' | 'candidate' | 'verified' | 'rejected' | 'conflict' | 'expired'
  readonly expiresAt: string | null
  readonly conflicts: readonly string[]
}

type ToolKnowledgeWikiService = {
  modelSearch(
    request: { query: string; topK?: number },
    scope: KnowledgeAccessContext,
    signal?: AbortSignal,
  ): Promise<Array<WikiSearchHit & { provenance: KnowledgeModelProvenance }>>
  modelPageContent(
    request: { path: string },
    scope: KnowledgeAccessContext,
  ): Promise<WikiPageContent & { provenance: KnowledgeModelProvenance }>
  modelList(scope: KnowledgeAccessContext): Promise<Array<WikiFileEntry & { provenance?: KnowledgeModelProvenance }>>
  modelGraph(scope: KnowledgeAccessContext): Promise<WikiGraphResult & {
    provenance: Readonly<Record<string, KnowledgeModelProvenance>>
  }>
  modelReviews(
    request: { status?: string; limit?: number },
    scope: KnowledgeAccessContext,
  ): Promise<Array<WikiReviewItem & { provenance?: KnowledgeModelProvenance }>>
  ingestQueueAdd(request: { inputs: string[] }): Promise<{
    tasks: Array<{ id: number; input: string; status: string }>
    running: boolean
    cancelled?: boolean
  }>
  verifyCandidate(request: {
    reviewId: string
    action: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' | 'Archive'
  }, signal: AbortSignal): Promise<{
    ok: boolean
    receiptId?: string
    result?: 'pass' | 'fail'
    evidence: string[]
    errorCode?: string
  }>
}

/** Stable Cordis plugin name. */
export const name = 'tool-knowledge-wiki'

/** Required services: the tool registry and the prompt section owner. */
export const inject = ['tools', 'systemPrompt']

/** Deployment selection for the governed tool catalog. */
export interface Config {
  /**
   * Expose governed reads and Candidate verification. Defaults to true;
   * false retains only wiki_ingest. Exposure does not grant service authority.
   */
  readonly exposeGovernedTools?: boolean
}

/** Resolve the load-time catalog choice without coercing configuration values. */
function resolveGovernedToolExposure(config: unknown): boolean {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new TypeError('tool-knowledge-wiki config must be an object')
  }
  const exposure = (config as { readonly exposeGovernedTools?: unknown }).exposeGovernedTools
  if (exposure !== undefined && typeof exposure !== 'boolean') {
    throw new TypeError('exposeGovernedTools must be a boolean')
  }
  return exposure ?? true
}

/** Cap on returned hits / listed files / read characters. */
const SEARCH_MAX_RESULTS = 8
const FILES_MAX = 60
const READ_MAX_CHARS = 8000
const REVIEW_MAX = 30
const renderedProvenance = new Map<string, KnowledgeModelProvenance[]>()

/** Resolve the knowledgeWiki service; undefined when the bridge is absent. */
function wikiService(ctx: Context): ToolKnowledgeWikiService | undefined {
  return ctx.get('knowledgeWiki') as ToolKnowledgeWikiService | undefined
}

/** Text block helper for render callbacks. */
function textBlock(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function sessionScope(exec: Pick<ToolRunContext, 'agent'> | Pick<ToolExecution, 'agent'>): KnowledgeAccessContext | undefined {
  const session = exec.agent?.session
  if (session === undefined) return undefined
  const cwd = session.header.cwd
  if (cwd === undefined || cwd.trim() === '') return undefined
  const projectId = resolve(cwd)
  return {
    sessionId: String(session.id),
    projectId,
    workspaceId: projectId,
    ...(exec.agent?.id === undefined ? {} : { actor: String(exec.agent.id) }),
  }
}

function sessionEventScope(scope: KnowledgeAccessContext): { sessionId: string; projectId?: string; workspaceId?: string } {
  if (scope.sessionId === undefined) throw new Error('knowledge scope is missing session id')
  return {
    sessionId: scope.sessionId,
    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
    ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
  }
}

function recordKnowledgeResult(
  exec: ToolRunContext,
  type: 'knowledge/retrieved' | 'knowledge/injected',
  details: {
    kind: 'search' | 'page' | 'graph' | 'reviews' | 'files'
    path: string
    value: JsonValue
    contentBytes: number
    truncated?: boolean
    provenance?: KnowledgeModelProvenance
  },
): void {
  if (type === 'knowledge/injected') return
  const session = exec.agent?.session
  const scope = sessionScope(exec)
  if (session === undefined || scope === undefined) return
  const resultHash = stableHash(details.value)
  if (details.provenance !== undefined) {
    const current = renderedProvenance.get(String(exec.callId)) ?? []
    current.push(details.provenance)
    renderedProvenance.set(String(exec.callId), current)
  }
  const base = {
    knowledgeId: `wiki:${details.path}`,
    path: details.path,
    resultHash,
    contentHash: stableHash(details.value),
    tool: exec.name,
    callId: String(exec.callId),
    scope: sessionEventScope(scope),
    value: details.value,
    ...(details.provenance === undefined ? {} : {
      sourceHash: details.provenance.sourceHash,
      ...(details.provenance.contentHash === undefined ? {} : { sourceContentHash: details.provenance.contentHash }),
      trust: details.provenance.trust,
      authority: details.provenance.authority,
      evidenceRefs: [...details.provenance.evidenceRefs],
      verificationStatus: details.provenance.verificationStatus,
      expiresAt: details.provenance.expiresAt,
      conflicts: [...details.provenance.conflicts],
    }),
  }
  session.append('knowledge/retrieved', {
    ...base,
    kind: details.kind,
    allowed: true,
    reason: 'ok',
  })
}

function recordRenderedKnowledgeResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
  if (result.isError || !['wiki_search', 'wiki_files', 'wiki_read', 'wiki_graph', 'wiki_reviews'].includes(exec.name)) return
  const session = exec.agent?.session
  const scope = sessionScope(exec)
  if (session === undefined || scope === undefined) return
  const rendered = asJsonValue(result.content)
  const kind = exec.name.slice('wiki_'.length) as 'search' | 'files' | 'read' | 'graph' | 'reviews'
  const rawValue = result.value
  const resultPath = typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)
    && typeof (rawValue as { path?: unknown }).path === 'string'
    ? (rawValue as { path: string }).path
    : `tool:${exec.name}`
  const provenance = renderedProvenance.get(String(exec.callId)) ?? []
  renderedProvenance.delete(String(exec.callId))
  const rows = provenance.length === 0 ? [undefined] : [...new Map(provenance.map(item => [item.knowledgeId, item])).values()]
  for (const item of rows) {
    session.append('knowledge/injected', {
      knowledgeId: item?.knowledgeId ?? `wiki:${resultPath}`,
      path: item === undefined || provenance.length === 1 ? resultPath : `tool:${exec.name}:${item.knowledgeId}`,
      resultHash: stableHash(rendered),
      contentHash: stableHash(rendered),
      tool: exec.name,
      callId: String(exec.callId),
      scope: sessionEventScope(scope),
      value: rendered,
      kind: kind === 'read' ? 'page' : kind,
      contentBytes: Buffer.byteLength(JSON.stringify(rendered), 'utf8'),
      ...(item === undefined ? {} : {
        sourceHash: item.sourceHash,
        ...(item.contentHash === undefined ? {} : { sourceContentHash: item.contentHash }),
        trust: item.trust,
        authority: item.authority,
        evidenceRefs: [...item.evidenceRefs],
        verificationStatus: item.verificationStatus,
        expiresAt: item.expiresAt,
        conflicts: [...item.conflicts],
      }),
    })
  }
}

function wikiRootRelativePath(input: string): string {
  if (input === '' || input.startsWith('/') || input.startsWith('wiki/') || input.includes('\\') || input.includes('\0')) {
    throw new Error('path must be relative to the Wiki root (for example entities/name.md)')
  }
  if (input.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('path must not contain traversal segments')
  }
  return input
}

/**
 * Register the knowledge-base tools.
 * @param ctx - plugin context.
 * @param config - load-time tool exposure; invalid boolean values reject before registration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const exposeGovernedTools = resolveGovernedToolExposure(config)
  ctx.systemPrompt.section({
    name: 'tool:knowledge-wiki',
    order: 120,
    text: exposeGovernedTools
      ? 'Use wiki_search to find knowledge-base pages, wiki_read to read one Wiki-root-relative page, wiki_files to list canonical pages, wiki_graph to inspect the graph, wiki_reviews to inspect governance, wiki_verify_candidate to run the trusted verifier, and wiki_ingest to enqueue source work. Cite pages by their Wiki-root-relative path.'
      : 'Use wiki_ingest to enqueue source work.',
  })
  if (!exposeGovernedTools) {
    registerIngestTool(ctx)
    return
  }
  ctx.on('tools/result', (exec, result) => {
    recordRenderedKnowledgeResult(exec, result)
    return undefined
  })

  ctx.tools.register(defineTool({
    name: 'wiki_search',
    description: 'Search the project knowledge base (万相织鉴). Returns ranked page paths with relevance scores.',
    parameters: {
      query: { type: 'string', required: true, description: 'The search query (keywords or a question).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                score: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const hits = value.hits as Array<{ path: string; score: number }>
        if (hits.length === 0) return textBlock('No matches found.')
        return textBlock(hits.map(hit => `- ${hit.path} (score ${hit.score})`).join('\n'))
      },
    },
    async execute(args: { query: string }, exec) {
      const service = wikiService(ctx)
      if (service === undefined) throw new Error('knowledgeWiki service unavailable')
      const scope = sessionScope(exec)
      if (scope === undefined) throw new Error('knowledge scope unavailable')
      const hits = await service.modelSearch({ query: args.query, topK: SEARCH_MAX_RESULTS }, scope, exec.signal)
      const visibleHits = hits.map(({ path, score }) => ({ path, score }))
      for (const hit of hits) recordKnowledgeResult(exec, 'knowledge/retrieved', {
        kind: 'search', path: hit.path, value: asJsonValue({ path: hit.path, score: hit.score }), contentBytes: JSON.stringify(hit).length,
        provenance: hit.provenance,
      })
      recordKnowledgeResult(exec, 'knowledge/injected', {
        kind: 'search', path: `search:${args.query}`, value: asJsonValue({ hits: visibleHits }), contentBytes: JSON.stringify(visibleHits).length,
      })
      return { hits: visibleHits }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_files',
    description: 'List canonical knowledge-base pages. Paths are relative to the Wiki root; raw sources are intentionally not exposed by this tool.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: { type: 'array', required: true, items: { type: 'string' } },
          total: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const files = value.files
        return textBlock(`${value.total as number} files total. First ${files.length}:\n${files.map(file => `- ${file}`).join('\n')}`)
      },
    },
    async execute(_args: Record<string, never>, exec) {
      const service = wikiService(ctx)
      if (service === undefined) throw new Error('knowledgeWiki service unavailable')
      const scope = sessionScope(exec)
      if (scope === undefined) throw new Error('knowledge scope unavailable')
      const entries = await service.modelList(scope)
      const value = { files: entries.slice(0, FILES_MAX).map(entry => entry.path), total: entries.length }
      for (const entry of entries.slice(0, FILES_MAX)) {
        if (entry.provenance === undefined) continue
        recordKnowledgeResult(exec, 'knowledge/retrieved', {
          kind: 'files', path: entry.path, value: asJsonValue({ path: entry.path }), contentBytes: entry.path.length,
          provenance: entry.provenance,
        })
      }
      recordKnowledgeResult(exec, 'knowledge/retrieved', {
        kind: 'files', path: 'files', value: asJsonValue(value), contentBytes: JSON.stringify(value).length,
      })
      recordKnowledgeResult(exec, 'knowledge/injected', {
        kind: 'files', path: 'files', value: asJsonValue(value), contentBytes: JSON.stringify(value).length,
      })
      return value
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_read',
    description: 'Read one canonical knowledge-base page by its Wiki-root-relative path (e.g. entities/角色名.md).',
    parameters: {
      path: { type: 'string', required: true, description: 'Project-relative page path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const truncated = value.truncated === true ? '\n(内容已截断)' : ''
        return textBlock(`# ${value.path as string}\n\n${value.content as string}${truncated}`)
      },
    },
    async execute(args: { path: string }, exec) {
      const service = wikiService(ctx)
      if (service === undefined) throw new Error('knowledgeWiki service unavailable')
      const path = wikiRootRelativePath(args.path)
      const scope = sessionScope(exec)
      if (scope === undefined) throw new Error('knowledge scope unavailable')
      const page = await service.modelPageContent({ path }, scope)
      if (page.content === '') throw new Error(`page not found or unreadable: ${args.path}`)
      const truncated = page.content.length > READ_MAX_CHARS
      const content = page.content.slice(0, READ_MAX_CHARS)
      const value = { path: page.path, content, truncated }
      recordKnowledgeResult(exec, 'knowledge/retrieved', {
        kind: 'page', path: page.path, value, contentBytes: content.length, truncated, provenance: page.provenance,
      })
      recordKnowledgeResult(exec, 'knowledge/injected', {
        kind: 'page', path: page.path, value, contentBytes: content.length, truncated,
      })
      return value
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_graph',
    description: 'Query the knowledge graph. Returns nodes (with community ids and link counts) and edges matching the filter.',
    parameters: {
      query: { type: 'string', description: 'Filter nodes whose label or id contains this text.' },
      nodeType: { type: 'string', description: 'Filter by node type (entity/concept/source/finding/…).' },
      limit: { type: 'number', description: 'Maximum nodes to return (default 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                type: { type: 'string' },
                path: { type: 'string' },
                linkCount: { type: 'number' },
                community: { type: 'number' },
              },
            },
          },
          edges: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string' },
                target: { type: 'string' },
                weight: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const nodes = value.nodes as Array<{ label: string; type: string; linkCount: number; path?: string }>
        const edges = value.edges as Array<{ source: string; target: string; weight: number }>
        const nodeLines = nodes.map(node => `- ${node.label} (${node.type}, ${node.linkCount} links${node.path ? `, ${node.path}` : ''})`)
        const edgeLines = edges.slice(0, 30).map(edge => `- ${edge.source} ↔ ${edge.target} (w=${edge.weight})`)
        return textBlock(`Nodes (${nodes.length}):\n${nodeLines.join('\n')}\n\nEdges (showing first 30 of ${edges.length}):\n${edgeLines.join('\n')}`)
      },
    },
    async execute(args: { query?: string; nodeType?: string; limit?: number }, exec) {
      const service = wikiService(ctx)
      if (service === undefined) throw new Error('knowledgeWiki service unavailable')
      const scope = sessionScope(exec)
      if (scope === undefined) throw new Error('knowledge scope unavailable')
      const graph = await service.modelGraph(scope)
      const q = args.query?.toLowerCase()
      const t = args.nodeType?.toLowerCase()
      const limit = Math.min(args.limit ?? 20, 100)
      const matchedIds = new Set<string>()
      const nodes = graph.nodes
        .filter((node) => {
          if (t !== undefined && node.type !== t) return false
          if (q !== undefined && q !== '' && !node.label.toLowerCase().includes(q) && !node.id.toLowerCase().includes(q)) return false
          return true
        })
        .slice(0, limit)
      for (const node of nodes) matchedIds.add(node.id)
      const edges = graph.edges.filter(edge => matchedIds.has(edge.source) && matchedIds.has(edge.target))
      const value = { nodes, edges }
      for (const node of nodes) {
        const provenance = graph.provenance[node.id]
        if (provenance === undefined) continue
        recordKnowledgeResult(exec, 'knowledge/retrieved', {
          kind: 'graph', path: node.path, value: asJsonValue(node), contentBytes: JSON.stringify(node).length,
          provenance,
        })
      }
      recordKnowledgeResult(exec, 'knowledge/retrieved', {
        kind: 'graph', path: `graph:${args.query ?? ''}`, value: asJsonValue(value), contentBytes: JSON.stringify(value).length,
      })
      recordKnowledgeResult(exec, 'knowledge/injected', {
        kind: 'graph', path: `graph:${args.query ?? ''}`, value: asJsonValue(value), contentBytes: JSON.stringify(value).length,
      })
      return value
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_reviews',
    description: 'List unresolved knowledge-base review items (missing pages, contradictions, pending human judgment).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reviews: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                type: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const reviews = value.reviews as Array<{ title: string; type: string; description?: string }>
        if (reviews.length === 0) return textBlock('No unresolved review items are visible to this session.')
        return textBlock(reviews.map(review => `- [${review.type}] ${review.title}${review.description ? ` — ${review.description.slice(0, 140)}` : ''}`).join('\n'))
      },
    },
    async execute(_args: Record<string, never>, exec) {
      const service = wikiService(ctx)
      if (service === undefined) throw new Error('knowledgeWiki service unavailable')
      const scope = sessionScope(exec)
      if (scope === undefined) throw new Error('knowledge scope unavailable')
      const reviews = await service.modelReviews({ status: 'unresolved', limit: REVIEW_MAX }, scope)
      const value = {
        reviews: reviews.map(review => ({
          id: review.id,
          title: review.title,
          type: review.type,
          ...(review.description === undefined ? {} : { description: review.description }),
        })),
      }
      for (const review of reviews) {
        if (review.provenance === undefined) continue
        recordKnowledgeResult(exec, 'knowledge/retrieved', {
          kind: 'reviews', path: review.id, value: asJsonValue(review), contentBytes: JSON.stringify(review).length,
          provenance: review.provenance,
        })
      }
      recordKnowledgeResult(exec, 'knowledge/retrieved', {
        kind: 'reviews', path: 'reviews', value: asJsonValue(value), contentBytes: JSON.stringify(value).length,
      })
      recordKnowledgeResult(exec, 'knowledge/injected', {
        kind: 'reviews', path: 'reviews', value: asJsonValue(value), contentBytes: JSON.stringify(value).length,
      })
      return value
    },
  }))

  registerIngestTool(ctx)

  ctx.tools.register(defineTool({
    name: 'wiki_verify_candidate',
    description: 'Run the canonical deterministic verifier for one Candidate review. The caller cannot provide pass/fail metadata or receipt hashes.',
    parameters: {
      reviewId: { type: 'string', required: true, description: 'Candidate review id returned by wiki_reviews.' },
      action: {
        type: 'string',
        required: true,
        enum: ['Promote', 'Merge', 'Replace', 'Deduplicate', 'Archive'],
        description: 'Exact governance action the independent result must bind.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          receiptId: { type: 'string' },
          result: { type: 'string' },
          evidence: { type: 'array', required: true, items: { type: 'string' } },
          errorCode: { type: 'string' },
        },
      },
      render: (_args, value) => textBlock(value.ok
        ? `Candidate verified by the trusted owner (${value.receiptId}).`
        : `Candidate verification failed${value.errorCode ? `: ${value.errorCode}` : '.'}`),
    },
    async execute(
      args: {
        reviewId: string
        action: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' | 'Archive'
      },
      exec,
    ) {
      const service = wikiService(ctx)
      if (service === undefined) throw new Error('knowledgeWiki service unavailable')
      return service.verifyCandidate({ reviewId: args.reviewId, action: args.action }, exec.signal)
    },
  }))
}

/** Register the durable ingestion consumer shared by both catalogs. */
function registerIngestTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'wiki_ingest',
    description: 'Queue one raw source path or http(s) URL for the canonical Knowledge Wiki ingest owner. Returns the durable task state; it does not run a second direct ingest path.',
    parameters: {
      input: { type: 'string', required: true, description: 'Project-relative source path or http(s) URL.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'number' },
                input: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
          running: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const tasks = value.tasks as Array<{ id: number; input: string; status: string }>
        return textBlock(tasks.length === 0
          ? 'No task was queued.'
          : tasks.map(task => `- #${task.id} ${task.status}: ${task.input}`).join('\n'))
      },
    },
    async execute(args: { input: string }) {
      const service = wikiService(ctx)
      if (service === undefined) throw new Error('knowledgeWiki service unavailable')
      const snapshot = await service.ingestQueueAdd({ inputs: [args.input] })
      return {
        tasks: snapshot.tasks.map(task => ({ id: task.id, input: task.input, status: task.status })),
        running: snapshot.running,
      }
    },
  }))
}
