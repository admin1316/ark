/** Signals that a derived wiki snapshot belongs to an older project generation. */
export declare class StaleWikiSnapshotError extends Error {
    constructor(root: string, key: string);
}
/** Per-project memoization with external-edit invalidation. Git/files remain the source of truth. */
export declare class WikiSnapshotStore {
    private readonly debounceMs;
    private readonly maxEntriesPerRoot;
    private readonly caches;
    private readonly generations;
    private readonly watchedRoots;
    constructor(debounceMs?: number, maxEntriesPerRoot?: number);
    /**
     * Resolve or share one derived snapshot value for a project root.
     * @param root - The root input.
     * @param key - The key input.
     * @param load - The load input.
     * @returns The value produced by get.
     */
    get<T>(root: string, key: string, load: () => Promise<T>): Promise<T>;
    /**
     * Invalidate all projections for one project after a write or watcher event.
     * @param root - The root input.
     */
    invalidate(root: string): void;
    /**
     * Current per-root snapshot generation, exposed for deterministic contracts/tests.
     * @param root - The root input.
     * @returns The value produced by current generation.
     */
    currentGeneration(root: string): number;
    /** Close every watcher when the service is disposed. */
    dispose(): void;
    private cacheFor;
    private trim;
    private ensureWatcher;
}
//# sourceMappingURL=snapshot-store.d.ts.map