import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bm25, cosine, embed, hybridSearch } from '../src/search.ts'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wiki-search-'))
  roots.push(root)
  mkdirSync(join(root, 'concepts'))
  writeFileSync(join(root, 'concepts', 'alpha.md'), `---
title: "Alpha Page"
aliases: ["阿尔法", "first"]
---

alpha body 中文知识
`, 'utf8')
  writeFileSync(join(root, 'concepts', 'fallback.md'), '# fallback\n\nalpha secondary', 'utf8')
  return root
}

describe('BM25 and vector primitives', () => {
  it('handles empty, stopped, missing, title, repeated, English, and Chinese tokens', () => {
    expect(bm25([], 'alpha')).toEqual([])
    expect(bm25([{ path: 'empty', title: '', aliases: [], text: '' }], 'the and')).toEqual([])
    expect(bm25([{ path: 'empty', title: '', aliases: [], text: '' }], 'absent')).toEqual([])

    const pages = [
      { path: 'a', title: 'Alpha alpha', aliases: ['first'], text: 'alpha beta 中' },
      { path: 'b', title: 'Beta', aliases: [], text: 'beta 中文' },
    ]
    expect(bm25(pages, 'alpha absent')[0]?.path).toBe('a')
    expect(bm25(pages, '中').map(hit => hit.path).sort()).toEqual(['a', 'b'])
  })

  it('covers every cosine boundary', () => {
    expect(cosine([1], [1, 2])).toBe(0)
    expect(cosine([], [])).toBe(0)
    expect(cosine([0, 0], [1, 2])).toBe(0)
    expect(cosine([1, 0], [1, 0])).toBe(1)
  })

  it('treats sparse vector slots from an untrusted runtime as zero', () => {
    const left = Array<number>(2)
    const right = Array<number>(2)
    left[0] = 1
    right[0] = 1
    expect(cosine(left, right)).toBe(1)
  })

  it('keeps disabled embedding optional but reports HTTP, schema, and network failures', async () => {
    expect(await embed(['text'], '')).toBeNull()
    expect(await embed([], 'key')).toBeNull()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('no', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [1, 2] }, {}] }), { status: 200 }))
      .mockRejectedValueOnce(new Error('offline'))

    await expect(embed(['a'], 'key')).rejects.toThrow('failed (500)')
    await expect(embed(['a'], 'key')).rejects.toThrow('malformed')
    expect(await embed(['a', 'b'], 'key')).toEqual([[1, 2], []])
    await expect(embed(['a'], 'key')).rejects.toThrow('offline')
    const body = fetchMock.mock.calls[2]?.[1]?.body
    expect(typeof body === 'string' ? (JSON.parse(body) as { input: string[] }).input : undefined)
      .toEqual(['a', 'b'])
  })
})

describe('hybrid Wiki search', () => {
  it('falls back to keyword results when vectors are disabled or incomplete', async () => {
    const root = fixture()
    const keywordOnly = await hybridSearch(root, 'alpha', '', 1)
    expect(keywordOnly).toHaveLength(1)

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 }))
    expect(await hybridSearch(root, 'alpha', 'key', 2)).toEqual(await hybridSearch(root, 'alpha', '', 2))
  })

  it('blends positive, zero, and missing semantic vectors and sorts the result', async () => {
    const root = fixture()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [
        { embedding: [1, 0] },
        { embedding: [1, 0] },
      ] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [
        { embedding: [0, 0] },
        { embedding: [0, 0] },
        { embedding: [0, 0] },
      ] }), { status: 200 }))

    const positive = await hybridSearch(root, 'alpha', 'key', 5)
    expect(positive[0]?.path).toBe('concepts/alpha.md')
    expect(positive.every(hit => Number.isFinite(hit.score))).toBe(true)

    const zero = await hybridSearch(root, 'alpha', 'key', 5)
    expect(zero).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses a zero semantic score for keyword hits beyond the fifteen-page vector window', async () => {
    const root = fixture()
    for (let index = 0; index < 16; index += 1) {
      writeFileSync(join(root, 'concepts', `extra-${index}.md`), `# Extra ${index}\n\nalpha extra ${index}`, 'utf8')
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: Array.from({ length: 16 }, () => ({ embedding: [1, 0] })),
    }), { status: 200 }))

    const results = await hybridSearch(root, 'alpha', 'key', 20)
    expect(results.length).toBeGreaterThan(15)
  })
})
