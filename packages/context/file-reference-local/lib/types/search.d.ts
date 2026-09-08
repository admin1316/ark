/**
 * Host-workspace discovery for `@file` completion. The index contains paths
 * only: selected values remain ordinary prompt text and file contents stay
 * behind the model-facing `read` tool.
 *
 * @module @deepseek-ai/dsh-file-reference-local/search
 */
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference';
export { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar';
/** Default maximum file and directory candidates rendered for one query. */
export declare const DEFAULT_FILE_SEARCH_MAX_RESULTS = 20;
/** Default maximum entries retained in one workspace search index. */
export declare const DEFAULT_FILE_SEARCH_MAX_ENTRIES = 10000;
/** Directory basenames omitted from traversal unless the deployment overrides them. */
export declare const DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES: readonly [".git", "node_modules"];
/** Resolved limits and exclusions for one workspace index. */
export interface FileSearchConfig {
    /** Maximum ranked candidates returned for one query. */
    maxResults: number;
    /** Maximum indexed files and directories. */
    maxEntries: number;
    /** Directory basenames never traversed or offered. */
    excludedDirectories: readonly string[];
}
/**
 * Cancellable, reusable fuzzy index rooted at one agent working directory.
 * Directory-scoped queries list live state; bare fuzzy queries share one
 * bounded traversal until the `@` interaction ends or a tool result invalidates it.
 */
export declare class WorkspaceFileSearch {
    private readonly root;
    private readonly config;
    private readonly excludedDirectories;
    private generation;
    private disposed;
    constructor(root: string, config: FileSearchConfig);
    /**
     * Return ranked path candidates for the current token.
     * @param rawQuery - path text following `@` or `@"`.
     * @param signal - cancels this caller's wait without killing an index shared by a newer query.
     * @returns at most `maxResults` deterministic candidates.
     */
    list(rawQuery: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>;
    /** Discard the current index so the next bare query observes a fresh tree. */
    invalidate(): void;
    /** Abort traversal and make later queries return no candidates. */
    dispose(): void;
    private ensureIndex;
    private scanWorkspace;
    private listDirectory;
}
//# sourceMappingURL=search.d.ts.map