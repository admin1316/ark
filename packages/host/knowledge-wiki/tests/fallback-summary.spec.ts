import { describe, expect, it } from 'vitest'
import { buildFallbackSourceSummaryPage, fallbackSummaryRelPath } from '../src/fallback-summary.ts'

describe('fallbackSummaryRelPath', () => {
  it('derives the contract slug path from the identity', () => {
    expect(fallbackSummaryRelPath('ark-sessions/2026-08-15-你是一名测试质量审计专家。-11cab26a.md')).toBe(
      'wiki/sources/12-ark-sessions--32-2026-08-15-你是一名测试质量审计专家-11cab26a--1js7z6u.md',
    )
  })
})

describe('buildFallbackSourceSummaryPage', () => {
  it('emits a source page with the contract frontmatter fields', () => {
    const page = buildFallbackSourceSummaryPage('ark-sessions/a.md', '2026-08-19')
    expect(page).toContain('type: source')
    expect(page).toContain('created: 2026-08-19')
    expect(page).toContain('updated: 2026-08-19')
    expect(page).toContain('sources: ["ark-sessions/a.md"]')
    expect(page).toContain('# a')
    expect(page).toContain('源文件：`ark-sessions/a.md`')
  })
})
