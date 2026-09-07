/**
 * 万相织鉴 host service: the in-process knowledge engine behind the
 * concept-graph tab. Owns the wiki page tree (graph + Louvain communities),
 * hybrid search, page editing, the two-stage LLM ingest pipeline with a
 * persisted queue, review items, and deep research — all inside the harness.
 * @module @deepseek-ai/dsh-knowledge-wiki
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import s from '@deepseek-ai/schemastery'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { buildGraph, extractWikiLinkTargets, listPages, readPage } from './graph.ts'
import { hybridSearch } from './search.ts'
import { WikiSnapshotStore } from './snapshot-store.ts'
import { createProjectExecutionContext, type ProjectExecutionContext } from './project-context.ts'
import { ingestSource as runIngest } from './ingest.ts'
import {
  pageExists, sedimentTarget, extractConversationText, buildSessionSummaryPage,
} from './auto-sediment.ts'
import { deepResearch as runResearch } from './research.ts'
import {
  appendCandidateReviews,
  applyCandidateReview,
  recoverCandidateReviewTransactions,
  recordCandidateVerification as recordTrustedCandidateVerification,
  resolveAdvisoryReviewBatch,
} from './reviews.ts'
import {
  verifyCandidate,
  type KnowledgeWikiVerifierAuthority,
} from './verifier.ts'
import { htmlToMarkdown } from './html-clip.ts'
import { isImagePath } from './vision.ts'
import {
  atomicWriteFile,
  isMissingPathError,
  readOptionalJson,
  readRegularFileBounded,
  resolveConfinedPath,
} from './filesystem.ts'
import {
  existsSync, lstatSync, mkdirSync, readdirSync,
} from 'node:fs'
import { basename, extname, join, dirname, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https'
import {
  executeKnowledgeWikiStage,
  isKnowledgeWikiStageExecutor,
  type KnowledgeWikiStageExecutor,
} from './stage-executor.ts'
import type {
  CandidateVerificationResult,
  GraphNode, IngestQueueSnapshot, IngestQueueTask, WikiFileEntry, WikiGraphResult, WikiPageContent,
  IngestOutcome, KnowledgeUtilityRecord, WikiReviewItem, WikiSearchHit, WikiWriteResult,
} from './types.ts'

const MAX_RAW_SOURCE_BYTES = 100 * 1024 * 1024

export type * from './types.ts'
export type {
  IngestQueueSnapshot, IngestQueueTask, WikiFileEntry, WikiGraphResult, WikiPageContent,
  KnowledgeUtilityRecord, WikiReviewItem, WikiSearchHit, WikiWriteResult,
} from './types.ts'

/**
 * Strict endpoint metadata for the later Gateway/Native lane. This package
 * declares the contract only; it does not bypass or self-register Gateway routes.
 */
export const KNOWLEDGE_WIKI_ENDPOINT_METADATA = Object.freeze({
  verifyCandidate: Object.freeze({
    endpoint: 'knowledgeWiki/verifyCandidate',
    owner: 'knowledgeWiki',
    transport: 'strict-remote',
    requiresVerifierAuthority: true,
    verifierAuthorityService: 'knowledgeWikiVerifierAuthority',
    sourceIdentitySchema: 'commit40+sourceDigest+dirtyDigest+buildDigest',
    nativeIntegration: 'pending',
  }),
})

/** Preserve immediate synchronous work while exposing the Remote Promise contract. */
function promiseFromSync<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation())
  } catch (cause) {
    return Promise.reject(cause instanceof Error
      ? cause
      : new Error('knowledge-wiki synchronous operation failed', { cause }))
  }
}

interface SessionQuerySurface {
  readonly session: { readonly cwd?: string }
  readonly events: unknown[]
}

interface SessionQueryReader {
  readSession(sessionId: string): Promise<SessionQuerySurface>
}

/** Narrow the optional session-query seam without adding a hard package edge. */
function isSessionQueryReader(value: unknown): value is SessionQueryReader {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).readSession === 'function'
}

/** Deployment configuration. */
export interface Config {
  /** Absolute path of the project wiki directory (contains concepts/, entities/, ...). */
  readonly wikiRoot: string
  /** Main workspace root (fixed, non-removable); defaults to the wiki root's parent. */
  readonly mainRoot: string
  /** Credential reference for DashScope semantic embeddings and image descriptions. */
  readonly credential: string
  /** LLM provider id for ingest/research (default deepseek-official). */
  readonly llmProvider: string
  /** LLM model id for ingest/research. */
  readonly llmModel: string
}

/**
 * The knowledgeWiki Remote service: graph, search, pages, ingest queue,
 * reviews, and deep research — computed locally from the project directory.
 */
export default class KnowledgeWikiService extends TypertRemoteService {
  /** Required services. */
  static inject = ['llm', 'timer', 'credentials']

  /** Loader validation for the deployment configuration. */
  static Config: s<Config> = s.object({
    wikiRoot: s.string().required(),
    mainRoot: s.string().default(''),
    credential: s.string().default('VISION_API_KEY'),
    llmProvider: s.string().default('deepseek-official'),
    llmModel: s.string().default('deepseek-reasoner'), // = deepseek-v4-flash + 推理模式（别名解析，实测检查能力≈v4-pro）
  })

  private readonly wikiRoot: string
  private readonly mainRoot: string
  private currentRoot: string
  private readonly credential: CredentialRef
  private readonly llmProvider: string
  private readonly llmModel: string
  private readonly queue: IngestQueueTask[] = []
  private readonly restoredQueueRoots = new Set<string>()
  private readonly snapshots = new WikiSnapshotStore()
  private queueDrain: Promise<void> | undefined
  private activeIngest: { readonly taskId: number; readonly controller: AbortController } | undefined
  private readonly backgroundStages = new Set<AbortController>()
  private queueNextId = 1
  private projectGeneration = 0

  /**
   * @param ctx - Host context.
   * @param config - Resolved deployment configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'knowledgeWiki')
    this.wikiRoot = config.wikiRoot.replace(/\/+$/u, '')
    const parent = dirname(this.wikiRoot)
    this.mainRoot = config.mainRoot.replace(/\/+$/u, '') || parent
    this.currentRoot = this.mainRoot
    this.credential = credentialRef(config.credential)
    this.llmProvider = config.llmProvider
    this.llmModel = config.llmModel
  }

  /** Resolve on every operation so Keychain updates apply without a restart. */
  private async resolveApiKey(): Promise<string> {
    return (await this.ctx.credentials.resolve(this.credential))?.value ?? ''
  }

  /** Optional trusted verifier/build owner; project files can never supply it. */
  private get verifierAuthority(): KnowledgeWikiVerifierAuthority | undefined {
    const value: unknown = this.ctx.get('knowledgeWikiVerifierAuthority')
    if (typeof value !== 'object' || value === null
      || typeof Reflect.get(value, 'authorityId') !== 'string'
      || typeof Reflect.get(value, 'sourceIdentity') !== 'function'
      || typeof Reflect.get(value, 'verifyCandidate') !== 'function'
      || typeof Reflect.get(value, 'validateCandidateResult') !== 'function'
      || typeof Reflect.get(value, 'sealPromotion') !== 'function'
      || typeof Reflect.get(value, 'validatePromotion') !== 'function') return undefined
    return value as KnowledgeWikiVerifierAuthority
  }

  /** Parent-owned hard-deadline stage executor; absence disables non-cooperative ingest. */
  private get stageExecutor(): KnowledgeWikiStageExecutor | undefined {
    const value: unknown = this.ctx.get('knowledgeWikiStageExecutor')
    return isKnowledgeWikiStageExecutor(value) ? value : undefined
  }

  /** Knowledge-base directory of the active workspace: the main wikiRoot, or `<root>/wiki` for a registered workspace. */
  private get activeWikiRoot(): string {
    return this.currentRoot === this.mainRoot ? this.wikiRoot : join(this.currentRoot, 'wiki')
  }

  private captureProjectContext(): ProjectExecutionContext {
    return createProjectExecutionContext(
      this.currentRoot,
      this.mainRoot,
      this.wikiRoot,
      this.projectGeneration,
    )
  }

  /**
   * Start the source-folder auto-watch: restore the persisted queue, scan
   * raw/sources every 60s, and enqueue newly changed files for two-stage
   * ingest. A completed session may create one governed candidate after the
   * session-level admission gate accepts it; individual turns never create pages.
   */
  protected [Service.init](): Promise<void> {
    return promiseFromSync(() => {
      this.restoreQueue(this.currentRoot)
      recoverCandidateReviewTransactions(
        this.verifierAuthority,
        this.reviewFile(this.currentRoot),
        this.activeWikiRoot,
        join(this.mainRoot, 'jiuzhang-tarballs', 'archive'),
      )
      this.ctx.effect(() => () => { this.snapshots.dispose() }, 'knowledge-wiki: snapshot store')
      this.ctx.effect(() => () => { this.activeIngest?.controller.abort(new Error('knowledge-wiki disposed')) }, 'knowledge-wiki: ingest owner')
      this.ctx.effect(() => () => {
        for (const controller of this.backgroundStages) controller.abort(new Error('knowledge-wiki disposed'))
      }, 'knowledge-wiki: background stages')
      const dispose = this.ctx.timer.interval(() => {
        void this.scanSources()
        // Drain independently of scan: restored pending tasks survive a
        // restart only when the timer drains them without a cache change.
        void this.drainQueue()
      }, 60_000)
      this.ctx.effect(() => dispose, 'knowledge-wiki: source auto-watch')
      // Turn-level Markdown is intentionally disabled. The session event log is
      // already the lossless source; only the session-level admission gate may
      // create a candidate page when the conversation has reusable value.
      // 会话销毁（关闭/切换）时做一次会话级 AI 提炼——把整段对话浓缩为
      // 一页知识（每会话一页，区别于每轮一页的实时沉淀）。
      const onAgentDisposed = (payload: { readonly agent: { readonly id: string } }): void => {
        void this.summarizeSession(payload.agent.id)
      }
      this.ctx.on('agent/disposed' as never, onAgentDisposed as never)
    })
  }

  /**
   * 会话级 AI 提炼：agent 销毁时把整段对话交给 LLM 浓缩为一页知识，
   * 写入会话所属工作区的 `_candidates/sessions/`（每会话一页）。
   * 候选页不进入主图谱，等待治理提案与人工审批后再晋升。
   *
   * 与实时沉淀同一套工作区策略（非主工作区才写）；幂等靠 slug 含会话
   * id + 页面存在检查。LLM 失败静默（不阻塞 agent 销毁）。
   */
  private async summarizeSession(sessionId: string | undefined): Promise<void> {
    const controller = new AbortController()
    this.backgroundStages.add(controller)
    try {
      if (!sessionId) return
      const sessionQuery: unknown = this.ctx.get('sessionQuery')
      if (!isSessionQueryReader(sessionQuery)) return
      const surface = await sessionQuery.readSession(sessionId)
      const target = sedimentTarget(surface.session.cwd, this.mainRoot)
      if (!target) return
      const events = surface.events
      if (!Array.isArray(events) || events.length === 0) return
      const conversation = extractConversationText(events)
      if (conversation.trim().length < 200) return // 对话太短，提炼无价值

      const completed = await executeKnowledgeWikiStage(this.stageExecutor, {
        kind: 'llm-complete',
        provider: this.llmProvider,
        model: this.llmModel,
        prompt: buildSummaryPrompt(conversation),
        operation: 'session summary',
        timeoutMs: 120_000,
      }, controller.signal)
      const out = completed.text ?? ''
      const parsed = parseSummaryJson(out)
      if (!parsed || parsed.action === 'skip' || !parsed.title) return
      const isIncident = parsed.action === 'incident_open' || parsed.action === 'incident_verified'
      const isReflection = parsed.action === 'reflection'
      const slug = issueSlugFrom(parsed.issueKey)
      const rel = join(
        '_candidates',
        isIncident ? 'incidents' : isReflection ? 'reflections' : 'topics',
        `${slug}.md`,
      )
      const alreadyExists = pageExists(target.wikiRoot, rel)
      const today = new Date().toISOString().slice(0, 10)
      const content = buildSessionSummaryPage({
        title: parsed.title,
        summary: parsed.summary,
        related: parsed.related,
        sessionId,
        today,
        workspaceName: target.workspaceName,
        candidateKind: isIncident ? 'incident' : isReflection ? 'reflection' : 'knowledge',
        epistemicStatus: parsed.action === 'incident_verified' ? 'verified' : 'hypothesis',
        evidenceCount: 1,
        independentSourceCount: 1,
        ...(isIncident
          ? {
            resolutionStatus: parsed.action === 'incident_verified' ? 'verified' : 'open',
            issueId: slug,
          }
          : {}),
      })
      try {
        const full = join(target.wikiRoot, rel)
        mkdirSync(dirname(full), { recursive: true })
        const next = alreadyExists
          ? isIncident
            ? mergeIncidentCandidate(
              readRegularFileBounded(full, 5 * 1024 * 1024).toString('utf8'),
              content,
              sessionId,
              today,
              parsed.action === 'incident_verified' ? 'verified' : 'open',
            )
            : mergeSessionCandidate(
              readRegularFileBounded(full, 5 * 1024 * 1024).toString('utf8'),
              content,
              sessionId,
              today,
              isReflection ? '反思证据增量' : '知识证据增量',
            )
          : content
        if (next !== readFileIfExists(full)) atomicWriteFile(full, next)
        const projectRoot = dirname(target.wikiRoot)
        appendCandidateReviews(
          join(projectRoot, '.llm-wiki', 'review.json'),
          projectRoot,
          `session:${sessionId}`,
          [`wiki/${rel}`],
        )
        this.ctx.logger.info(`[knowledge-wiki] session-summary: ${rel}`)
      } catch (error) {
        this.ctx.logger.warn('[knowledge-wiki] session summary write failed')
        this.ctx.logger.warn(error)
      }
    } catch (error) {
      this.ctx.logger.warn('[knowledge-wiki] session summary failed')
      this.ctx.logger.warn(error)
    } finally {
      this.backgroundStages.delete(controller)
    }
  }

  /** Retry cooldown for failed ingests (prevents 60s crash-looping on a broken key). */
  private static readonly FAILED_RETRY_MS = 60 * 60 * 1000

  private queueFile(projectRoot = this.currentRoot): string {
    return join(projectRoot, '.llm-wiki', 'ingest-queue.json')
  }

  /** Restore resumable tasks and cancelled-source tombstones. */
  private restoreQueue(projectRoot = this.currentRoot): void {
    if (this.restoredQueueRoots.has(projectRoot)) return
    try {
      const parsed = JSON.parse(
        readRegularFileBounded(this.queueFile(projectRoot), 5 * 1024 * 1024).toString('utf8'),
      ) as unknown
      if (!Array.isArray(parsed)) throw new Error('invalid knowledge ingest queue state')
      const context = createProjectExecutionContext(projectRoot, this.mainRoot, this.wikiRoot, this.projectGeneration)
      for (const value of parsed) {
        if (typeof value !== 'object' || value === null) continue
        const task = value as Partial<IngestQueueTask>
        if (typeof task.input !== 'string'
          || !['pending', 'running', 'done', 'error', 'cancelled'].includes(task.status ?? '')) continue
        const id = typeof task.id === 'number' ? task.id : this.queueNextId
        if (this.queue.some(item => item.projectRoot === projectRoot && item.input === task.input
          && (item.status === 'pending' || item.status === 'running' || item.status === 'cancelled'))) continue
        this.queue.push({
          id,
          input: task.input,
          projectRoot,
          wikiRoot: context.wikiRoot,
          projectGeneration: typeof task.projectGeneration === 'number'
            ? task.projectGeneration
            : context.generation,
          createdAt: typeof task.createdAt === 'number' ? task.createdAt : Date.now(),
          status: task.status === 'running' ? 'pending' : task.status as Exclude<IngestQueueTask['status'], 'running'>,
          ...(typeof task.ingestedHash === 'string' ? { ingestedHash: task.ingestedHash } : {}),
          ...(Array.isArray(task.written) ? { written: task.written.filter(value => typeof value === 'string') } : {}),
          ...(Array.isArray(task.warnings) ? { warnings: task.warnings.filter(value => typeof value === 'string') } : {}),
          ...(typeof task.error === 'string' ? { error: task.error } : {}),
          ...(typeof task.failedAt === 'number' ? { failedAt: task.failedAt } : {}),
          ...(typeof task.completedAt === 'number' ? { completedAt: task.completedAt } : {}),
          ...(typeof task.cancelRequestedAt === 'number' ? { cancelRequestedAt: task.cancelRequestedAt } : {}),
          ...(typeof task.runId === 'string' ? { runId: task.runId } : {}),
          ...(typeof task.leaseStartedAt === 'number' ? { leaseStartedAt: task.leaseStartedAt } : {}),
        })
        this.queueNextId = Math.max(this.queueNextId, id + 1)
      }
      this.restoredQueueRoots.add(projectRoot)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      this.restoredQueueRoots.add(projectRoot)
    }
  }

  /** Persist resumable tasks and cancelled-source tombstones. */
  private persistQueue(projectRoot?: string): void {
    const roots = projectRoot === undefined
      ? new Set(this.queue.map(task => task.projectRoot))
      : new Set([projectRoot])
    for (const root of roots) {
      const durable = this.queue.filter(task => task.projectRoot === root)
      atomicWriteFile(this.queueFile(root), `${JSON.stringify(durable, null, 2)}\n`)
    }
  }

  /**
   * Enqueue one input (project-relative path or URL) with dedup and
   * failure cooldown: an error task retries only after the cooldown, and
   * pending/running tasks are never duplicated. Done and cancelled tasks re-enqueue
   * only on an explicit manual request (force) — the scanner never
   * re-runs a completed ingest, so a content change mid-ingest cannot
   * stack duplicate tasks for the same input.
   * @param input - cache-relative path or URL.
   * @param force - allow re-enqueue of a done task (manual ingestQueueAdd).
   * @returns whether the task was enqueued.
   */
  private enqueueIngest(
    input: string,
    force = false,
    context = this.captureProjectContext(),
  ): boolean {
    const normalized = input
      .replace(/^\/+/u, '')
      // Tasks are keyed by their cache-relative identity (relative to
      // raw/sources), so a project-relative caller input (raw/sources/…)
      // and the scanner's bare rel enqueue the same task; URLs pass
      // through untouched.
      .replace(/^raw\/sources\//u, '')
    const existing = this.queue.findLast(
      task => task.projectRoot === context.projectRoot && task.input === normalized,
    )
    if (existing !== undefined) {
      if (existing.status === 'pending' || existing.status === 'running') return false
      if (existing.status === 'done' && !force) {
        // A done task re-enqueues only when the source changed since it
        // was ingested (scanner re-run) or on explicit force. With a
        // recorded hash, an unchanged source is a true duplicate.
        if (existing.ingestedHash !== undefined
          && existing.ingestedHash === this.currentHash(normalized, context.projectRoot)) {
          return false
        }
      }
      if (existing.status === 'cancelled' && !force
        && existing.ingestedHash !== undefined
        && existing.ingestedHash === this.currentHash(normalized, context.projectRoot)) {
        return false
      }
      if (existing.status === 'error') {
        const failedAt = existing.failedAt
        if (failedAt !== undefined && Date.now() - failedAt < KnowledgeWikiService.FAILED_RETRY_MS) {
          return false
        }
      }
    }
    this.queue.push({
      id: this.queueNextId++,
      input: normalized,
      projectRoot: context.projectRoot,
      wikiRoot: context.wikiRoot,
      projectGeneration: context.generation,
      createdAt: Date.now(),
      status: 'pending',
    })
    this.persistQueue(context.projectRoot)
    return true
  }

  /** Current content hash of a cache-relative source path, or undefined
   * for URLs and unreadable files. */
  private currentHash(input: string, projectRoot = this.currentRoot): string | undefined {
    if (/^https?:\/\//i.test(input)) return undefined
    const source = resolveRawSourcePath(projectRoot, input)
    return this.sha256(readRegularFileBounded(source, MAX_RAW_SOURCE_BYTES))
  }

  private cacheFile(projectRoot = this.currentRoot): string {
    return join(projectRoot, '.llm-wiki', 'ingest-cache.json')
  }

  private readCache(projectRoot = this.currentRoot): Record<string, string> {
    return readOptionalJson(this.cacheFile(projectRoot), {})
  }

  private writeCache(cache: Record<string, string>, projectRoot = this.currentRoot): void {
    atomicWriteFile(this.cacheFile(projectRoot), `${JSON.stringify(cache, null, 2)}\n`)
  }

  private sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex')
  }

  private listRawSources(projectRoot = this.currentRoot): string[] {
    const root = join(projectRoot, 'raw', 'sources')
    const out: string[] = []
    let rootStat
    try {
      rootStat = lstatSync(root)
    } catch (error) {
      if (isMissingPathError(error)) return out
      throw error
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('raw source root is not an ordinary directory')
    const visited = new Set<string>()
    const visitedFiles = new Set<string>()
    const walk = (dir: string): void => {
      const directory = lstatSync(dir)
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(`unsafe raw source directory: ${dir}`)
      const identity = `${directory.dev}:${directory.ino}`
      if (visited.has(identity)) throw new Error(`revisited raw source directory inode: ${dir}`)
      visited.add(identity)
      const entries = readdirSync(dir)
      for (const name of entries) {
        if (name.startsWith('.') || name === 'node_modules') continue
        const full = join(dir, name)
        const st = lstatSync(full)
        const rel = relative(root, full).split(sep).join('/')
        if (st.isSymbolicLink()) throw new Error(`symbolic links are not allowed in raw sources: ${rel}`)
        if (st.isDirectory()) walk(full)
        else if (!st.isFile()) throw new Error(`non-regular raw source is not allowed: ${rel}`)
        else {
          if (st.nlink !== 1) throw new Error(`hard-linked raw source is not allowed: ${rel}`)
          const fileIdentity = `${st.dev}:${st.ino}`
          if (visitedFiles.has(fileIdentity)) throw new Error(`revisited raw source file inode: ${rel}`)
          visitedFiles.add(fileIdentity)
          if (st.size > MAX_RAW_SOURCE_BYTES) throw new Error(`raw source exceeds 100 MiB: ${rel}`)
          out.push(rel)
        }
      }
    }
    walk(root)
    return out
  }

  private scanSources(): Promise<void> {
    return promiseFromSync(() => {
      const context = this.captureProjectContext()
      const cache = this.readCache(context.projectRoot)
      for (const rel of this.listRawSources(context.projectRoot)) {
        const source = resolveRawSourcePath(context.projectRoot, rel)
        const hash = this.sha256(readRegularFileBounded(source, MAX_RAW_SOURCE_BYTES))
        if (cache[rel] === hash) continue
        this.enqueueIngest(rel, false, context)
      }
    })
  }

  private reviewFile(projectRoot = this.currentRoot): string {
    return join(projectRoot, '.llm-wiki', 'review.json')
  }

  private utilityFile(projectRoot = this.currentRoot): string {
    return join(projectRoot, '.llm-wiki', 'knowledge-utility.json')
  }

  private readUtility(projectRoot = this.currentRoot): Record<string, KnowledgeUtilityRecord> {
    return readOptionalJson(this.utilityFile(projectRoot), {})
  }

  private writeUtility(records: Record<string, KnowledgeUtilityRecord>, projectRoot = this.currentRoot): void {
    atomicWriteFile(this.utilityFile(projectRoot), `${JSON.stringify(records, null, 2)}\n`)
  }

  private recordKnowledgeRetrieval(paths: string[], projectRoot = this.currentRoot): void {
    if (paths.length === 0) return
    const records = this.readUtility(projectRoot)
    const now = new Date().toISOString()
    for (const path of [...new Set(paths)]) {
      const current = records[path] ?? {
        path,
        retrievalHits: 0,
        successfulUses: 0,
        userCorrections: 0,
        utilityScore: 0,
      }
      records[path] = { ...current, retrievalHits: current.retrievalHits + 1, lastRetrievedAt: now }
    }
    this.writeUtility(records, projectRoot)
  }

  /**
   * The concept graph (nodes + wikilink edges, Louvain clusters).
   * @returns the graph computed from the wiki page tree.
   */

  private computeGraph(): Promise<WikiGraphResult> {
    const wikiRoot = this.activeWikiRoot
    return this.snapshots.get(wikiRoot, 'graph', () => promiseFromSync(() => buildGraph(wikiRoot)))
  }

  /**
   * Provides the graph operation.
   * @returns The computed graph value.
   */
  @Remote('graph')
  graph(): Promise<WikiGraphResult> {
    return this.computeGraph()
  }

  /**
   * Provides the full graph operation.
   * @returns The computed graph value.
   */
  @Remote('fullGraph')
  fullGraph(): Promise<WikiGraphResult> {
    return this.computeGraph()
  }

  /**
   * Lists the list operation.
   * @returns The wiki file entries.
   */
  @Remote('list')
  list(): Promise<WikiFileEntry[]> {
    const wikiRoot = this.activeWikiRoot
    return this.snapshots.get(wikiRoot, 'list', () =>
      promiseFromSync(() => listPages(wikiRoot) as WikiFileEntry[]))
  }

  /**
   * Hybrid search over the wiki (BM25 + optional vector).
   * @param request - query text and optional hit count.
   * @returns ranked hits.
   */
  @Remote('search')
  async search(request: { query: string; topK?: number }): Promise<WikiSearchHit[]> {
    const context = this.captureProjectContext()
    const topK = request.topK ?? 8
    const hits = await this.snapshots.get(context.wikiRoot, `search:${topK}:${request.query}`, async () =>
      hybridSearch(context.wikiRoot, request.query, await this.resolveApiKey(), topK))
    this.recordKnowledgeRetrieval(hits.map(hit => hit.path), context.projectRoot)
    return hits.map(hit => ({ path: hit.path, score: hit.score }))
  }

  /**
   * Provides the knowledge utility operation.
   * @returns The knowledge utility records.
   */
  @Remote('knowledgeUtility')
  knowledgeUtility(): Promise<KnowledgeUtilityRecord[]> {
    return promiseFromSync(() =>
      Object.values(this.readUtility()).sort((left, right) => right.utilityScore - left.utilityScore))
  }

  /**
   * Record whether retrieved knowledge helped or required a user correction.
   * @param request - The request input.
   * @returns The value produced by record knowledge outcome.
   */
  @Remote('recordKnowledgeOutcome')
  recordKnowledgeOutcome(request: {
    paths: string[]
    outcome: 'successful' | 'corrected' | 'neutral'
  }): Promise<number> {
    return promiseFromSync(() => {
      const records = this.readUtility()
      const now = new Date().toISOString()
      let updated = 0
      for (const candidate of [...new Set(request.paths)]) {
        let safe: string
        try {
          safe = resolveSafePath(this.activeWikiRoot, candidate, false).relativePath
        } catch { continue }
        const current = records[safe] ?? {
          path: safe,
          retrievalHits: 0,
          successfulUses: 0,
          userCorrections: 0,
          utilityScore: 0,
        }
        const successfulUses = current.successfulUses + (request.outcome === 'successful' ? 1 : 0)
        const userCorrections = current.userCorrections + (request.outcome === 'corrected' ? 1 : 0)
        const denominator = Math.max(1, current.retrievalHits)
        records[safe] = {
          ...current,
          successfulUses,
          userCorrections,
          utilityScore: Number(((successfulUses * 2 - userCorrections * 3) / denominator).toFixed(4)),
          lastOutcomeAt: now,
        }
        updated += 1
      }
      if (updated > 0) this.writeUtility(records)
      return updated
    })
  }

  /**
   * Provides the page content operation.
   * @param request - The request input.
   * @returns The requested page content.
   */
  @Remote('pageContent')
  pageContent(request: { path: string }): Promise<WikiPageContent> {
    return promiseFromSync(() => {
      try {
        const { relativePath: safe, absolutePath: resolved } = resolveSafePath(
          this.activeWikiRoot,
          request.path,
          false,
        )
        if (lstatSync(resolved).isDirectory()) return { path: request.path, content: '' }
        return { path: request.path, content: readPage(this.activeWikiRoot, safe) }
      } catch (error) {
        if (!isMissingPathError(error) && !(error instanceof Error && error.message === 'path does not exist')) throw error
        return { path: request.path, content: '' }
      }
    })
  }

  /**
   * Write one wiki page.
   * @param request - page path and Markdown content.
   * @returns the written path.
   */
  @Remote('writePage')
  writePage(request: {
    path: string
    content: string
    expectedContent?: string
  }): Promise<WikiWriteResult> {
    return promiseFromSync(() => {
      try {
        const { relativePath: safe, absolutePath: full } = resolveSafePath(
          this.activeWikiRoot,
          request.path,
          true,
        )
        if (!existsSync(full) && !safe.startsWith('_candidates/')) {
          return { path: safe, ok: false, error: 'new generated pages must be written under _candidates/' }
        }
        if (request.expectedContent !== undefined && existsSync(full)) {
          const current = readRegularFileBounded(full, 5 * 1024 * 1024).toString('utf8')
          if (current !== request.expectedContent) {
            return {
              path: safe,
              ok: false,
              conflict: true,
              error: 'page changed on disk; reload before saving',
            }
          }
        }
        atomicWriteFile(full, request.content)
        this.snapshots.invalidate(this.activeWikiRoot)
        return { path: safe, ok: true }
      } catch (error) {
        return { path: request.path, ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  /**
   * Create a new wiki page under wiki/concepts.
   * @param request - page title and optional content.
   * @returns the created path.
   */
  @Remote('createPage')
  createPage(request: { title: string; content?: string }): Promise<WikiWriteResult> {
    return promiseFromSync(() => {
      try {
        const slug = request.title.trim().replace(/[\\/:*?"<>|\s]+/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '')
        const rel = `concepts/${slug}.md`
        const full = join(this.activeWikiRoot, rel)
        if (existsSync(full)) return { path: rel, ok: false, error: 'page already exists' }
        const frontmatter = `---\ntype: concept\nstatus: canonical\norigin: human\ntitle: ${request.title.trim()}\napproved_at: ${new Date().toISOString().slice(0, 10)}\napproved_by: human\ncreated: ${new Date().toISOString().slice(0, 10)}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n${request.content ?? ''}\n`
        mkdirSync(join(this.activeWikiRoot, 'concepts'), { recursive: true })
        atomicWriteFile(full, frontmatter)
        this.snapshots.invalidate(this.activeWikiRoot)
        return { path: rel, ok: true }
      } catch (error) {
        return { path: '', ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  /**
   * Two-stage ingest of one source file (project-relative raw/sources path).
   * @param request - the source path.
   * @returns written wiki paths and warnings.
   */
  @Remote('ingestSource')
  async ingestSource(request: { path: string }): Promise<IngestOutcome> {
    try {
      const context = this.captureProjectContext()
      resolveRawSourcePath(context.projectRoot, request.path)
      return await this.enqueueAndWait(request.path, context)
    } catch (error) {
      return ingestFailure(error, 'invalid-input')
    }
  }

  private async ingestSourceWithContext(
    request: { path: string },
    context: ProjectExecutionContext,
    signal: AbortSignal,
  ): Promise<{ written: string[]; warnings: string[] }> {
    resolveRawSourcePath(context.projectRoot, request.path)
    signal.throwIfAborted()
    if (isImagePath(request.path)) {
      const outcome = await this.ingestImage(request.path, context, signal)
      signal.throwIfAborted()
      this.snapshots.invalidate(context.wikiRoot)
      return outcome
    }
    const outcome = await runIngest(
      this.stageExecutor,
      this.llmProvider,
      this.llmModel,
      context.projectRoot,
      request.path,
      signal,
    )
    signal.throwIfAborted()
    if (outcome.written.length > 0) this.snapshots.invalidate(context.wikiRoot)
    return { written: outcome.written, warnings: outcome.warnings }
  }

  /** Multimodal image ingest: copy into wiki/media and caption with the vision LLM. */
  private async ingestImage(
    relPath: string,
    context: ProjectExecutionContext,
    signal: AbortSignal,
  ): Promise<{ written: [string, ...string[]]; warnings: string[] }> {
    signal.throwIfAborted()
    const source = resolveRawSourcePath(context.projectRoot, relPath)
    const apiKey = await this.resolveApiKey()
    if (apiKey && this.stageExecutor === undefined) {
      throw new Error('knowledge Wiki stage executor unavailable; refusing vision work')
    }
    signal.throwIfAborted()
    const fileName = basename(relPath)
    const slug = fileName.replace(/[\/:*?"<>|\s]+/gu, '-').replace(/-+/gu, '-').replace(/\.[^.]+$/u, '')
    const mediaRel = `_candidates/ingest/media/${slug}${extname(fileName).toLowerCase()}`
    atomicWriteFile(
      join(context.wikiRoot, mediaRel),
      readRegularFileBounded(source, 16 * 1024 * 1024),
    )
    signal.throwIfAborted()
    const caption = apiKey
      ? (await executeKnowledgeWikiStage(this.stageExecutor, {
        kind: 'vision-describe',
        apiKey,
        path: source,
        timeoutMs: 60_000,
      }, signal)).text ?? ''
      : ''
    signal.throwIfAborted()
    if (!caption) return { written: [mediaRel], warnings: ['视觉说明生成失败（检查 apiKey/网络）'] }
    const pageRel = `_candidates/ingest/sources/${slug}.md`
    const page = `---\ntype: source\nstatus: candidate\norigin: image\ntitle: ${fileName}\nsources: ["${relPath}"]\ncreated: ${new Date().toISOString().slice(0, 10)}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# ${fileName}\n\n![${fileName}](/${mediaRel})\n\n## 图片说明\n\n${caption}\n`
    mkdirSync(dirname(join(context.wikiRoot, pageRel)), { recursive: true })
    atomicWriteFile(join(context.wikiRoot, pageRel), page)
    appendCandidateReviews(this.reviewFile(context.projectRoot), context.projectRoot, relPath, [`wiki/${pageRel}`])
    return { written: [pageRel, mediaRel], warnings: [] }
  }

  /**
   * Fetch one URL, clip it to Markdown, and ingest it.
   * @param request - the URL.
   * @returns written wiki paths and warnings.
   */
  @Remote('ingestUrl')
  async ingestUrl(request: { url: string }): Promise<IngestOutcome> {
    try {
      const url = new URL(request.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https URLs are allowed')
      return await this.enqueueAndWait(request.url, this.captureProjectContext())
    } catch (error) {
      return ingestFailure(error, 'invalid-input')
    }
  }

  private async ingestUrlWithContext(
    request: { url: string },
    context: ProjectExecutionContext,
    signal: AbortSignal,
  ): Promise<{ written: string[]; warnings: string[] }> {
    const fetched = await fetchPublicText(request.url, signal)
    signal.throwIfAborted()
    const md = htmlToMarkdown(fetched.text, fetched.url)
    const slug = new URL(fetched.url).hostname.replace(/\./gu, '-')
    const rel = `raw/sources/clips/${slug}-${Date.now()}.md`
    atomicWriteFile(join(context.projectRoot, rel), `# ${request.url}\n\n> 来源：${request.url}\n\n${md}\n`)
    signal.throwIfAborted()
    return this.ingestSourceWithContext({ path: rel }, context, signal)
  }

  /**
   * Enqueue sources for two-stage ingest (serialized, deduped; a completed
   * task can be re-run manually, an errored one only after its cooldown).
   * @param request - inputs (project-relative paths or URLs).
   * @returns the queue snapshot.
   */
  @Remote('ingestQueueAdd')
  ingestQueueAdd(request: { inputs: string[] }): Promise<IngestQueueSnapshot> {
    return promiseFromSync(() => {
      const context = this.captureProjectContext()
      for (const input of request.inputs) {
        // Manual enqueue may re-run a done task; the scanner path never does.
        this.enqueueIngest(input, true, context)
      }
      void this.drainQueue()
      return this.queueSnapshot()
    })
  }

  /**
   * Provides the ingest queue status operation.
   * @returns The current ingest queue snapshot.
   */
  @Remote('ingestQueueStatus')
  ingestQueueStatus(): Promise<IngestQueueSnapshot> {
    return promiseFromSync(() => this.queueSnapshot())
  }

  /**
   * Provides the ingest queue cancel operation.
   * @returns The current ingest queue snapshot after cancellation.
   */
  @Remote('ingestQueueCancel')
  ingestQueueCancel(): Promise<IngestQueueSnapshot> {
    return promiseFromSync(() => {
      this.cancelPendingForRoot(this.currentRoot)
      return this.queueSnapshot()
    })
  }

  private cancelPendingForRoot(projectRoot: string): boolean {
    let changed = false
    for (let index = 0; index < this.queue.length; index += 1) {
      const task = this.queue[index]
      if (task === undefined || task.projectRoot !== projectRoot) continue
      if (task.status === 'running' && this.activeIngest?.taskId === task.id) {
        const cancelRequestedAt = Date.now()
        this.queue[index] = { ...task, cancelRequestedAt }
        this.activeIngest.controller.abort(new Error('knowledge-wiki ingest cancelled'))
        changed = true
        continue
      }
      if (task.status !== 'pending') continue
      const ingestedHash = this.currentHash(task.input, task.projectRoot)
      this.queue[index] = {
        ...task,
        status: 'cancelled',
        cancelRequestedAt: Date.now(),
        completedAt: Date.now(),
        ...(ingestedHash === undefined ? {} : { ingestedHash }),
      }
      changed = true
    }
    if (changed) this.persistQueue(projectRoot)
    return changed
  }

  private queueSnapshot(): IngestQueueSnapshot {
    const tasks = this.queue.filter(task => task.projectRoot === this.currentRoot)
    return {
      tasks: [...tasks],
      running: tasks.some(task => task.status === 'running'),
      cancelled: tasks.some(task => task.status === 'cancelled'),
    }
  }

  private queueTaskContext(task: IngestQueueTask): ProjectExecutionContext {
    return Object.freeze({
      projectRoot: task.projectRoot,
      wikiRoot: task.wikiRoot,
      generation: task.projectGeneration,
      startedAt: task.createdAt,
    })
  }

  private executeQueuedIngest(
    task: IngestQueueTask,
    context: ProjectExecutionContext,
    signal: AbortSignal,
  ): Promise<{ written: string[]; warnings: string[] }> {
    return /^https?:\/\//i.test(task.input)
      ? this.ingestUrlWithContext({ url: task.input }, context, signal)
      : this.ingestSourceWithContext({ path: `raw/sources/${task.input}` }, context, signal)
  }

  private drainQueue(): Promise<void> {
    if (this.queueDrain !== undefined) return this.queueDrain
    const drain = this.runQueue().finally(() => {
      this.queueDrain = undefined
    })
    this.queueDrain = drain
    return drain
  }

  private async runQueue(): Promise<void> {
    for (const [index, task] of this.queue.entries()) {
      if (task.status !== 'pending') continue
      const controller = new AbortController()
      const running: IngestQueueTask = {
        ...task,
        status: 'running',
        runId: randomUUID(),
        leaseStartedAt: Date.now(),
      }
      this.queue[index] = running
      this.activeIngest = { taskId: task.id, controller }
      this.persistQueue(running.projectRoot)
      const timeoutState = { expired: false }
      const timeout = setTimeout(() => {
        timeoutState.expired = true
        controller.abort(new Error('ingest timed out after 5 minutes'))
      }, 5 * 60 * 1000)
      const context = this.queueTaskContext(running)
      try {
        const outcome = await this.executeQueuedIngest(running, context, controller.signal)
        controller.signal.throwIfAborted()
        if (outcome.written.length === 0 && outcome.warnings.length > 0) {
          throw new Error(outcome.warnings.join('; '))
        }
        const ingestedHash = this.markIngested(running.input, context)
        this.queue[index] = running
        this.queue[index] = {
          ...running,
          status: 'done',
          written: outcome.written,
          warnings: outcome.warnings,
          completedAt: Date.now(),
          ...(ingestedHash !== undefined ? { ingestedHash } : {}),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const current = this.queue[index]
        const cancelled = !timeoutState.expired && current.cancelRequestedAt !== undefined
        console.error('[knowledge-wiki] ingest failed:', running.input, message)
        this.queue[index] = {
          ...running,
          status: cancelled ? 'cancelled' : 'error',
          error: message,
          completedAt: Date.now(),
          ...(cancelled
            ? { cancelRequestedAt: current.cancelRequestedAt ?? Date.now() }
            : { failedAt: Date.now() }),
        }
      } finally {
        clearTimeout(timeout)
        this.activeIngest = undefined
        this.persistQueue(context.projectRoot)
      }
    }
  }

  private async enqueueAndWait(
    input: string,
    context: ProjectExecutionContext,
  ): Promise<IngestOutcome> {
    this.enqueueIngest(input, true, context)
    const task = this.queue.findLast(item => item.projectRoot === context.projectRoot
      && item.input === input.replace(/^\/+|^raw\/sources\//gu, ''))
    if (task === undefined) throw new Error('ingest task was not admitted')
    await this.drainQueue()
    const terminal = this.queue.find(item => item.id === task.id)
    if (terminal?.status === 'done') {
      const warnings = terminal.warnings ?? []
      return {
        written: terminal.written ?? [],
        warnings,
        status: warnings.length > 0 ? 'degraded' : 'ok',
      }
    }
    const error = terminal?.error ?? `ingest task ${task.id} did not complete`
    const errorCode = terminal?.status === 'cancelled'
      ? 'cancelled'
      : error.includes('timed out') ? 'timeout' : 'ingest-failed'
    return { written: [], warnings: [error], status: 'error', errorCode }
  }

  /** Record the content hash in the ingest cache only after a successful
   * ingest, so a failed task is retried once its cooldown elapses.
   * @returns the recorded hash (undefined for URLs or unreadable files). */
  private markIngested(input: string, context = this.captureProjectContext()): string | undefined {
    if (/^https?:\/\//i.test(input)) return undefined
    const cache = this.readCache(context.projectRoot)
    const source = resolveRawSourcePath(context.projectRoot, input)
    const hash = this.sha256(readRegularFileBounded(source, MAX_RAW_SOURCE_BYTES))
    cache[input] = hash
    this.writeCache(cache, context.projectRoot)
    return hash
  }

  /**
   * Expand a topic, search, and write research Candidates for the workspace captured at entry.
   * Written pages receive Candidate reviews and invalidate that workspace's cached snapshot.
   * @param request - Topic passed to query expansion and synthesis.
   * @param signal - Cancels executor stages; pipeline cancellation/failure becomes a degraded result.
   * @returns Findings with project-relative paths and warnings; pipeline failures include an error code.
   * @throws If recording Candidate reviews fails after the pipeline returns.
   */
  @Remote('deepResearch')
  async deepResearch(request: { topic: string }, signal: AbortSignal): Promise<{
    findings: Array<{ title: string; path: string }>
    warnings: string[]
    degraded: boolean
    errorCode?: 'stage-executor-unavailable' | 'research-failed'
  }> {
    const context = this.captureProjectContext()
    let result
    try {
      result = await runResearch(
        this.stageExecutor,
        this.llmProvider,
        this.llmModel,
        context.projectRoot,
        request.topic,
        signal,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        findings: [],
        warnings: [message],
        degraded: true,
        errorCode: message.includes('stage executor unavailable')
          ? 'stage-executor-unavailable'
          : 'research-failed',
      }
    }
    appendCandidateReviews(
      this.reviewFile(context.projectRoot),
      context.projectRoot,
      `research:${request.topic}`,
      result.written,
    )
    if (result.written.length > 0) this.snapshots.invalidate(context.wikiRoot)
    return {
      findings: result.written.map(path => ({ title: basename(path), path })),
      warnings: result.warnings,
      degraded: result.warnings.length > 0,
    }
  }

  /**
   * Unresolved review items from .llm-wiki/review.json.
   * @param request - status filter and limit.
   * @returns matching review items.
   */
  @Remote('reviews')
  reviews(request: { status?: string; limit?: number }): Promise<WikiReviewItem[]> {
    return promiseFromSync(() => {
      const all = readOptionalJson<WikiReviewItem[]>(this.reviewFile(), [])
      if (!Array.isArray(all)) throw new Error('invalid knowledge review state')
      const status = request.status ?? 'unresolved'
      const filtered = status === 'all' ? all : all.filter(item => status === 'resolved' ? item.resolved : !item.resolved)
      return filtered.slice(0, request.limit ?? 100)
    })
  }

  /**
   * Ask the injected independent authority to verify a Candidate, then bind a passing receipt to its review.
   * Receipt persistence precedes review binding; this operation does not apply the governance action.
   * @param request - Review id and proposed governance action to bind into verification.
   * @param signal - Cancellation checked around and passed through the independent verifier call.
   * @returns Verdict/evidence or an explicit blocker; binding failure retains the receipt with ok: false.
   * @throws On cancellation, authority errors, malformed persisted state, or uncaught I/O failures.
   */
  @Remote('verifyCandidate')
  async verifyCandidate(
    request: {
      reviewId: string
      action: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' | 'Archive'
    },
    signal: AbortSignal,
  ): Promise<CandidateVerificationResult> {
    const authority = this.verifierAuthority
    const reviewFile = this.reviewFile()
    const result = await verifyCandidate(
      authority,
      reviewFile,
      this.activeWikiRoot,
      request.reviewId,
      request.action,
      signal,
    )
    if (result.ok && result.receiptId !== undefined) {
      const recorded = recordTrustedCandidateVerification(
        authority,
        reviewFile,
        this.activeWikiRoot,
        request.reviewId,
        result.receiptId,
        request.action,
      )
      if (!recorded) {
        return { ...result, ok: false, errorCode: 'verification-failed' }
      }
    }
    return result
  }

  /**
   * Resolve one review item.
   * @param request - review id and optional action.
   * @returns whether the item was found and updated.
   */
  @Remote('resolveReview')
  resolveReview(request: { reviewId: string; action?: string }): Promise<boolean> {
    return promiseFromSync(() => {
      const reviewFile = this.reviewFile()
      const advisory = resolveAdvisoryReviewBatch(reviewFile, [request.reviewId], request.action ?? 'skip')
      if (advisory.resolvedCount > 0) return true
      for (const candidateId of advisory.candidateIds) {
        const candidateResult = applyCandidateReview(
          this.verifierAuthority,
          reviewFile,
          this.currentRoot,
          this.activeWikiRoot,
          join(this.mainRoot, 'jiuzhang-tarballs', 'archive'),
          candidateId,
          request.action ?? 'Skip',
        )
        if (candidateResult) this.snapshots.invalidate(this.activeWikiRoot)
        return candidateResult === true
      }
      return false
    })
  }

  /**
   * Bulk-resolve review items.
   * @param request - review ids and optional action.
   * @returns the number resolved.
   */
  @Remote('resolveReviews')
  resolveReviews(request: { ids: string[]; action?: string }): Promise<number> {
    return promiseFromSync(() => {
      const projectRoot = this.currentRoot
      const wikiRoot = this.activeWikiRoot
      const reviewFile = this.reviewFile(projectRoot)
      const advisory = resolveAdvisoryReviewBatch(reviewFile, request.ids, request.action ?? 'skip')
      let count = advisory.resolvedCount
      let snapshotChanged = false
      for (const id of advisory.candidateIds) {
        const candidateResult = applyCandidateReview(
          this.verifierAuthority,
          reviewFile,
          projectRoot,
          wikiRoot,
          join(this.mainRoot, 'jiuzhang-tarballs', 'archive'),
          id,
          request.action ?? 'Skip',
        )
        if (candidateResult) {
          count += 1
          snapshotChanged = true
        }
      }
      if (snapshotChanged) this.snapshots.invalidate(wikiRoot)
      return count
    })
  }

  private workspacesFile(): string {
    return join(this.mainRoot, '.llm-wiki', 'workspaces.json')
  }

  private readWorkspaces(): Array<{ path: string; name: string }> {
    const file = this.workspacesFile()
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readRegularFileBounded(file, 5 * 1024 * 1024).toString('utf8')) as {
      workspaces?: unknown
    }
    if (parsed.workspaces === undefined) return []
    if (!Array.isArray(parsed.workspaces)) throw new Error('invalid knowledge project registry')
    return parsed.workspaces.map((value) => {
      if (typeof value !== 'object' || value === null) throw new Error('invalid knowledge project registry entry')
      const row = value as { path?: unknown; name?: unknown }
      if (typeof row.path !== 'string' || row.path.length === 0
        || typeof row.name !== 'string' || row.name.length === 0) {
        throw new Error('invalid knowledge project registry entry')
      }
      return { path: row.path, name: row.name }
    })
  }

  private writeWorkspaces(workspaces: Array<{ path: string; name: string }>): void {
    const file = this.workspacesFile()
    atomicWriteFile(file, `${JSON.stringify({ workspaces }, null, 2)}\n`)
  }

  /**
   * Lists the list projects operation.
   * @returns The available workspaces and current workspace.
   */
  @Remote('listProjects')
  listProjects(): Promise<{ projects: Array<{ path: string; name: string; main?: boolean }>; current: string }> {
    return promiseFromSync(() => {
      const main = { path: this.mainRoot, name: '万相织鉴', main: true }
      return { projects: [main, ...this.readWorkspaces()], current: this.currentRoot }
    })
  }

  /**
   * Switch the active workspace.
   * @param request - workspace path (main or a registered workspace).
   * @returns the new current root.
   */
  @Remote('setProject')
  setProject(request: { path: string }): Promise<{ current: string }> {
    return promiseFromSync(() => {
      const target = request.path.replace(/\/+$/u, '')
      const known = [this.mainRoot, ...this.readWorkspaces().map(ws => ws.path.replace(/\/+$/u, ''))]
      if (known.includes(target)) {
        if (this.currentRoot !== target) {
          this.currentRoot = target
          this.projectGeneration += 1
          this.restoreQueue(target)
          recoverCandidateReviewTransactions(
            this.verifierAuthority,
            this.reviewFile(target),
            this.activeWikiRoot,
            join(this.mainRoot, 'jiuzhang-tarballs', 'archive'),
          )
        }
      }
      return { current: this.currentRoot }
    })
  }

  /**
   * Create and register a new workspace (initialized wiki/raw structure).
   * @param request - workspace name and path.
   * @returns the created path or an error.
   */
  @Remote('createProject')
  createProject(request: { name: string; path: string }): Promise<{ path: string; error?: string }> {
    return promiseFromSync(() => {
      try {
        const name = request.name.trim()
        const root = request.path.trim().replace(/\/+$/u, '')
        if (name.length === 0 || root.length === 0) return { path: '', error: 'project name and path are required' }
        if (root === this.mainRoot) return { path: '', error: '主工作区已存在' }
        const workspaces = this.readWorkspaces()
        mkdirSync(join(root, 'wiki', 'concepts'), { recursive: true })
        mkdirSync(join(root, 'wiki', 'entities'), { recursive: true })
        mkdirSync(join(root, 'wiki', 'sources'), { recursive: true })
        mkdirSync(join(root, 'raw', 'sources'), { recursive: true })
        if (!existsSync(join(root, 'wiki', 'index.md'))) {
          atomicWriteFile(join(root, 'wiki', 'index.md'), '# Wiki Index\n\n## Entities\n\n## Concepts\n\n## Sources\n')
        }
        if (!existsSync(join(root, 'wiki', 'log.md'))) {
          atomicWriteFile(join(root, 'wiki', 'log.md'), '# Research Log\n')
        }
        if (!existsSync(join(root, 'purpose.md'))) {
          atomicWriteFile(join(root, 'purpose.md'), `# 项目目的 — ${name}\n\n## 核心问题\n\n> 待补充\n`)
        }
        if (!existsSync(join(root, 'schema.md'))) {
          atomicWriteFile(join(root, 'schema.md'), '# Wiki Schema\n\n## Page Types\n\n| Type | Directory | Purpose |\n|------|-----------|---------|\n| entity | wiki/entities/ | Named things |\n| concept | wiki/concepts/ | Ideas and techniques |\n| source | wiki/sources/ | Source materials |\n')
        }
        if (!workspaces.some(ws => ws.path.replace(/\/+$/u, '') === root)) {
          workspaces.push({ path: root, name })
          this.writeWorkspaces(workspaces)
        }
        return { path: root }
      } catch (error) {
        return { path: '', error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  /**
   * Remove a workspace from the registry (files untouched). The main
   * workspace cannot be removed.
   * @returns the remaining workspace list.
   * @param request - The request input.
   */
  @Remote('removeProject')
  removeProject(request: { path: string }): Promise<{
    projects: Array<{ path: string; name: string; main?: boolean }>
    current: string
  }> {
    return promiseFromSync(() => {
      const target = request.path.replace(/\/+$/u, '')
      if (target === this.mainRoot) {
        // 主工作区不可删除：原样返回列表。
        return {
          projects: [{ path: this.mainRoot, name: '万相织鉴', main: true }, ...this.readWorkspaces()],
          current: this.currentRoot,
        }
      }
      const registered = this.readWorkspaces()
      if (!registered.some(ws => ws.path.replace(/\/+$/u, '') === target)) {
        return {
          projects: [{ path: this.mainRoot, name: '万相织鉴', main: true }, ...registered],
          current: this.currentRoot,
        }
      }
      const remaining = registered.filter(ws => ws.path.replace(/\/+$/u, '') !== target)
      this.writeWorkspaces(remaining)
      this.cancelPendingForRoot(target)
      if (this.currentRoot === target) {
        this.currentRoot = this.mainRoot
        this.projectGeneration += 1
        this.restoreQueue(this.mainRoot)
      }
      return {
        projects: [{ path: this.mainRoot, name: '万相织鉴', main: true }, ...remaining],
        current: this.currentRoot,
      }
    })
  }

  /**
   * Graph insights: surprising connections, isolated pages, bridge nodes,
   * and sparse communities.
   * @returns the insight report.
   */
  @Remote('graphInsights')
  async graphInsights(): Promise<{
    isolated: Array<{ id: string; label: string; path: string }>
    bridges: Array<{ id: string; label: string; path: string; communities: number }>
    sparseCommunities: Array<{ id: number; nodeCount: number; topNodes: string[] }>
  }> {
    const graph = await this.computeGraph()
    const nodesById = new Map(graph.nodes.map(node => [node.id, node]))
    const isolated = graph.nodes
      .filter(node => node.linkCount <= 1)
      .slice(0, 20)
      .map(node => ({ id: node.id, label: node.label, path: node.path }))
    const communityNeighbors = new Map<GraphNode, Set<number>>()
    for (const edge of graph.edges) {
      const a = nodesById.get(edge.source)
      const b = nodesById.get(edge.target)
      if (!a || !b) continue
      let aCommunities = communityNeighbors.get(a)
      if (aCommunities === undefined) {
        aCommunities = new Set()
        communityNeighbors.set(a, aCommunities)
      }
      aCommunities.add(b.community)
      let bCommunities = communityNeighbors.get(b)
      if (bCommunities === undefined) {
        bCommunities = new Set()
        communityNeighbors.set(b, bCommunities)
      }
      bCommunities.add(a.community)
    }
    const bridges = [...communityNeighbors.entries()]
      .filter(([, communities]) => communities.size >= 3)
      .map(([node, communities]) => ({
        id: node.id, label: node.label, path: node.path, communities: communities.size,
      }))
      .slice(0, 15)
    const sparseCommunities = graph.communities
      .filter(community => community.nodeCount >= 3)
      .slice(0, 10)
      .map(community => ({ id: community.id, nodeCount: community.nodeCount, topNodes: community.topNodes }))
    return { isolated, bridges, sparseCommunities }
  }

  /**
   * Lint the wiki: broken wikilinks, empty pages, and isolated pages.
   * @returns the lint report.
   */
  @Remote('lint')
  async lint(): Promise<{ brokenLinks: Array<{ from: string; target: string }>; emptyPages: string[]; totalPages: number }> {
    const pages = await this.list()
    const mdPages = pages.filter(page => page.path.endsWith('.md'))
    const known = new Set(mdPages.map(page => page.path))
    const brokenLinks: Array<{ from: string; target: string }> = []
    const emptyPages: string[] = []
    for (const page of mdPages) {
      const content = readPage(this.activeWikiRoot, page.path)
      const body = content.replace(/^---\n[\s\S]*?\n---\n?/u, '')
      if (body.trim().length === 0) emptyPages.push(page.path)
      for (const link of extractWikiLinkTargets(body)) {
        const target = link.replace(/\//gu, '/')
        const normalized = target.replace(/\.md$/u, '')
        const exists = known.has(target)
          || known.has(`${normalized}.md`)
          || [...known].some(knownPath => knownPath.endsWith(`/${normalized}.md`) || knownPath === `${normalized}.md`)
        if (!exists) brokenLinks.push({ from: page.path, target })
      }
    }
    return { brokenLinks: brokenLinks.slice(0, 50), emptyPages, totalPages: mdPages.length }
  }

  /**
   * Export the whole knowledge-base project as a ZIP archive.
   * @returns the archive path or an error.
   */
  @Remote('exportProject')
  async exportProject(): Promise<{ path: string; error?: string }> {
    try {
      const outDir = join(this.currentRoot, '.llm-wiki', 'exports')
      mkdirSync(outDir, { recursive: true })
      const outPath = join(outDir, `wanxiang-${new Date().toISOString().slice(0, 10)}.zip`)
      const { execFileSync } = await import('node:child_process')
      execFileSync('/usr/bin/zip', ['-r', '-q', outPath, 'wiki', 'raw', 'purpose.md', 'schema.md'], {
        cwd: this.currentRoot,
      })
      return { path: outPath }
    } catch (error) {
      return { path: '', error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Import a project archive: list the ZIP contents (wiki/raw/purpose/schema).
   * @param request - archive path.
   * @returns the archive summary or an error.
   */
  @Remote('importProject')
  async importProject(request: { path: string }): Promise<{ ok: boolean; error?: string; entries?: string[] }> {
    try {
      const { execFileSync } = await import('node:child_process')
      const listing = execFileSync('/usr/bin/unzip', ['-l', '--', request.path], { encoding: 'utf8' })
      const entries = listing.split('\n').slice(3, -2).map(line => line.trim().replace(/^.*\s/u, '')).filter(Boolean)
      return { ok: true, entries: entries.slice(0, 200) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * Normalize user input without repairing traversal into a different path.
 * @param input - The input input.
 * @returns The value produced by normalize wiki relative path.
 */
export function normalizeWikiRelativePath(input: string): string {
  if (input.includes('\0') || input.includes('\\')) throw new Error('invalid wiki path')
  const value = input.replace(/^\/+|\/+$/gu, '')
  const parts = value.split('/')
  if (value === '' || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('wiki path traversal is not allowed')
  }
  return parts.join('/')
}

/**
 * Checks the is blocked network address operation.
 * @param address - The address input.
 * @returns The value produced by is blocked network address.
 */
function resolveSafePath(root: string, input: string, allowMissingLeaf: boolean): {
  relativePath: string
  absolutePath: string
} {
  const relativePath = normalizeWikiRelativePath(input)
  return { relativePath, absolutePath: resolveConfinedPath(root, relativePath, allowMissingLeaf) }
}

function resolveRawSourcePath(projectRoot: string, input: string): string {
  const normalized = normalizeWikiRelativePath(input)
  const prefix = 'raw/sources/'
  if (normalized === '' || normalized === 'raw/sources') {
    throw new Error('raw source path must name a file below raw/sources')
  }
  const rel = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
  return resolveSafePath(resolve(projectRoot, 'raw', 'sources'), rel, false).absolutePath
}

/**
 * Checks whether an address belongs to a network range blocked by the wiki fetcher.
 * @param address - The address to classify.
 * @returns Whether the address belongs to a blocked range.
 */
export function isBlockedNetworkAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/gu, '')
  if (isIP(value) === 4) {
    const parsed = parseIpv4(value)
    return parsed === undefined || IPV4_BLOCKED_RANGES.some(([network, bits]) => cidr4(parsed, network, bits))
  }
  if (isIP(value) === 6) {
    const parsed = parseIpv6(value)
    if (parsed === undefined) return true
    const mapped = ipv6EmbeddedIpv4(parsed)
    if (mapped !== undefined) return isBlockedIpv4(mapped)
    return !cidr6(parsed, 0x2000n << 112n, 3)
      || IPV6_BLOCKED_RANGES.some(([network, bits]) => cidr6(parsed, network, bits))
  }
  return false
}

const IPV4_BLOCKED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
]

const IPV6_BLOCKED_RANGES: ReadonlyArray<readonly [bigint, number]> = [
  [0n, 96],
  [0x00000000000000000000000000000000n, 128],
  [0x00000000000000000000000000000001n, 128],
  [0x0064ff9b000100000000000000000000n, 48],
  [0x01000000000000000000000000000000n, 64],
  [0x20010000000000000000000000000000n, 32],
  [0x20010002000000000000000000000000n, 48],
  [0x20010010000000000000000000000000n, 28],
  [0x20010020000000000000000000000000n, 28],
  [0x20010db8000000000000000000000000n, 32],
  [0x20020000000000000000000000000000n, 16],
  [0x3fff0000000000000000000000000000n, 20],
  [0xfc000000000000000000000000000000n, 7],
  [0xfe800000000000000000000000000000n, 10],
  [0xfec00000000000000000000000000000n, 10],
  [0xff000000000000000000000000000000n, 8],
]

function parseIpv4(input: string): number | undefined {
  const parts = input.split('.')
  if (parts.length !== 4) return undefined
  let output = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    output = (output * 256 + value) >>> 0
  }
  return output
}

function cidr4(value: number, network: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) >>> 0 === (network & mask) >>> 0
}

function isBlockedIpv4(value: number): boolean {
  return IPV4_BLOCKED_RANGES.some(([network, bits]) => cidr4(value, network, bits))
}

function parseIpv6(input: string): bigint | undefined {
  if (input.includes('%') || input.split('::').length > 2) return undefined
  let source = input
  const ipv4Tail = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(source)?.[1]
  if (ipv4Tail !== undefined) {
    const ipv4 = parseIpv4(ipv4Tail)
    if (ipv4 === undefined) return undefined
    source = source.slice(0, -ipv4Tail.length)
      + `${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`
  }
  const [leftRaw = '', rightRaw] = source.split('::')
  const left = leftRaw === '' ? [] : leftRaw.split(':')
  const right = rightRaw === undefined || rightRaw === '' ? [] : rightRaw.split(':')
  const missing = 8 - left.length - right.length
  if ((rightRaw === undefined && missing !== 0) || (rightRaw !== undefined && missing < 1)) return undefined
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/u.test(part))) return undefined
  return parts.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n)
}

function cidr6(value: bigint, network: bigint, bits: number): boolean {
  if (bits === 0) return true
  const shift = BigInt(128 - bits)
  return value >> shift === network >> shift
}

function ipv6EmbeddedIpv4(value: bigint): number | undefined {
  const prefix96 = value >> 32n
  const mappedPrefix = 0xffffn
  const nat64Prefix = 0x0064ff9b0000000000000000n
  if (prefix96 === mappedPrefix || prefix96 === nat64Prefix) return Number(value & 0xffffffffn)
  return undefined
}

async function publicAddressFor(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http and https URLs are allowed')
  if (url.username || url.password) throw new Error('URL credentials are not allowed')
  if (url.port && !((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443'))) {
    throw new Error('non-default URL ports are not allowed')
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('local network targets are not allowed')
  }
  const family = isIP(hostname)
  const addresses = family === 4 || family === 6
    ? [{ address: hostname, family }]
    : await lookup(hostname, { all: true, order: 'verbatim' })
  if (addresses.length === 0 || addresses.some(item => isBlockedNetworkAddress(item.address))) {
    throw new Error('private or non-routable network targets are not allowed')
  }
  const selected = addresses[0]
  if (selected === undefined || (selected.family !== 4 && selected.family !== 6)) {
    throw new Error('URL target has no supported public address')
  }
  return { address: selected.address, family: selected.family }
}

/**
 * Start one HTTP(S) GET with DNS lookup pinned to the supplied address.
 * The caller validates the URL/address and handles redirects, status, deadlines, and body limits.
 * @param url - Request URL; its host is retained for Host and HTTPS server-name verification.
 * @param address - Prevalidated destination address and IP family supplied to the lookup callback.
 * @param signal - Passed to Node's request to abort transport, including an outstanding response body.
 * @param tlsAuthority - Optional HTTPS CA certificates; omitted to use Node's default trust roots.
 * @returns Response when headers arrive; the caller must consume or destroy its body.
 * @throws Rejects on request setup, transport, TLS, or abort errors before the response is returned.
 */
export function requestPinned(
  url: URL,
  address: { address: string; family: 4 | 6 },
  signal: AbortSignal,
  tlsAuthority?: string | Buffer,
): Promise<IncomingMessage> {
  const pinnedLookup = ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void): void => {
    if (typeof options === 'object' && options !== null && Reflect.get(options, 'all') === true) {
      callback(null, [address])
    } else {
      callback(null, address.address, address.family)
    }
  }) as LookupFunction
  return new Promise((resolveRequest, reject) => {
    const options: HttpsRequestOptions = {
      method: 'GET',
      signal,
      lookup: pinnedLookup,
      ...(url.protocol === 'https:' ? { servername: url.hostname, ca: tlsAuthority } : {}),
      headers: {
        Host: url.host,
        'User-Agent': 'Mozilla/5.0 (Ark knowledge engine)',
        Accept: 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1',
      },
    }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, resolveRequest)
    request.once('error', reject)
    request.end()
  })
}

/**
 * Consume a response through EOF with a byte ceiling, destroying it when the ceiling is exceeded.
 * @param response - Response stream whose chunks are collected in arrival order.
 * @param limit - Maximum accumulated body bytes; the over-limit diagnostic always says 5 MiB.
 * @param signal - Checked for each yielded chunk; the transport owner must abort a stalled read.
 * @returns Concatenated bytes after the stream ends, including an empty buffer for an empty body.
 * @throws On stream failure, cancellation observed at a chunk, or accumulated bytes exceeding limit.
 */
export async function readResponseBounded(
  response: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of response) {
    signal.throwIfAborted()
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    total += chunk.byteLength
    if (total > limit) {
      response.destroy(new Error('remote document exceeds 5 MiB'))
      throw new Error('remote document exceeds 5 MiB')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

async function fetchPublicText(input: string, ownerSignal: AbortSignal): Promise<{ text: string; url: string }> {
  let url = new URL(input)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    ownerSignal.throwIfAborted()
    const address = await publicAddressFor(url)
    ownerSignal.throwIfAborted()
    const requestController = new AbortController()
    const forwardAbort = (): void => { requestController.abort(ownerSignal.reason) }
    ownerSignal.addEventListener('abort', forwardAbort, { once: true })
    const timeout = setTimeout(() => {
      requestController.abort(new Error('remote document request timed out after 15 seconds'))
    }, 15_000)
    try {
      const response = await requestPinned(url, address, requestController.signal)
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400) {
        const location = response.headers.location
        response.destroy()
        if (typeof location !== 'string' || location === '') throw new Error(`redirect ${status} has no location`)
        url = new URL(location, url)
        continue
      }
      if (status < 200 || status >= 300) {
        response.destroy()
        throw new Error(`fetch failed (${status})`)
      }
      const declared = Number(response.headers['content-length'] ?? 0)
      if (declared > 5 * 1024 * 1024) {
        response.destroy()
        throw new Error('remote document exceeds 5 MiB')
      }
      const body = await readResponseBounded(response, 5 * 1024 * 1024, requestController.signal)
      return { text: body.toString('utf8'), url: url.toString() }
    } finally {
      clearTimeout(timeout)
      ownerSignal.removeEventListener('abort', forwardAbort)
    }
  }
  throw new Error('too many redirects')
}

function readFileIfExists(path: string): string {
  try {
    return readRegularFileBounded(path, 5 * 1024 * 1024).toString('utf8')
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    return ''
  }
}

function ingestFailure(error: unknown, errorCode: NonNullable<IngestOutcome['errorCode']>): IngestOutcome {
  return {
    written: [],
    warnings: [error instanceof Error ? error.message : String(error)],
    status: 'error',
    errorCode,
  }
}

/** Stable issue key used to append repeated repair attempts to one Incident. */
function issueSlugFrom(issueKey: string): string {
  const slug = issueKey
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|\s]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 64)
  return slug || 'unresolved-incident'
}

/** Append one session delta to an existing Incident instead of creating another page. */
function mergeIncidentCandidate(
  existing: string,
  incoming: string,
  sessionId: string,
  today: string,
  resolutionStatus: 'open' | 'verified',
): string {
  if (existing.includes(`session:${sessionId}`)) return existing
  let merged = existing
    .replace(/^updated:\s*.*$/mu, `updated: ${today}`)
    .replace(/^resolution_status:\s*.*$/mu, `resolution_status: ${resolutionStatus}`)
  merged = merged.replace(/^sources:\s*\[([^\]]*)\]$/mu, (_line, inner: string) => {
    const prefix = inner.trim()
    return `sources: [${prefix}${prefix ? ', ' : ''}"session:${sessionId}"]`
  })
  const body = incoming
    .replace(/^---\n[\s\S]*?\n---\n*/u, '')
    .replace(/^#[^\n]*\n*/u, '')
    .trim()
  return `${merged.trimEnd()}\n\n## 会话增量 ${sessionId.slice(0, 8)}\n\n${body}\n`
}

/** Upsert repeated sessions into one stable topic candidate instead of creating siblings. */
function mergeSessionCandidate(
  existing: string,
  incoming: string,
  sessionId: string,
  today: string,
  heading: '知识证据增量' | '反思证据增量',
): string {
  if (existing.includes(`session:${sessionId}`)) return existing
  let merged = existing.replace(/^updated:\s*.*$/mu, `updated: ${today}`)
  merged = merged.replace(/^evidence_count:\s*(\d+)\s*$/mu, (_line, count: string) =>
    `evidence_count: ${Number(count) + 1}`,
  )
  merged = merged.replace(/^sources:\s*\[([^\]]*)\]$/mu, (_line, inner: string) => {
    const prefix = inner.trim()
    return `sources: [${prefix}${prefix ? ', ' : ''}"session:${sessionId}"]`
  })
  const delta = incoming
    .replace(/^---\n[\s\S]*?\n---\n*/u, '')
    .replace(/^#[^\n]*\n*/u, '')
    .trim()
  return `${merged.trimEnd()}\n\n## ${heading} ${sessionId.slice(0, 8)}\n\n${delta}\n`
}

/** 会话提炼 prompt：要求 LLM 输出结构化 JSON（标题/要点/相关概念）。 */
function buildSummaryPrompt(conversation: string): string {
  return [
    '你是知识库准入审查员。判断以下完整会话是否包含值得长期保留的新知识，或者是在反复处理同一个尚未关闭的问题。',
    '不要因为会话很长、完成了任务或包含技术细节就保留。操作过程、工具调用、构建日志、提交哈希、文件路径、部署状态、进度确认和“继续/看看/修一下”都不是知识。',
    '助手自己声称“已完成/已修复”、编译通过、打包成功、提交完成都不是问题已解决的证据。',
    '如果用户在后续轮次继续报告同一症状，前面的修复尝试必须视为 failed 或 superseded，问题保持 open。',
    '只有用户明确确认、刷新或重启后的真实复现通过、针对原问题的测试通过、或明确观察到未再复发，才能输出 incident_verified。',
    '同一个问题无论尝试多少次，只输出一个稳定 issue_key 和一组 attempts，不要拆成多条知识。',
    '如果只是重复已有结论且没有新增尝试、证据或稳定知识，action 必须是 skip。',
    '每项评分为 0-2：reusable 可复用性、novelty 新颖性、evidence 证据性、stability 稳定性；总分低于 6 必须 skip。',
    '上述评分只约束 candidate；incident_open 可以低分保存为未关闭事件，但不能晋升知识。',
    'candidate 必须至少包含 claims、decisions、procedures 之一；一次会话最多生成一个候选主题、一个 reflection 或一个 Incident。',
    'reflection 不是事实，只用于记录可复用的失败反思。必须同时包含失败模式、根因假设、反事实做法、防复发动作、适用条件和证据；“以后更仔细/加强验证/已经完成”一律 skip。',
    '同一 reflection 或 candidate 必须输出稳定 topic_key，后续会话更新同一候选并累计证据，不得换标题制造新页。',
    '单一会话无论包含多少轮都只算一个来源；reflection 默认 hypothesis，不能声称 verified。',
    '只输出 JSON：',
    '{"action":"skip|candidate|reflection|incident_open|incident_verified","reason":"判断理由","title":"稳定主题名","topic_key":"知识或反思的稳定主题键","issue_key":"组件:对象:症状；仅事件填写","claims":["可验证主张"],"decisions":["可复用决定"],"procedures":["可重复流程"],"failure_pattern":"仅 reflection","root_cause_hypothesis":"仅 reflection","counterfactual":"仅 reflection","prevention":"仅 reflection","applicability":"仅 reflection","attempts":[{"hypothesis":"假设","action":"采取的动作","result":"proposed|applied|failed|unverified|superseded|verified|reverted"}],"final_root_cause":"仅 verified 填写","final_fix":"仅 verified 填写","verification_evidence":["用户确认或真实验证证据"],"related":["相关正式概念"],"scores":{"reusable":0,"novelty":0,"evidence":0,"stability":0}}',
    '',
    '对话内容：',
    conversation,
  ].join('\n')
}

type SummaryAction = 'skip' | 'candidate' | 'reflection' | 'incident_open' | 'incident_verified'

interface SummaryDecision {
  action: SummaryAction
  title: string
  summary: string
  related: string[]
  issueKey: string
}

/** 解析 LLM 返回的提炼 JSON（容忍 ```json 围栏与前后杂音）。 */
function parseSummaryJson(text: string): SummaryDecision | null {
  const cleaned = text.replace(/```json/gu, '').replace(/```/gu, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
    const empty = (action: SummaryAction = 'skip'): SummaryDecision => ({
      action,
      title: '',
      summary: '',
      related: [],
      issueKey: '',
    })
    if (parsed.action === 'skip') return empty()
    const action = parsed.action as SummaryAction
    if (!['candidate', 'reflection', 'incident_open', 'incident_verified'].includes(action)
      || typeof parsed.title !== 'string'
      || !parsed.title.trim()) return null
    const title = parsed.title.trim()
    if (/^(会话知识沉淀|会话沉淀|问题解决|继续)$/u.test(title)) {
      return empty()
    }
    const list = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
      : []
    const claims = list(parsed.claims)
    const decisions = list(parsed.decisions)
    const procedures = list(parsed.procedures)
    const verificationEvidence = list(parsed.verification_evidence)
    const issueKey = typeof parsed.issue_key === 'string' ? parsed.issue_key.trim() : ''
    const topicKey = typeof parsed.topic_key === 'string' ? parsed.topic_key.trim() : ''
    const incident = action === 'incident_open' || action === 'incident_verified'
    const reflection = action === 'reflection'
    if (incident && !issueKey) return null
    if (!incident && !reflection && claims.length + decisions.length + procedures.length === 0) return empty()
    const reflectionFields = reflection
      ? [parsed.failure_pattern, parsed.root_cause_hypothesis, parsed.counterfactual, parsed.prevention, parsed.applicability]
      : []
    if (reflection && (reflectionFields.some(value => typeof value !== 'string' || value.trim() === '') || !topicKey)) {
      return empty()
    }
    const scores = parsed.scores && typeof parsed.scores === 'object'
      ? parsed.scores as Record<string, unknown>
      : {}
    const values = ['reusable', 'novelty', 'evidence', 'stability'].map(key => Number(scores[key]))
    if (!incident && (values.some(value => !Number.isFinite(value) || value < 0 || value > 2)
      || values.reduce((sum, value) => sum + value, 0) < 6)) {
      return empty()
    }
    const verifiedEvidence = verificationEvidence.filter(item =>
      /用户.*确认|真实.*(?:页面|运行时|复现)|(?:测试|复现).*(?:通过|正常)|(?:刷新|重启).*(?:通过|正常)|未再复发/u.test(item),
    )
    const effectiveAction: SummaryAction = action === 'incident_verified' && verifiedEvidence.length === 0
      ? 'incident_open'
      : action
    const sections: string[] = []
    const add = (heading: string, items: string[]): void => {
      if (items.length > 0) sections.push(`## ${heading}\n\n${items.map(item => `- ${item}`).join('\n')}`)
    }
    add('可验证主张', claims)
    add('可复用决定', decisions)
    add('可重复流程', procedures)
    if (reflection) {
      add('失败模式', [String(parsed.failure_pattern).trim()])
      add('根因假设', [String(parsed.root_cause_hypothesis).trim()])
      add('反事实做法', [String(parsed.counterfactual).trim()])
      add('防复发动作', [String(parsed.prevention).trim()])
      add('适用条件', [String(parsed.applicability).trim()])
      add('证据', verificationEvidence)
    } else if (incident) {
      sections.push(`## 当前状态\n\n${effectiveAction === 'incident_verified' ? 'verified' : 'open'}`)
      const attempts = Array.isArray(parsed.attempts) ? parsed.attempts : []
      const attemptLines = attempts.flatMap((raw, index) => {
        if (!raw || typeof raw !== 'object') return []
        const attempt = raw as Record<string, unknown>
        const hypothesis = typeof attempt.hypothesis === 'string' ? attempt.hypothesis.trim() : ''
        const attemptedAction = typeof attempt.action === 'string' ? attempt.action.trim() : ''
        const result = typeof attempt.result === 'string' ? attempt.result.trim() : 'unverified'
        if (!hypothesis && !attemptedAction) return []
        return [`${index + 1}. [${result}] ${hypothesis}${attemptedAction ? `；动作：${attemptedAction}` : ''}`]
      })
      add('修复尝试', attemptLines)
      if (effectiveAction === 'incident_verified') {
        add('最终根因', typeof parsed.final_root_cause === 'string' && parsed.final_root_cause.trim()
          ? [parsed.final_root_cause.trim()]
          : [])
        add('最终修复', typeof parsed.final_fix === 'string' && parsed.final_fix.trim()
          ? [parsed.final_fix.trim()]
          : [])
        add('验证证据', verifiedEvidence)
      }
    } else {
      add('证据', verificationEvidence)
    }
    return {
      action: effectiveAction,
      title,
      summary: sections.join('\n\n'),
      related: Array.isArray(parsed.related) ? parsed.related.filter((r): r is string => typeof r === 'string') : [],
      issueKey: incident ? issueKey : topicKey || title,
    }
  } catch {
    return null
  }
}
