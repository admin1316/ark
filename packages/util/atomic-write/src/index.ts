/**
 * Zero-dependency atomic file replacement and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, then renames it over the target, so readers
 * observe either the old or the new complete content and a replaced file ends
 * up with exactly the stated mode. `withFileLock` serializes cross-process
 * writers of one file through a `wx`-created `<file>.lock` sibling, so a
 * read-modify-write cycle can never resurrect a state another writer just
 * replaced; readers stay lock-free because the rename commit is atomic. Locks
 * whose recorded holder process is proven gone can be taken over.
 * @module @deepseek-ai/dsh-atomic-write
 */

import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. Cleanup only applies after exclusive create succeeds, so
 * a collision never removes another writer's file. Later failures attempt
 * cleanup and rethrow the original error. Crash durability (fsync) is out of scope.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): Use a replacement that fsyncs the file
  // and parent directory and preserves owner-only permissions on Windows.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  // A refused create confers no ownership of the existing temp path.
  const handle = await open(temp, 'wx', options.mode)
  try {
    await handle.writeFile(content)
    await handle.close()
    await rename(temp, filename)
  } catch (error) {
    await handle.close().catch((cleanupError: unknown) => { void cleanupError })
    await rm(temp, { force: true }).catch((cleanupError: unknown) => { void cleanupError })
    throw error
  }
}

/** Whether an exclusive create found an existing lock. */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    // Keep the original EPERM authoritative when lock existence is unproven.
    return false
  }
}

/** Whether the holder a `<pid>\n` record names is proven gone: a signal probe finds no such process. */
function holderExited(record: string): boolean {
  // Any other content is being written or was cut short, which proves nothing about its holder.
  if (!/^\d+\n$/.test(record)) return false
  const pid = Number(record.trim())
  // PID 0 addresses the caller's process group, and the probe accepts only positive int32 PIDs.
  if (pid === 0 || pid > 0x7fffffff) return false
  // This process is running; a runtime whose probe cannot see itself must not take over its own lock.
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means the process exists under another user.
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** The lock file's content, or undefined when it cannot be read. */
async function readLockRecord(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockPath, 'utf8')
  } catch (error) {
    // A lock that vanished, or that Windows is still deleting, proves nothing about a holder.
    void error
    return undefined
  }
}

/**
 * Remove the lock when its recorded holder exited. Contenders that read the
 * same record serialize on a claim file named after it. Under the claim, the
 * claimant re-reads the lock and probes its PID again, and removes it only
 * when it still holds that record and that PID is still gone: the record's
 * holder can no longer release it, and no other contender can remove it
 * without the claim, so a removal never deletes a lock another contender
 * acquired after the dead holder's, including one whose holder reused the PID.
 * @returns Whether this call removed the dead holder's lock.
 */
async function takeOverExitedLock(lockPath: string): Promise<boolean> {
  const record = await readLockRecord(lockPath)
  if (record === undefined || !holderExited(record)) return false
  const claim = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`
  try {
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    // Another contender owns the claim for this record, or Windows still deletes the claim it released.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'EPERM') return false
    throw error
  }
  try {
    if (await readLockRecord(lockPath) !== record || !holderExited(record)) return false
    try {
      await rm(lockPath, { force: true })
    } catch (error) {
      // Windows can refuse the removal while other software briefly holds the file; the next attempt retries.
      void error
      return false
    }
    return true
  } finally {
    await rm(claim, { force: true }).catch((error: unknown) => {
      // Retain an undeletable claim. If the old lock also remains, acquisition
      // fails closed until an operator verifies both owners; never infer age.
      void error
    })
  }
}

/**
 * Retry cadence for a contended lock. These stay robustness invariants of the
 * cross-process write protocol rather than deployment tunables: they govern how
 * often a contender asks, which no caller has a reason to vary.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200

/**
 * How long a contender waits when the caller states no limit — sized for the
 * render-and-rename cycle every call site had when this package was written.
 * Expiry fails the contender rather than guessing whether the existing lock
 * still has an owner. How long is *worth* waiting is a property of the
 * operation the lock holder runs, which is why {@link FileLockOptions.waitMs}
 * exists; the value here is the floor for an operation that does file work
 * alone.
 */
const DEFAULT_LOCK_WAIT_MS = 2_000

/** Options for one {@link withFileLock} acquisition. */
export interface FileLockOptions {
  /**
   * Maximum time to wait for the lock, in milliseconds. State one when the
   * holder's operation legitimately runs longer than file work — a credential
   * mutation that refreshes a token performs a network round trip while
   * holding the lock, and leaving the default in place would fail every other
   * writer of the same file for the duration. Waiting is productive: a
   * contender that acquires the lock afterwards re-reads the committed state.
   */
  waitMs?: number
}

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is a `wx`-created sibling (`<filename>.lock`); paired with the
 * rename-based commit of {@link writeFileAtomic}, readers stay lock-free and
 * only writers contend. `EEXIST` is contention directly; an `EPERM` is
 * contention only when a fresh `lstat` confirms the lock path exists, covering
 * Windows exclusive-create behavior. Windows retries one unconfirmed EPERM
 * because the holder can release before the probe; a repeated unconfirmed
 * permission error is rethrown. The lock records its holder's PID. A contender
 * removes the lock and retries at once when no process with that PID exists
 * (`ESRCH`); any other lock, including one whose holder exists under another
 * user (`EPERM`) or whose record is incomplete, is waited for. Contention backs
 * off exponentially and times out after the deadline. A holder whose PID a
 * live process reused keeps its lock until an operator removes it. Takeover
 * proves only that the recorded process exited: an operation that starts other
 * writers must stop them with it or leave its successor a way to find them.
 * PIDs are compared on the contender's host, so writers on other hosts or in
 * other PID namespaces sharing the file are unsupported and could both hold
 * the lock. A takeover claimant that exits before removing the old lock can
 * leave a claim that requires operator recovery; contenders never remove an
 * existing claim. Release checks the held inode and PID record, but those
 * checks and unlink are not an atomic compare-and-unlink against external
 * interference. The parent directory must exist.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @param options - acquisition options; omitted waits {@link DEFAULT_LOCK_WAIT_MS}.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS)
  let delay = LOCK_RETRY_INITIAL_MS
  let retriedUnconfirmedPermissionError = false
  const record = `${process.pid}\n`
  let identity: { dev: number; ino: number }
  for (;;) {
    try {
      await writeFile(lockPath, record, { mode: 0o600, flag: 'wx' })
      identity = await lstat(lockPath)
      if (await readLockRecord(lockPath) !== record) {
        throw new Error(`atomic-write: writer lock changed during acquisition at ${lockPath}`)
      }
      break
    } catch (error) {
      if (!await isLockContention(error, lockPath)) {
        // Windows can release the competing lock between exclusive create and lstat.
        if (process.platform !== 'win32'
          || (error as NodeJS.ErrnoException | null)?.code !== 'EPERM'
          || retriedUnconfirmedPermissionError) throw error
        retriedUnconfirmedPermissionError = true
      } else if (await takeOverExitedLock(lockPath)) continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    let current: Awaited<ReturnType<typeof lstat>> | undefined
    try {
      current = await lstat(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // A cooperating contender cannot replace a live holder. Preserve a lock
    // replaced externally instead of deleting another owner's record. The
    // comparison and unlink are separate filesystem operations, not a CAS.
    if (current?.dev === identity.dev && current.ino === identity.ino
      && await readLockRecord(lockPath) === record) {
      await rm(lockPath, { force: true })
    }
  }
}
