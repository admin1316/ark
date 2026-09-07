import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendReviews, parseReviewBlocks, resolveAdvisoryReviews } from '../src/reviews.ts'

const dirs: string[] = []

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kw-reviews-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseReviewBlocks', () => {
  it('parses a complete block with description, PAGES and SEARCH', () => {
    const text = [
      '--- FILE: wiki/x.md ---',
      '---',
      'type: concept',
      '---',
      '--- END FILE ---',
      '---REVIEW: suggestion | 输出语言归因---',
      'description: 需要更多会话内容佐证。',
      'PAGES: wiki/queries/输出语言.md, wiki/queries/归因.md',
      'SEARCH: 输出语言 提示词, 多语言 归因',
      '---END REVIEW---',
    ].join('\n')
    const reviews = parseReviewBlocks(text)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      type: 'suggestion',
      title: '输出语言归因',
      description: '需要更多会话内容佐证。',
      affectedPages: ['wiki/queries/输出语言.md', 'wiki/queries/归因.md'],
      searchQueries: ['输出语言 提示词', '多语言 归因'],
    })
  })

  it('discards a block without a closer', () => {
    expect(parseReviewBlocks('---REVIEW: suggestion | X---\ndescription: d\n')).toEqual([])
  })

  it('parses block-list PAGES items', () => {
    const text = ['---REVIEW: missing-page | M---', 'PAGES:', '- wiki/queries/q.md', '---END REVIEW---'].join('\n')
    const reviews = parseReviewBlocks(text)
    expect(reviews[0]!.affectedPages).toEqual(['wiki/queries/q.md'])
  })

  it('rejects malformed openers and bounds malformed list continuations', () => {
    expect(parseReviewBlocks('---REVIEW: missing suffix')).toEqual([])
    expect(parseReviewBlocks('---REVIEW: no separator ---\n---END REVIEW---')).toEqual([])
    const inline = parseReviewBlocks(
      '---REVIEW: suggestion | Inline---\nPAGES: ["wiki/a.md"]\n---END REVIEW---',
    )
    expect(inline[0]?.affectedPages).toEqual(['wiki/a.md'])
    const malformed = parseReviewBlocks(
      '---REVIEW: suggestion | Malformed---\nPAGES:\nnot-a-list\n---END REVIEW---',
    )
    expect(malformed[0]?.affectedPages).toEqual([])
  })
})

describe('appendReviews', () => {
  it('appends new reviews and dedupes by id on re-append', () => {
    const dir = fixture()
    const reviewFile = join(dir, 'review.json')
    const text = '---REVIEW: suggestion | 标题---\ndescription: d\n---END REVIEW---'
    const reviews = parseReviewBlocks(text)
    expect(appendReviews(reviewFile, '/p/raw/sources/a.md', reviews)).toBe(1)
    expect(appendReviews(reviewFile, '/p/raw/sources/a.md', reviews)).toBe(0)
    const items = JSON.parse(readFileSync(reviewFile, 'utf8')) as Array<{ id: string; resolved: boolean }>
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toMatch(/^review-[0-9a-f]{8}$/u)
    expect(items[0]!.resolved).toBe(false)
  })

  it('merges into an existing app-era review file', () => {
    const dir = fixture()
    const reviewFile = join(dir, 'review.json')
    writeFileSync(reviewFile, JSON.stringify([{ id: 'review-12345678', title: 'old', type: 'suggestion', resolved: true }]))
    const reviews = parseReviewBlocks('---REVIEW: suggestion | 新---\n---END REVIEW---')
    appendReviews(reviewFile, '/p/a.md', reviews)
    const items = JSON.parse(readFileSync(reviewFile, 'utf8')) as unknown[]
    expect(items).toHaveLength(2)
  })

  it('fails loudly without overwriting a malformed review file', () => {
    const dir = fixture()
    const reviewFile = join(dir, 'review.json')
    writeFileSync(reviewFile, '{broken json')
    const reviews = parseReviewBlocks('---REVIEW: suggestion | 新---\n---END REVIEW---')
    expect(() => appendReviews(reviewFile, '/p/a.md', reviews)).toThrow(SyntaxError)
    expect(readFileSync(reviewFile, 'utf8')).toBe('{broken json')
  })

  it('is a no-op for empty reviews and never touches the file', () => {
    const dir = fixture()
    const reviewFile = join(dir, 'review.json')
    expect(appendReviews(reviewFile, '/p/a.md', [])).toBe(0)
    expect(existsSync(reviewFile)).toBe(false)
  })
})

describe('resolveAdvisoryReviews', () => {
  it('owns missing, duplicate, candidate, resolved, unrequested, and pending rows', () => {
    const dir = fixture()
    const reviewFile = join(dir, 'review.json')
    expect(resolveAdvisoryReviews(reviewFile, ['missing'], 'skip')).toBe(0)
    writeFileSync(reviewFile, JSON.stringify([
      { id: 'pending', title: 'P', type: 'suggestion', reviewKind: 'advisory', resolved: false },
      { id: 'resolved', title: 'R', type: 'suggestion', reviewKind: 'advisory', resolved: true },
      { id: 'candidate', title: 'C', type: 'candidate-approval', reviewKind: 'candidate', resolved: false },
      { id: 'unrequested', title: 'U', type: 'suggestion', reviewKind: 'advisory', resolved: false },
      { id: 'pending', title: 'Duplicate P', type: 'suggestion', reviewKind: 'advisory', resolved: false },
    ]))
    expect(resolveAdvisoryReviews(reviewFile, ['pending', 'pending', 'resolved', 'candidate'], 'Skip')).toBe(1)
    expect(resolveAdvisoryReviews(reviewFile, ['pending'], 'Skip')).toBe(0)
    expect(readFileSync(reviewFile, 'utf8')).toContain('"resolvedAction": "Skip"')
    writeFileSync(reviewFile, 'null', 'utf8')
    expect(() => resolveAdvisoryReviews(reviewFile, ['pending'], 'Skip')).toThrow('invalid knowledge review state')
    writeFileSync(reviewFile, JSON.stringify([{}]), 'utf8')
    expect(() => resolveAdvisoryReviews(reviewFile, ['pending'], 'Skip')).toThrow('invalid knowledge review state')
    writeFileSync(reviewFile, JSON.stringify([null]), 'utf8')
    expect(() => resolveAdvisoryReviews(reviewFile, ['pending'], 'Skip')).toThrow('invalid knowledge review state')
  })
})
