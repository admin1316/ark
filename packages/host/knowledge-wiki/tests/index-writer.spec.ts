import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { updateWikiIndexDeterministically } from '../src/index-writer.ts'

const dirs: string[] = []

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kw-index-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('updateWikiIndexDeterministically', () => {
  it('does not turn a non-regular index into an empty skeleton or overwrite its contents', () => {
    const dir = fixture()
    const indexPath = join(dir, 'index.md')
    mkdirSync(indexPath)
    writeFileSync(join(indexPath, 'keep.txt'), 'protected content')

    expect(() => updateWikiIndexDeterministically(indexPath, ['concepts/new.md'])).toThrow()
    expect(readdirSync(dir)).toEqual(['index.md'])
    expect(readdirSync(indexPath)).toEqual(['keep.txt'])
    expect(readFileSync(join(indexPath, 'keep.txt'), 'utf8')).toBe('protected content')
  })

  it('preserves the index when a candidate title path is not a regular file', () => {
    const dir = fixture()
    const indexPath = join(dir, 'index.md')
    const original = '# Wiki Index\n\n## Recently Updated\n- [[concepts/old]] — Old\n'
    writeFileSync(indexPath, original)
    mkdirSync(join(dir, 'concepts', 'unsafe.md'), { recursive: true })

    expect(() => updateWikiIndexDeterministically(indexPath, ['concepts/unsafe.md'])).toThrow()
    expect(read(indexPath)).toBe(original)
    expect(readdirSync(join(dir, 'concepts', 'unsafe.md'))).toEqual([])
  })

  it('inserts new entries at the top of the Recently Updated section', () => {
    const dir = fixture()
    const indexPath = join(dir, 'index.md')
    writeFileSync(indexPath, '# Wiki Index\n\n## Recently Updated\n\n- [[concepts/old]] — Old\n')
    const changed = updateWikiIndexDeterministically(indexPath, ['sources/12-new--abc.md'])
    expect(changed).toBe(true)
    const text = read(indexPath)
    expect(text).toContain('## Recently Updated\n\n- [[sources/12-new--abc]] — 12-new--abc\n- [[concepts/old]] — Old')
  })

  it('reads the page title from frontmatter when available', () => {
    const dir = fixture()
    const indexPath = join(dir, 'index.md')
    writeFileSync(indexPath, '# Wiki Index\n\n## Recently Updated\n')
    mkdirSync(join(dir, 'concepts'), { recursive: true })
    writeFileSync(join(dir, 'concepts', 'x.md'), '---\ntype: concept\ntitle: 概念 X\n---\n')
    updateWikiIndexDeterministically(indexPath, ['concepts/x.md'])
    expect(read(indexPath)).toContain('- [[concepts/x]] — 概念 X')
  })

  it('does not duplicate existing targets', () => {
    const dir = fixture()
    const indexPath = join(dir, 'index.md')
    writeFileSync(indexPath, '# Wiki Index\n\n## Recently Updated\n\n- [[concepts/x]] — X\n')
    const changed = updateWikiIndexDeterministically(indexPath, ['concepts/x.md'])
    expect(changed).toBe(false)
    expect(read(indexPath)).not.toContain('- [[concepts/x]] — X\n- [[concepts/x]]')
  })

  it('preserves malformed link lines without treating them as existing targets', () => {
    const dir = fixture()
    const indexPath = join(dir, 'index.md')
    writeFileSync(indexPath, '# Wiki Index\n\n## Recently Updated\n- [[unterminated\n')
    expect(updateWikiIndexDeterministically(indexPath, ['concepts/new.md'])).toBe(true)
    expect(read(indexPath)).toContain('- [[concepts/new]]')
    expect(read(indexPath)).toContain('- [[unterminated')
  })

  it('appends a new section when missing', () => {
    const dir = fixture()
    const indexPath = join(dir, 'index.md')
    writeFileSync(indexPath, '# Wiki Index\n')
    updateWikiIndexDeterministically(indexPath, ['concepts/y.md'])
    expect(read(indexPath)).toContain('## Recently Updated\n- [[concepts/y]]')
  })

  it('caps the section at 200 entries', () => {
    const dir = fixture()
    const indexPath = join(dir, 'index.md')
    const entries = Array.from({ length: 210 }, (_, i) => `- [[concepts/p${i}]] — P${i}`).join('\n')
    writeFileSync(indexPath, `# Wiki Index\n\n## Recently Updated\n${entries}\n`)
    updateWikiIndexDeterministically(indexPath, ['concepts/new.md'])
    const text = read(indexPath)
    const matches = text.match(/^- \[\[/gmu)
    expect(matches?.length).toBe(200)
    expect(text).toContain('- [[concepts/new]]')
  })
})

function read(path: string): string {
  return readFileSync(path, 'utf8')
}
