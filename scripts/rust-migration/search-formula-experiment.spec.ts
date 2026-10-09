import { describe, expect, it } from 'vitest'
import {
  bm25f,
  bm25Plus,
  formulaExperimentFixture,
  reciprocalRankFusion,
  runFormulaExperiment,
} from './search-formula-experiment.ts'

describe('offline search formula experiment', () => {
  it('keeps BM25F field weighting and BM25+ deterministic', () => {
    const fixture = formulaExperimentFixture()
    const bm25fResults = bm25f(fixture.pages, 'Rust candidate')
    const bm25PlusResults = bm25Plus(fixture.pages, 'Rust candidate')
    expect(bm25fResults[0]?.path).toBe('concepts/rust-runtime.md')
    expect(bm25PlusResults[0]?.path).toBe('concepts/rust-runtime.md')
    expect(bm25fResults.every(result => Number.isFinite(result.score))).toBe(true)
    expect(JSON.stringify(bm25fResults)).toBe(JSON.stringify(bm25f(fixture.pages, 'Rust candidate')))
  })

  it('allows a semantic-only hit to enter RRF', () => {
    const lexical = [{ path: 'lexical.md', score: 2 }]
    const fused = reciprocalRankFusion(lexical, ['semantic-only.md', 'lexical.md'])
    expect(fused.map(result => result.path)).toContain('semantic-only.md')
    expect(fused.every(result => result.score > 0)).toBe(true)
  })

  it('reports deterministic quality metrics for every formula', () => {
    const first = runFormulaExperiment()
    const second = runFormulaExperiment()
    expect(first.mode).toBe('offline-deterministic')
    expect(first.corpusHash).toBe('16014ce2b1c30bab15899efb090b63d6e9b5c0984373312d35a2179def341010')
    expect(first.results.map(result => result.formula)).toEqual(['bm25', 'bm25f', 'bm25+', 'rrf'])
    expect(first).toEqual(second)
    for (const result of first.results) {
      expect(result.metrics.recallAt5).toBeGreaterThanOrEqual(0)
      expect(result.metrics.recallAt5).toBeLessThanOrEqual(1)
      expect(result.metrics.mrr).toBeGreaterThanOrEqual(0)
      expect(result.metrics.mrr).toBeLessThanOrEqual(1)
      expect(result.metrics.ndcgAt5).toBeGreaterThanOrEqual(0)
      expect(result.metrics.ndcgAt5).toBeLessThanOrEqual(1)
    }
  })
})
