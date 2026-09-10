import { describe, expect, it } from 'vitest'
import {
  canonicalizeSourcesField,
  formatFrontmatterArray,
  parseFrontmatterArray,
  parseFrontmatterBlock,
  parseFrontmatterField,
  stampSourcesField,
} from '../src/frontmatter-utils.ts'

describe('frontmatter structural parser', () => {
  it('preserves CRLF slices and accepts a closing fence at EOF', () => {
    expect(parseFrontmatterBlock('---\r\ntitle: X\r\n---')).toEqual({
      prefix: '---\r\n',
      body: 'title: X',
      suffix: '\r\n---',
      rest: '',
      lineBreak: '\r\n',
    })
  })

  it('rejects an unclosed block and malformed field key', () => {
    expect(parseFrontmatterBlock('---\ntitle: X')).toBeNull()
    expect(parseFrontmatterField('bad key: value')).toBeNull()
  })
})

describe('parseFrontmatterArray', () => {
  it('parses quoted items with commas inside quotes', () => {
    expect(parseFrontmatterArray('["a, b", "c"]')).toEqual(['a, b', 'c'])
  })

  it('parses bare unquoted items', () => {
    expect(parseFrontmatterArray('[a, b]')).toEqual(['a', 'b'])
  })

  it('returns [] for empty values', () => {
    expect(parseFrontmatterArray('')).toEqual([])
    expect(parseFrontmatterArray('[]')).toEqual([])
  })

  it('tolerates a missing closing bracket', () => {
    expect(parseFrontmatterArray('["a"')).toEqual(['a'])
  })

  it('parses a YAML block list', () => {
    expect(parseFrontmatterArray('- "a"\n- b')).toEqual(['a', 'b'])
  })
})

describe('formatFrontmatterArray', () => {
  it('serializes quoted inline JSON style', () => {
    expect(formatFrontmatterArray(['a', 'b c'])).toBe('["a", "b c"]')
  })
})

describe('canonicalizeSourcesField', () => {
  it('filters invalid references and force-includes the identity', () => {
    const out = canonicalizeSourcesField('["a.md", "[[wikilink]]", "", "x/../y.md", "b.md"]', 'b.md')
    expect(out).toBe('["a.md", "b.md"]')
  })

  it('strips a raw/sources prefix from references', () => {
    expect(canonicalizeSourcesField('["raw/sources/ark-sessions/a.md"]', 'a.md')).toBe('["ark-sessions/a.md", "a.md"]')
  })

  it('dedupes while preserving order', () => {
    expect(canonicalizeSourcesField('["a.md", "a.md", "b.md"]', 'b.md')).toBe('["a.md", "b.md"]')
  })

  it('keeps a block-list input shape', () => {
    expect(canonicalizeSourcesField('- "a.md"\n- b.md', 'b.md')).toBe('["a.md", "b.md"]')
  })

  it('does not synthesize an empty source identity', () => {
    expect(canonicalizeSourcesField('[]', '')).toBe('[]')
    expect(canonicalizeSourcesField('[""]', '  ')).toBe('[]')
  })
})

describe('stampSourcesField', () => {
  const page = `---
type: concept
title: X
sources: ["raw/sources/old.md"]
---\n# Body`

  it('rewrites the sources line to canonical form', () => {
    const stamped = stampSourcesField(page, 'new.md')
    expect(stamped).toContain('sources: ["old.md", "new.md"]')
    expect(stamped).not.toContain('raw/sources/old.md')
  })

  it('leaves a page without frontmatter untouched', () => {
    expect(stampSourcesField('# no fm', 'a.md')).toBe('# no fm')
  })
})
