/**
 * Public wire vocabulary for the knowledgeWiki Remote: graph nodes/edges,
 * wiki file tree entries, hybrid-search hits, and Candidate verification results.
 * This module contains types only so generated Remote clients can consume it
 * without importing Host runtime code.
 * @module @deepseek-ai/dsh-knowledge-wiki/types
 */

/** One concept-graph node as served by LLM Wiki. */
export interface WikiGraphNode {
  /** Stable node id. */
  readonly id: string
  /** Display label. */
  readonly label: string
  /** Incoming wikilink count. */
  readonly linkCount: number
  /** Node category (entity/concept/source/finding/overview/...). */
  readonly nodeType: string
  /** Wiki page path relative to the project root, when backed by a page. */
  readonly path?: string
  /** Louvain community id, when the node belongs to a detected cluster. */
  readonly cluster?: string | null
}

/** One concept-graph edge (wikilink) as served by LLM Wiki. */
export interface WikiGraphEdge {
  /** Source node label. */
  readonly source: string
  /** Target node label. */
  readonly target: string
  /** Optional link weight. */
  readonly weight?: number
}

/** The concept graph. */
export interface WikiGraph {
  readonly nodes: WikiGraphNode[]
  readonly edges: WikiGraphEdge[]
}

/** One wiki file tree entry (directory or page). */
export interface WikiFileEntry {
  readonly name: string
  /** Project-relative path. */
  readonly path: string
  readonly isDir: boolean
  /** Page byte size when known. */
  readonly size?: number | null
  /** Directory children; present only when this entry is a directory. */
  readonly children?: WikiFileEntry[] | null
}


/** One wiki page's text content. */
export interface WikiPageContent {
  /** Project-relative path of the page. */
  readonly path: string
  /** Page text content (Markdown). */
  readonly content: string
}
/** One hybrid-search hit. */
export interface WikiSearchHit {
  readonly path: string
  readonly score: number
}

/** Retrieval and outcome evidence for one canonical knowledge page. */
export interface KnowledgeUtilityRecord {
  readonly path: string
  readonly retrievalHits: number
  readonly successfulUses: number
  readonly userCorrections: number
  readonly utilityScore: number
  readonly lastRetrievedAt?: string
  readonly lastOutcomeAt?: string
}

/** Hash-bound verification evidence for one Candidate review. */
export interface CandidateVerification {
  readonly status: 'pending' | 'passed' | 'failed'
  readonly candidateHash: string
  readonly action?: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' | 'Archive'
  readonly reviewHash?: string
  readonly sourceIdentity?: {
    readonly commit: string
    readonly sourceDigest: string
    readonly dirty: boolean
    readonly dirtyDigest: string
    readonly buildDigest: string
  }
  readonly authorityId?: string
  readonly methods: ReadonlyArray<'unit_test' | 'integration_test' | 'production_observation' | 'manual_review'>
  readonly evidence: string[]
  readonly receipts: VerificationReceiptReference[]
  readonly confidence: number
  readonly successCount: number
  readonly failureCount: number
  readonly verifiedBy?: 'human' | 'deterministic-executor'
  readonly lastVerifiedAt?: string
}

/** Service result with explicit integration blockers. */
export interface CandidateVerificationResult {
  /** True for a passing receipt; the service also requires binding it to the current review. */
  readonly ok: boolean
  /** Persisted receipt id, present for authenticated pass and fail results. */
  readonly receiptId?: string
  /** Authority verdict; a pass can accompany ok: false if review binding fails. */
  readonly result?: 'pass' | 'fail'
  /** Flattened check evidence, or a source-identity error; empty when no evidence is available. */
  readonly evidence: string[]
  /** Blocker or failed verification/binding classification when ok is false. */
  readonly errorCode?:
    | 'review-not-found'
    | 'candidate-invalid'
    | 'verifier-authority-unavailable'
    | 'source-identity-invalid'
    | 'verification-failed'
}

/** Reference to an immutable verification artifact produced outside the Candidate author. */
export interface VerificationReceiptReference {
  readonly id: string
  readonly path: string
  readonly receiptHash: string
  readonly environmentHash: string
  readonly result: 'pass' | 'fail'
  readonly gitCommit: string
}

/** One Review item as served by the LLM Wiki Review system. */
export interface WikiReviewItem {
  /** Stable review id. */
  readonly id: string
  /** Human-readable review title. */
  readonly title: string
  /** Review category (suggestion/missing-page/...). */
  readonly type: string
  /** Longer explanation of the finding. */
  readonly description?: string
  /** Absolute path of the source that produced this review. */
  readonly sourcePath?: string
  /** Project-relative wiki pages the review touches. */
  readonly affectedPages?: string[]
  /** Actions the user may take to close this review. */
  readonly options?: ReadonlyArray<{ readonly action: string; readonly label: string }>
  /** Whether the review has been resolved. */
  readonly resolved: boolean
  /** Action taken when resolved (Skip / Create Page / …). */
  readonly resolvedAction?: string
  /** Creation timestamp (milliseconds). */
  readonly createdAt?: number
  /** Search queries that motivated the review. */
  readonly searchQueries?: string[]
  /** Advisory items are informational; candidate items control real promotion. */
  readonly reviewKind?: 'advisory' | 'candidate'
  /** Wiki-root-relative candidate path. */
  readonly candidatePath?: string
  /** SHA-256 of the candidate content at proposal time. */
  readonly candidateHash?: string
  /** Verification is required before any action can modify Canonical knowledge. */
  readonly verification?: CandidateVerification
  /** Derived canonical target; absent candidates cannot be promoted automatically. */
  readonly targetPath?: string
  /** Applied canonical or archive path. */
  readonly appliedPath?: string
  /** Resolution timestamp (milliseconds). */
  readonly resolvedAt?: number
}

/** Outcome of one write/create page operation. */
export interface WikiWriteResult {
  /** Project-relative path of the written page. */
  readonly path: string
  readonly ok: boolean
  /** Failure message when ok is false. */
  readonly error?: string
  /** True when compare-and-swap rejected an externally modified page. */
  readonly conflict?: boolean
}

/** One node of the locally built knowledge graph. */
export interface GraphNode {
  readonly id: string
  readonly label: string
  readonly type: string
  readonly path: string
  /** Inbound + outbound wikilink count. */
  readonly linkCount: number
  /** Louvain community id. */
  readonly community: number
}

/** One weighted edge of the knowledge graph. */
export interface GraphEdge {
  readonly source: string
  readonly target: string
  /** 4-signal relevance score between source and target. */
  readonly weight: number
}

/** Summary of one detected community. */
export interface CommunityInfo {
  readonly id: number
  readonly nodeCount: number
  /** Intra-community edge density. */
  readonly cohesion: number
  /** Top nodes by linkCount (labels). */
  readonly topNodes: string[]
}

/** The full knowledge graph: nodes, weighted edges, community stats. */
export interface WikiGraphResult {
  readonly nodes: GraphNode[]
  readonly edges: GraphEdge[]
  readonly communities: CommunityInfo[]
}

/** Ingest outcome: written wiki-relative paths plus non-fatal warnings. */
export interface IngestOutcome {
  readonly written: string[]
  readonly warnings: string[]
  /** Explicit outcome; omitted only by lower-level legacy helpers. */
  readonly status?: 'ok' | 'degraded' | 'error'
  /** Stable machine-readable failure classification. */
  readonly errorCode?: 'invalid-input' | 'timeout' | 'cancelled' | 'ingest-failed'
}

/** One queued ingestion task. */
export interface IngestQueueTask {
  readonly id: number
  /** Source path or URL. */
  readonly input: string
  /** Immutable workspace identity captured when the task was enqueued. */
  readonly projectRoot: string
  readonly wikiRoot: string
  readonly projectGeneration: number
  readonly createdAt: number
  readonly status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  /** Unique execution lease for a running attempt. */
  readonly runId?: string
  /** Time at which the current execution lease started. */
  readonly leaseStartedAt?: number
  /** Durable cancellation tombstone for an admitted task. */
  readonly cancelRequestedAt?: number
  /** Durable terminal outcome timestamp. */
  readonly completedAt?: number
  /** Written wiki-relative paths (done tasks). */
  readonly written?: string[]
  /** Content sha256 at ingest time (done file tasks); dedup guard. */
  readonly ingestedHash?: string
  /** Failure message (error tasks). */
  readonly error?: string
  /** Epoch ms of the last failure (error tasks); used for retry cooldown. */
  readonly failedAt?: number
  /** Non-fatal warnings retained with a successful outcome. */
  readonly warnings?: string[]
}

/** Snapshot of the ingestion queue. */
export interface IngestQueueSnapshot {
  readonly tasks: IngestQueueTask[]
  readonly running: boolean
  readonly cancelled: boolean
}

/** Deep-research outcome. */
export interface ResearchResult {
  readonly written: string[]
  readonly sourceCount: number
  readonly warnings: string[]
}
