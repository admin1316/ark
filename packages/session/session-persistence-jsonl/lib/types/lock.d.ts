import type { SessionId } from '@deepseek-ai/dsh-session';
/** Root-level directory reserved for writer locks. */
export declare const LOCK_DIR = ".dsh-locks";
/**
 * Run one physical mutation while holding this root/session writer lock.
 * @param root - The root input.
 * @param id - The id input.
 * @param operation - The operation input.
 * @returns The value produced by with session id lock.
 */
export declare function withSessionIdLock<T>(root: string, id: SessionId, operation: () => Promise<T>): Promise<T>;
/**
 * A dead or malformed lock holder can be reclaimed.
 * @param lockPath - The lock path input.
 * @returns The value produced by is stale session lock.
 */
export declare function isStaleSessionLock(lockPath: string): Promise<boolean>;
//# sourceMappingURL=lock.d.ts.map