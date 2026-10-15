import {
  appendFileSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Operation = 'open' | 'read' | 'write' | 'mkdir' | 'realpath' | 'rename' | 'lstat' | 'stat' | 'fstat'
const faults = vi.hoisted(() => ({
  before: undefined as ((operation: Operation, target: unknown) => void) | undefined,
}))
const preciseMetadata = vi.hoisted(() => new Map<string, { ino?: bigint; mtimeNs?: bigint }>())
const descriptorPaths = vi.hoisted(() => new Map<number, string>())

// Keep I/O and confinement real. Only registered precision fixtures override
// inode or timestamp observations; other faults interleave real filesystem changes.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  function observed<T extends ReturnType<typeof actual.fstatSync>>(stat: T, path: unknown): T {
    const metadata = preciseMetadata.get(String(path))
    if (metadata === undefined) return stat
    const values: { ino?: number | bigint; mtimeNs?: bigint; mtimeMs?: number | bigint } = {}
    if (metadata.ino !== undefined) values.ino = typeof stat.ino === 'bigint' ? metadata.ino : Number(metadata.ino)
    if (metadata.mtimeNs !== undefined) {
      if (typeof stat.ino === 'bigint') { values.mtimeNs = metadata.mtimeNs; values.mtimeMs = metadata.mtimeNs / 1_000_000n }
      else values.mtimeMs = Number(metadata.mtimeNs) / 1_000_000
    }
    return Object.assign(Object.create(stat), values) as T
  }
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      faults.before?.('lstat', args[0])
      const stat = actual.lstatSync(...args)
      return stat === undefined ? stat : observed(stat, args[0])
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      const path = descriptorPaths.get(args[0])
      faults.before?.('fstat', path)
      return observed(actual.fstatSync(...args), path)
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      faults.before?.('stat', args[0])
      return actual.statSync(...args)
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      faults.before?.('open', args[0])
      const descriptor = actual.openSync(...args)
      descriptorPaths.set(descriptor, String(args[0]))
      return descriptor
    },
    closeSync: (descriptor: number) => {
      descriptorPaths.delete(descriptor)
      actual.closeSync(descriptor)
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
  ensureConfinedDirectory, inodeIdentity, readRegularFileBounded, resolveConfinedPath,
} from '../src/filesystem.ts'
import { appendKnowledgeEvent, createKnowledgeEvent, readKnowledgeEventLog, syncKnowledgeEventLog } from '../src/knowledge-governance.ts'

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wiki-filesystem-race-'))
  roots.push(root)
  return root
}

afterEach(() => {
  faults.before = undefined
  preciseMetadata.clear()
  descriptorPaths.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('knowledge journal append after a complete read', () => {
  function journal() {
    const root = fixture()
    const path = join(root, 'events.jsonl')
    const scope = { projectId: 'project-a', visibility: 'project' as const }
    const first = createKnowledgeEvent('knowledge/retrieved', 'claim:a', scope, {})
    appendKnowledgeEvent(path, first)
    const next = createKnowledgeEvent('knowledge/retrieved', 'claim:a', scope, {}, {
      seq: 1, previousEventHash: first.eventHash,
    })
    return { root, path, first, next, before: readFileSync(path, 'utf8') }
  }

  it.each(['symlink', 'hard-link', 'directory'] as const)('rejects an unsafe journal replacement before append: %s', (change) => {
    const value = journal()
    const preserved = join(value.root, 'preserved.jsonl')
    const outside = join(fixture(), 'protected.jsonl')
    writeFileSync(outside, 'outside bytes')
    faults.before = (operation, target) => {
      if (operation !== 'mkdir' || target !== value.root) return
      faults.before = undefined
      if (change === 'hard-link') linkSync(value.path, preserved)
      else {
        renameSync(value.path, preserved)
        if (change === 'symlink') symlinkSync(outside, value.path)
        else mkdirSync(value.path)
      }
    }
    expect(() => { appendKnowledgeEvent(value.path, value.next) }).toThrow('unsafe knowledge event log')
    expect(readFileSync(preserved, 'utf8')).toBe(value.before)
    expect(readFileSync(outside, 'utf8')).toBe('outside bytes')
  })

  it('propagates an append-time inspection denial without modifying the journal', () => {
    const value = journal()
    const denied = Object.assign(new Error('journal inspection denied'), { code: 'EACCES' })
    faults.before = (operation, target) => {
      if (operation !== 'mkdir' || target !== value.root) return
      faults.before = (nextOperation, nextTarget) => {
        if (nextOperation !== 'lstat' || nextTarget !== value.path) return
        faults.before = undefined
        throw denied
      }
    }
    expect(() => { appendKnowledgeEvent(value.path, value.next) }).toThrow(denied)
    expect(readFileSync(value.path, 'utf8')).toBe(value.before)
    expect(readKnowledgeEventLog(value.path)).toEqual([value.first])
  })

  it.each(['linux', 'win32'] as const)('appends and syncs the exact chain under the selected platform flags: %s', (selectedPlatform) => {
    const value = journal()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    // Dispatch is exercised on this host; native kernel enforcement remains
    // the responsibility of each actual CI platform.
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: selectedPlatform })
      appendKnowledgeEvent(value.path, value.next)
      syncKnowledgeEventLog(value.path)
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
    expect(readKnowledgeEventLog(value.path)).toEqual([value.first, value.next])
    expect(readFileSync(value.path, 'utf8')).toBe(`${JSON.stringify(value.first)}\n${JSON.stringify(value.next)}\n`)
  })

  it('refuses an append replacement with a colliding Number inode before changing bytes', () => {
    const value = journal(), largeInode = 9007199254740992n
    preciseMetadata.set(value.path, { ino: largeInode })
    let opens = 0
    faults.before = (operation, path) => {
      if (operation !== 'open' || path !== value.path || ++opens !== 2) return
      faults.before = undefined
      renameSync(value.path, join(value.root, 'preserved.jsonl'))
      writeFileSync(value.path, value.before)
      preciseMetadata.set(value.path, { ino: largeInode + 1n })
    }
    expect(() => { appendKnowledgeEvent(value.path, value.next) }).toThrow('unsafe knowledge event log')
    expect(readFileSync(value.path, 'utf8')).toBe(value.before)
    expect(readKnowledgeEventLog(value.path)).toEqual([value.first])
  })

  it.each(['file', 'parent'] as const)('refuses a colliding Number inode in event-log synchronization: %s', (boundary) => {
    const value = journal(), largeInode = 9007199254740992n
    const target = boundary === 'file' ? value.path : value.root
    preciseMetadata.set(target, { ino: largeInode })
    faults.before = (operation, path) => {
      if (operation !== 'fstat' || path !== target) return
      faults.before = undefined
      preciseMetadata.set(target, { ino: largeInode + 1n })
    }
    expect(() => { syncKnowledgeEventLog(value.path) }).toThrow(boundary === 'file'
      ? 'unsafe knowledge event log' : 'unsafe knowledge event log parent')
    expect(readFileSync(value.path, 'utf8')).toBe(value.before)
    expect(readKnowledgeEventLog(value.path)).toEqual([value.first])
  })
})

describe('Wiki filesystem identity and cleanup under I/O interleavings', () => {
  const largeInode = 9007199254740992n
  it('rejects a real replacement whose large inode rounds to the same Number while opening', () => {
    const root = fixture(), target = join(root, 'page.md'), preserved = join(root, 'preserved.md')
    writeFileSync(target, 'first')
    preciseMetadata.set(target, { ino: largeInode })
    expect(Number(largeInode)).toBe(Number(largeInode + 1n))
    expect(inodeIdentity(target)).toBe(`${lstatSync(target, { bigint: true }).dev}:${largeInode}`)
    faults.before = (operation, path) => {
      if (operation !== 'open' || path !== target) return
      faults.before = undefined
      renameSync(target, preserved)
      writeFileSync(target, 'other')
      preciseMetadata.set(target, { ino: largeInode + 1n })
    }
    expect(() => readRegularFileBounded(target, 8)).toThrow('file identity changed while opening')
    expect(readFileSync(preserved, 'utf8')).toBe('first')
    expect(readFileSync(target, 'utf8')).toBe('other')
  })

  it('rejects a nanosecond modification hidden by Number millisecond precision', () => {
    const target = join(fixture(), 'page.md')
    writeFileSync(target, 'same')
    const nanos = 1_700_000_000_000_000_000n
    expect(Number(nanos) / 1_000_000).toBe(Number(nanos + 1n) / 1_000_000)
    preciseMetadata.set(target, { mtimeNs: nanos })
    faults.before = (operation, descriptor) => {
      if (operation !== 'read' || descriptorPaths.get(descriptor as number) !== target) return
      faults.before = undefined
      preciseMetadata.set(target, { mtimeNs: nanos + 1n })
    }
    expect(() => readRegularFileBounded(target, 8)).toThrow('file changed while reading')
    expect(readFileSync(target, 'utf8')).toBe('same')
  })

  it('refuses an atomic publication whose full staged inode differs', () => {
    const target = join(fixture(), 'page.md')
    faults.before = (operation, path) => {
      if (operation === 'open' && typeof path === 'string' && path.includes('.ark-save-')) {
        preciseMetadata.set(path, { ino: largeInode })
      } else if (operation === 'rename') preciseMetadata.set(target, { ino: largeInode + 1n })
    }
    expect(() => { atomicWriteFile(target, 'published') }).toThrow('published file identity mismatch')
    expect(readFileSync(target, 'utf8')).toBe('published')
    expect(readdirSync(dirname(target))).toEqual(['page.md'])
  })

  it('refuses an unlink tombstone with a colliding Number inode and restores the entry', () => {
    const target = join(fixture(), 'page.md')
    writeFileSync(target, 'preserved')
    preciseMetadata.set(target, { ino: largeInode })
    faults.before = (operation, path) => {
      if (operation === 'open' && typeof path === 'string' && path.includes('.ark-unlink-')) {
        preciseMetadata.set(path, { ino: largeInode + 1n })
      }
    }
    expect(() => { durableUnlinkFile(target) }).toThrow('file changed before unlink')
    expect(readFileSync(target, 'utf8')).toBe('preserved')
    expect(readdirSync(dirname(target))).toEqual(['page.md'])
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

  it('propagates a target inspection denial without unlinking any bytes', () => {
    const root = fixture(), target = join(root, 'preserved.md')
    writeFileSync(target, 'preserved original bytes')
    const denied = Object.assign(new Error('target inspection denied'), { code: 'EACCES' })
    faults.before = (operation, path) => {
      if (operation !== 'lstat' || path !== target) return
      faults.before = undefined
      throw denied
    }
    expect(() => { durableUnlinkFile(target) }).toThrow(denied)
    expect(readFileSync(target, 'utf8')).toBe('preserved original bytes')
    expect(readdirSync(root)).toEqual(['preserved.md'])
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
