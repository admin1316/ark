import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runBenchmark, runFileBackedComparisonSeries } from './benchmark-knowledge-search.ts'
import { bm25 } from '../../packages/host/knowledge-wiki/src/search.ts'
import { createRustKnowledgeSearchRequest, runRustKnowledgeSearchCandidate } from '../../packages/host/knowledge-wiki/src/rust-search-candidate.ts'

describe('knowledge search benchmark scaffold', () => {
  it.skipIf(!existsSync(resolve('rust/knowledge-search-shadow/target/release/knowledge-search-shadow')))(
    'binds real Rust result digests to Node numbers and multibyte path endpoints', async () => {
      const binary = resolve('rust/knowledge-search-shadow/target/release/knowledge-search-shadow')
      const pages = [{ path: '中'.repeat(341) + 'x', title: 'Runtime', aliases: [], text: 'runtime 中' }]
      for (const query of [1, 64, 100, 128, 256].map(count => Array(count).fill('runtime').join(' '))) {
        const request = createRustKnowledgeSearchRequest({
          sessionId: 'real-wire-replay', generation: 1, pages, query, budget: 1,
        })
        const expected = [bm25(pages, query)]
        const result = await runRustKnowledgeSearchCandidate(request, expected, {
          mode: 'enforce', binaryPath: binary, timeoutMs: 5000,
        })
        expect(result.source).toBe('rust')
        expect(result.results).toEqual(expected)
        expect(result.observation).toMatchObject({ status: 'matched', matched: true, exitCode: 0 })
      }
    },
  )

  it('matches current and optimized TypeScript and replays Rust when its binary is built', () => {
    const binary = resolve('rust/knowledge-search-shadow/target/release/knowledge-search-shadow')
    const result = runBenchmark(3, binary) as {
      status: string
      differentialReplay: string
      stopWordCount: number
      implementation: { rust: unknown }
      envelopes: {
        typescriptCold: { indexReuse: boolean }
        typescriptWarm: { indexReuse: boolean }
        rustCold: unknown
        rustWarm: unknown
      }
    }
    expect(result.status).toBe('unknown')
    expect(result.stopWordCount).toBeGreaterThan(200)
    expect(result.envelopes.typescriptCold.indexReuse).toBe(false)
    expect(result.envelopes.typescriptWarm.indexReuse).toBe(true)
    if (existsSync(binary)) {
      expect(result.differentialReplay).toBe('current-optimized-rust-match')
      expect(result.implementation.rust).not.toBeNull()
      expect(result.envelopes.rustWarm).toEqual(expect.objectContaining({ processReuse: true }))
    } else {
      expect(result.differentialReplay).toBe('current-and-optimized-ts-match')
      expect(result.implementation.rust).toBeNull()
      expect(result.envelopes.rustCold).toBeNull()
      expect(result.envelopes.rustWarm).toBeNull()
    }
  })

  it('reproduces the file-backed one-query comparison with the production snapshot cache', async () => {
    const binary = resolve('rust/knowledge-search-shadow/target/release/knowledge-search-shadow')
    const result = await runFileBackedComparisonSeries(1, 2) as {
      status: string
      execution: string
      fixture: { pages: number; queryPerRequest: number; independentRuns: number; iterationsPerRun: number }
      differentialMatches: number
      rustWorkerCleanExits: number
      productionCacheFirstIndexMissMs: number[]
      scenarios: {
        currentTypeScript: { p50: number | null }
        productionCachedTypeScript: { p50: number | null }
        rustIpc: { p50: number | null }
      }
    }
    expect(result.execution).toBe('independent-file-backed-single-query-comparison')
    expect(result.fixture).toMatchObject({ pages: 240, queryPerRequest: 1, independentRuns: 1, iterationsPerRun: 2 })
    expect(result.productionCacheFirstIndexMissMs).toHaveLength(1)
    expect(result.scenarios.currentTypeScript.p50).toEqual(expect.any(Number))
    expect(result.scenarios.productionCachedTypeScript.p50).toEqual(expect.any(Number))
    if (existsSync(binary)) {
      expect(result.status).toBe('bounded-source-comparison-pass')
      expect(result.differentialMatches).toBe(1)
      expect(result.rustWorkerCleanExits).toBe(1)
      expect(result.scenarios.rustIpc.p50).toEqual(expect.any(Number))
    } else {
      expect(result.status).toBe('unknown')
      expect(result.differentialMatches).toBe(0)
      expect(result.scenarios.rustIpc.p50).toBeNull()
    }
  })
})
