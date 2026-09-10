import { describe, expect, it } from 'vitest'
import {
  deduplicateCandidateAgainstCanonical,
  mergeCandidateIntoCanonical,
  replaceCanonicalWithCandidate,
} from '../src/canonical-merge.ts'

function page(
  body: string,
  fields: readonly string[] = ['title: Page', 'created: 2025-01-02', 'sources: ["a"]'],
): string {
  return `---\n${fields.join('\n')}\n---\n\n${body}\n`
}

describe('candidate to canonical merge policy', () => {
  it('merges normalized duplicates and preserves canonical creation provenance', () => {
    const canonical = page('# Heading\nSame, body!', [
      'title: Old',
      'created: 2025-01-02',
      'sources: ["a", "shared"]',
      'status: canonical',
      'approved_at: old',
      'approved_by: human',
      'updated: 2025-01-02',
    ])
    const candidate = page('same body', [
      'title: New',
      'sources: ["shared", "b"]',
      'candidate_id: c1',
      'candidate_kind: source',
      'candidate_hash: hash',
      'origin: ingest',
      'resolution_status: pending',
      'review_status: unresolved',
    ])

    const result = mergeCandidateIntoCanonical(canonical, candidate, '2026-08-31T10:20:30Z')

    expect(result.mode).toBe('duplicate')
    expect(result.content).toContain('created: 2025-01-02')
    expect(result.content).toContain('sources: ["a", "shared", "b"]')
    expect(result.content).toContain('approved_at: 2026-08-31T10:20:30Z')
    expect(result.content).not.toContain('candidate_id')
  })

  it('keeps a canonical superset and promotes a candidate superset', () => {
    expect(mergeCandidateIntoCanonical(
      page('alpha beta gamma'),
      page('alpha beta'),
      '2026-08-31',
    )).toMatchObject({ mode: 'canonical-superset' })

    const promoted = mergeCandidateIntoCanonical(
      page('alpha beta', ['title: Canonical', 'created: 2025-01-02']),
      page('alpha beta gamma', ['title: Candidate', 'sources: ["new"]']),
      '2026-08-31',
    )
    expect(promoted.mode).toBe('candidate-superset')
    expect(promoted.content).toContain('title: Candidate')
    expect(promoted.content).toContain('created: 2025-01-02')
  })

  it('rejects malformed, empty, and divergent inputs', () => {
    expect(() => mergeCandidateIntoCanonical('plain', page('body'), '2026-08-31'))
      .toThrow('missing frontmatter')
    expect(() => mergeCandidateIntoCanonical(page('---'), page('body'), '2026-08-31'))
      .toThrow('empty knowledge body')
    expect(() => mergeCandidateIntoCanonical(page('alpha'), page('omega'), '2026-08-31'))
      .toThrow('bodies diverge')
    expect(() => replaceCanonicalWithCandidate(page('alpha'), page(' # !! '), '2026-08-31'))
      .toThrow('empty knowledge body')
  })

  it('supports explicit replacement and provenance-only deduplication', () => {
    const canonical = page('old', ['not a field', 'title: First', 'title: Last'])
    const candidate = page('new', ['title: New', 'sources: ["new"]'])

    const replaced = replaceCanonicalWithCandidate(canonical, candidate, '2026-08-31')
    expect(replaced.mode).toBe('replace')
    expect(replaced.content).toContain('title: New')

    const defaultDedup = deduplicateCandidateAgainstCanonical(canonical, candidate, '2026-08-31')
    expect(defaultDedup.content).toContain('approved_by: governance-agent')
    const humanDedup = deduplicateCandidateAgainstCanonical(
      page('old', ['title: Old']),
      page('new', ['title: New']),
      '2026-08-31',
      'human-reviewer',
    )
    expect(humanDedup.content).toContain('approved_by: human-reviewer')
    expect(humanDedup.content).toContain('sources: []')
  })
})
