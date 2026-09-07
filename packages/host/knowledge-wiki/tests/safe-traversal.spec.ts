import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listPages } from '../src/graph.ts'
import { atomicWriteFile, readRegularFileBounded } from '../src/filesystem.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('no-follow Wiki traversal', () => {
  it('rejects a directory symlink instead of reading an external tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-safe-tree-'))
    const outside = mkdtempSync(join(tmpdir(), 'wiki-safe-tree-outside-'))
    roots.push(root, outside)
    writeFileSync(join(outside, 'secret.md'), '# external')
    symlinkSync(outside, join(root, 'concepts'))
    expect(() => listPages(root)).toThrow(/symbolic links are not allowed/u)
  })

  it('rejects a FIFO rather than blocking or treating it as a page', () => {
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
