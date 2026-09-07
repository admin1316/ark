import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertAbsolutePathInside, atomicWriteFile, createPrivateFileIfMissing, durableUnlinkFile,
  ensureConfinedDirectory, inodeIdentity, normalizeConfinedRelativePath, readConfinedText,
  readOptionalJson, readOptionalText, readRegularFileBounded, resolveConfinedPath,
} from '../src/filesystem.ts'

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wiki-filesystem-contract-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('confined Wiki filesystem contracts', () => {
  it.each(['', '/absolute', 'nul\0name', 'back\\slash', './page', '../page', 'a/../page', 'a//page', 'a/'])
  ('rejects unsafe relative input %j without normalizing it into an accepted path', (input) => {
    expect(() => normalizeConfinedRelativePath(input)).toThrow(/invalid confined path|path traversal/u)
  })

  it('creates only the requested private directories and reads the confined UTF-8 file', () => {
    const root = fixture()
    const dir = ensureConfinedDirectory(root, 'concepts/nested')
    expect(dir).toBe(join(root, 'concepts', 'nested'))
    expect(ensureConfinedDirectory(root, 'concepts/nested')).toBe(dir)
    expect(lstatSync(dir).mode & 0o077).toBe(0)
    writeFileSync(join(dir, 'page.md'), '中文 page')
    expect(normalizeConfinedRelativePath('concepts/nested/page.md')).toBe('concepts/nested/page.md')
    expect(readConfinedText(root, 'concepts/nested/page.md')).toBe('中文 page')
    expect(readConfinedText(root, 'concepts/nested/page.md', Buffer.byteLength('中文 page'))).toBe('中文 page')
    expect(() => readConfinedText(root, 'concepts/nested/page.md', 2)).toThrow('file exceeds 2 bytes')
    const stat = lstatSync(join(dir, 'page.md'))
    expect(inodeIdentity(join(dir, 'page.md'))).toBe(`${stat.dev}:${stat.ino}`)
  })

  it('resolves an allowed absent suffix without creating it, and rejects required absence', () => {
    const root = fixture()
    expect(resolveConfinedPath(root, 'new/nested/page.md', true)).toBe(join(root, 'new/nested/page.md'))
    expect(readdirSync(root)).toEqual([])
    expect(() => resolveConfinedPath(root, 'new/nested/page.md', false)).toThrow('ENOENT')
    expect(() => resolveConfinedPath('/', 'not-read-by-this-lexical-guard', true)).toThrow('path escapes configured root')
  })

  it('rejects file roots and non-directory ancestors without replacing them', () => {
    const root = fixture()
    const file = join(root, 'file')
    writeFileSync(file, 'protected')
    expect(() => resolveConfinedPath(file, 'child', true)).toThrow('configured root is not an ordinary directory')
    expect(() => ensureConfinedDirectory(file, 'child')).toThrow('configured root is not an ordinary directory')
    expect(() => resolveConfinedPath(root, 'file/child', true)).toThrow('non-directory path ancestor')
    expect(() => ensureConfinedDirectory(root, 'file/child')).toThrow('unsafe directory path')
    expect(readFileSync(file, 'utf8')).toBe('protected')
  })

  it('rejects linked directories for both confinement and atomic publication', () => {
    const root = fixture()
    const outside = fixture()
    symlinkSync(outside, join(root, 'linked'))
    expect(() => resolveConfinedPath(root, 'linked/page.md', true)).toThrow('symbolic link is not allowed')
    expect(() => ensureConfinedDirectory(root, 'linked/child')).toThrow('unsafe directory path')
    expect(() => { atomicWriteFile(join(root, 'linked', 'page.md'), 'must not publish') }).toThrow('unsafe directory path')
    expect(readdirSync(outside)).toEqual([])
  })

  it('creates a private file once and never replaces an existing file', () => {
    const root = fixture()
    const file = join(root, 'private', 'state.json')
    expect(createPrivateFileIfMissing(file, Buffer.from('original'))).toBe(true)
    expect(lstatSync(file).mode & 0o077).toBe(0)
    expect(createPrivateFileIfMissing(file, Buffer.from('replacement'))).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('original')
    expect(readdirSync(dirname(file))).toEqual(['state.json'])
  })

  it('publishes complete replacement bytes and removes only the exact ordinary file', () => {
    const root = fixture()
    const file = join(root, 'page.md')
    atomicWriteFile(file, Buffer.from('first'))
    atomicWriteFile(file, 'second')
    expect(readFileSync(file, 'utf8')).toBe('second')
    expect(readdirSync(root)).toEqual(['page.md'])
    durableUnlinkFile(file)
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(root)).toEqual([])
    expect(() => { durableUnlinkFile(file) }).not.toThrow()
  })

  it('refuses directory, hard-link, and invalid-ancestor deletion targets', () => {
    const root = fixture()
    const directory = join(root, 'directory')
    mkdirSync(directory)
    const first = join(root, 'first.md')
    const second = join(root, 'second.md')
    writeFileSync(first, 'preserve both links')
    linkSync(first, second)
    expect(() => { durableUnlinkFile(directory) }).toThrow('refusing to unlink')
    expect(() => { durableUnlinkFile(second) }).toThrow('refusing to unlink')
    expect(() => { durableUnlinkFile(join(first, 'child')) }).toThrow('ENOTDIR')
    expect(readFileSync(first, 'utf8')).toBe('preserve both links')
    expect(readFileSync(second, 'utf8')).toBe('preserve both links')
    expect(readdirSync(root)).toEqual(['directory', 'first.md', 'second.md'])
  })

  it('distinguishes optional absence from corrupt or non-regular data', () => {
    const root = fixture()
    const file = join(root, 'metadata.json')
    const fallback = { absent: true }
    expect(readOptionalText(file)).toBeUndefined()
    expect(readOptionalJson(file, fallback)).toBe(fallback)
    writeFileSync(file, '{bad json')
    expect(readOptionalText(file, 100)).toBe('{bad json')
    expect(() => readOptionalJson(file, fallback)).toThrow(SyntaxError)
    expect(() => readOptionalText(root)).toThrow('not a unique ordinary file')
    expect(() => readRegularFileBounded(file, 2)).toThrow('file exceeds 2 bytes')
    writeFileSync(file, '{"value":1}')
    expect(readOptionalJson(file, fallback)).toEqual({ value: 1 })
  })

  it('allows root equality but rejects both a parent and a sibling prefix', () => {
    const root = fixture()
    expect(() => { assertAbsolutePathInside(root, root) }).not.toThrow()
    expect(() => { assertAbsolutePathInside(root, join(root, 'child')) }).not.toThrow()
    expect(() => { assertAbsolutePathInside(root, dirname(root)) }).toThrow('path escapes configured root')
    expect(() => { assertAbsolutePathInside(root, `${root}-sibling/file`) }).toThrow('path escapes configured root')
  })
})
