import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const faultFsync = vi.hoisted(() => ({ active: false, code: 'EPERM' }))
const directoryFds = vi.hoisted(() => new Set<number>())

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  // Only directory-handle fsyncs fail with EPERM — the exact windows contract.
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args)
      try { if (actual.statSync(String(args[0])).isDirectory()) directoryFds.add(fd) } catch { /* not a stat-able path */ }
      return fd
    },
    closeSync: (fd: number) => {
      directoryFds.delete(fd)
      actual.closeSync(fd)
    },
    fsyncSync: (descriptor: number) => {
      if (faultFsync.active && directoryFds.has(descriptor)) {
        throw Object.assign(new Error(`${faultFsync.code}: operation not permitted, fsync`), { code: faultFsync.code })
      }
      actual.fsyncSync(descriptor)
    },
  }
})

import {
  atomicWriteFile,
  createPrivateFileIfMissing,
  durableUnlinkFile,
} from '../src/filesystem.ts'

const roots: string[] = []
afterEach(() => {
  faultFsync.active = false
  faultFsync.code = 'EPERM'
  directoryFds.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Windows cannot fsync directory handles (EPERM); the durable-write helpers
// must tolerate that specific failure and still publish the bytes, because
// NTFS journals its own metadata. Every helper runs under the injected fault.
describe('durable writes tolerate EPERM directory fsync', () => {
  it('atomicWriteFile publishes the replacement without the directory fsync', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-eperm-'))
    roots.push(root)
    const page = join(root, 'concepts', 'a.md')
    faultFsync.active = true
    atomicWriteFile(page, 'first body')
    faultFsync.active = false
    expect(readFileSync(page, 'utf8')).toBe('first body')
    atomicWriteFile(page, 'second body')
    expect(readFileSync(page, 'utf8')).toBe('second body')
    expect(existsSync(join(root, 'concepts'))).toBe(true)
  })

  it('rethrows non-EPERM fsync failures instead of swallowing them', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-eperm-'))
    roots.push(root)
    const page = join(root, 'concepts', 'eio.md')
    faultFsync.active = true
    faultFsync.code = 'EIO'
    expect(() => {
      atomicWriteFile(page, 'body')
    }).toThrow('EIO: operation not permitted, fsync')
    // The other two durable helpers surface the same non-EPERM failure.
    const ledger = join(root, '_governance', 'log.md')
    expect(() => createPrivateFileIfMissing(ledger, Buffer.from('entry')))
      .toThrow('EIO: operation not permitted, fsync')
    expect(() => {
      durableUnlinkFile(ledger)
    }).toThrow('EIO: operation not permitted, fsync')
    faultFsync.code = 'EPERM'
    faultFsync.code = 'EPERM'
    atomicWriteFile(page, 'body')
    faultFsync.active = false
    expect(readFileSync(page, 'utf8')).toBe('body')
  })

  it('createPrivateFileIfMissing and durableUnlinkFile tolerate the EPERM fsync', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-eperm-'))
    roots.push(root)
    const ledger = join(root, '_governance', 'log.md')
    faultFsync.active = true
    expect(createPrivateFileIfMissing(ledger, Buffer.from('entry'))).toBe(true)
    expect(existsSync(ledger)).toBe(true)
    durableUnlinkFile(ledger)
    expect(existsSync(ledger)).toBe(false)
    faultFsync.active = false
  })
})
