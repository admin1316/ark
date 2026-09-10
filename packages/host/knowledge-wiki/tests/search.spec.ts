import { describe, expect, it } from 'vitest'
import { bm25 } from '../src/search.ts'

describe('BM25 aliases', () => {
  it('retrieves an English page through an explicit Chinese alias', () => {
    const hits = bm25([
      { path: 'render.md', title: 'Render-Phase Full Scans', aliases: ['渲染阶段全量扫描'], text: 'Expensive recomputation.' },
      { path: 'other.md', title: 'Other', aliases: [], text: 'Unrelated content.' },
    ], '渲染阶段每次全量扫描为什么影响性能')
    expect(hits[0]?.path).toBe('render.md')
  })
})
