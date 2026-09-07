/**
 * Two-stage chain-of-thought ingestion: stage 1 analyzes the source into
 * entities/concepts/findings, stage 2 generates wiki pages as
 * `--- FILE: <path> ---` blocks. The harness LLM runtime supplies both
 * calls; generated pages are sanitized, stamped, canonicalized, merged
 * with any existing candidate page, and written under the project's
 * wiki/_candidates/ingest/ directory. Deterministic fallbacks (candidate
 * log entry, source
 * summary, review items) run after the model blocks.
 * @module @deepseek-ai/dsh-knowledge-wiki/ingest
 */
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { IngestOutcome } from './types.ts';
import { type KnowledgeWikiStageExecutor } from './stage-executor.ts';
/**
 * Stage 1: structured analysis of one source document.
 * @param purpose - the project purpose.md text (may be empty).
 * @param index - the wiki index text (may be empty).
 * @param sourceContent - the source document text.
 * @returns the analysis prompt.
 */
export declare function buildAnalysisPrompt(purpose: string, index: string, sourceContent: string): string;
/** Options for the stage-2 generation prompt. */
export interface GenerationPromptOptions {
    /** The project purpose.md text (may be empty). */
    readonly purpose: string;
    /** The wiki index text (may be empty). */
    readonly index: string;
    /** Original source file name (goes into `sources`). */
    readonly sourceFileName: string;
    /** The source text (language rule input). */
    readonly sourceContent: string;
    /** Stage-1 analysis text. */
    readonly analysis: string;
    /** ISO date string for created/updated/log stamps. */
    readonly today: string;
    /** The project schema.md text (may be empty). */
    readonly schema: string;
    /** The exact wiki-relative summary page path (wiki/sources/<slug>.md). */
    readonly summaryPath: string;
}
/**
 * Stage 2: wiki page generation from the stage-1 analysis.
 * @param options - generation prompt inputs.
 * @returns the generation prompt.
 */
export declare function buildGenerationPrompt(options: GenerationPromptOptions): string;
/** One parsed FILE block. */
export interface ParsedFileBlock {
    readonly path: string;
    readonly content: string;
    readonly closed: boolean;
}
/**
 * Parse `--- FILE: path --- … --- END FILE ---` blocks out of model output.
 * @param text - The text input.
 * @returns The value produced by parse file blocks.
 */
export declare function parseFileBlocks(text: string): ParsedFileBlock[];
/**
 * Collect the visible text of one streamed LLM call. 也供 auto-sediment 的 kind 语义分类复用。
 * @param llm - Runtime streaming a single user message attributed to knowledge-wiki.
 * @param provider - Provider route for the model call.
 * @param model - Exact model id on that provider.
 * @param prompt - Text of the sole user message.
 * @param operation - Stable operation name used in streamed failure diagnostics.
 * @param signal - Optional cancellation passed to the runtime and checked before streaming and at each chunk.
 * @returns Concatenated text-delta content after the stream ends; reasoning and other chunk kinds are omitted.
 * @throws On observed cancellation, stream errors, or an aborted/error finish chunk; partial text is not returned.
 */
export declare function completeText(llm: LlmRuntime, provider: string, model: string, prompt: string, operation?: string, signal?: AbortSignal): Promise<string>;
/**
 * Run the two-stage ingestion for one source file and write the generated
 * pages. Every extraction/model stage runs through the injected owned
 * worker/subprocess executor; this package refuses an in-process fallback.
 * Extraction has a 60-second deadline and each model stage has 120 seconds.
 * Candidate pages/log entries and reviews can be partially written; per-write failures become warnings.
 * @param executor - parent-owned worker/subprocess stage executor.
 * @param provider - LLM provider id (e.g. deepseek-official).
 * @param model - exact model id.
 * @param projectPath - absolute project root.
 * @param sourceRel - project-relative source path (e.g. raw/sources/x.md).
 * @param signal - Cancels executor stages and is checked between reads and before selected writes; no rollback.
 * @returns Written project-relative wiki/_candidates paths and warnings, including caught write-time cancellation.
 * @throws On uncaught cancellation, stage failures/missing text, or source/context read failures.
 */
export declare function ingestSource(executor: KnowledgeWikiStageExecutor | undefined, provider: string, model: string, projectPath: string, sourceRel: string, signal: AbortSignal): Promise<IngestOutcome>;
//# sourceMappingURL=ingest.d.ts.map