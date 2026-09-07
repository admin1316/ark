import { describe, expect, it } from 'vitest'
import { sourceIdentityForPath, sourceSummaryFileNameFromIdentity, sourceSummarySlugFromIdentity } from '../src/source-slug.ts'

describe('sourceIdentityForPath', () => {
  it('strips the project-root raw/sources prefix', () => {
    expect(sourceIdentityForPath('/Users/hui/ark', '/Users/hui/ark/raw/sources/ark-sessions/a.md')).toBe(
      'ark-sessions/a.md',
    )
  })

  it('strips a bare raw/sources prefix and a mid-path marker', () => {
    expect(sourceIdentityForPath('/p', 'raw/sources/clips/x.md')).toBe('clips/x.md')
    expect(sourceIdentityForPath('/p', '/other/root/raw/sources/y.md')).toBe('y.md')
  })

  it('falls back to the file name outside raw/sources', () => {
    expect(sourceIdentityForPath('/p', '/Users/hui/ark/notes.md')).toBe('notes.md')
  })
})

describe('sourceSummarySlugFromIdentity', () => {
  it('matches the existing corpus page name exactly (contract ground truth)', () => {
    const identity = 'ark-sessions/2026-08-15-你是一名测试质量审计专家。-11cab26a.md'
    expect(sourceSummarySlugFromIdentity(identity)).toBe(
      '12-ark-sessions--32-2026-08-15-你是一名测试质量审计专家-11cab26a--1js7z6u',
    )
    expect(sourceSummaryFileNameFromIdentity(identity)).toBe(
      '12-ark-sessions--32-2026-08-15-你是一名测试质量审计专家-11cab26a--1js7z6u.md',
    )
  })

  it('returns a single-segment identity bare (no hash)', () => {
    expect(sourceSummarySlugFromIdentity('profile.md')).toBe('profile')
  })

  it('NFKC-normalizes and strips non-letter/number characters per segment', () => {
    const slug = sourceSummarySlugFromIdentity('ark-sessions/2026-08-16-你是安全审计专家（Security-Revi-e1df614e.md')
    expect(slug).toContain('--')
    expect(slug).not.toMatch(/[（）]/u)
    expect(slug).toMatch(/^12-ark-sessions--/)
  })

  it('caps the slug at 120 characters and keeps the hash', () => {
    const long = `ark-sessions/${'very-long-descriptive-session-title-'.repeat(6)}-deadbeef.md`
    const slug = sourceSummarySlugFromIdentity(long)
    expect(slug.length).toBeLessThanOrEqual(120)
    expect(slug).toMatch(/--[0-9a-z]+$/u)
  })
})
