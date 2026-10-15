import {
  appendFileSync, existsSync, fstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Operation = 'open' | 'read' | 'write' | 'mkdir' | 'realpath' | 'rename' | 'lstat' | 'stat'
const faults = vi.hoisted(() => ({
  before: undefined as ((operation: Operation, target: unknown) => void) | undefined,
}))

// Interleave real filesystem changes at the I/O boundary, never replace the
// confinement/identity algorithms or fabricate stat structures.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      faults.before?.('lstat', args[0])
      return actual.lstatSync(...args)
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      faults.before?.('stat', args[0])
      return actual.statSync(...args)
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      faults.before?.('open', args[0])
      return actual.openSync(...args)
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      faults.before?.('read', args[0])
      return actual.readSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      faults.before?.('write', args[0])
      actual.writeFileSync(...args)
    },
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      const result = actual.mkdirSync(...args)
      faults.before?.('mkdir', args[0])
      return result
    },
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
      faults.before?.('realpath', args[0])
      return actual.realpathSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      faults.before?.('rename', args[0])
      actual.renameSync(...args)
    },
  }
})

import {
  atomicWriteFile, createPrivateFileIfMissing, durableUnlinkFile,
  ensureConfinedDirectory, isMissingPathError, readRegularFileBounded, resolveConfinedPath,
} from '../src/filesystem.ts'

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wiki-filesystem-race-'))
  roots.push(root)
  return root
}

afterEach(() => {
  faults.before = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Wiki filesystem identity and cleanup under I/O interleavings', () => {
  it.each(['directory', 'file'] as const)('classifies missing children through a real linked %s without changing its target', (kind) => {
    const root = fixture()
    const target = join(root, 'target')
    if (kind === 'directory') mkdirSync(target)
    else writeFileSync(target, 'preserved target')
    const link = join(root, 'link')
    symlinkSync(target, link, kind === 'directory' ? process.platform === 'win32' ? 'junction' : 'dir' : 'file')
    const missing = Object.assign(new Error('Windows-style missing child'), {
      code: 'ENOENT', path: join(link, 'missing.md'),
    })
    expect(isMissingPathError(missing)).toBe(kind === 'directory')
    if (kind === 'directory') expect(readdirSync(target)).toEqual([])
    else expect(readFileSync(target, 'utf8')).toBe('preserved target')
  })

  it('preserves an ancestor inspection error while classifying an absent optional file', () => {
    const root = fixture()
    const parent = join(root, 'missing')
    const denied = Object.assign(new Error('ancestor inspection denied'), { code: 'EACCES' })
    faults.before = (operation, path) => {
      if (operation === 'lstat' && path === parent) throw denied
    }
    const missing = Object.assign(new Error('optional file absent'), { code: 'ENOENT', path: join(parent, 'page.md') })
    let caught: unknown
    try { isMissingPathError(missing) } catch (error: unknown) { caught = error }
    expect(caught).toBe(denied)
    expect(readdirSync(root)).toEqual([])
  })

  it('refuses optional absence when no directory ancestry can be inspected', () => {
    const root = fixture()
    const inspected: unknown[] = []
    faults.before = (operation, path) => {
      if (operation !== 'lstat') return
      inspected.push(path)
      throw Object.assign(new Error('ancestor unavailable'), { code: 'ENOENT' })
    }
    const missing = Object.assign(new Error('optional file absent'), { code: 'ENOENT', path: join(root, 'missing.md') })
    expect(isMissingPathError(missing)).toBe(false)
    expect(inspected).toContain(parse(root).root)
    expect(readdirSync(root)).toEqual([])
  })

  it('rejects a directory replaced with a link between component checks and final realpath', () => {
    const root = fixture()
    const outside = fixture()
    const directory = join(root, 'directory')
    const target = join(directory, 'page.md')
    mkdirSync(directory)
    writeFileSync(target, 'inside')
    writeFileSync(join(outside, 'page.md'), 'outside')
    faults.before = (operation, path) => {
      if (operation !== 'realpath' || path !== target) return
      faults.before = undefined
      renameSync(directory, join(root, 'preserved-directory'))
      symlinkSync(outside, directory)
    }
    expect(() => resolveConfinedPath(root, 'directory/page.md', false)).toThrow('path realpath escapes configured root')
    expect(readFileSync(join(outside, 'page.md'), 'utf8')).toBe('outside')
  })

  it('rechecks a newly created directory before trusting it', () => {
    const root = fixture()
    const target = join(root, 'new-directory')
    faults.before = (operation, path) => {
      if (operation !== 'mkdir' || path !== target) return
      faults.before = undefined
      renameSync(target, join(root, 'preserved-directory'))
      writeFileSync(target, 'concurrent file')
    }
    expect(() => ensureConfinedDirectory(root, 'new-directory')).toThrow('unsafe created directory')
    expect(readFileSync(target, 'utf8')).toBe('concurrent file')
  })

  it.each(['replace', 'grow', 'replace during read'] as const)('rejects a file that changes while reading: %s', (change) => {
    const root = fixture()
    const target = join(root, 'page.md')
    writeFileSync(target, 'first')
    let descriptor: number | undefined
    faults.before = (operation, path) => {
      if (change === 'replace' ? operation !== 'open' || path !== target : operation !== 'read') return
      faults.before = undefined
      if (operation === 'read') descriptor = path as number
      if (change === 'grow') appendFileSync(target, 'more bytes')
      else {
        renameSync(target, join(root, 'preserved.md'))
        writeFileSync(target, 'other')
      }
    }
    expect(() => readRegularFileBounded(target, 8)).toThrow(
      change === 'replace' ? 'file identity changed while opening'
        : change === 'grow' ? 'file exceeds 8 bytes' : 'file changed while reading',
    )
    if (descriptor !== undefined) {
      const leaked = descriptor
      expect(() => fstatSync(leaked)).toThrow('EBADF')
    }
    expect(readFileSync(target, 'utf8')).toBe(change === 'grow' ? 'firstmore bytes' : 'other')
  })

  it('closes and removes the private staging file if writing fails before publication', () => {
    const root = fixture()
    const target = join(root, 'page.md')
    writeFileSync(target, 'original')
    let descriptor: number | undefined
    faults.before = (operation, fd) => {
      if (operation !== 'write' || typeof fd !== 'number') return
      faults.before = undefined
      descriptor = fd
      throw new Error('injected disk write failure')
    }
    expect(() => { atomicWriteFile(target, 'new') }).toThrow('injected disk write failure')
    expect(readFileSync(target, 'utf8')).toBe('original')
    expect(readdirSync(root)).toEqual(['page.md'])
    expect(descriptor).toBeTypeOf('number')
    expect(() => fstatSync(descriptor!)).toThrow('EBADF')
  })

  it('rejects a published destination swapped before its identity check', () => {
    const root = fixture()
    const target = join(root, 'page.md')
    faults.before = (operation, path) => {
      if (operation !== 'open' || path !== target) return
      faults.before = undefined
      renameSync(target, join(root, 'preserved-published.md'))
      writeFileSync(target, 'concurrent replacement')
    }
    expect(() => { atomicWriteFile(target, 'published') }).toThrow('published file identity mismatch')
    expect(readFileSync(join(root, 'preserved-published.md'), 'utf8')).toBe('published')
    expect(readFileSync(target, 'utf8')).toBe('concurrent replacement')
    expect(readdirSync(root).some(name => name.includes('.ark-save-'))).toBe(false)
  })

  it.each([new Error('open denied'), 'untyped open failure', null])('propagates exclusive-create errors %s without claiming creation', (failure) => {
    const target = join(fixture(), 'private.json')
    faults.before = (operation, path) => {
      if (operation !== 'open' || path !== target) return
      faults.before = undefined
      throw failure
    }
    let caught: unknown = Symbol('not thrown')
    try { createPrivateFileIfMissing(target, Buffer.from('must not publish')) } catch (error: unknown) { caught = error }
    expect(caught).toBe(failure)
    expect(existsSync(target)).toBe(false)
  })

  it.each(['removed', 'denied', 'hard-linked'] as const)('revalidates deletion after initial stat: %s', (change) => {
    const root = fixture()
    const target = join(root, 'page.md')
    writeFileSync(target, 'protected')
    faults.before = (operation, path) => {
      if (operation !== 'open' || path !== target) return
      faults.before = undefined
      if (change === 'removed') unlinkSync(target)
      else if (change === 'hard-linked') linkSync(target, join(root, 'alias.md'))
      else throw new Error('deletion open denied')
    }
    if (change === 'removed') expect(() => { durableUnlinkFile(target) }).not.toThrow()
    else {
      expect(() => { durableUnlinkFile(target) }).toThrow(change === 'denied' ? 'deletion open denied' : 'refusing to unlink')
      expect(readFileSync(target, 'utf8')).toBe('protected')
    }
    expect(readdirSync(root).some(name => name.includes('.ark-unlink-'))).toBe(false)
  })

  it.each(['lstat', 'open'] as const)('refuses Windows-style ENOENT beneath an ordinary file at %s', (boundary) => {
    const root = fixture()
    const parent = join(root, 'blocked')
    const target = join(parent, 'page.md')
    if (boundary === 'open') {
      mkdirSync(parent)
      writeFileSync(target, 'removed by the injected concurrent replacement')
    } else writeFileSync(parent, 'preserve ordinary ancestor')
    const missing = Object.assign(new Error('Windows-style missing child'), { code: 'ENOENT', path: target })
    faults.before = (operation, path) => {
      if (operation !== boundary || path !== target) return
      faults.before = undefined
      if (boundary === 'open') {
        rmSync(parent, { recursive: true })
        writeFileSync(parent, 'preserve ordinary ancestor')
      }
      throw missing
    }
    expect(() => { durableUnlinkFile(target) }).toThrow('ENOTDIR')
    expect(readFileSync(parent, 'utf8')).toBe('preserve ordinary ancestor')
    expect(readdirSync(root)).toEqual(['blocked'])
  })

  it('keeps truly absent nested targets idempotent without creating directories', () => {
    const root = fixture()
    expect(() => { durableUnlinkFile(join(root, 'missing', 'nested', 'page.md')) }).not.toThrow()
    expect(readdirSync(root)).toEqual([])
  })

  it('propagates an ancestor inspection denial instead of declaring optional absence', () => {
    const root = fixture()
    const parent = join(root, 'missing')
    const denied = Object.assign(new Error('ancestor inspection denied'), { code: 'EACCES' })
    faults.before = (operation, path) => {
      if (operation !== 'lstat' || path !== parent) return
      faults.before = undefined
      throw denied
    }
    expect(() => { durableUnlinkFile(join(parent, 'page.md')) }).toThrow(denied)
    expect(readdirSync(root)).toEqual([])
  })

  it('bounds missing-ancestor traversal at an unavailable filesystem root', () => {
    const root = fixture()
    const missing = Object.assign(new Error('filesystem root unavailable'), { code: 'ENOENT' })
    faults.before = (operation) => {
      if (operation === 'lstat') throw missing
    }
    expect(() => { durableUnlinkFile(join(root, 'missing', 'page.md')) }).toThrow(missing)
    expect(readdirSync(root)).toEqual([])
  })

  it('propagates directory stat failure after finding an existing ancestor', () => {
    const root = fixture()
    const denied = Object.assign(new Error('directory inspection denied'), { code: 'EACCES' })
    faults.before = (operation, path) => {
      if (operation !== 'stat' || path !== root) return
      faults.before = undefined
      throw denied
    }
    expect(() => { durableUnlinkFile(join(root, 'missing.md')) }).toThrow(denied)
    expect(readdirSync(root)).toEqual([])
  })

  it('preserves intermediate directory-alias resolution for an absent target', () => {
    const root = fixture()
    const directory = fixture()
    const alias = join(root, 'alias')
    symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => { durableUnlinkFile(join(alias, 'missing.md')) }).not.toThrow()
    expect(readdirSync(directory)).toEqual([])
    expect(readdirSync(root)).toEqual(['alias'])
  })

  it.each([false, true])('refuses to unlink a changed inode and restores only an unoccupied path, occupied=%s', (occupied) => {
    const root = fixture()
    const target = join(root, 'page.md')
    writeFileSync(target, 'original')
    faults.before = (operation, path) => {
      if (operation !== 'rename' || path !== target) return
      faults.before = undefined
      renameSync(target, join(root, 'preserved-original.md'))
      writeFileSync(target, 'concurrent replacement')
      if (occupied) faults.before = (next, tombstone) => {
        if (next !== 'open' || typeof tombstone !== 'string' || !tombstone.includes('.ark-unlink-')) return
        faults.before = undefined
        writeFileSync(target, 'new occupant')
      }
    }
    expect(() => { durableUnlinkFile(target) }).toThrow('file changed before unlink')
    expect(readFileSync(join(root, 'preserved-original.md'), 'utf8')).toBe('original')
    expect(readFileSync(target, 'utf8')).toBe(occupied ? 'new occupant' : 'concurrent replacement')
    const tombstones = readdirSync(dirname(target)).filter(name => name.includes('.ark-unlink-'))
    expect(tombstones).toHaveLength(occupied ? 1 : 0)
    if (occupied) expect(readFileSync(join(root, tombstones[0]!), 'utf8')).toBe('concurrent replacement')
  })
})
