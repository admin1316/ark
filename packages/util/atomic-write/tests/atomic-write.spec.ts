import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFileLock, writeFileAtomic } from '../src/index.ts'

const state = vi.hoisted(() => ({
  lockPermissionFailures: 0,
  releaseLockBeforeProbe: false,
  afterClaim: undefined as (() => Promise<void>) | undefined,
  afterLockWrite: undefined as (() => Promise<void>) | undefined,
  claimFailure: undefined as string | undefined,
  claimRemovalFails: false,
  lockRemovalFails: false,
  lockStatFails: false,
  fixedTempSuffix: false,
  atomicWriteFails: false,
  atomicCleanupFails: false,
}))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: (size: number) => state.fixedTempSuffix ? Buffer.alloc(size) : actual.randomBytes(size),
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (state.atomicWriteFails) {
        vi.spyOn(handle, 'writeFile').mockRejectedValue(Object.assign(new Error('synthetic content failure'), { code: 'EIO' }))
      }
      if (state.atomicCleanupFails) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close()
          throw Object.assign(new Error('synthetic close failure'), { code: 'EBUSY' })
        })
      }
      return handle
    },
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      if (state.lockStatFails && String(args[0]).endsWith('.lock')) {
        throw Object.assign(new Error('synthetic lock identity permission failure'), { code: 'EACCES' })
      }
      return actual.lstat(...args)
    }) as typeof actual.lstat,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (state.atomicCleanupFails && String(args[0]).endsWith('.tmp')) {
        throw Object.assign(new Error('synthetic temp removal failure'), { code: 'EPERM' })
      }
      if (state.claimRemovalFails && String(args[0]).includes('.lock.takeover-')) {
        throw Object.assign(new Error('synthetic claim removal failure'), { code: 'EBUSY' })
      }
      if (state.lockRemovalFails && String(args[0]).endsWith('.lock')) {
        throw Object.assign(new Error('synthetic lock removal failure'), { code: 'EPERM' })
      }
      return actual.rm(...args)
    },
    writeFile: (async (path: unknown, ...rest: never[]) => {
      if (state.claimFailure !== undefined && String(path).includes('.lock.takeover-')) {
        throw Object.assign(new Error('synthetic claim failure'), { code: state.claimFailure })
      }
      if (state.lockPermissionFailures > 0 && String(path).endsWith('.lock')) {
        state.lockPermissionFailures -= 1
        if (state.releaseLockBeforeProbe) await actual.rm(String(path))
        throw Object.assign(new Error('EPERM: injected exclusive-create failure'), { code: 'EPERM' })
      }
      await (actual.writeFile as (path: unknown, ...args: never[]) => Promise<void>)(path, ...rest)
      if (String(path).includes('.lock.takeover-')) await state.afterClaim?.()
      if (String(path).endsWith('.lock')) await state.afterLockWrite?.()
    }) as typeof actual.writeFile,
  }
})

const scratchDirs: string[] = []

afterEach(async () => {
  state.lockPermissionFailures = 0
  state.releaseLockBeforeProbe = false
  state.afterClaim = undefined
  state.afterLockWrite = undefined
  state.claimFailure = undefined
  state.claimRemovalFails = false
  state.lockRemovalFails = false
  state.lockStatFails = false
  state.fixedTempSuffix = false
  state.atomicWriteFails = false
  state.atomicCleanupFails = false
  vi.restoreAllMocks()
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-'))
  scratchDirs.push(dir)
  return dir
}

/** Resolve once the lockfile exists, so contention is measured against a held lock. */
async function waitForLock(lockPath: string): Promise<void> {
  for (;;) {
    try {
      await stat(lockPath)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
}

describe('writeFileAtomic', () => {
  it('creates the file and its parents with exactly the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'nested', 'deep', 'doc.yaml')
    await writeFileAtomic(target, 'a: 1\n', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('a: 1\n')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('replaces existing content and narrows a wider-permission file to the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old', { mode: 0o644 })
    await writeFileAtomic(target, 'new', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('new')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('creates private parent directories when their mode is explicitly required', async () => {
    const dir = await scratch()
    const parent = join(dir, 'private')
    const target = join(parent, 'document')
    await writeFileAtomic(target, 'private content', { mode: 0o600, dirMode: 0o700 })
    expect(await readFile(target, 'utf8')).toBe('private content')
    if (process.platform !== 'win32') expect((await stat(parent)).mode & 0o777).toBe(0o700)
  })

  it('replaces a symlinked target itself without writing through to the referent', async () => {
    const dir = await scratch()
    const victim = join(dir, 'victim')
    await writeFile(victim, 'victim-content')
    const target = join(dir, 'doc.yaml')
    await symlink(victim, target)
    await writeFileAtomic(target, 'replaced', { mode: 0o600 })
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('replaced')
    expect(await readFile(victim, 'utf8')).toBe('victim-content')
  })

  it('leaves no temp sibling and rethrows when the rename fails', async () => {
    const dir = await scratch()
    const target = join(dir, 'occupied')
    await mkdir(target)
    await expect(writeFileAtomic(target, 'content', { mode: 0o600 })).rejects.toThrow()
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it('preserves another writer temp file when exclusive create collides', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    const occupied = `${target}.000000000000.tmp`
    await writeFile(occupied, 'other writer content')
    state.fixedTempSuffix = true
    await expect(writeFileAtomic(target, 'replacement', { mode: 0o600 }))
      .rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(occupied, 'utf8')).toBe('other writer content')
    expect(await readdir(dir)).toEqual(['document.000000000000.tmp'])
  })

  it.each([false, true])('preserves a content failure when cleanup fails=%s', async (cleanupFails) => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(target, 'original')
    state.fixedTempSuffix = true
    state.atomicWriteFails = true
    state.atomicCleanupFails = cleanupFails
    await expect(writeFileAtomic(target, 'replacement', { mode: 0o600 }))
      .rejects.toMatchObject({ code: 'EIO' })
    expect(await readFile(target, 'utf8')).toBe('original')
    expect(await readdir(dir)).toEqual(cleanupFails
      ? ['document', 'document.000000000000.tmp']
      : ['document'])
  })
})

describe('withFileLock', () => {
  const exitedPid = 0x7fffffff

  function probeExitedPid(): void {
    const original = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === exitedPid) throw Object.assign(new Error('synthetic exited holder'), { code: 'ESRCH' })
      return original(pid, signal)
    })
  }

  it('takes over a complete record only when its holder is proven exited', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, `${exitedPid}\n`)
    probeExitedPid()

    await expect(withFileLock(target, async () => readFile(`${target}.lock`, 'utf8'), { waitMs: 0 }))
      .resolves.toBe(`${process.pid}\n`)
    expect(await readdir(dir)).toEqual([])
  })

  it('waits when the existing lock record cannot be read', async () => {
    const target = join(await scratch(), 'document')
    await mkdir(`${target}.lock`)
    await expect(withFileLock(target, async () => {}, { waitMs: 0 })).rejects.toThrow(/timed out/)
    expect((await stat(`${target}.lock`)).isDirectory()).toBe(true)
  })

  it('preserves a contended lock when a claim is refused with EPERM', async () => {
    const target = join(await scratch(), 'document')
    await writeFile(`${target}.lock`, `${exitedPid}\n`)
    probeExitedPid()
    state.claimFailure = 'EPERM'
    await expect(withFileLock(target, async () => {}, { waitMs: 0 })).rejects.toThrow(/timed out/)
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(`${exitedPid}\n`)
  })

  it('surfaces claim I/O failure without running the operation', async () => {
    const target = join(await scratch(), 'document')
    await writeFile(`${target}.lock`, `${exitedPid}\n`)
    probeExitedPid()
    state.claimFailure = 'EIO'
    const operation = vi.fn(async () => {})
    await expect(withFileLock(target, operation)).rejects.toMatchObject({ code: 'EIO' })
    expect(operation).not.toHaveBeenCalled()
  })

  it('waits when the proven exited holder lock cannot be removed', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, `${exitedPid}\n`)
    probeExitedPid()
    state.lockRemovalFails = true
    await expect(withFileLock(target, async () => {}, { waitMs: 0 })).rejects.toThrow(/timed out/)
    expect(await readdir(dir)).toEqual(['document.lock'])
  })

  it('completes acquired work when only the obsolete claim cannot be removed', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, `${exitedPid}\n`)
    probeExitedPid()
    state.claimRemovalFails = true
    await expect(withFileLock(target, async () => 'completed', { waitMs: 0 })).resolves.toBe('completed')
    expect((await readdir(dir)).every(name => name.startsWith('document.lock.takeover-'))).toBe(true)
  })

  it.each(['', '12', 'holder\n', '0\n', '-1\n', '1.5\n', '2147483648\n'])(
    'preserves an incomplete or invalid holder record %j', async (record) => {
      const target = join(await scratch(), 'document')
      await writeFile(`${target}.lock`, record)
      const operation = vi.fn(async () => {})
      await expect(withFileLock(target, operation, { waitMs: 0 })).rejects.toThrow(/timed out/)
      expect(operation).not.toHaveBeenCalled()
      expect(await readFile(`${target}.lock`, 'utf8')).toBe(record)
    },
  )

  it('preserves its own lock even when the runtime probe reports ESRCH', async () => {
    const target = join(await scratch(), 'document')
    await writeFile(`${target}.lock`, `${process.pid}\n`)
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('synthetic process shim'), { code: 'ESRCH' })
    })
    await expect(withFileLock(target, async () => {}, { waitMs: 0 })).rejects.toThrow(/timed out/)
    expect(probe).not.toHaveBeenCalled()
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('preserves a holder whose process probe returns EPERM', async () => {
    const target = join(await scratch(), 'document')
    await writeFile(`${target}.lock`, `${exitedPid}\n`)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('synthetic other-user holder'), { code: 'EPERM' })
    })
    await expect(withFileLock(target, async () => {}, { waitMs: 0 })).rejects.toThrow(/timed out/)
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(`${exitedPid}\n`)
  })

  it('preserves a live successor that replaced the record during takeover', async () => {
    const target = join(await scratch(), 'document')
    await writeFile(`${target}.lock`, `${exitedPid}\n`)
    probeExitedPid()
    state.afterClaim = async () => { await writeFile(`${target}.lock`, `${process.pid}\n`) }

    await expect(withFileLock(target, async () => {}, { waitMs: 0 })).rejects.toThrow(/timed out/)
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('rechecks whether the exited PID was reused before removing its record', async () => {
    const target = join(await scratch(), 'document')
    await writeFile(`${target}.lock`, `${exitedPid}\n`)
    let live = false
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (!live) throw Object.assign(new Error('synthetic exited holder'), { code: 'ESRCH' })
      return true
    })
    state.afterClaim = async () => { live = true }

    await expect(withFileLock(target, async () => {}, { waitMs: 0 })).rejects.toThrow(/timed out/)
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(`${exitedPid}\n`)
  })

  it('fails closed when a takeover claim remains, without deleting either record', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    const record = `${exitedPid}\n`
    const claim = `${target}.lock.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`
    await writeFile(`${target}.lock`, record)
    await writeFile(claim, record)
    probeExitedPid()
    const operation = vi.fn(async () => {})

    await expect(withFileLock(target, operation, { waitMs: 0 })).rejects.toThrow(/timed out/)
    expect(operation).not.toHaveBeenCalled()
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(record)
    expect(await readFile(claim, 'utf8')).toBe(record)
  })

  it('does not release a lock whose owner record was replaced externally', async () => {
    const target = join(await scratch(), 'document')
    await withFileLock(target, async () => { await writeFile(`${target}.lock`, '1\n') })
    expect(await readFile(`${target}.lock`, 'utf8')).toBe('1\n')
  })

  it('does not release a replacement inode even when it repeats the original PID', async () => {
    const target = join(await scratch(), 'document')
    await withFileLock(target, async () => {
      await writeFileAtomic(`${target}.lock`, `${process.pid}\n`, { mode: 0o600 })
    })
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('rejects acquisition if the just-written owner record was replaced externally', async () => {
    const target = join(await scratch(), 'document')
    state.afterLockWrite = async () => {
      state.afterLockWrite = undefined
      await writeFile(`${target}.lock`, '1\n')
    }
    const operation = vi.fn(async () => {})
    await expect(withFileLock(target, operation)).rejects.toThrow(/changed during acquisition/)
    expect(operation).not.toHaveBeenCalled()
    expect(await readFile(`${target}.lock`, 'utf8')).toBe('1\n')
  })

  it('leaves an already removed lock absent when releasing', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await withFileLock(target, async () => { await rm(`${target}.lock`) })
    expect(await readdir(dir)).toEqual([])
  })

  it('reports an identity lookup failure without unlinking an unverified lock', async () => {
    const target = join(await scratch(), 'document')
    await expect(withFileLock(target, async () => { state.lockStatFails = true }))
      .rejects.toMatchObject({ code: 'EACCES' })
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('retries EPERM only when the lock path currently exists', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    const lockPath = `${target}.lock`
    await writeFile(lockPath, 'holder\n')
    const release = setTimeout(() => { void rm(lockPath, { force: true }) }, 50)
    state.lockPermissionFailures = 1
    let called = false

    try {
      await withFileLock(target, async () => { called = true })
    } finally {
      clearTimeout(release)
    }
    expect(called).toBe(true)
  })

  it.each(['win32', 'linux'] as const)('preserves persistent EPERM on %s when no lock path exists', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    const dir = await scratch()
    const operation = vi.fn(async () => {})
    state.lockPermissionFailures = 2

    await expect(withFileLock(join(dir, 'document'), operation)).rejects.toMatchObject({ code: 'EPERM' })
    expect(operation).not.toHaveBeenCalled()
  })

  it('retries one Windows EPERM when the holder releases before the existence probe', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, 'holder\n')
    state.lockPermissionFailures = 1
    state.releaseLockBeforeProbe = true

    await expect(withFileLock(target, async () => 'acquired')).resolves.toBe('acquired')
    expect(await readdir(dir)).toEqual([])
  })

  it('rejects an invalid parent hierarchy before running the operation', async () => {
    const dir = await scratch()
    const parent = join(dir, 'not-a-directory')
    await writeFile(parent, 'occupied')
    let called = false

    await expect(withFileLock(join(parent, 'document'), async () => {
      called = true
    })).rejects.toThrow(/ENOENT|ENOTDIR|not a directory/i)
    expect(called).toBe(false)
  })

  it('waits for the caller-stated limit rather than the protocol default', async () => {
    // An operation whose work includes a network round trip legitimately holds
    // the lock far longer than the render-and-rename the default was sized
    // for. The limit is per call so one such operation cannot fail every other
    // writer of the same file, and a caller that states a short one still
    // fails fast.
    const dir = await scratch()
    const target = join(dir, 'document')
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const holder = withFileLock(target, () => held)
    // The holder owns the lock once its lockfile exists; contending before
    // that would measure nothing.
    await waitForLock(`${target}.lock`)

    // Elapsed time is the assertion that distinguishes a honoured limit from
    // the ignored argument: without it the contender simply waits out the
    // protocol default and fails with the same message.
    const startedAt = Date.now()
    await expect(withFileLock(target, async () => 'impatient', { waitMs: 50 }))
      .rejects.toThrow(/timed out waiting for the writer lock/)
    expect(Date.now() - startedAt).toBeLessThan(1_000)

    const patient = withFileLock(target, async () => 'patient', { waitMs: 10_000 })
    release()
    await holder
    expect(await patient).toBe('patient')
  })
})
