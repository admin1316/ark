import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const faultFsync = vi.hoisted(() => ({ active: false, code: 'EPERM', path: '', filePath: '' }))
const directoryFds = vi.hoisted(() => new Map<number, string>())
const fileFds = vi.hoisted(() => new Map<number, string>())

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args)
      if (actual.fstatSync(fd).isDirectory()) directoryFds.set(fd, String(args[0]))
      else fileFds.set(fd, String(args[0]))
      return fd
    },
    closeSync: (fd: number) => {
      directoryFds.delete(fd)
      fileFds.delete(fd)
      actual.closeSync(fd)
    },
    fsyncSync: (descriptor: number) => {
      if (faultFsync.filePath !== '' && fileFds.get(descriptor) === faultFsync.filePath) {
        throw new Error('injected private-file fsync failure')
      }
      const path = directoryFds.get(descriptor)
      if (faultFsync.active && path !== undefined && (faultFsync.path === '' || faultFsync.path === path)) {
        throw Object.assign(new Error(`${faultFsync.code}: directory fsync failed`), { code: faultFsync.code })
      }
      actual.fsyncSync(descriptor)
    },
  }
})

import {
  atomicWriteFile, createPrivateFileIfMissing, durableUnlinkFile, ensureConfinedDirectory,
} from '../src/filesystem.ts'

const roots: string[] = []
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wiki-directory-sync-')))
  roots.push(root)
  return root
}

afterEach(() => {
  faultFsync.active = false
  faultFsync.code = 'EPERM'
  faultFsync.path = ''
  faultFsync.filePath = ''
  directoryFds.clear()
  fileFds.clear()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Wiki namespace durability failures', () => {
  it('re-syncs an exclusive-create retry without replacing the retained private bytes', () => {
    const root = fixture()
    const path = join(root, 'private.json')
    faultFsync.filePath = path
    expect(() => createPrivateFileIfMissing(path, Buffer.from('original private bytes')))
      .toThrow('injected private-file fsync failure')
    expect(readFileSync(path, 'utf8')).toBe('original private bytes')
    expect(() => createPrivateFileIfMissing(path, Buffer.from('must not replace')))
      .toThrow('injected private-file fsync failure')
    faultFsync.filePath = ''
    expect(createPrivateFileIfMissing(path, Buffer.from('must not replace'))).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('original private bytes')
  })

  it.skipIf(process.platform === 'win32').each(['EPERM', 'EIO', 'ENOSPC'])('rejects POSIX directory fsync %s', (code) => {
    const root = fixture()
    faultFsync.active = true
    faultFsync.code = code
    expect(() => { atomicWriteFile(join(root, 'page.md'), 'bytes') }).toThrow(`${code}: directory fsync failed`)
    expect(() => createPrivateFileIfMissing(join(root, 'private.json'), Buffer.from('bytes')))
      .toThrow(`${code}: directory fsync failed`)
    const removable = join(root, 'delete.md')
    writeFileSync(removable, 'before')
    expect(() => { durableUnlinkFile(removable) }).toThrow(`${code}: directory fsync failed`)
    expect(directoryFds.size).toBe(0)
  })

  it('preserves the explicitly legacy win32 visibility behavior for EPERM only', () => {
    const root = fixture()
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    faultFsync.active = true
    atomicWriteFile(join(root, 'page.md'), 'visible bytes')
    expect(createPrivateFileIfMissing(join(root, 'private.json'), Buffer.from('private'))).toBe(true)
    durableUnlinkFile(join(root, 'private.json'))
    expect(readFileSync(join(root, 'page.md'), 'utf8')).toBe('visible bytes')
    expect(existsSync(join(root, 'private.json'))).toBe(false)
    faultFsync.code = 'EIO'
    expect(() => { atomicWriteFile(join(root, 'other.md'), 'other') }).toThrow('EIO: directory fsync failed')
  })

  it.skipIf(process.platform === 'win32')('retries a visible directory creation barrier before proceeding to its child', () => {
    const root = fixture()
    faultFsync.active = true
    faultFsync.path = root
    expect(() => ensureConfinedDirectory(root, 'new/child')).toThrow('EPERM: directory fsync failed')
    expect(existsSync(join(root, 'new'))).toBe(true)
    expect(existsSync(join(root, 'new/child'))).toBe(false)
    expect(() => ensureConfinedDirectory(root, 'new/child')).toThrow('EPERM: directory fsync failed')
    faultFsync.active = false
    expect(ensureConfinedDirectory(root, 'new/child')).toBe(join(root, 'new/child'))
  })

  it.skipIf(process.platform === 'win32')('does not publish into an unflushed newly created absolute directory chain on retry', () => {
    const root = fixture()
    const page = join(root, 'new', 'child', 'page.md')
    faultFsync.active = true
    faultFsync.path = root
    expect(() => { atomicWriteFile(page, 'bytes') }).toThrow('EPERM: directory fsync failed')
    expect(existsSync(page)).toBe(false)
    expect(() => { atomicWriteFile(page, 'bytes') }).toThrow('EPERM: directory fsync failed')
    expect(existsSync(page)).toBe(false)
    faultFsync.active = false
    atomicWriteFile(page, 'bytes')
    expect(readFileSync(page, 'utf8')).toBe('bytes')
  })

  it.skipIf(process.platform === 'win32')('retains the renamed tombstone when its first namespace barrier fails', () => {
    const root = fixture()
    const page = join(root, 'page.md')
    writeFileSync(page, 'recoverable bytes')
    faultFsync.active = true
    faultFsync.path = root
    expect(() => { durableUnlinkFile(page) }).toThrow('EPERM: directory fsync failed')
    const tombstones = readdirSync(root).filter(name => name.includes('.ark-unlink-'))
    expect(tombstones).toHaveLength(1)
    expect(readFileSync(join(root, tombstones[0]!), 'utf8')).toBe('recoverable bytes')
    expect(existsSync(page)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('re-syncs an already absent entry instead of certifying only visibility', () => {
    const root = fixture()
    const page = join(root, 'absent.md')
    faultFsync.active = true
    faultFsync.path = root
    expect(() => { durableUnlinkFile(page) }).toThrow('EPERM: directory fsync failed')
    faultFsync.active = false
    expect(() => { durableUnlinkFile(page) }).not.toThrow()
  })
})
