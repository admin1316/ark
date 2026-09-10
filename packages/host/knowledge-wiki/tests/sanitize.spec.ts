import { describe, expect, it } from 'vitest'
import {
  sanitizeIngestedFileContent, stampGeneratedFrontmatterDates, stampGeneratedLogDate,
} from '../src/sanitize.ts'

describe('sanitizeIngestedFileContent', () => {
  it('strips an outer code fence wrapping the whole document', () => {
    const input = '```yaml\n---\ntype: concept\n---\n# Body\n```'
    expect(sanitizeIngestedFileContent(input)).toBe('---\ntype: concept\n---\n# Body\n')
  })

  it('strips a fence that closes right after the frontmatter block', () => {
    const input = '```md\n---\ntype: concept\n---\n```\n# Body'
    expect(sanitizeIngestedFileContent(input)).toBe('---\ntype: concept\n---\n# Body')
  })

  it('strips a leading frontmatter: key prefix', () => {
    const input = 'frontmatter:\n---\ntype: concept\n---\n'
    expect(sanitizeIngestedFileContent(input)).toBe('---\ntype: concept\n---\n')
  })

  it('prepends a missing opening fence when fields precede a closing one', () => {
    const input = 'type: concept\ntitle: X\n---\n# Body'
    expect(sanitizeIngestedFileContent(input)).toBe('---\ntype: concept\ntitle: X\n---\n# Body')
  })

  it('leaves a body-level code fence alone', () => {
    const input = '---\ntype: concept\n---\n# Body\n\n```ts\nconst x = 1\n```'
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it('repairs wikilink lists inside frontmatter only', () => {
    const input = '---\ntype: concept\nrelated: [[a]], [[b]]\n---\n\nrelated: [[a]], [[b]]'
    const out = sanitizeIngestedFileContent(input)
    expect(out).toContain('related: ["[[a]]", "[[b]]"]')
    expect(out.split('\n').pop()).toBe('related: [[a]], [[b]]')
  })

  it('leaves an already-clean document untouched', () => {
    const input = '---\ntype: concept\n---\n# Body'
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })
})

describe('stampGeneratedFrontmatterDates', () => {
  it('forces created/updated to the ingest day', () => {
    const input = '---\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-02\n---\n'
    expect(stampGeneratedFrontmatterDates(input, '2026-08-19')).toBe(
      '---\ntype: concept\ncreated: 2026-08-19\nupdated: 2026-08-19\n---\n',
    )
  })

  it('leaves content without frontmatter untouched', () => {
    expect(stampGeneratedFrontmatterDates('# x', '2026-08-19')).toBe('# x')
  })
})

describe('stampGeneratedLogDate', () => {
  it('replaces a wrong date in an existing heading', () => {
    expect(stampGeneratedLogDate('## [2026-01-01] ingest | A\nbody', '2026-08-19')).toBe(
      '## [2026-08-19] ingest | A\nbody',
    )
  })

  it('prepends a date to a bare heading', () => {
    expect(stampGeneratedLogDate('## ingest | A', '2026-08-19')).toBe('## [2026-08-19] ingest | A')
  })

  it('wraps a headingless entry', () => {
    expect(stampGeneratedLogDate('note', '2026-08-19')).toBe('## [2026-08-19] ingest\n\nnote')
  })
})
