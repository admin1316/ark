/**
 * Confined, crash-safe filesystem primitives shared by Knowledge Wiki.
 * @module @deepseek-ai/dsh-knowledge-wiki/filesystem
 */
/** Default maximum for one Wiki Markdown page. */
export declare const MAX_WIKI_PAGE_BYTES: number;
/**
 * Distinguish an absent optional file from corruption or unsafe I/O.
 * @param error - Caught value to inspect for Node's missing-path error code.
 * @returns True only for a non-null object whose code property is ENOENT.
 */
export declare function isMissingPathError(error: unknown): boolean;
/**
 * Return a normalized root-relative path without repairing unsafe input.
 * @param input - Nonempty slash-separated relative path with no empty, dot, or parent segments.
 * @returns Accepted path with its segments preserved.
 * @throws On a leading slash, NUL, backslash, or invalid path segment.
 */
export declare function normalizeConfinedRelativePath(input: string): string;
/**
 * Resolve a path and reject any existing symbolic-link ancestor.
 * @param root - Existing ordinary directory used as the confinement root.
 * @param input - Slash-separated path below root, validated without repairing traversal.
 * @param allowMissingLeaf - Whether the unresolved suffix may be absent, including missing parent directories.
 * @returns Absolute target after checking existing components and the nearest ancestor's realpath; creates nothing.
 * @throws On unsafe paths, symlinks, non-directory ancestors, disallowed absence, or other filesystem failures.
 */
export declare function resolveConfinedPath(root: string, input: string, allowMissingLeaf: boolean): string;
/**
 * Create a confined directory hierarchy without following symbolic links.
 * @param root - Existing ordinary directory under which each path component is checked.
 * @param input - Slash-separated relative directory path; missing components are created with mode 0700.
 * @returns Absolute directory path after existing and newly created components pass the checks.
 * @throws On invalid paths, symlink/non-directory components, or filesystem failures; earlier creations remain.
 */
export declare function ensureConfinedDirectory(root: string, input: string): string;
/**
 * Read one ordinary file with O_NOFOLLOW and a hard byte ceiling.
 * @param path - File path; the leaf must be an ordinary file with exactly one hard link.
 * @param maxBytes - Maximum byte size checked both before reading and as chunks arrive.
 * @returns Complete bytes after checking file identity, size, modification time, and link count for changes.
 * @throws On unsafe or changed files, excess size, or filesystem failures; the opened descriptor is closed.
 */
export declare function readRegularFileBounded(path: string, maxBytes: number): Buffer;
/**
 * Read one confined ordinary UTF-8 file.
 * @param root - Existing ordinary Wiki directory used for confinement.
 * @param input - Existing root-relative file path; symlink components are rejected.
 * @param maxBytes - Maximum encoded file bytes, defaulting to MAX_WIKI_PAGE_BYTES.
 * @returns Bounded file bytes decoded as UTF-8.
 * @throws On confinement, file identity, size-limit, or filesystem failures.
 */
export declare function readConfinedText(root: string, input: string, maxBytes?: number): string;
/**
 * Atomically replace one file and durably publish both bytes and directory entry.
 * File fsync precedes rename; published identity is checked before the parent directory is fsynced.
 * @param path - Destination, absent or an ordinary single-link file; missing parent directories are created.
 * @param content - UTF-8 text or exact bytes to stage in a sibling temporary file.
 * @param mode - Staged file creation mode, subject to umask; defaults to 0600 and replaces the old file's mode.
 * @throws On unsafe destinations, identity mismatch, or I/O failure; errors after rename may leave new bytes visible.
 */
export declare function atomicWriteFile(path: string, content: string | Buffer, mode?: number): void;
/**
 * Create one private file durably; return false when it already exists.
 * @param path - Destination checked for an ordinary single-link file or absence; missing parents are created.
 * @param content - Bytes written by exclusive creation with mode 0600, subject to umask.
 * @returns True after file and parent-directory fsync; false if exclusive creation reports EEXIST.
 * @throws On an unsafe destination or other I/O failure; a newly created file is not rolled back on write failure.
 */
export declare function createPrivateFileIfMissing(path: string, content: Buffer): boolean;
/**
 * Durably remove one ordinary file without following a symbolic link.
 * The file is renamed to a sibling tombstone and its identity checked before unlink and directory fsync.
 * @param path - Single-link ordinary file to remove; absence at the initial stat or open is a no-op.
 * @throws On an unsafe file, changed identity, or I/O failure; a later failure may leave a tombstone or removed file.
 */
export declare function durableUnlinkFile(path: string): void;
/**
 * Read optional UTF-8 text; only ENOENT maps to undefined.
 * @param path - Optional ordinary single-link file to read.
 * @param maxBytes - Maximum encoded bytes, defaulting to MAX_WIKI_PAGE_BYTES.
 * @returns UTF-8 text, or undefined when the bounded read reports a missing path.
 * @throws On other filesystem errors, unsafe/changed files, or excess size.
 */
export declare function readOptionalText(path: string, maxBytes?: number): string | undefined;
/**
 * Parse optional JSON; only absence is converted to the caller's fallback.
 * @param path - Optional ordinary single-link JSON file, bounded by MAX_WIKI_PAGE_BYTES.
 * @param fallback - Value returned unchanged when the read reports ENOENT.
 * @returns Parsed JSON asserted as T without schema validation, or the supplied fallback on absence.
 * @throws On malformed JSON, unsafe/changed or oversized files, and other filesystem errors.
 */
export declare function readOptionalJson<T>(path: string, fallback: T): T;
/**
 * Stable inode identity for cycle/alias detection.
 * @param path - Entry to stat without following a symbolic-link leaf.
 * @returns Device and inode joined by a colon for the entry observed by lstat.
 * @throws If the entry cannot be statted, including when it is absent.
 */
export declare function inodeIdentity(path: string): string;
/**
 * Assert an absolute child remains inside a root after normalization.
 * @param root - Root resolved to an absolute path for a lexical comparison.
 * @param child - Child resolved to an absolute path; equality with root is allowed and symlinks are not resolved.
 * @throws If the normalized relative path starts with a parent-directory segment.
 */
export declare function assertAbsolutePathInside(root: string, child: string): void;
//# sourceMappingURL=filesystem.d.ts.map