import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildFallbackSourceSummaryPage } from '../src/fallback-summary.ts'
import {
  canonicalizeSourcesField,
  parseFrontmatterArray,
  stampSourcesField,
} from '../src/frontmatter-utils.ts'
import { updateWikiIndexDeterministically } from '../src/index-writer.ts'
import { isOwnedOnlyBySource, mergePageContent } from '../src/merge-page.ts'
import {
  sanitizeIngestedFileContent,
  stampGeneratedFrontmatterDates,
  stampGeneratedLogDate,
} from '../src/sanitize.ts'
import {
  sourceIdentityForPath,
  sourceSummarySlugFromIdentity,
} from '../src/source-slug.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wiki-utils-'))
  roots.push(root)
  return root
}

describe('frontmatter and generated-content edges', () => {
  it('parses quote styles, dangling commas, block lists, and malformed arrays', () => {
    expect(parseFrontmatterArray("['single', \"double,comma\", bare,]")).toEqual([
      'single', 'double,comma', 'bare',
    ])
    expect(parseFrontmatterArray('- one\nignored\n- "two"\n-')).toEqual(['one', 'two'])
    expect(parseFrontmatterArray('[open, list')).toEqual(['open', 'list'])
    expect(parseFrontmatterArray('[]')).toEqual([])
  })

  it('canonicalizes source references and leaves unstamped pages unchanged', () => {
    expect(canonicalizeSourcesField(
      '["raw/sources/a.md", "[[bad]]", "../escape", "a.md", "b.md"]',
      'current.md',
    )).toBe('["a.md", "b.md", "current.md"]')
    expect(stampSourcesField('plain body', 'a.md')).toBe('plain body')
    expect(stampSourcesField('---\ntitle: no sources\n---\nBody', 'a.md'))
      .toBe('---\ntitle: no sources\n---\nBody')
  })

  it('covers every anchored sanitizer refusal and repair form', () => {
    expect(sanitizeIngestedFileContent('```yaml\nnot frontmatter'))
      .toBe('```yaml\nnot frontmatter')
    expect(sanitizeIngestedFileContent('```yaml\n---\ntitle: T\n---\n```\nBody'))
      .toBe('---\ntitle: T\n---\nBody')
    expect(sanitizeIngestedFileContent('   \n\t')).toBe('   \n\t')
    expect(sanitizeIngestedFileContent('unknown: value\n---\nBody'))
      .toBe('unknown: value\n---\nBody')
    expect(sanitizeIngestedFileContent('title: T\n# Body\n---'))
      .toBe('title: T\n# Body\n---')
    expect(sanitizeIngestedFileContent('Body [[link]]')).toBe('Body [[link]]')
    expect(sanitizeIngestedFileContent('---\ntags: [[a]], [[b]]\ntitle: T\n---\nBody [[kept]]'))
      .toContain('tags: ["[[a]]", "[[b]]"]')
  })

  it('stamps dates and every log heading shape', () => {
    expect(stampGeneratedFrontmatterDates('plain', '2026-08-31')).toBe('plain')
    expect(stampGeneratedFrontmatterDates(
      '---\ntitle: T\ncreated: old\nupdated : older\n---\nBody',
      '2026-08-31',
    )).toContain('created: 2026-08-31\nupdated : 2026-08-31')
    expect(stampGeneratedLogDate('## [2020-01-01] ingest | x\nmore', '2026-08-31'))
      .toBe('## [2026-08-31] ingest | x\nmore')
    expect(stampGeneratedLogDate('## ingest | x', '2026-08-31'))
      .toBe('## [2026-08-31] ingest | x')
    expect(stampGeneratedLogDate('plain', '2026-08-31'))
      .toBe('## [2026-08-31] ingest\n\nplain')
  })
})

describe('source identity and re-ingest edges', () => {
  it('uses deterministic fallbacks for empty and punctuation-only identities', () => {
    expect(sourceSummarySlugFromIdentity('')).toBe('source')
    expect(sourceSummarySlugFromIdentity('!!!/???')).toMatch(/^6-source--6-source--/u)
    expect(buildFallbackSourceSummaryPage('/', '2026-08-31')).toContain('# source')
  })

  it('derives identities from rooted, relative, embedded, and unrelated paths', () => {
    expect(sourceIdentityForPath('/project/', '/project/raw/sources/a.md')).toBe('a.md')
    expect(sourceIdentityForPath('/project', 'raw/sources/b.md')).toBe('b.md')
    expect(sourceIdentityForPath('/project', '/other/raw/sources/c.md')).toBe('c.md')
    expect(sourceIdentityForPath('/project', '/other/d.md')).toBe('d.md')
  })

  it('replaces owned pages and conservatively unions shared source provenance', () => {
    const owned = '---\nsources: ["raw/sources/A.md"]\n---\nOld'
    expect(isOwnedOnlyBySource(owned, 'a.md')).toBe(true)
    expect(mergePageContent(owned, 'NEW', 'a.md', '2026-08-31')).toBe('NEW')

    const shared = '---\ntitle: Shared\nsources: a.md, b.md\nupdated: old\n---\nBody'
    const merged = mergePageContent(shared, 'ignored', 'c.md', '2026-08-31')
    expect(merged).toContain('sources: ["a.md", "b.md", "c.md"]')
    expect(merged).toContain('updated: 2026-08-31')
    expect(mergePageContent(merged, 'ignored', 'C.MD', '2026-08-31'))
      .toContain('sources: ["a.md", "b.md", "c.md"]')

    expect(isOwnedOnlyBySource('plain', 'a.md')).toBe(false)
    expect(mergePageContent('plain', 'new', 'a.md', '2026-08-31')).toBe('plain')
    expect(mergePageContent('---\ntitle: none\n---\nBody', 'new', 'a.md', '2026-08-31'))
      .toBe('---\ntitle: none\n---\nBody')
    expect(mergePageContent('---\nsources:\n---\nBody', 'new', 'a.md', '2026-08-31'))
      .toBe('---\nsources:\n---\nBody')
  })
})

describe('deterministic Wiki index edges', () => {
  it('seeds missing and empty indexes and falls back for missing or blank titles', () => {
    const root = fixture()
    const index = join(root, 'index.md')
    mkdirSync(join(root, 'sources'))
    writeFileSync(join(root, 'sources', 'blank.md'), '---\ntitle:   \n---\n', 'utf8')

    expect(updateWikiIndexDeterministically(index, ['sources/missing.md', 'sources/blank.md'])).toBe(true)
    const created = readFileSync(index, 'utf8')
    expect(created).toContain('— missing')
    expect(created).toContain('— blank')

    writeFileSync(index, '', 'utf8')
    expect(updateWikiIndexDeterministically(index, [])).toBe(true)
    expect(readFileSync(index, 'utf8')).toContain('# Wiki Index')
  })

  it('bounds an existing section, skips duplicates, and caps it at 200 entries', () => {
    const root = fixture()
    const index = join(root, 'index.md')
    const entries = Array.from({ length: 200 }, (_, indexValue) => `- [[sources/${indexValue}]] — ${indexValue}`)
    writeFileSync(index, [
      '# Index',
      '## Recently Updated',
      '',
      '- not a link',
      ...entries,
      '### Next section',
      'keep',
    ].join('\n'), 'utf8')

    expect(updateWikiIndexDeterministically(index, ['sources/0.md'])).toBe(false)
    expect(updateWikiIndexDeterministically(index, ['sources/new.md'])).toBe(true)
    const updated = readFileSync(index, 'utf8')
    expect(updated).toContain('- [[sources/new]] — new')
    expect(updated).toContain('### Next section\nkeep')
    expect(updated.match(/^- \[\[sources\//gmu)).toHaveLength(200)
  })
})
