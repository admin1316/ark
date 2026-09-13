/**
 * Fork-owned hard-deadline stage executor for the Knowledge Wiki.
 *
 * The release ships no provider for the `knowledgeWikiStageExecutor` seam, so
 * ingest refused every non-cooperative stage and the feature failed 100% of the
 * time. This provider runs each stage inside an owned worker thread: the parent
 * resolves connection facts, the isolate performs the file read or the HTTP
 * call, and cancellation terminates the isolate instead of detaching it.
 * @module @deepseek-ai/dsh-knowledge-wiki/owned-stage-executor
 */
import type { KnowledgeWikiStageExecutor } from './stage-executor.ts';
/** Connection facts the parent resolves before the isolate performs a model call. */
export interface StageConnectionFacts {
    /** OpenAI-compatible chat-completions base URL. */
    baseUrl: string;
    /** Bearer credential for that endpoint; an empty string fails the stage loudly. */
    apiKey: string;
}
/** Optional search endpoint used by the `web-search` stage. */
export interface StageSearchFacts {
    baseUrl?: string;
    apiKey?: string;
}
/** Resolve the facts one stage needs; called in the parent, before the isolate starts. */
export interface OwnedStageExecutorOptions {
    /** Facts for `llm-complete`; absence fails that stage with a precise message. */
    resolveConnection: () => Promise<StageConnectionFacts>;
    /** Optional search facts for `web-search`. */
    search?: StageSearchFacts;
}
/**
 * Build the owned-worker executor the wiki service publishes when no other
 * component provides one.
 * @param options - connection resolvers used by the model-backed stages.
 * @returns an executor whose every stage runs, and dies, inside its own isolate.
 */
export declare function createOwnedStageExecutor(options: OwnedStageExecutorOptions): KnowledgeWikiStageExecutor;
//# sourceMappingURL=owned-stage-executor.d.ts.map