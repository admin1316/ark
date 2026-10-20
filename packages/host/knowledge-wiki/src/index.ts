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
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { buildGraph, extractWikiLinkTargets, listPages, readPage } from './graph.ts'
import { hybridSearch, type EmbeddingConnection } from './search.ts'
import { WikiSnapshotStore } from './snapshot-store.ts'
import { createProjectExecutionContext, type ProjectExecutionContext } from './project-context.ts'
import { ingestSource as runIngest } from './ingest.ts'
import { createOwnedStageExecutor } from './owned-stage-executor.ts'
import { isKnowledgeFileErrorCode, knowledgeFilePolicyHash, KnowledgeFileError } from './file-extract.ts'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { knowledgeConnectionFields, knowledgeConnectionSchema, validateKnowledgeConnections, type KnowledgeConnections } from './connections.ts'
import type { WikiProjectRequest, WikiProjectRegistry, KnowledgeResearchResult, KnowledgeProjectContextId, KnowledgeIngestAdmissionId } from './types.ts'
import {
  sedimentTarget, extractConversationText, buildSessionSummaryPage,
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
  atomicWriteConfinedFile,
  isMissingPathError,
  readOptionalJson,
  readRegularFileBounded,
  resolveConfinedPath,
} from './filesystem.ts'
import { ARCHIVE_INPUTS, zipExportInvocation, zipListEntries, zipListInvocation } from './archive.ts'
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

class KnowledgeResearchTimeoutError extends Error {
  constructor(timeoutMs: number) { super(`knowledge research timed out after ${timeoutMs}ms`) }
}

type PermanentFailure = NonNullable<IngestQueueTask['permanentFailure']>
type SourceDisposition = string | { cancelledHash: string; admissionId?: string } | { retryAfter: number }
  | { permanentFailure: PermanentFailure; admissionId?: string }

function isPermanentFailure(value: unknown): value is PermanentFailure {
  if (typeof value !== 'object' || value === null) return false
  return isKnowledgeFileErrorCode(Reflect.get(value, 'code'))
    && typeof Reflect.get(value, 'sourceHash') === 'string' && /^[a-f0-9]{64}$/u.test(Reflect.get(value, 'sourceHash') as string)
    && typeof Reflect.get(value, 'policyHash') === 'string' && /^[a-f0-9]{64}$/u.test(Reflect.get(value, 'policyHash') as string)
}

function normalizeIngestInput(input: string): string {
  return input.replace(/^\/+/u, '').replace(/^raw\/sources\//u, '')
}

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
  /** Text provider registered with the LLM service. */
  readonly llmProvider: string
  /** Text model resolved by that provider. */
  readonly llmModel: string
  /** Optional independent vision provider registered with the LLM service. */
  readonly visionProvider: string
  /** Image model resolved by the independent vision provider. */
  readonly visionModel: string
  /** Independent embedding provider; all connection fields empty disables it. */
  readonly embeddingProvider: string
  /** OpenAI-compatible embedding API base URL owned by the embedding provider. */
  readonly embeddingBaseUrl: string
  /** Embedding model resolved by the independent embedding provider. */
  readonly embeddingModel: string
  /** Credential reference resolved only for the declared embedding endpoint. */
  readonly embeddingCredential: string
  /** Maximum duration of an embedding request. */
  readonly embeddingTimeoutMs: number
  /** Enable the owned file worker and existing LLM/web provider dispatch. */
  readonly ownedStageExecutor: boolean
  /** Maximum admitted pending/running tasks across restored projects. */
  readonly ingestMaxActiveTasks: number
  /** Maximum inputs in one manual enqueue request. */
  readonly ingestMaxBatchInputs: number
  /** Maximum terminal tasks retained per project. */
  readonly ingestHistoryLimit: number
  /** Maximum serialized bytes in each queue or source-disposition file. */
  readonly ingestStateMaxBytes: number
  /** Maximum simultaneous research operations across projects; duplicates share one. */
  readonly researchConcurrency: number
  /** Total research deadline including provider preflight and cancellation-aware stages. */
  readonly researchTimeoutMs: number
}

/**
 * The knowledgeWiki Remote service: graph, search, pages, ingest queue,
 * reviews, and deep research — computed locally from the project directory.
 */
export default class KnowledgeWikiService extends TypertRemoteService {
  /** Required services. */
  static inject = ['llm', 'timer', 'credentials', 'settings']

  /** Loader validation for the deployment configuration. */
  static Config: s<Config> = s.object({
    wikiRoot: s.string().required(),
    mainRoot: s.string().default(''),
    visionProvider: knowledgeConnectionFields.visionProvider,
    visionModel: knowledgeConnectionFields.visionModel,
    embeddingProvider: knowledgeConnectionFields.embeddingProvider,
    embeddingBaseUrl: knowledgeConnectionFields.embeddingBaseUrl,
    embeddingModel: knowledgeConnectionFields.embeddingModel,
    embeddingCredential: knowledgeConnectionFields.embeddingCredential,
    embeddingTimeoutMs: s.number().min(1).max(2_147_483_647).default(30_000),
    // Absence of an executor keeps non-cooperative ingest disabled, so the
    // deployment that wants ingest turns this on explicitly.
    ownedStageExecutor: s.boolean().default(false),
    llmProvider: knowledgeConnectionFields.textProvider,
    llmModel: knowledgeConnectionFields.textModel,
    ingestMaxActiveTasks: s.number().min(1).max(10_000).step(1).default(64),
    ingestMaxBatchInputs: s.number().min(1).max(10_000).step(1).default(64),
    ingestHistoryLimit: s.number().min(0).max(10_000).step(1).default(128),
    ingestStateMaxBytes: s.number().min(4096).max(64 * 1024 * 1024).step(1).default(5 * 1024 * 1024),
    researchConcurrency: s.number().min(1).max(32).step(1).default(2),
    researchTimeoutMs: s.number().min(1).max(3_600_000).step(1).default(600_000),
  })

  private readonly embeddingTimeoutMs: number
  private readonly wikiRoot: string
  private readonly mainRoot: string
  private currentRoot: string
  private connections: () => KnowledgeConnections
  private readonly projectLifetimes = new Map<string, AbortController>()
  private readonly projectTokens = new Map<string, KnowledgeProjectContextId>()
  private readonly ownedStageExecutor: KnowledgeWikiStageExecutor | undefined
  private readonly queue: IngestQueueTask[] = []
  private readonly restoredQueueRoots = new Set<string>()
  private readonly snapshots = new WikiSnapshotStore()
  private embeddingWarningLogged = false
  private queueDrain: Promise<void> | undefined
  private activeIngest: { readonly taskId: number; readonly controller: AbortController } | undefined
  private readonly backgroundStages = new Set<AbortController>()
  private readonly lifetime = new AbortController()
  private readonly stageOperations = new Set<Promise<unknown>>()
  private queueNextId = 1
  private projectGeneration = 0
  private readonly taskWaiters = new Map<string, Set<(task: IngestQueueTask) => void>>()
  private readonly researchOperations = new Map<string, {
    controller: AbortController
    promise: Promise<KnowledgeResearchResult>
    subscribers: number
  }>()
  private readonly limits: Pick<Config, 'ingestMaxActiveTasks' | 'ingestMaxBatchInputs' | 'ingestHistoryLimit' | 'ingestStateMaxBytes' | 'researchConcurrency' | 'researchTimeoutMs'>

  /**
   * @param ctx - Host context.
   * @param config - Resolved deployment configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'knowledgeWiki')
    this.limits = config
    if (config.ingestMaxActiveTasks * 512 >= config.ingestStateMaxBytes) throw new Error('knowledge-wiki: ingestStateMaxBytes must reserve more than 512 bytes per active task')
    this.wikiRoot = config.wikiRoot.replace(/\/+$/u, '')
    const parent = dirname(this.wikiRoot)
    this.mainRoot = config.mainRoot.replace(/\/+$/u, '') || parent
    this.currentRoot = this.mainRoot
    this.embeddingTimeoutMs = config.embeddingTimeoutMs
    const entry: KnowledgeConnections = {
      textProvider: config.llmProvider, textModel: config.llmModel,
      visionProvider: config.visionProvider, visionModel: config.visionModel,
      embeddingProvider: config.embeddingProvider, embeddingBaseUrl: config.embeddingBaseUrl,
      embeddingModel: config.embeddingModel, embeddingCredential: config.embeddingCredential,
    }
    validateKnowledgeConnections(entry)
    this.connections = () => entry
    const settings = ctx.get('settings')
    if (settings !== undefined) {
      const scope = settings.register(settingsNamespace('knowledge-wiki'), knowledgeConnectionSchema, {
        base: entry, validate: validateKnowledgeConnections,
      })
      this.connections = () => scope.get()
    }
    this.ownedStageExecutor = config.ownedStageExecutor
      ? createOwnedStageExecutor({ llm: ctx.llm, web: () => ctx.get('web'), attachments: () => ctx.get('attachments') })
      : undefined
  }

  private projectToken(root: string): KnowledgeProjectContextId {
    let token = this.projectTokens.get(root)
    if (token === undefined) {
      token = randomUUID() as KnowledgeProjectContextId
      this.projectTokens.set(root, token)
      this.projectLifetimes.set(token, new AbortController())
    }
    return token
  }

  /** Resolve registered project identity once; never fall back to the selected UI project. */
  private resolveProjectContext(token: string): ProjectExecutionContext {
    const registered = new Set([this.mainRoot, ...this.readWorkspaces().map(row => row.path)])
    const root = [...this.projectTokens].find(([root, id]) => id === token && registered.has(root))?.[0]
    if (root === undefined) throw new Error('knowledge project context is missing, invalid, or revoked')
    return createProjectExecutionContext(root, this.mainRoot, this.wikiRoot, this.projectGeneration)
  }

  /** Resolve the current operation's embedding credential only for its declared endpoint. */
  private async embeddingConnection(
    config = this.connections(),
    signal = this.lifetime.signal,
  ): Promise<EmbeddingConnection | undefined> {
    if (config.embeddingProvider === '') return undefined
    const apiKey = (await this.ctx.credentials.resolve(credentialRef(config.embeddingCredential)))?.value
    if (!apiKey) return undefined
    return Object.freeze({
      provider: config.embeddingProvider, baseUrl: config.embeddingBaseUrl,
      model: config.embeddingModel, apiKey,
      signal: AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.embeddingTimeoutMs)]),
    })
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

  /** Parent-owned cancellable stage executor; absence disables ingest. */
  private get stageExecutor(): KnowledgeWikiStageExecutor | undefined {
    const value: unknown = this.ctx.get('knowledgeWikiStageExecutor')
    // Composition may supply another owner with the same cancellation contract.
    const executor = isKnowledgeWikiStageExecutor(value) ? value : this.ownedStageExecutor
    if (executor === undefined) return undefined
    return this.trackStageExecutor(executor)
  }

  private trackStageExecutor(executor: KnowledgeWikiStageExecutor): KnowledgeWikiStageExecutor {
    return {
      isolation: executor.isolation,
      ...executor.assertSearchAvailable === undefined ? {} : {
        assertSearchAvailable: (signal?: AbortSignal) => executor.assertSearchAvailable?.(signal),
      },
      ...executor.prepareOperation === undefined ? {} : {
        prepareOperation: async (route: { provider: string; model: string; modelCalls: number }, signal: AbortSignal) =>
          this.trackStageExecutor(await (executor.prepareOperation as NonNullable<KnowledgeWikiStageExecutor['prepareOperation']>)(
            route, signal,
          )),
      },
      execute: (request, signal) => {
        const operation = executor.execute(request, AbortSignal.any([signal, this.lifetime.signal]))
        this.stageOperations.add(operation)
        // The caller owns errors; this bookkeeping branch only releases the tracked promise.
        void operation.then(() => { this.stageOperations.delete(operation) }, () => { this.stageOperations.delete(operation) })
        return operation
      },
    }
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
      this.ctx.effect(() => async () => {
        this.lifetime.abort(new Error('knowledge-wiki disposed'))
        this.activeIngest?.controller.abort(new Error('knowledge-wiki disposed'))
        for (const controller of this.backgroundStages) controller.abort(new Error('knowledge-wiki disposed'))
        await Promise.allSettled([...this.stageOperations, ...this.queueDrain === undefined ? [] : [this.queueDrain]])
        this.settleStoppedWaiters()
        this.snapshots.dispose()
      }, 'knowledge-wiki: operation owner')
      const dispose = this.ctx.timer.interval(() => {
        if (this.lifetime.signal.aborted) return
        void this.scanSources().catch((error: unknown) => { this.ctx.logger.warn('knowledge source scan failed', error) })
        // Drain independently of scan: restored pending tasks survive a
        // restart only when the timer drains them without a cache change.
        this.startQueueDrain()
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
   * 仅写入已注册会话工作区的 `_candidates/`；注销工作区会取消提炼。
   * 候选页不进入主图谱，等待治理提案与人工审批后再晋升。
   *
   * 非主工作区才写；稳定主题页合并会话来源。失败只记日志，不阻塞 agent 销毁。
   */
  private async summarizeSession(sessionId: string | undefined): Promise<void> {
    const controller = new AbortController()
    this.backgroundStages.add(controller)
    try {
      if (!sessionId) return
      this.lifetime.signal.throwIfAborted()
      const sessionQuery: unknown = this.ctx.get('sessionQuery')
      if (!isSessionQueryReader(sessionQuery)) return
      const surface = await sessionQuery.readSession(sessionId)
      const target = sedimentTarget(surface.session.cwd, this.mainRoot)
      if (!target) return
      const registered = this.readWorkspaces().find(row => resolve(row.path) === dirname(target.wikiRoot))
      if (registered === undefined) return
      const token = this.projectToken(registered.path)
      const context = this.resolveProjectContext(token)
      const signal = AbortSignal.any([
        controller.signal, this.lifetime.signal,
        (this.projectLifetimes.get(token) as AbortController).signal,
      ])
      signal.throwIfAborted()
      const events = surface.events
      if (!Array.isArray(events) || events.length === 0) return
      const conversation = extractConversationText(events)
      if (conversation.trim().length < 200) return // 对话太短，提炼无价值

      const completed = await executeKnowledgeWikiStage(this.stageExecutor, {
        kind: 'llm-complete',
        provider: this.connections().textProvider,
        model: this.connections().textModel,
        prompt: buildSummaryPrompt(conversation),
        operation: 'session summary',
        timeoutMs: 120_000,
      }, signal)
      signal.throwIfAborted()
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
        const pageRel = `wiki/${rel.split(sep).join('/')}`
        const full = resolveConfinedPath(context.projectRoot, pageRel, true)
        const alreadyExists = existsSync(full)
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
        signal.throwIfAborted()
        if (next !== readFileIfExists(full)) atomicWriteConfinedFile(context.projectRoot, pageRel, next)
        signal.throwIfAborted()
        appendCandidateReviews(
          this.reviewFile(context.projectRoot),
          context.projectRoot,
          `session:${sessionId}`,
          [pageRel],
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
    let content: string
    try {
      content = readRegularFileBounded(this.queueFile(projectRoot), this.limits.ingestStateMaxBytes).toString('utf8')
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      this.restoredQueueRoots.add(projectRoot)
      return
    }
    const before = [...this.queue]
    const nextId = this.queueNextId
    try {
      const parsed = JSON.parse(content) as unknown
      if (!Array.isArray(parsed)) throw new Error('invalid knowledge ingest queue state')
      const context = createProjectExecutionContext(projectRoot, this.mainRoot, this.wikiRoot, this.projectGeneration)
      for (const value of parsed) {
        if (typeof value !== 'object' || value === null) continue
        const task = value as Partial<IngestQueueTask>
        if (task.permanentFailure !== undefined && task.status !== 'error') throw new Error('permanent failure requires an error knowledge ingest task')
        if (typeof task.input !== 'string'
          || !['pending', 'running', 'done', 'error', 'cancelled'].includes(task.status ?? '')) continue
        const input = normalizeIngestInput(task.input)
        const id = typeof task.id === 'number' ? task.id : this.queueNextId
        if (!Number.isSafeInteger(id) || id < 1 || this.queue.some(row => row.projectRoot === projectRoot && row.id === id)) throw new Error('invalid or duplicate knowledge ingest task identity')
        if (this.queue.some(item => item.projectRoot === projectRoot && item.input === input
          && (item.status === 'pending' || item.status === 'running' || task.status === 'cancelled' && item.status === 'cancelled'))) continue
        const restored: IngestQueueTask = {
          id,
          input,
          ...typeof task.admissionId === 'string' ? { admissionId: task.admissionId } : {},
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
          ...task.permanentFailure === undefined ? {} : { permanentFailure: this.validatedPermanentFailure(task.permanentFailure) },
          ...(typeof task.completedAt === 'number' ? { completedAt: task.completedAt } : {}),
          ...(typeof task.cancelRequestedAt === 'number' ? { cancelRequestedAt: task.cancelRequestedAt } : {}),
          ...(typeof task.runId === 'string' ? { runId: task.runId } : {}),
          ...(typeof task.leaseStartedAt === 'number' ? { leaseStartedAt: task.leaseStartedAt } : {}),
        }
        this.queue.push(restored.status === 'pending' ? this.resumableTask(restored) : restored)
        this.queueNextId = Math.max(this.queueNextId, id + 1)
      }
      const cache = this.readCache(projectRoot)
      const restoredHistory = this.queue.filter(row => row.projectRoot === projectRoot)
        .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt) || b.id - a.id)
      for (const task of restoredHistory) {
        if (cache[task.input] !== undefined) continue
        if (task.status === 'done' && task.ingestedHash !== undefined) cache[task.input] = task.ingestedHash
        if (task.status === 'cancelled' && task.ingestedHash !== undefined) cache[task.input] = { cancelledHash: task.ingestedHash, ...task.admissionId === undefined ? {} : { admissionId: task.admissionId } }
        if (task.status === 'error' && task.permanentFailure !== undefined) cache[task.input] = {
          permanentFailure: task.permanentFailure, ...task.admissionId === undefined ? {} : { admissionId: task.admissionId },
        }
        else if (task.status === 'error' && task.failedAt !== undefined) cache[task.input] = { retryAfter: task.failedAt + KnowledgeWikiService.FAILED_RETRY_MS }
      }
      for (let index = 0; index < this.queue.length; index++) {
        const task = this.taskAt(index)
        const disposition = cache[task.input]
        if (task.projectRoot === projectRoot && task.status === 'pending' && typeof disposition === 'object' && 'cancelledHash' in disposition
          && (disposition.admissionId === undefined || disposition.admissionId === task.admissionId)
          && disposition.cancelledHash === this.currentHash(task.input, projectRoot)) {
          this.queue[index] = { ...task, status: 'cancelled', ingestedHash: disposition.cancelledHash, completedAt: Date.now() }
        }
        if (task.projectRoot === projectRoot && task.status === 'pending' && typeof disposition === 'object' && 'permanentFailure' in disposition
          && disposition.admissionId === task.admissionId
          && this.permanentFailureIsCurrent(disposition.permanentFailure, task.input, projectRoot)) {
          this.queue[index] = { ...task, status: 'error', permanentFailure: disposition.permanentFailure,
            error: `source requires a content/policy change or manual retry (${disposition.permanentFailure.code})`,
            completedAt: Date.now(), failedAt: Date.now() }
        }
      }
      if (this.queue.filter(task => task.status === 'pending' || task.status === 'running').length > this.limits.ingestMaxActiveTasks) throw new Error('knowledge ingest queue exceeds ingestMaxActiveTasks; increase the deployment capacity before restoring')
      const active = this.queue.filter(task => task.projectRoot === projectRoot && (task.status === 'pending' || task.status === 'running'))
      this.requireStateFits(active, active.filter(task => task.status === 'pending').length * 512)
      const reserved = { ...cache }
      for (const task of active) reserved[task.input] = this.reservedFailureDisposition(task)
      this.requireStateFits(reserved)
      if (Object.keys(cache).length > 0) this.writeCache(cache, projectRoot)
      this.persistQueue(projectRoot)
      this.restoredQueueRoots.add(projectRoot)
    } catch (error) {
      this.queue.splice(0, this.queue.length, ...before)
      this.queueNextId = nextId
      throw error
    }
  }

  private encodeState(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`
  }

  private requireStateFits(value: unknown, reserve = 0): string {
    const encoded = this.encodeState(value)
    if (Buffer.byteLength(encoded) + reserve > this.limits.ingestStateMaxBytes) {
      throw new Error('knowledge ingest state capacity exceeded; reduce the batch or increase ingestStateMaxBytes')
    }
    return encoded
  }

  /** Keep active work and a bounded terminal history; source dispositions own replay suppression. */
  private persistQueue(projectRoot?: string): void {
    const roots = projectRoot === undefined ? new Set(this.queue.map(task => task.projectRoot)) : new Set([projectRoot])
    for (const root of roots) {
      const active = this.queue.filter(task => task.projectRoot === root && (task.status === 'pending' || task.status === 'running'))
      const history = this.queue.filter(task => task.projectRoot === root && task.status !== 'pending' && task.status !== 'running')
        .sort((a, b) => (a.completedAt ?? a.createdAt) - (b.completedAt ?? b.createdAt) || a.id - b.id)
        .slice(-this.limits.ingestHistoryLimit)
      if (this.limits.ingestHistoryLimit === 0) history.length = 0
      const reserve = active.filter(task => task.status === 'pending').length * 512
      while (history.length > 0
        && Buffer.byteLength(this.encodeState([...active, ...history])) + reserve > this.limits.ingestStateMaxBytes) history.shift()
      const retained = [...active, ...history]
      const encoded = this.requireStateFits(retained, reserve)
      atomicWriteFile(this.queueFile(root), encoded)
      const keys = new Set(retained.map(task => this.taskKey(task)))
      for (let index = this.queue.length - 1; index >= 0; index--) {
        const task = this.taskAt(index)
        if (task.projectRoot === root && !keys.has(this.taskKey(task))) this.queue.splice(index, 1)
      }
    }
  }

  private taskAt(index: number): IngestQueueTask {
    const task = this.queue[index]
    if (task === undefined) throw new Error('knowledge ingest task identity was lost')
    return task
  }

  private serviceStopped(): boolean {
    return this.lifetime.signal.aborted
  }

  private resumableTask(task: IngestQueueTask): IngestQueueTask {
    return {
      id: task.id, input: task.input, projectRoot: task.projectRoot, wikiRoot: task.wikiRoot,
      projectGeneration: task.projectGeneration, createdAt: task.createdAt, status: 'pending',
      ...task.admissionId === undefined ? {} : { admissionId: task.admissionId },
    }
  }

  private taskKey(task: Pick<IngestQueueTask, 'projectRoot' | 'id'>): string {
    return JSON.stringify([task.projectRoot, task.id])
  }

  private settleTask(task: IngestQueueTask): void {
    const key = this.taskKey(task)
    const waiters = this.taskWaiters.get(key)
    this.taskWaiters.delete(key)
    for (const settle of waiters ?? []) settle(task)
  }

  private settleStoppedWaiters(error = 'knowledge-wiki disposed'): void {
    for (const task of this.queue) {
      if (this.taskWaiters.has(this.taskKey(task))) this.settleTask({ ...task, status: 'error', error })
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
    persist = true,
  ): boolean {
    this.lifetime.signal.throwIfAborted()
    const normalized = normalizeIngestInput(input)
    const disposition = this.readCache(context.projectRoot)[normalized]
    if (typeof disposition === 'object') {
      if ('retryAfter' in disposition && Date.now() < disposition.retryAfter) return false
      if (!force && 'permanentFailure' in disposition && this.permanentFailureIsCurrent(disposition.permanentFailure, normalized, context.projectRoot)) return false
      if (!force && 'cancelledHash' in disposition && disposition.cancelledHash === this.currentHash(normalized, context.projectRoot)) return false
    }
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
        if (!force && existing.permanentFailure !== undefined
          && this.permanentFailureIsCurrent(existing.permanentFailure, normalized, context.projectRoot)) return false
        const failedAt = existing.failedAt
        if (existing.permanentFailure === undefined && failedAt !== undefined
          && Date.now() - failedAt < KnowledgeWikiService.FAILED_RETRY_MS) {
          return false
        }
      }
    }
    if (this.queue.filter(task => task.status === 'pending' || task.status === 'running').length >= this.limits.ingestMaxActiveTasks) throw new Error('knowledge ingest queue is busy; active task capacity reached')
    const next: IngestQueueTask = {
      id: this.queueNextId++,
      admissionId: randomUUID() as KnowledgeIngestAdmissionId,
      input: normalized,
      projectRoot: context.projectRoot,
      wikiRoot: context.wikiRoot,
      projectGeneration: context.generation,
      createdAt: Date.now(),
      status: 'pending',
    }
    const active = [...this.queue.filter(task => task.projectRoot === context.projectRoot && (task.status === 'pending' || task.status === 'running')), next]
    this.requireStateFits(active, active.filter(task => task.status === 'pending').length * 512)
    const reservedCache = { ...this.readCache(context.projectRoot) }
    for (const task of active) reservedCache[task.input] = this.reservedFailureDisposition(task)
    this.requireStateFits(reservedCache)
    this.queue.push(next)
    if (persist) this.persistQueue(context.projectRoot)
    return true
  }

  /** Current content hash of a cache-relative source path, or undefined
   * for URLs and unreadable files. */
  private currentHash(input: string, projectRoot = this.currentRoot): string | undefined {
    if (/^https?:\/\//i.test(input)) return undefined
    const source = resolveRawSourcePath(projectRoot, input)
    return this.sha256(readRegularFileBounded(source, MAX_RAW_SOURCE_BYTES))
  }

  private validatedPermanentFailure(value: unknown): PermanentFailure {
    if (!isPermanentFailure(value)) throw new Error('invalid permanent knowledge ingest failure state')
    return value
  }

  private reservedFailureDisposition(task: IngestQueueTask): SourceDisposition {
    return { permanentFailure: { code: 'unsupported-format', sourceHash: 'f'.repeat(64), policyHash: 'f'.repeat(64) },
      ...task.admissionId === undefined ? {} : { admissionId: task.admissionId } }
  }

  private permanentFailureIsCurrent(failure: PermanentFailure, input: string, projectRoot: string): boolean {
    return failure.policyHash === knowledgeFilePolicyHash() && failure.sourceHash === this.sourceHashForFailure(input, projectRoot)
  }

  private sourceHashForFailure(input: string, projectRoot: string): string | undefined {
    try { return this.currentHash(input, projectRoot) }
    catch {
      // A removed/replaced/unreadable source cannot authorize a durable permanent suppression.
      return undefined
    }
  }

  private cacheFile(projectRoot = this.currentRoot): string {
    return join(projectRoot, '.llm-wiki', 'ingest-cache.json')
  }

  private readCache(projectRoot = this.currentRoot): Record<string, SourceDisposition> {
    try {
      const parsed: unknown = JSON.parse(readRegularFileBounded(this.cacheFile(projectRoot), this.limits.ingestStateMaxBytes).toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid knowledge source disposition state')
      for (const value of Object.values(parsed) as unknown[]) {
        if (typeof value === 'string') continue
        if (typeof value !== 'object' || value === null) throw new Error('invalid knowledge source disposition')
        if ('cancelledHash' in value && typeof value.cancelledHash === 'string' && (!('admissionId' in value) || typeof value.admissionId === 'string')) continue
        if ('retryAfter' in value && typeof value.retryAfter === 'number' && Number.isFinite(value.retryAfter)) continue
        if ('permanentFailure' in value && isPermanentFailure(value.permanentFailure)
          && (!('admissionId' in value) || typeof value.admissionId === 'string')) continue
        throw new Error('invalid knowledge source disposition')
      }
      return parsed as Record<string, SourceDisposition>
    } catch (error) {
      if (isMissingPathError(error)) return {}
      throw error
    }
  }

  private writeCache(cache: ReturnType<KnowledgeWikiService['readCache']>, projectRoot = this.currentRoot): void {
    const retained = Object.fromEntries(Object.entries(cache).filter(([, value]) =>
      typeof value !== 'object' || !('retryAfter' in value) || value.retryAfter > Date.now()))
    atomicWriteFile(this.cacheFile(projectRoot), this.requireStateFits(retained))
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
    // The loop below re-stats every child before recursing, so walk() is only
    // ever entered with an ordinary directory, and a revisit would require a
    // symbolic or hard link, both of which are rejected there.
    const walk = (dir: string): void => {
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
      try {
        for (const rel of this.listRawSources(context.projectRoot)) {
          if (this.queue.filter(task => task.status === 'pending' || task.status === 'running').length >= this.limits.ingestMaxActiveTasks) break
          const source = resolveRawSourcePath(context.projectRoot, rel)
          const hash = this.sha256(readRegularFileBounded(source, MAX_RAW_SOURCE_BYTES))
          const disposition = cache[rel]
          if (disposition === hash || typeof disposition === 'object' && 'cancelledHash' in disposition && disposition.cancelledHash === hash) continue
          this.enqueueIngest(rel, false, context, false)
        }
      } finally { this.persistQueue(context.projectRoot) }
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

  private computeGraph(wikiRoot: string): Promise<WikiGraphResult> {
    return this.snapshots.get(wikiRoot, 'graph', () => promiseFromSync(() => buildGraph(wikiRoot)))
  }

  /**
   * Provides the graph operation.
   * @param request - Host-issued registered project identity.
   * @returns The computed graph value.
   */
  @Remote('graph')
  async graph(request: WikiProjectRequest): Promise<WikiGraphResult> {
    const context = this.resolveProjectContext(request.projectContext)
    return this.computeGraph(context.wikiRoot)
  }

  /**
   * Provides the full graph operation.
   * @param request - Host-issued registered project identity.
   * @returns The computed graph value.
   */
  @Remote('fullGraph')
  async fullGraph(request: WikiProjectRequest): Promise<WikiGraphResult> {
    const context = this.resolveProjectContext(request.projectContext)
    return this.computeGraph(context.wikiRoot)
  }

  /**
   * Lists the list operation.
   * @param request - Host-issued registered project identity.
   * @returns The wiki file entries.
   */
  @Remote('list')
  async list(request: WikiProjectRequest): Promise<WikiFileEntry[]> {
    const context = this.resolveProjectContext(request.projectContext)
    const wikiRoot = context.wikiRoot
    return this.snapshots.get(wikiRoot, 'list', () =>
      promiseFromSync(() => listPages(wikiRoot) as WikiFileEntry[]))
  }

  /**
   * Describe independently configured knowledge routes without exposing credentials.
   * @param request - Registered project identity.
   * @returns Local keyword/hybrid mode, route configuration flags, and the complete research deadline.
   */
  @Remote('projectStatus')
  projectStatus(request: WikiProjectRequest): Promise<{
    searchMode: 'keyword' | 'hybrid'
    textConfigured: boolean
    visionConfigured: boolean
    embeddingConfigured: boolean
    researchTimeoutMs: number
  }> {
    return promiseFromSync(() => {
      this.resolveProjectContext(request.projectContext)
      const config = this.connections()
      return {
        searchMode: config.embeddingProvider === '' ? 'keyword' : 'hybrid',
        textConfigured: config.textProvider !== '', visionConfigured: config.visionProvider !== '',
        embeddingConfigured: config.embeddingProvider !== '',
        researchTimeoutMs: this.limits.researchTimeoutMs,
      }
    })
  }

  /**
   * Hybrid search over the wiki (BM25 + optional vector).
   * @param request - query text and optional hit count.
   * @returns ranked hits.
   */
  @Remote('search')
  async search(request: WikiProjectRequest & { query: string; topK?: number }): Promise<WikiSearchHit[]> {
    const context = this.resolveProjectContext(request.projectContext)
    const signal = AbortSignal.any([
      this.lifetime.signal, (this.projectLifetimes.get(request.projectContext) as AbortController).signal,
    ])
    const config = this.connections()
    const connection = await this.embeddingConnection(config, signal)
    signal.throwIfAborted()
    // Each query binds route and credential resolution before sharing a derived result.
    // A reference rotation or a newly configured key must not reuse a previous route's cache.
    const route = createHash('sha256').update(JSON.stringify([
      config.embeddingProvider, config.embeddingBaseUrl, config.embeddingModel, config.embeddingCredential,
      connection?.apiKey ?? '',
    ])).digest('hex')
    const topK = request.topK ?? 8
    const hits = await this.snapshots.get(context.wikiRoot, `search:${route}:${topK}:${request.query}`, async () =>
      hybridSearch(context.wikiRoot, request.query, connection, topK, (diagnostic) => {
        if (this.embeddingWarningLogged) return
        this.embeddingWarningLogged = true
        this.ctx.logger.warn(`[knowledge-wiki] semantic search unavailable, using keyword results: ${diagnostic.reason}`)
      }))
    signal.throwIfAborted()
    this.recordKnowledgeRetrieval(hits.map(hit => hit.path), context.projectRoot)
    return hits.map(hit => ({ path: hit.path, score: hit.score }))
  }

  /**
   * Provides the knowledge utility operation.
   * @param request - Host-issued registered project identity.
   * @returns The knowledge utility records.
   */
  @Remote('knowledgeUtility')
  knowledgeUtility(request: WikiProjectRequest): Promise<KnowledgeUtilityRecord[]> {
    return promiseFromSync(() => {
      const context = this.resolveProjectContext(request.projectContext)
      return Object.values(this.readUtility(context.projectRoot)).sort((left, right) => right.utilityScore - left.utilityScore)
    })
  }

  /**
   * Record whether retrieved knowledge helped or required a user correction.
   * @param request - The request input.
   * @returns The value produced by record knowledge outcome.
   */
  @Remote('recordKnowledgeOutcome')
  recordKnowledgeOutcome(request: WikiProjectRequest & {
    paths: string[]
    outcome: 'successful' | 'corrected' | 'neutral'
  }): Promise<number> {
    return promiseFromSync(() => {
      const context = this.resolveProjectContext(request.projectContext)
      const records = this.readUtility(context.projectRoot)
      const now = new Date().toISOString()
      let updated = 0
      for (const candidate of [...new Set(request.paths)]) {
        let safe: string
        try {
          safe = resolveSafePath(context.wikiRoot, candidate, false).relativePath
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
      if (updated > 0) this.writeUtility(records, context.projectRoot)
      return updated
    })
  }

  /**
   * Provides the page content operation.
   * @param request - The request input.
   * @returns The requested page content.
   */
  @Remote('pageContent')
  pageContent(request: WikiProjectRequest & { path: string }): Promise<WikiPageContent> {
    return promiseFromSync(() => {
      const context = this.resolveProjectContext(request.projectContext)
      try {
        const { relativePath: safe, absolutePath: resolved } = resolveSafePath(
          context.wikiRoot,
          request.path,
          false,
        )
        if (lstatSync(resolved).isDirectory()) return { path: request.path, content: '' }
        return { path: request.path, content: readPage(context.wikiRoot, safe) }
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
  writePage(request: WikiProjectRequest & {
    path: string
    content: string
    expectedContent?: string
  }): Promise<WikiWriteResult> {
    return promiseFromSync(() => {
      const context = this.resolveProjectContext(request.projectContext)
      try {
        const { relativePath: safe, absolutePath: full } = resolveSafePath(
          context.wikiRoot,
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
        this.snapshots.invalidate(context.wikiRoot)
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
  createPage(request: WikiProjectRequest & { title: string; content?: string }): Promise<WikiWriteResult> {
    return promiseFromSync(() => {
      const context = this.resolveProjectContext(request.projectContext)
      try {
        const slug = request.title.trim().replace(/[\\/:*?"<>|\s]+/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '')
        const rel = `concepts/${slug}.md`
        const full = join(context.wikiRoot, rel)
        if (existsSync(full)) return { path: rel, ok: false, error: 'page already exists' }
        const frontmatter = `---\ntype: concept\nstatus: canonical\norigin: human\ntitle: ${request.title.trim()}\napproved_at: ${new Date().toISOString().slice(0, 10)}\napproved_by: human\ncreated: ${new Date().toISOString().slice(0, 10)}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n${request.content ?? ''}\n`
        mkdirSync(join(context.wikiRoot, 'concepts'), { recursive: true })
        atomicWriteFile(full, frontmatter)
        this.snapshots.invalidate(context.wikiRoot)
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
  async ingestSource(request: WikiProjectRequest & { path: string }): Promise<IngestOutcome> {
    try {
      const context = this.resolveProjectContext(request.projectContext)
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
      this.connections().textProvider,
      this.connections().textModel,
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
    const vision = this.connections()
    const configured = vision.visionProvider !== ''
    if (configured && this.stageExecutor === undefined) {
      throw new Error('knowledge Wiki stage executor unavailable; refusing vision work')
    }
    signal.throwIfAborted()
    const fileName = basename(relPath)
    const slug = fileName.replace(/[\/:*?"<>|\s]+/gu, '-').replace(/-+/gu, '-').replace(/\.[^.]+$/u, '')
    const wikiParent = dirname(context.wikiRoot)
    const wikiDirectory = basename(context.wikiRoot)
    const mediaRel = `_candidates/ingest/media/${slug}${extname(fileName).toLowerCase()}`
    atomicWriteConfinedFile(
      wikiParent, `${wikiDirectory}/${mediaRel}`,
      readRegularFileBounded(source, 16 * 1024 * 1024),
    )
    signal.throwIfAborted()
    const caption = configured
      ? (await executeKnowledgeWikiStage(this.stageExecutor, {
        kind: 'vision-describe',
        provider: vision.visionProvider,
        model: vision.visionModel,
        path: source,
        timeoutMs: 60_000,
      }, signal)).text ?? ''
      : ''
    signal.throwIfAborted()
    if (!caption) return { written: [mediaRel], warnings: [configured ? '视觉说明生成失败，请检查所选连接。' : '未配置图片说明连接，图片已保留在本机。'] }
    const pageRel = `_candidates/ingest/sources/${slug}.md`
    const page = `---\ntype: source\nstatus: candidate\norigin: image\ntitle: ${fileName}\nsources: ["${relPath}"]\ncreated: ${new Date().toISOString().slice(0, 10)}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# ${fileName}\n\n![${fileName}](/${mediaRel})\n\n## 图片说明\n\n${caption}\n`
    atomicWriteConfinedFile(wikiParent, `${wikiDirectory}/${pageRel}`, page)
    appendCandidateReviews(this.reviewFile(context.projectRoot), context.projectRoot, relPath, [`wiki/${pageRel}`])
    return { written: [pageRel, mediaRel], warnings: [] }
  }

  /**
   * Fetch one URL, clip it to Markdown, and ingest it.
   * @param request - the URL.
   * @returns written wiki paths and warnings.
   */
  @Remote('ingestUrl')
  async ingestUrl(request: WikiProjectRequest & { url: string }): Promise<IngestOutcome> {
    const context = this.resolveProjectContext(request.projectContext)
    try {
      const url = new URL(request.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https URLs are allowed')
      return await this.enqueueAndWait(request.url, context)
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
    atomicWriteConfinedFile(context.projectRoot, rel, `# ${request.url}\n\n> 来源：${request.url}\n\n${md}\n`)
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
  ingestQueueAdd(request: WikiProjectRequest & { inputs: string[] }): Promise<IngestQueueSnapshot> {
    return promiseFromSync(() => {
      const context = this.resolveProjectContext(request.projectContext)
      if (request.inputs.length > this.limits.ingestMaxBatchInputs) throw new Error('knowledge ingest batch exceeds ingestMaxBatchInputs')
      const previous = [...this.queue]
      try {
        for (const input of request.inputs) this.enqueueIngest(input, true, context, false)
        this.persistQueue(context.projectRoot)
      } catch (error) {
        this.queue.splice(0, this.queue.length, ...previous)
        throw error
      }
      this.startQueueDrain()
      return this.queueSnapshot(context.projectRoot)
    })
  }

  /**
   * Provides the ingest queue status operation.
   * @param request - Host-issued registered project identity.
   * @returns The current ingest queue snapshot.
   */
  @Remote('ingestQueueStatus')
  ingestQueueStatus(request: WikiProjectRequest): Promise<IngestQueueSnapshot> {
    const context = this.resolveProjectContext(request.projectContext)
    return promiseFromSync(() => this.queueSnapshot(context.projectRoot))
  }

  /**
   * Cancel pending tasks only; the current owned execution continues safely.
   * @param request - Host-issued registered project identity.
   * @returns The current ingest queue snapshot after cancellation.
   */
  @Remote('ingestQueueCancel')
  ingestQueueCancel(request: WikiProjectRequest): Promise<IngestQueueSnapshot> {
    return promiseFromSync(() => {
      const context = this.resolveProjectContext(request.projectContext)
      this.cancelPendingForRoot(context.projectRoot, true)
      return this.queueSnapshot(context.projectRoot)
    })
  }

  private cancelPendingForRoot(projectRoot: string, userRequested = false): boolean {
    let changed = false
    for (let index = 0; index < this.queue.length; index += 1) {
      const task = this.taskAt(index)
      if (task.projectRoot !== projectRoot) continue
      if (task.status !== 'pending') continue
      const ingestedHash = userRequested ? this.currentHash(task.input, task.projectRoot) : undefined
      if (ingestedHash !== undefined) {
        const cache = this.readCache(projectRoot)
        cache[task.input] = { cancelledHash: ingestedHash, ...task.admissionId === undefined ? {} : { admissionId: task.admissionId } }
        this.writeCache(cache, projectRoot)
      }
      this.queue[index] = {
        ...task,
        status: 'cancelled',
        ...userRequested ? { cancelRequestedAt: Date.now() } : {},
        completedAt: Date.now(),
        ...(ingestedHash === undefined ? {} : { ingestedHash }),
      }
      this.settleTask(this.taskAt(index))
      changed = true
    }
    if (changed) this.persistQueue(projectRoot)
    return changed
  }

  private queueSnapshot(projectRoot: string): IngestQueueSnapshot {
    const tasks = this.queue.filter(task => task.projectRoot === projectRoot)
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

  private startQueueDrain(): void {
    void this.drainQueue().catch((error: unknown) => {
      this.ctx.logger.warn('knowledge ingest queue failed', error)
      this.settleStoppedWaiters(error instanceof Error ? error.message : String(error))
    })
  }

  private drainQueue(): Promise<void> {
    if (this.queueDrain !== undefined) return this.queueDrain
    const drain = this.runQueue().then(() => {
      this.queueDrain = undefined
      if (!this.lifetime.signal.aborted && this.queue.some(task => task.status === 'pending')) this.startQueueDrain()
    }, (error: unknown) => {
      this.queueDrain = undefined
      throw error
    })
    this.queueDrain = drain
    return drain
  }

  private async runQueue(): Promise<void> {
    while (!this.lifetime.signal.aborted) {
      const index = this.queue.findIndex(task => task.status === 'pending')
      if (index < 0) break
      const task = this.taskAt(index)
      const currentIndex = (): number => this.queue.findIndex(row => this.taskKey(row) === this.taskKey(task))
      const controller = new AbortController()
      const running: IngestQueueTask = {
        ...task,
        status: 'running',
        runId: randomUUID(),
        leaseStartedAt: Date.now(),
      }
      this.queue[currentIndex()] = running
      this.activeIngest = { taskId: task.id, controller }
      const timeout = setTimeout(() => {
        controller.abort(new Error('ingest timed out after 5 minutes'))
      }, 5 * 60 * 1000)
      const context = this.queueTaskContext(running)
      try {
        this.persistQueue(running.projectRoot)
        const outcome = await this.executeQueuedIngest(running, context, controller.signal)
        controller.signal.throwIfAborted()
        if (outcome.written.length === 0 && outcome.warnings.length > 0) {
          throw new Error(outcome.warnings.join('; '))
        }
        const remaining = this.queue.filter(row => row.projectRoot === running.projectRoot && this.taskKey(row) !== this.taskKey(running) && (row.status === 'pending' || row.status === 'running'))
        try {
          this.requireStateFits([...remaining, { ...running, status: 'done', written: outcome.written, warnings: outcome.warnings, completedAt: Date.now(), ingestedHash: 'f'.repeat(64) }], remaining.filter(task => task.status === 'pending').length * 512)
        } catch {
          throw new Error('knowledge ingest outcome exceeds ingestStateMaxBytes; generated files were preserved and the outcome was not committed')
        }
        const ingestedHash = this.markIngested(running.input, context)
        this.queue[currentIndex()] = {
          ...running,
          status: 'done',
          written: outcome.written,
          warnings: outcome.warnings,
          completedAt: Date.now(),
          ...(ingestedHash !== undefined ? { ingestedHash } : {}),
        }
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error)
        const remaining = this.queue.filter(row => row.projectRoot === running.projectRoot && this.taskKey(row) !== this.taskKey(running) && (row.status === 'pending' || row.status === 'running'))
        const stopped = this.serviceStopped()
        const revoked = running.projectRoot !== this.mainRoot && !this.readWorkspaces().some(row => row.path === running.projectRoot)
        const failedHash = error instanceof KnowledgeFileError
          ? error.sourceHash ?? this.sourceHashForFailure(running.input, context.projectRoot) : undefined
        const permanentFailure = error instanceof KnowledgeFileError && failedHash !== undefined
          ? { code: error.code, sourceHash: failedHash, policyHash: knowledgeFilePolicyHash() } : undefined
        if (Buffer.byteLength(this.encodeState([...remaining, { ...running, status: 'error', error: message,
          completedAt: Date.now(), failedAt: Date.now(), ...permanentFailure === undefined ? {} : { permanentFailure } }]))
          + remaining.filter(task => task.status === 'pending').length * 512 > this.limits.ingestStateMaxBytes) {
          message = 'knowledge ingest error exceeds ingestStateMaxBytes; generated files were preserved'
        }
        console.error('[knowledge-wiki] ingest failed:', running.input, message)
        this.queue[currentIndex()] = {
          ...running,
          status: stopped ? 'pending' : revoked ? 'cancelled' : 'error',
          error: message,
          completedAt: Date.now(),
          ...stopped || revoked ? {} : { failedAt: Date.now() },
          ...stopped || revoked || permanentFailure === undefined ? {} : { permanentFailure },
        }
        if (stopped) this.queue[currentIndex()] = this.resumableTask(running)
        if (this.taskAt(currentIndex()).status === 'error') {
          const cache = this.readCache(context.projectRoot)
          cache[running.input] = permanentFailure === undefined
            ? { retryAfter: Date.now() + KnowledgeWikiService.FAILED_RETRY_MS }
            : { permanentFailure, ...running.admissionId === undefined ? {} : { admissionId: running.admissionId } }
          this.writeCache(cache, context.projectRoot)
        }
      } finally {
        clearTimeout(timeout)
        this.activeIngest = undefined
        const terminal = this.taskAt(currentIndex())
        this.persistQueue(context.projectRoot)
        if (terminal.status !== 'pending') this.settleTask(terminal)
      }
    }
  }

  private async enqueueAndWait(
    input: string,
    context: ProjectExecutionContext,
  ): Promise<IngestOutcome> {
    this.enqueueIngest(input, true, context)
    const task = this.queue.findLast(item => item.projectRoot === context.projectRoot
      && item.input === normalizeIngestInput(input))
    if (task === undefined) throw new Error('ingest task was not admitted')
    const terminal = task.status === 'pending' || task.status === 'running'
      ? await new Promise<IngestQueueTask>((resolve) => {
        const key = this.taskKey(task)
        const waiters = this.taskWaiters.get(key) ?? new Set()
        waiters.add(resolve)
        this.taskWaiters.set(key, waiters)
        this.startQueueDrain()
      })
      : task
    if (terminal.status === 'done') {
      // runQueue only marks a task done with both arrays attached.
      const warnings = terminal.warnings as string[]
      return {
        written: terminal.written as string[],
        warnings,
        status: warnings.length > 0 ? 'degraded' : 'ok',
      }
    }
    const error = terminal.error ?? `ingest task ${task.id} did not complete`
    const errorCode = terminal.status === 'cancelled'
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
   * @param signal - Detaches this subscriber; the final subscriber aborts the shared operation.
   * @returns Findings with project-relative paths and warnings; pipeline failures include an error code.
   * @throws On subscriber cancellation or failure to record Candidate reviews.
   */
  @Remote('deepResearch')
  async deepResearch(
    request: WikiProjectRequest & { topic: string },
    signal: AbortSignal,
  ): Promise<KnowledgeResearchResult> {
    const context = this.resolveProjectContext(request.projectContext)
    signal.throwIfAborted()
    const topic = request.topic.trim().replace(/\s+/gu, ' ')
    const route = Object.freeze({ ...this.connections() })
    const revisions = this.ctx.get('settings')?.describe({ redactSecrets: true }).map(row => [row.ns, row.revision]) ?? []
    const key = JSON.stringify([request.projectContext, topic, route.textProvider, route.textModel, revisions])
    let operation = this.researchOperations.get(key)
    if (operation === undefined) {
      if (this.researchOperations.size >= this.limits.researchConcurrency) {
        return { findings: [], sources: [], sourceCount: 0, warnings: ['knowledge research is busy; operation capacity reached'], degraded: true, errorCode: 'research-failed' }
      }
      const controller = new AbortController()
      const ownerSignal = AbortSignal.any([
        controller.signal, this.lifetime.signal,
        (this.projectLifetimes.get(request.projectContext) as AbortController).signal,
      ])
      const deadline = setTimeout(() => {
        controller.abort(new KnowledgeResearchTimeoutError(this.limits.researchTimeoutMs))
      }, this.limits.researchTimeoutMs)
      const promise = Promise.resolve()
        .then(() => this.runResearchOperation({ ...request, topic }, context, route, ownerSignal))
        .finally(() => { clearTimeout(deadline) })
      operation = { controller, promise, subscribers: 0 }
      this.researchOperations.set(key, operation)
      this.stageOperations.add(promise)
      const release = (): void => { this.researchOperations.delete(key); this.stageOperations.delete(promise) }
      void promise.then(release, release)
    }
    const owned = operation
    owned.subscribers++
    try {
      return await new Promise<KnowledgeResearchResult>((resolve, reject) => {
        const abort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('knowledge research subscriber cancelled')) }
        signal.addEventListener('abort', abort, { once: true })
        const release = (): void => { signal.removeEventListener('abort', abort) }
        void owned.promise.then((value) => { release(); resolve(value) }, (error: unknown) => {
          release()
          reject(error instanceof Error ? error : new Error(String(error)))
        })
        if (signal.aborted) abort()
      })
    } finally {
      owned.subscribers--
      if (owned.subscribers === 0) owned.controller.abort(new Error('knowledge research has no remaining subscribers'))
    }
  }

  private async runResearchOperation(
    request: WikiProjectRequest & { topic: string },
    context: ProjectExecutionContext,
    route: KnowledgeConnections,
    signal: AbortSignal,
  ): Promise<KnowledgeResearchResult> {
    let result
    try {
      result = await runResearch(
        this.stageExecutor,
        route.textProvider,
        route.textModel,
        context.projectRoot,
        request.topic,
        signal,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        findings: [],
        sources: [],
        sourceCount: 0,
        warnings: [message],
        degraded: true,
        errorCode: signal.reason instanceof KnowledgeResearchTimeoutError ? 'timeout' : signal.aborted ? 'cancelled' : message.includes('stage executor unavailable')
          ? 'stage-executor-unavailable'
          : message.includes('web') ? 'web-search-unavailable' : 'research-failed',
      }
    }
    signal.throwIfAborted()
    appendCandidateReviews(
      this.reviewFile(context.projectRoot),
      context.projectRoot,
      `research:${request.topic}`,
      result.written,
    )
    if (result.written.length > 0) this.snapshots.invalidate(context.wikiRoot)
    return {
      findings: result.written.map((path) => {
        const sourceURLs = result.pageSources[path]
        if (sourceURLs === undefined || sourceURLs.length === 0) throw new Error('research candidate has no validated source association')
        return { title: basename(path), path, sourceURLs }
      }),
      sources: result.sources,
      sourceCount: result.sourceCount,
      ...result.errorCode === undefined ? {} : { errorCode: result.errorCode },
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
  reviews(request: WikiProjectRequest & { status?: string; limit?: number }): Promise<WikiReviewItem[]> {
    return promiseFromSync(() => {
      const context = this.resolveProjectContext(request.projectContext)
      const all = readOptionalJson<WikiReviewItem[]>(this.reviewFile(context.projectRoot), [])
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
    request: WikiProjectRequest & {
      reviewId: string
      action: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' | 'Archive'
    },
    signal: AbortSignal,
  ): Promise<CandidateVerificationResult> {
    const context = this.resolveProjectContext(request.projectContext)
    signal = AbortSignal.any([signal, this.lifetime.signal, (this.projectLifetimes.get(request.projectContext) as AbortController).signal])
    const authority = this.verifierAuthority
    const reviewFile = this.reviewFile(context.projectRoot)
    const result = await verifyCandidate(
      authority,
      reviewFile,
      context.wikiRoot,
      request.reviewId,
      request.action,
      signal,
    )
    signal.throwIfAborted()
    if (result.ok && result.receiptId !== undefined) {
      const recorded = recordTrustedCandidateVerification(
        authority,
        reviewFile,
        context.wikiRoot,
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
  resolveReview(request: WikiProjectRequest & { reviewId: string; action?: string }): Promise<boolean> {
    return promiseFromSync(() => {
      const context = this.resolveProjectContext(request.projectContext)
      const reviewFile = this.reviewFile(context.projectRoot)
      const advisory = resolveAdvisoryReviewBatch(reviewFile, [request.reviewId], request.action ?? 'skip')
      if (advisory.resolvedCount > 0) return true
      for (const candidateId of advisory.candidateIds) {
        const candidateResult = applyCandidateReview(
          this.verifierAuthority,
          reviewFile,
          context.projectRoot,
          context.wikiRoot,
          join(this.mainRoot, 'jiuzhang-tarballs', 'archive'),
          candidateId,
          request.action ?? 'Skip',
        )
        if (candidateResult) this.snapshots.invalidate(context.wikiRoot)
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
  resolveReviews(request: WikiProjectRequest & { ids: string[]; action?: string }): Promise<number> {
    return promiseFromSync(() => {
      const context = this.resolveProjectContext(request.projectContext)
      const projectRoot = context.projectRoot
      const wikiRoot = context.wikiRoot
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
  listProjects(): Promise<WikiProjectRegistry> {
    return promiseFromSync(() => this.projectRegistry())
  }

  private projectRegistry(): WikiProjectRegistry {
    return {
      projects: [{ path: this.mainRoot, name: '万相织鉴', main: true }, ...this.readWorkspaces()]
        .map(project => ({ ...project, projectContext: this.projectToken(project.path) })),
      current: this.currentRoot,
      currentProjectContext: this.projectToken(this.currentRoot),
    }
  }

  /**
   * Switch the active workspace.
   * @param request - workspace path (main or a registered workspace).
   * @returns the new current root.
   */
  @Remote('setProject')
  setProject(request: { path: string }): Promise<{ current: string; projectContext: KnowledgeProjectContextId }> {
    return promiseFromSync(() => {
      const target = request.path.replace(/\/+$/u, '')
      const known = [this.mainRoot, ...this.readWorkspaces().map(ws => ws.path.replace(/\/+$/u, ''))]
      if (known.includes(target)) {
        if (this.currentRoot !== target) {
          this.restoreQueue(target)
          recoverCandidateReviewTransactions(
            this.verifierAuthority,
            this.reviewFile(target),
            createProjectExecutionContext(target, this.mainRoot, this.wikiRoot, this.projectGeneration).wikiRoot,
            join(this.mainRoot, 'jiuzhang-tarballs', 'archive'),
          )
          this.currentRoot = target
          this.projectGeneration += 1
        }
      }
      return { current: this.currentRoot, projectContext: this.projectToken(this.currentRoot) }
    })
  }

  /**
   * Create and register a new workspace (initialized wiki/raw structure).
   * @param request - workspace name and path.
   * @returns the created path or an error.
   */
  @Remote('createProject')
  createProject(request: { name: string; path: string }): Promise<{
    path: string
    error?: string
    projectContext?: KnowledgeProjectContextId
  }> {
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
        return { path: root, projectContext: this.projectToken(root) }
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
  removeProject(request: { path: string }): Promise<WikiProjectRegistry> {
    return promiseFromSync(() => {
      const target = request.path.replace(/\/+$/u, '')
      if (target === this.mainRoot) {
        // 主工作区不可删除：原样返回列表。
        return this.projectRegistry()
      }
      const registered = this.readWorkspaces()
      if (!registered.some(ws => ws.path.replace(/\/+$/u, '') === target)) {
        return this.projectRegistry()
      }
      const remaining = registered.filter(ws => ws.path.replace(/\/+$/u, '') !== target)
      this.writeWorkspaces(remaining)
      const revoked = this.projectTokens.get(target)
      if (revoked !== undefined) {
        this.projectLifetimes.get(revoked)?.abort(new Error('knowledge project was unregistered'))
        this.projectLifetimes.delete(revoked)
      }
      this.projectTokens.delete(target)
      if (this.activeIngest !== undefined && this.queue.some(task => task.projectRoot === target && task.status === 'running' && task.id === this.activeIngest?.taskId)) this.activeIngest.controller.abort(new Error('knowledge project was unregistered'))
      this.cancelPendingForRoot(target)
      if (this.currentRoot === target) {
        this.currentRoot = this.mainRoot
        this.projectGeneration += 1
        this.restoreQueue(this.mainRoot)
      }
      return this.projectRegistry()
    })
  }

  /**
   * Graph insights: surprising connections, isolated pages, bridge nodes,
   * and sparse communities.
   * @param request - Host-issued registered project identity.
   * @returns the insight report.
   */
  @Remote('graphInsights')
  async graphInsights(request: WikiProjectRequest): Promise<{
    isolated: Array<{ id: string; label: string; path: string }>
    bridges: Array<{ id: string; label: string; path: string; communities: number }>
    sparseCommunities: Array<{ id: number; nodeCount: number; topNodes: string[] }>
  }> {
    const context = this.resolveProjectContext(request.projectContext)
    const graph = await this.computeGraph(context.wikiRoot)
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
   * @param request - Host-issued registered project identity.
   * @returns the lint report.
   */
  @Remote('lint')
  async lint(request: WikiProjectRequest): Promise<{
    brokenLinks: Array<{ from: string; target: string }>
    emptyPages: string[]
    totalPages: number
  }> {
    const context = this.resolveProjectContext(request.projectContext)
    const pages = await this.list(request)
    const mdPages = pages.filter(page => page.path.endsWith('.md'))
    const known = new Set(mdPages.map(page => page.path))
    const brokenLinks: Array<{ from: string; target: string }> = []
    const emptyPages: string[] = []
    for (const page of mdPages) {
      const content = readPage(context.wikiRoot, page.path)
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
   * @param request - Host-issued registered project identity.
   * @returns the archive path or an error.
   */
  @Remote('exportProject')
  async exportProject(request: WikiProjectRequest): Promise<{ path: string; error?: string }> {
    const context = this.resolveProjectContext(request.projectContext)
    try {
      const outDir = join(context.projectRoot, '.llm-wiki', 'exports')
      mkdirSync(outDir, { recursive: true })
      const outPath = join(outDir, `wanxiang-${new Date().toISOString().slice(0, 10)}.zip`)
      const { execFileSync } = await import('node:child_process')
      const inv = zipExportInvocation(ARCHIVE_INPUTS, outPath)
      execFileSync(inv.command, inv.args, {
        cwd: context.projectRoot,
        env: { ...process.env, ...inv.env },
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
  async importProject(request: WikiProjectRequest & { path: string }): Promise<{ ok: boolean; error?: string; entries?: string[] }> {
    this.resolveProjectContext(request.projectContext)
    try {
      const { execFileSync } = await import('node:child_process')
      const inv = zipListInvocation(request.path)
      const listing = execFileSync(inv.command, inv.args, {
        encoding: 'utf8',
        env: { ...process.env, ...inv.env },
      })
      const entries = zipListEntries(listing)
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
    return IPV4_BLOCKED_RANGES.some(([network, bits]) => cidr4(parseIpv4(value), network, bits))
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

function parseIpv4(input: string): number {
  // Every caller passes node's isIP(…)==4 gate first, so the input is always
  // four decimal parts within 0-255 and no rejection arm is reachable here.
  let output = 0
  for (const part of input.split('.')) output = (output * 256 + Number(part)) >>> 0
  return output
}

function cidr4(value: number, network: number, bits: number): boolean {
  const mask = (0xffffffff << (32 - bits)) >>> 0
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
    source = source.slice(0, -ipv4Tail.length)
      + `${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`
  }
  const [leftRaw = '', rightRaw] = source.split('::')
  const left = leftRaw === '' ? [] : leftRaw.split(':')
  const right = rightRaw === undefined || rightRaw === '' ? [] : rightRaw.split(':')
  const missing = 8 - left.length - right.length
  // node's isIP(…)==6 gate above guarantees eight groups with well-formed
  // hex parts, so no rejection arm is reachable here.
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  return parts.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n)
}

function cidr6(value: bigint, network: bigint, bits: number): boolean {
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
