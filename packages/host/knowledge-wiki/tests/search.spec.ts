import { describe, expect, it } from 'vitest'
import { bm25, bm25FromKnowledgeSearchIndex, createKnowledgeSearchIndex } from '../src/search.ts'

describe('BM25 aliases', () => {
  it('retrieves an English page through an explicit Chinese alias', () => {
    const hits = bm25([
      { path: 'render.md', title: 'Render-Phase Full Scans', aliases: ['渲染阶段全量扫描'], text: 'Expensive recomputation.' },
      { path: 'other.md', title: 'Other', aliases: [], text: 'Unrelated content.' },
    ], '渲染阶段每次全量扫描为什么影响性能')
    expect(hits[0]?.path).toBe('render.md')
  })

  it('keeps prepared-index scores identical to the one-query path', () => {
    const pages = [
      { path: 'policy.md', title: 'Verified retention policy', aliases: ['记忆复用规则'], text: 'Keep verified evidence and expire stale claims.' },
      { path: 'review.md', title: 'Independent review', aliases: [], text: 'Check corrected claims against primary sources.' },
      { path: 'notes.md', title: 'Unrelated notes', aliases: [], text: 'A small scratchpad.' },
    ]
    const index = createKnowledgeSearchIndex(pages)

    for (const query of ['verified evidence retention', '记忆复用规则', 'corrected claims']) {
      expect(bm25FromKnowledgeSearchIndex(index, query)).toEqual(bm25(pages, query))
    }
  })
})
