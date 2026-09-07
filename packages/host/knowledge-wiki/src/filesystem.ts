/**
 * Confined, crash-safe filesystem primitives shared by Knowledge Wiki.
 * @module @deepseek-ai/dsh-knowledge-wiki/filesystem
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/** Default maximum for one Wiki Markdown page. */
export const MAX_WIKI_PAGE_BYTES = 5 * 1024 * 1024

/**
 * Distinguish an absent optional file from corruption or unsafe I/O.
 * @param error - Caught value to inspect for Node's missing-path error code.
 * @returns True only for a non-null object whose code property is ENOENT.
 */
export function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

/**
 * Return a normalized root-relative path without repairing unsafe input.
 * @param input - Nonempty slash-separated relative path with no empty, dot, or parent segments.
 * @returns Accepted path with its segments preserved.
 * @throws On a leading slash, NUL, backslash, or invalid path segment.
 */
export function normalizeConfinedRelativePath(input: string): string {
  if (input === '' || input.includes('\0') || input.includes('\\') || input.startsWith('/')) {
    throw new Error('invalid confined path')
  }
  const parts = input.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('path traversal is not allowed')
  }
  return parts.join('/')
}

/**
 * Resolve a path and reject any existing symbolic-link ancestor.
 * @param root - Existing ordinary directory used as the confinement root.
 * @param input - Slash-separated path below root, validated without repairing traversal.
 * @param allowMissingLeaf - Whether the unresolved suffix may be absent, including missing parent directories.
 * @returns Absolute target after checking existing components and the nearest ancestor's realpath; creates nothing.
 * @throws On unsafe paths, symlinks, non-directory ancestors, disallowed absence, or other filesystem failures.
 */
export function resolveConfinedPath(root: string, input: string, allowMissingLeaf: boolean): string {
  const rel = normalizeConfinedRelativePath(input)
  const base = resolve(root)
  const target = resolve(base, ...rel.split('/'))
  if (!target.startsWith(`${base}${sep}`)) throw new Error('path escapes configured root')

  const rootStat = lstatSync(base)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('configured root is not an ordinary directory')
  const rootReal = realpathSync(base)
  let cursor = base
  for (const [index, part] of rel.split('/').entries()) {
    cursor = join(cursor, part)
    try {
      const stat = lstatSync(cursor)
      if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${cursor}`)
      if (index < rel.split('/').length - 1 && !stat.isDirectory()) {
        throw new Error(`non-directory path ancestor: ${cursor}`)
      }
    } catch (error) {
      if (!isMissingPathError(error) || !allowMissingLeaf) throw error
      break
    }
  }
  const existingAncestor = nearestExistingAncestor(target)
  const ancestorReal = realpathSync(existingAncestor)
  if (ancestorReal !== rootReal && !ancestorReal.startsWith(`${rootReal}${sep}`)) {
    throw new Error('path realpath escapes configured root')
  }
  return target
}

function nearestExistingAncestor(path: string): string {
  let cursor = path
  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error('no existing path ancestor')
    cursor = parent
  }
  return cursor
}

/**
 * Create a confined directory hierarchy without following symbolic links.
 * @param root - Existing ordinary directory under which each path component is checked.
 * @param input - Slash-separated relative directory path; missing components are created with mode 0700.
 * @returns Absolute directory path after existing and newly created components pass the checks.
 * @throws On invalid paths, symlink/non-directory components, or filesystem failures; earlier creations remain.
 */
export function ensureConfinedDirectory(root: string, input: string): string {
  const rel = normalizeConfinedRelativePath(input)
  const base = resolve(root)
  const rootStat = lstatSync(base)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('configured root is not an ordinary directory')
  let cursor = base
  for (const part of rel.split('/')) {
    cursor = join(cursor, part)
    try {
      const stat = lstatSync(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe directory path: ${cursor}`)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      mkdirSync(cursor, { mode: 0o700 })
      const created = lstatSync(cursor)
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`unsafe created directory: ${cursor}`)
    }
  }
  return cursor
}

function ensureAbsoluteDirectory(path: string): string {
  const absolute = resolve(path)
  mkdirSync(absolute, { recursive: true, mode: 0o700 })
  const stat = lstatSync(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe directory path: ${absolute}`)
  return absolute
}

function assertOrdinaryDestination(path: string): void {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`unsafe file destination: ${path}`)
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
}

function sameFileIdentity(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Read one ordinary file with O_NOFOLLOW and a hard byte ceiling.
 * @param path - File path; the leaf must be an ordinary file with exactly one hard link.
 * @param maxBytes - Maximum byte size checked both before reading and as chunks arrive.
 * @returns Complete bytes after checking file identity, size, modification time, and link count for changes.
 * @throws On unsafe or changed files, excess size, or filesystem failures; the opened descriptor is closed.
 */
export function readRegularFileBounded(path: string, maxBytes: number): Buffer {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`not a unique ordinary file: ${path}`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.nlink !== 1 || !sameFileIdentity(before, stat)) {
      throw new Error(`file identity changed while opening: ${path}`)
    }
    if (stat.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${path}`)
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
      const count = readSync(descriptor, chunk, 0, chunk.length, null)
      if (count === 0) break
      total += count
      if (total > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${path}`)
      chunks.push(chunk.subarray(0, count))
    }
    const afterRead = fstatSync(descriptor)
    const afterPath = lstatSync(path)
    if (!sameFileIdentity(stat, afterRead) || !sameFileIdentity(stat, afterPath)
      || afterRead.size !== stat.size || afterRead.mtimeMs !== stat.mtimeMs || afterPath.nlink !== 1) {
      throw new Error(`file changed while reading: ${path}`)
    }
    return Buffer.concat(chunks, total)
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Read one confined ordinary UTF-8 file.
 * @param root - Existing ordinary Wiki directory used for confinement.
 * @param input - Existing root-relative file path; symlink components are rejected.
 * @param maxBytes - Maximum encoded file bytes, defaulting to MAX_WIKI_PAGE_BYTES.
 * @returns Bounded file bytes decoded as UTF-8.
 * @throws On confinement, file identity, size-limit, or filesystem failures.
 */
export function readConfinedText(root: string, input: string, maxBytes = MAX_WIKI_PAGE_BYTES): string {
  const path = resolveConfinedPath(root, input, false)
  return readRegularFileBounded(path, maxBytes).toString('utf8')
}

/**
 * Atomically replace one file and durably publish both bytes and directory entry.
 * File fsync precedes rename; published identity is checked before the parent directory is fsynced.
 * @param path - Destination, absent or an ordinary single-link file; missing parent directories are created.
 * @param content - UTF-8 text or exact bytes to stage in a sibling temporary file.
 * @param mode - Staged file creation mode, subject to umask; defaults to 0600 and replaces the old file's mode.
 * @throws On unsafe destinations, identity mismatch, or I/O failure; errors after rename may leave new bytes visible.
 */
export function atomicWriteFile(path: string, content: string | Buffer, mode = 0o600): void {
  const parent = ensureAbsoluteDirectory(dirname(path))
  assertOrdinaryDestination(path)
  const temporary = join(parent, `.${basename(path)}.ark-save-${process.pid}-${randomUUID()}`)
  let descriptor: number | undefined
  let stagedIdentity: ReturnType<typeof fstatSync> | undefined
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode)
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
    stagedIdentity = fstatSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    assertOrdinaryDestination(path)
    renameSync(temporary, path)
    const published = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const publishedIdentity = fstatSync(published)
      if (!publishedIdentity.isFile()
        || publishedIdentity.nlink !== 1 || !sameFileIdentity(stagedIdentity, publishedIdentity)) {
        throw new Error(`published file identity mismatch: ${path}`)
      }
    } finally {
      closeSync(published)
    }
    const directory = openSync(parent, constants.O_RDONLY)
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/**
 * Create one private file durably; return false when it already exists.
 * @param path - Destination checked for an ordinary single-link file or absence; missing parents are created.
 * @param content - Bytes written by exclusive creation with mode 0600, subject to umask.
 * @returns True after file and parent-directory fsync; false if exclusive creation reports EEXIST.
 * @throws On an unsafe destination or other I/O failure; a newly created file is not rolled back on write failure.
 */
export function createPrivateFileIfMissing(path: string, content: Buffer): boolean {
  const parent = ensureAbsoluteDirectory(dirname(path))
  assertOrdinaryDestination(path)
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EEXIST') return false
    throw error
  }
  try {
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  const directory = openSync(parent, constants.O_RDONLY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
  return true
}

/**
 * Durably remove one ordinary file without following a symbolic link.
 * The file is renamed to a sibling tombstone and its identity checked before unlink and directory fsync.
 * @param path - Single-link ordinary file to remove; absence at the initial stat or open is a no-op.
 * @throws On an unsafe file, changed identity, or I/O failure; a later failure may leave a tombstone or removed file.
 */
export function durableUnlinkFile(path: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`refusing to unlink non-unique or non-ordinary file: ${path}`)
  }
  const tombstone = join(dirname(path), `.${basename(path)}.ark-unlink-${randomUUID()}`)
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  const expected = fstatSync(descriptor)
  closeSync(descriptor)
  if (!expected.isFile() || expected.nlink !== 1) {
    throw new Error(`refusing to unlink non-unique or non-ordinary file: ${path}`)
  }
  renameSync(path, tombstone)
  const moved = openSync(tombstone, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!sameFileIdentity(expected, fstatSync(moved))) {
      if (!existsSync(path)) renameSync(tombstone, path)
      throw new Error(`file changed before unlink: ${path}`)
    }
  } finally {
    closeSync(moved)
  }
  unlinkSync(tombstone)
  const directory = openSync(dirname(path), constants.O_RDONLY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

/**
 * Read optional UTF-8 text; only ENOENT maps to undefined.
 * @param path - Optional ordinary single-link file to read.
 * @param maxBytes - Maximum encoded bytes, defaulting to MAX_WIKI_PAGE_BYTES.
 * @returns UTF-8 text, or undefined when the bounded read reports a missing path.
 * @throws On other filesystem errors, unsafe/changed files, or excess size.
 */
export function readOptionalText(path: string, maxBytes = MAX_WIKI_PAGE_BYTES): string | undefined {
  try {
    return readRegularFileBounded(path, maxBytes).toString('utf8')
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

/**
 * Parse optional JSON; only absence is converted to the caller's fallback.
 * @param path - Optional ordinary single-link JSON file, bounded by MAX_WIKI_PAGE_BYTES.
 * @param fallback - Value returned unchanged when the read reports ENOENT.
 * @returns Parsed JSON asserted as T without schema validation, or the supplied fallback on absence.
 * @throws On malformed JSON, unsafe/changed or oversized files, and other filesystem errors.
 */
export function readOptionalJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readRegularFileBounded(path, MAX_WIKI_PAGE_BYTES).toString('utf8')) as T
  } catch (error) {
    if (isMissingPathError(error)) return fallback
    throw error
  }
}

/**
 * Stable inode identity for cycle/alias detection.
 * @param path - Entry to stat without following a symbolic-link leaf.
 * @returns Device and inode joined by a colon for the entry observed by lstat.
 * @throws If the entry cannot be statted, including when it is absent.
 */
export function inodeIdentity(path: string): string {
  const stat = lstatSync(path)
  return `${stat.dev}:${stat.ino}`
}

/**
 * Assert an absolute child remains inside a root after normalization.
 * @param root - Root resolved to an absolute path for a lexical comparison.
 * @param child - Child resolved to an absolute path; equality with root is allowed and symlinks are not resolved.
 * @throws If the normalized relative path starts with a parent-directory segment.
 */
export function assertAbsolutePathInside(root: string, child: string): void {
  const rel = relative(resolve(root), resolve(child))
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('path escapes configured root')
}
