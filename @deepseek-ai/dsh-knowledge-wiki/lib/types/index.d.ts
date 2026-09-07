/**
 * 万相织鉴 host service: the in-process knowledge engine behind the
 * concept-graph tab. Owns the wiki page tree (graph + Louvain communities),
 * hybrid search, page editing, the two-stage LLM ingest pipeline with a
 * persisted queue, review items, and deep research — all inside the harness.
 * @module @deepseek-ai/dsh-knowledge-wiki
 */
import { Context, Service } from '@deepseek-ai/cordis';
import s from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { type IncomingMessage } from 'node:http';
import type { CandidateVerificationResult, IngestQueueSnapshot, WikiFileEntry, WikiGraphResult, WikiPageContent, IngestOutcome, KnowledgeUtilityRecord, WikiReviewItem, WikiSearchHit, WikiWriteResult } from './types.ts';
export type * from './types.ts';
export type { IngestQueueSnapshot, IngestQueueTask, WikiFileEntry, WikiGraphResult, WikiPageContent, KnowledgeUtilityRecord, WikiReviewItem, WikiSearchHit, WikiWriteResult, } from './types.ts';
/**
 * Strict endpoint metadata for the later Gateway/Native lane. This package
 * declares the contract only; it does not bypass or self-register Gateway routes.
 */
export declare const KNOWLEDGE_WIKI_ENDPOINT_METADATA: Readonly<{
    verifyCandidate: Readonly<{
        endpoint: "knowledgeWiki/verifyCandidate";
        owner: "knowledgeWiki";
        transport: "strict-remote";
        requiresVerifierAuthority: true;
        verifierAuthorityService: "knowledgeWikiVerifierAuthority";
        sourceIdentitySchema: "commit40+sourceDigest+dirtyDigest+buildDigest";
        nativeIntegration: "pending";
    }>;
}>;
/** Deployment configuration. */
export interface Config {
    /** Absolute path of the project wiki directory (contains concepts/, entities/, ...). */
    readonly wikiRoot: string;
    /** Main workspace root (fixed, non-removable); defaults to the wiki root's parent. */
    readonly mainRoot: string;
    /** Credential reference for DashScope semantic embeddings and image descriptions. */
    readonly credential: string;
    /** LLM provider id for ingest/research (default deepseek-official). */
    readonly llmProvider: string;
    /** LLM model id for ingest/research. */
    readonly llmModel: string;
}
/**
 * The knowledgeWiki Remote service: graph, search, pages, ingest queue,
 * reviews, and deep research — computed locally from the project directory.
 */
export default class KnowledgeWikiService extends TypertRemoteService {
    /** Required services. */
    static inject: string[];
    /** Loader validation for the deployment configuration. */
    static Config: s<Config>;
    private readonly wikiRoot;
    private readonly mainRoot;
    private currentRoot;
    private readonly credential;
    private readonly llmProvider;
    private readonly llmModel;
    private readonly queue;
    private readonly restoredQueueRoots;
    private readonly snapshots;
    private queueDrain;
    private activeIngest;
    private readonly backgroundStages;
    private queueNextId;
    private projectGeneration;
    /**
     * @param ctx - Host context.
     * @param config - Resolved deployment configuration.
     */
    constructor(ctx: Context, config: Config);
    /** Resolve on every operation so Keychain updates apply without a restart. */
    private resolveApiKey;
    /** Optional trusted verifier/build owner; project files can never supply it. */
    private get verifierAuthority();
    /** Parent-owned hard-deadline stage executor; absence disables non-cooperative ingest. */
    private get stageExecutor();
    /** Knowledge-base directory of the active workspace: the main wikiRoot, or `<root>/wiki` for a registered workspace. */
    private get activeWikiRoot();
    private captureProjectContext;
    /**
     * Start the source-folder auto-watch: restore the persisted queue, scan
     * raw/sources every 60s, and enqueue newly changed files for two-stage
     * ingest. A completed session may create one governed candidate after the
     * session-level admission gate accepts it; individual turns never create pages.
     */
    protected [Service.init](): Promise<void>;
    /**
     * 会话级 AI 提炼：agent 销毁时把整段对话交给 LLM 浓缩为一页知识，
     * 写入会话所属工作区的 `_candidates/sessions/`（每会话一页）。
     * 候选页不进入主图谱，等待治理提案与人工审批后再晋升。
     *
     * 与实时沉淀同一套工作区策略（非主工作区才写）；幂等靠 slug 含会话
     * id + 页面存在检查。LLM 失败静默（不阻塞 agent 销毁）。
     */
    private summarizeSession;
    /** Retry cooldown for failed ingests (prevents 60s crash-looping on a broken key). */
    private static readonly FAILED_RETRY_MS;
    private queueFile;
    /** Restore resumable tasks and cancelled-source tombstones. */
    private restoreQueue;
    /** Persist resumable tasks and cancelled-source tombstones. */
    private persistQueue;
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
    private enqueueIngest;
    /** Current content hash of a cache-relative source path, or undefined
     * for URLs and unreadable files. */
    private currentHash;
    private cacheFile;
    private readCache;
    private writeCache;
    private sha256;
    private listRawSources;
    private scanSources;
    private reviewFile;
    private utilityFile;
    private readUtility;
    private writeUtility;
    private recordKnowledgeRetrieval;
    /**
     * The concept graph (nodes + wikilink edges, Louvain clusters).
     * @returns the graph computed from the wiki page tree.
     */
    private computeGraph;
    /**
     * Provides the graph operation.
     * @returns The computed graph value.
     */
    graph(): Promise<WikiGraphResult>;
    /**
     * Provides the full graph operation.
     * @returns The computed graph value.
     */
    fullGraph(): Promise<WikiGraphResult>;
    /**
     * Lists the list operation.
     * @returns The wiki file entries.
     */
    list(): Promise<WikiFileEntry[]>;
    /**
     * Hybrid search over the wiki (BM25 + optional vector).
     * @param request - query text and optional hit count.
     * @returns ranked hits.
     */
    search(request: {
        query: string;
        topK?: number;
    }): Promise<WikiSearchHit[]>;
    /**
     * Provides the knowledge utility operation.
     * @returns The knowledge utility records.
     */
    knowledgeUtility(): Promise<KnowledgeUtilityRecord[]>;
    /**
     * Record whether retrieved knowledge helped or required a user correction.
     * @param request - The request input.
     * @returns The value produced by record knowledge outcome.
     */
    recordKnowledgeOutcome(request: {
        paths: string[];
        outcome: 'successful' | 'corrected' | 'neutral';
    }): Promise<number>;
    /**
     * Provides the page content operation.
     * @param request - The request input.
     * @returns The requested page content.
     */
    pageContent(request: {
        path: string;
    }): Promise<WikiPageContent>;
    /**
     * Write one wiki page.
     * @param request - page path and Markdown content.
     * @returns the written path.
     */
    writePage(request: {
        path: string;
        content: string;
        expectedContent?: string;
    }): Promise<WikiWriteResult>;
    /**
     * Create a new wiki page under wiki/concepts.
     * @param request - page title and optional content.
     * @returns the created path.
     */
    createPage(request: {
        title: string;
        content?: string;
    }): Promise<WikiWriteResult>;
    /**
     * Two-stage ingest of one source file (project-relative raw/sources path).
     * @param request - the source path.
     * @returns written wiki paths and warnings.
     */
    ingestSource(request: {
        path: string;
    }): Promise<IngestOutcome>;
    private ingestSourceWithContext;
    /** Multimodal image ingest: copy into wiki/media and caption with the vision LLM. */
    private ingestImage;
    /**
     * Fetch one URL, clip it to Markdown, and ingest it.
     * @param request - the URL.
     * @returns written wiki paths and warnings.
     */
    ingestUrl(request: {
        url: string;
    }): Promise<IngestOutcome>;
    private ingestUrlWithContext;
    /**
     * Enqueue sources for two-stage ingest (serialized, deduped; a completed
     * task can be re-run manually, an errored one only after its cooldown).
     * @param request - inputs (project-relative paths or URLs).
     * @returns the queue snapshot.
     */
    ingestQueueAdd(request: {
        inputs: string[];
    }): Promise<IngestQueueSnapshot>;
    /**
     * Provides the ingest queue status operation.
     * @returns The current ingest queue snapshot.
     */
    ingestQueueStatus(): Promise<IngestQueueSnapshot>;
    /**
     * Provides the ingest queue cancel operation.
     * @returns The current ingest queue snapshot after cancellation.
     */
    ingestQueueCancel(): Promise<IngestQueueSnapshot>;
    private cancelPendingForRoot;
    private queueSnapshot;
    private queueTaskContext;
    private executeQueuedIngest;
    private drainQueue;
    private runQueue;
    private enqueueAndWait;
    /** Record the content hash in the ingest cache only after a successful
     * ingest, so a failed task is retried once its cooldown elapses.
     * @returns the recorded hash (undefined for URLs or unreadable files). */
    private markIngested;
    /**
     * Expand a topic, search, and write research Candidates for the workspace captured at entry.
     * Written pages receive Candidate reviews and invalidate that workspace's cached snapshot.
     * @param request - Topic passed to query expansion and synthesis.
     * @param signal - Cancels executor stages; pipeline cancellation/failure becomes a degraded result.
     * @returns Findings with project-relative paths and warnings; pipeline failures include an error code.
     * @throws If recording Candidate reviews fails after the pipeline returns.
     */
    deepResearch(request: {
        topic: string;
    }, signal: AbortSignal): Promise<{
        findings: Array<{
            title: string;
            path: string;
        }>;
        warnings: string[];
        degraded: boolean;
        errorCode?: 'stage-executor-unavailable' | 'research-failed';
    }>;
    /**
     * Unresolved review items from .llm-wiki/review.json.
     * @param request - status filter and limit.
     * @returns matching review items.
     */
    reviews(request: {
        status?: string;
        limit?: number;
    }): Promise<WikiReviewItem[]>;
    /**
     * Ask the injected independent authority to verify a Candidate, then bind a passing receipt to its review.
     * Receipt persistence precedes review binding; this operation does not apply the governance action.
     * @param request - Review id and proposed governance action to bind into verification.
     * @param signal - Cancellation checked around and passed through the independent verifier call.
     * @returns Verdict/evidence or an explicit blocker; binding failure retains the receipt with ok: false.
     * @throws On cancellation, authority errors, malformed persisted state, or uncaught I/O failures.
     */
    verifyCandidate(request: {
        reviewId: string;
        action: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' | 'Archive';
    }, signal: AbortSignal): Promise<CandidateVerificationResult>;
    /**
     * Resolve one review item.
     * @param request - review id and optional action.
     * @returns whether the item was found and updated.
     */
    resolveReview(request: {
        reviewId: string;
        action?: string;
    }): Promise<boolean>;
    /**
     * Bulk-resolve review items.
     * @param request - review ids and optional action.
     * @returns the number resolved.
     */
    resolveReviews(request: {
        ids: string[];
        action?: string;
    }): Promise<number>;
    private workspacesFile;
    private readWorkspaces;
    private writeWorkspaces;
    /**
     * Lists the list projects operation.
     * @returns The available workspaces and current workspace.
     */
    listProjects(): Promise<{
        projects: Array<{
            path: string;
            name: string;
            main?: boolean;
        }>;
        current: string;
    }>;
    /**
     * Switch the active workspace.
     * @param request - workspace path (main or a registered workspace).
     * @returns the new current root.
     */
    setProject(request: {
        path: string;
    }): Promise<{
        current: string;
    }>;
    /**
     * Create and register a new workspace (initialized wiki/raw structure).
     * @param request - workspace name and path.
     * @returns the created path or an error.
     */
    createProject(request: {
        name: string;
        path: string;
    }): Promise<{
        path: string;
        error?: string;
    }>;
    /**
     * Remove a workspace from the registry (files untouched). The main
     * workspace cannot be removed.
     * @returns the remaining workspace list.
     * @param request - The request input.
     */
    removeProject(request: {
        path: string;
    }): Promise<{
        projects: Array<{
            path: string;
            name: string;
            main?: boolean;
        }>;
        current: string;
    }>;
    /**
     * Graph insights: surprising connections, isolated pages, bridge nodes,
     * and sparse communities.
     * @returns the insight report.
     */
    graphInsights(): Promise<{
        isolated: Array<{
            id: string;
            label: string;
            path: string;
        }>;
        bridges: Array<{
            id: string;
            label: string;
            path: string;
            communities: number;
        }>;
        sparseCommunities: Array<{
            id: number;
            nodeCount: number;
            topNodes: string[];
        }>;
    }>;
    /**
     * Lint the wiki: broken wikilinks, empty pages, and isolated pages.
     * @returns the lint report.
     */
    lint(): Promise<{
        brokenLinks: Array<{
            from: string;
            target: string;
        }>;
        emptyPages: string[];
        totalPages: number;
    }>;
    /**
     * Export the whole knowledge-base project as a ZIP archive.
     * @returns the archive path or an error.
     */
    exportProject(): Promise<{
        path: string;
        error?: string;
    }>;
    /**
     * Import a project archive: list the ZIP contents (wiki/raw/purpose/schema).
     * @param request - archive path.
     * @returns the archive summary or an error.
     */
    importProject(request: {
        path: string;
    }): Promise<{
        ok: boolean;
        error?: string;
        entries?: string[];
    }>;
}
/**
 * Normalize user input without repairing traversal into a different path.
 * @param input - The input input.
 * @returns The value produced by normalize wiki relative path.
 */
export declare function normalizeWikiRelativePath(input: string): string;
/**
 * Checks whether an address belongs to a network range blocked by the wiki fetcher.
 * @param address - The address to classify.
 * @returns Whether the address belongs to a blocked range.
 */
export declare function isBlockedNetworkAddress(address: string): boolean;
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
export declare function requestPinned(url: URL, address: {
    address: string;
    family: 4 | 6;
}, signal: AbortSignal, tlsAuthority?: string | Buffer): Promise<IncomingMessage>;
/**
 * Consume a response through EOF with a byte ceiling, destroying it when the ceiling is exceeded.
 * @param response - Response stream whose chunks are collected in arrival order.
 * @param limit - Maximum accumulated body bytes; the over-limit diagnostic always says 5 MiB.
 * @param signal - Checked for each yielded chunk; the transport owner must abort a stalled read.
 * @returns Concatenated bytes after the stream ends, including an empty buffer for an empty body.
 * @throws On stream failure, cancellation observed at a chunk, or accumulated bytes exceeding limit.
 */
export declare function readResponseBounded(response: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer>;
//# sourceMappingURL=index.d.ts.map