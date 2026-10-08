import { describe, expect, it } from 'vitest'
import { compareResults, runDifferentialReplay } from './differential-replay.ts'

describe('Rust knowledge-search shadow', () => {
  it('fails closed when unavailable and verifies the shared corpus when built', () => {
    const result = runDifferentialReplay()
    if (result.status === 'verified') {
      expect(result.mismatches).toEqual([])
      expect(result.rustDigest).toBe(result.tsDigest)
    } else {
      expect(result.status).toBe('unknown')
      expect(result.missingEvidence.length).toBeGreaterThan(0)
    }
  })

  it('rejects even sub-tolerance score drift', () => {
    const expected = [[{ path: 'a.md', score: 1 }]]
    const actual = [[{ path: 'a.md', score: 1 + 1e-13 }]]
    expect(compareResults(expected, actual)).toEqual(['query 0 hit 0 differs'])
  })
})
