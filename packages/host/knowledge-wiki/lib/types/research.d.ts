/**
 * Deep-research pipeline (Ark-native port of LLM Wiki's): one topic →
 * LLM-generated multi-queries → web search through the harness web runtime →
 * a synthesized research candidate written into wiki/_candidates/research/.
 * both query expansion and synthesis; the web seam supplies citeable sources.
 * @module @deepseek-ai/dsh-knowledge-wiki/research
 */
import type { ResearchResult } from './types.ts';
import { type KnowledgeWikiStageExecutor } from './stage-executor.ts';
/**
 * Run the deep-research pipeline for one topic.
 * Query expansion and synthesis each have a 120-second deadline; each search has 60 seconds.
 * Search and page-write failures become warnings; written Candidate pages are not rolled back.
 * @param executor - Parent-owned worker/subprocess executor for model and web-search stages; absence rejects.
 * @param provider - LLM provider id.
 * @param model - exact model id.
 * @param projectPath - absolute project root.
 * @param topic - the research topic.
 * @param signal - Cancels executor stages; the page-write loop does not check it after synthesis completes.
 * @returns Project-relative wiki/_candidates/research paths, unique source URL count, and warnings.
 * @throws If query expansion or synthesis fails, times out, or observes cancellation.
 */
export declare function deepResearch(executor: KnowledgeWikiStageExecutor | undefined, provider: string, model: string, projectPath: string, topic: string, signal: AbortSignal): Promise<ResearchResult>;
//# sourceMappingURL=research.d.ts.map