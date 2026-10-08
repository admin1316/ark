import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runBenchmark } from './benchmark-knowledge-search.ts'

describe('knowledge search benchmark scaffold', () => {
  it('matches current and optimized TypeScript and replays Rust when its binary is built', () => {
    const binary = resolve('rust/knowledge-search-shadow/target/release/knowledge-search-shadow')
    const result = runBenchmark(3, binary) as {
      status: string
      differentialReplay: string
      stopWordCount: number
      implementation: { rust: unknown }
    }
    expect(result.status).toBe('unknown')
    expect(result.stopWordCount).toBeGreaterThan(200)
    if (existsSync(binary)) {
      expect(result.differentialReplay).toBe('current-optimized-rust-match')
      expect(result.implementation.rust).not.toBeNull()
    } else {
      expect(result.differentialReplay).toBe('current-and-optimized-ts-match')
      expect(result.implementation.rust).toBeNull()
    }
  })
})
