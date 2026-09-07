import { watch, type FSWatcher } from 'node:fs'

interface WatchedRoot {
  readonly watcher: FSWatcher
  timer: ReturnType<typeof setTimeout> | null
}

/** Signals that a derived wiki snapshot belongs to an older project generation. */
export class StaleWikiSnapshotError extends Error {
  constructor(root: string, key: string) {
    super(`stale Wiki snapshot result: ${root}#${key}`)
    this.name = 'StaleWikiSnapshotError'
  }
}

/** Per-project memoization with external-edit invalidation. Git/files remain the source of truth. */
export class WikiSnapshotStore {
  private readonly caches = new Map<string, Map<string, Promise<unknown>>>()
  private readonly generations = new Map<string, number>()
  private readonly watchedRoots = new Map<string, WatchedRoot>()

  constructor(
    private readonly debounceMs = 200,
    private readonly maxEntriesPerRoot = 64,
  ) {}

  /**
   * Resolve or share one derived snapshot value for a project root.
   * @param root - The root input.
   * @param key - The key input.
   * @param load - The load input.
   * @returns The value produced by get.
   */
  get<T>(root: string, key: string, load: () => Promise<T>): Promise<T> {
    this.ensureWatcher(root)
    const generation = this.currentGeneration(root)
    const cache = this.cacheFor(root)
    const existing = cache.get(key)
    if (existing !== undefined) {
      cache.delete(key)
      cache.set(key, existing)
      return existing as Promise<T>
    }
    const request = Promise.resolve().then(load).then((value) => {
      if (generation !== this.currentGeneration(root)) throw new StaleWikiSnapshotError(root, key)
      return value
    })
    cache.set(key, request)
    this.trim(cache)
    void request.catch(() => {
      if (cache.get(key) === request) cache.delete(key)
    })
    return request
  }

  /**
   * Invalidate all projections for one project after a write or watcher event.
   * @param root - The root input.
   */
  invalidate(root: string): void {
    this.generations.set(root, this.currentGeneration(root) + 1)
    this.caches.delete(root)
  }

  /**
   * Current per-root snapshot generation, exposed for deterministic contracts/tests.
   * @param root - The root input.
   * @returns The value produced by current generation.
   */
  currentGeneration(root: string): number {
    return this.generations.get(root) ?? 0
  }

  /** Close every watcher when the service is disposed. */
  dispose(): void {
    for (const watched of this.watchedRoots.values()) {
      if (watched.timer !== null) clearTimeout(watched.timer)
      watched.watcher.close()
    }
    this.watchedRoots.clear()
    this.caches.clear()
    this.generations.clear()
  }

  private cacheFor(root: string): Map<string, Promise<unknown>> {
    const existing = this.caches.get(root)
    if (existing !== undefined) return existing
    const created = new Map<string, Promise<unknown>>()
    this.caches.set(root, created)
    return created
  }

  private trim(cache: Map<string, Promise<unknown>>): void {
    while (cache.size > this.maxEntriesPerRoot) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) return
      cache.delete(oldest)
    }
  }

  private ensureWatcher(root: string): void {
    if (this.watchedRoots.has(root)) return
    try {
      const watched: WatchedRoot = {
        watcher: watch(root, { recursive: true }, () => {
          if (watched.timer !== null) clearTimeout(watched.timer)
          watched.timer = setTimeout(() => {
            watched.timer = null
            this.invalidate(root)
          }, this.debounceMs)
        }),
        timer: null,
      }
      watched.watcher.on('error', () => {
        if (watched.timer !== null) clearTimeout(watched.timer)
        watched.watcher.close()
        this.watchedRoots.delete(root)
      })
      this.watchedRoots.set(root, watched)
    } catch {
      // Explicit write invalidation remains active when the platform cannot watch recursively.
    }
  }
}
