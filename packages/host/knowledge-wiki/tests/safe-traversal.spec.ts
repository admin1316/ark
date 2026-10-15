import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listPages } from '../src/graph.ts'
import { atomicWriteFile, readRegularFileBounded } from '../src/filesystem.ts'

const roots: string[] = []
const nonRegularEntries = vi.hoisted(() => new Set<string>())
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
    const stat = actual.lstatSync(...args)
    if (stat === undefined || !nonRegularEntries.has(String(args[0]))) return stat
    return Object.assign(Object.create(stat), { isFile: () => false }) as typeof stat
  } }
})

afterEach(() => {
  nonRegularEntries.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('no-follow Wiki traversal', () => {
  it('refuses a special-entry metadata observation without reading or changing its bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-special-entry-'))
    roots.push(root)
    const entry = join(root, 'special.md')
    writeFileSync(entry, 'preserved special-entry bytes')
    // Real files and traversal remain in use; only this leaf's nondeterministic
    // metadata classification is supplied as non-directory/non-regular.
    nonRegularEntries.add(entry)
    expect(() => listPages(root)).toThrow('non-regular Wiki entry is not allowed: special.md')
    expect(readFileSync(entry, 'utf8')).toBe('preserved special-entry bytes')
  })

  it('rejects a directory symlink instead of reading an external tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-safe-tree-'))
    const outside = mkdtempSync(join(tmpdir(), 'wiki-safe-tree-outside-'))
    roots.push(root, outside)
    writeFileSync(join(outside, 'secret.md'), '# external')
    symlinkSync(outside, join(root, 'concepts'))
    expect(() => listPages(root)).toThrow(/symbolic links are not allowed/u)
  })

  it('rejects a FIFO rather than blocking or treating it as a page', () => {
    if (process.platform === 'win32') {
      // The real FIFO syscall has no Windows equivalent. The separate
      // metadata refusal case covers classification without claiming a FIFO.
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'wiki-safe-fifo-'))
    roots.push(root)
    mkdirSync(join(root, 'concepts'))
    execFileSync('/usr/bin/mkfifo', [join(root, 'concepts', 'pipe.md')])
    expect(() => listPages(root)).toThrow(/non-regular Wiki entry/u)
  })

  it('rejects hard-linked Markdown pages', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-safe-hardlink-'))
    roots.push(root)
    mkdirSync(join(root, 'concepts'))
    writeFileSync(join(root, 'concepts', 'one.md'), '# one')
    linkSync(join(root, 'concepts', 'one.md'), join(root, 'concepts', 'two.md'))
    expect(() => listPages(root)).toThrow(/hard-linked Wiki page/u)
    expect(() => readRegularFileBounded(join(root, 'concepts', 'one.md'), 1024))
      .toThrow(/unique ordinary file/u)
    expect(() => { atomicWriteFile(join(root, 'concepts', 'two.md'), '# replacement') })
      .toThrow(/unsafe file destination/u)
  })
})
