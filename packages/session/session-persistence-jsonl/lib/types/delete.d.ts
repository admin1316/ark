import type { SessionId } from '@deepseek-ai/dsh-session';
/** No valid encoded Session id can collide with this raw project-local name. */
export declare const DELETE_TOMBSTONE_DIR = "~delete";
/**
 * Locate one crash-left deterministic tombstone across project directories.
 * @param listProjectDirs - The list project dirs input.
 * @param id - The id input.
 * @returns The value produced by find delete tombstone.
 */
export declare function findDeleteTombstone(listProjectDirs: (signal?: AbortSignal) => Promise<string[]>, id: SessionId): Promise<string | undefined>;
/**
 * Recursively clear one tombstone and durably sync its parent.
 * @param syncDirPosix - The sync dir posix input.
 * @param path - The path input.
 */
export declare function removeDeleteTombstone(syncDirPosix: (dir: string) => Promise<void>, path: string): Promise<void>;
/**
 * Scavenge every crash-left tombstone before accepting storage reads/writes.
 * @param syncDirPosix - The sync dir posix input.
 * @param project - The project input.
 */
export declare function scavengeDeleteTombstones(syncDirPosix: (dir: string) => Promise<void>, project: string): Promise<void>;
//# sourceMappingURL=delete.d.ts.map