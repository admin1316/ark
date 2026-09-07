import { describe, expect, it } from 'vitest'
import { isOwnedOnlyBySource, mergePageContent } from '../src/merge-page.ts'

const ownedPage = `---
type: concept
title: X
sources: ["ark-sessions/a.md"]
---\n# X body`

const sharedPage = `---
type: concept
title: X
sources: ["ark-sessions/a.md", "ark-sessions/b.md"]
updated: 2026-01-01
---\n# X shared body`

describe('isOwnedOnlyBySource', () => {
  it('is true when every source reference is the same identity', () => {
    expect(isOwnedOnlyBySource(ownedPage, 'ark-sessions/a.md')).toBe(true)
  })

  it('is true across raw/sources-prefixed references', () => {
    const page = '---\ntype: concept\nsources: ["raw/sources/ark-sessions/a.md"]\n---\n'
    expect(isOwnedOnlyBySource(page, 'ark-sessions/a.md')).toBe(true)
  })

  it('is false when another source is referenced', () => {
    expect(isOwnedOnlyBySource(sharedPage, 'ark-sessions/a.md')).toBe(false)
  })

  it('is false when the sources field is missing or empty', () => {
    expect(isOwnedOnlyBySource('---\ntype: concept\n---\n# X', 'ark-sessions/a.md')).toBe(false)
    expect(isOwnedOnlyBySource('# no fm', 'ark-sessions/a.md')).toBe(false)
  })
})

describe('mergePageContent', () => {
  it('replaces an owned-only page in full', () => {
    const fresh = '---\ntype: concept\ntitle: New\nsources: ["ark-sessions/a.md"]\n---\n# New body'
    expect(mergePageContent(ownedPage, fresh, 'ark-sessions/a.md', '2026-08-19')).toBe(fresh)
  })

  it('keeps a shared page body and unions the sources field', () => {
    const fresh = '---\ntype: concept\ntitle: X\nsources: ["ark-sessions/a.md"]\n---\n# fresh body'
    const merged = mergePageContent(sharedPage, fresh, 'ark-sessions/a.md', '2026-08-19')
    expect(merged).toContain('# X shared body')
    expect(merged).toContain('sources: ["ark-sessions/a.md", "ark-sessions/b.md"]')
    expect(merged).toContain('updated: 2026-08-19')
    expect(merged).not.toContain('# fresh body')
  })

  it('leaves a frontmatter-less page untouched', () => {
    expect(mergePageContent('# legacy', '---\ntype: x\n---\n', 'a.md', '2026-08-19')).toBe('# legacy')
  })

  it('leaves a page with empty sources untouched', () => {
    const empty = '---\ntype: concept\nsources: []\n---\n# X'
    expect(mergePageContent(empty, '---\ntype: concept\n---\n# new', 'a.md', '2026-08-19')).toBe(empty)
  })
})
