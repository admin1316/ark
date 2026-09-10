/**
 * Local concept-graph engine for the 万相织鉴 knowledge base.
 *
 * Reads the wiki page tree (project/wiki/**\/*.md), parses frontmatter and
 * [[wikilink]]s, builds the node/edge graph, and runs Louvain community
 * detection — all in-process, with no dependency on the LLM Wiki app.
 * @module @deepseek-ai/dsh-knowledge-wiki/graph
 */
import type { WikiGraphResult } from './types.ts';
/**
 * Extract raw `[[wikilink]]` targets from Markdown body.
 * @param text - Markdown body text.
 * @returns targets in source order.
 */
export declare function extractWikiLinkTargets(text: string): string[];
/**
 * Visit visible Wiki directories and Markdown pages once, with all consumers
 * sharing the same skip, path-normalization, and best-effort I/O boundary.
 * @param wikiRoot - absolute Wiki root.
 * @param visitor - callbacks for visible tree entries.
 */
export declare function visitWikiTree(wikiRoot: string, visitor: {
    readonly onDirectory?: (entry: {
        name: string;
        path: string;
    }) => void;
    readonly onMarkdown?: (entry: {
        name: string;
        path: string;
        fullPath: string;
        size: number;
    }) => void;
}): void;
/**
 * Build the concept graph from the wiki page tree.
 * @param wikiRoot - absolute path of the project wiki directory.
 * @returns the graph (nodes + wikilink edges, Louvain clusters).
 */
export declare function buildGraph(wikiRoot: string): WikiGraphResult;
/**
 * List wiki pages (recursive tree, heavyweight dirs skipped).
 * @param wikiRoot - The wiki root input.
 * @returns The value produced by list pages.
 */
export declare function listPages(wikiRoot: string): Array<{
    name: string;
    path: string;
    isDir: boolean;
    size: number | null;
    children?: unknown[];
}>;
/**
 * Read one wiki page's raw text.
 * @param wikiRoot - The wiki root input.
 * @param relPath - The rel path input.
 * @returns The value produced by read page.
 */
export declare function readPage(wikiRoot: string, relPath: string): string;
//# sourceMappingURL=graph.d.ts.map