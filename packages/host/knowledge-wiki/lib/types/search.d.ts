/**
 * Local hybrid search for the 万相织鉴 knowledge base: BM25 keyword scoring
 * over wiki pages, plus optional semantic vectors from the DashScope
 * embedding API. Runs fully in-process — no LLM Wiki app dependency.
 * @module @deepseek-ai/dsh-knowledge-wiki/search
 */
/** One indexed page. */
interface IndexedPage {
    readonly path: string;
    readonly title: string;
    readonly aliases: string[];
    readonly text: string;
}
/**
 * BM25 keyword scores over the page corpus.
 * @param pages - The pages input.
 * @param query - The query input.
 * @returns The value produced by bm25.
 */
export declare function bm25(pages: IndexedPage[], query: string): Array<{
    path: string;
    score: number;
}>;
/**
 * DashScope-compatible embedding for semantic search.
 * @param texts - input texts.
 * @param apiKey - DashScope API key (empty disables vector search).
 * @returns vectors aligned with texts, or null when unavailable.
 */
export declare function embed(texts: string[], apiKey: string): Promise<number[][] | null>;
/**
 * Cosine similarity between two vectors.
 * @param a - The a input.
 * @param b - The b input.
 * @returns The value produced by cosine.
 */
export declare function cosine(a: number[], b: number[]): number;
/**
 * Hybrid search: BM25 scores blended with vector similarity when available.
 * @param wikiRoot - The wiki root input.
 * @param query - The query input.
 * @param apiKey - The api key input.
 * @param topK - The top k input.
 * @returns The value produced by hybrid search.
 */
export declare function hybridSearch(wikiRoot: string, query: string, apiKey: string, topK: number): Promise<Array<{
    path: string;
    score: number;
}>>;
export {};
//# sourceMappingURL=search.d.ts.map