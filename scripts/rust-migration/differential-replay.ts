/** Run the same deterministic corpus through TypeScript and the isolated Rust shadow. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { bm25 } from '../../packages/host/knowledge-wiki/src/search.ts'
import { benchmarkCorpus } from './benchmark-knowledge-search.ts'
import { isolatedChildEnvironment } from './process-isolation.ts'

interface RustHit {
  readonly path: string
  readonly score: number
}

interface RustOutput {
  readonly schemaVersion: number
  readonly results: RustHit[][]
  readonly digest: string
  readonly inputDigest: string
}

interface DifferentialReplayReport {
  readonly schemaVersion: 1
  readonly status: 'verified' | 'unknown' | 'failed'
  readonly corpusHash: string
  readonly tsDigest: string
  readonly rustDigest?: string
  readonly inputDigest?: string
  readonly mismatches: string[]
  readonly missingEvidence: string[]
}

const repoRoot = resolve(import.meta.dirname, '../..')
const manifestPath = resolve(repoRoot, 'rust/knowledge-search-shadow/Cargo.toml')
const binaryPath = resolve(repoRoot, 'rust/knowledge-search-shadow/target/release/knowledge-search-shadow')

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function compareResults(expected: RustHit[][], actual: RustHit[][]): string[] {
  const mismatches: string[] = []
  // The migration contract is byte-stable canonical replay. A tolerance here
  // would allow a score drift to pass while the Rust provider is still
  // producing a different ranking payload.
  if (JSON.stringify(expected) === JSON.stringify(actual)) return mismatches
  if (expected.length !== actual.length) mismatches.push(`query count ${actual.length} !== ${expected.length}`)
  const queryCount = Math.max(expected.length, actual.length)
  for (let queryIndex = 0; queryIndex < queryCount; queryIndex += 1) {
    const expectedHits = expected[queryIndex] ?? []
    const actualHits = actual[queryIndex] ?? []
    if (JSON.stringify(expectedHits) === JSON.stringify(actualHits)) continue
    if (expectedHits.length !== actualHits.length) {
      mismatches.push(`query ${queryIndex} hit count ${actualHits.length} !== ${expectedHits.length}`)
      continue
    }
    for (let hitIndex = 0; hitIndex < expectedHits.length; hitIndex += 1) {
      const expectedHit = expectedHits[hitIndex]
      const actualHit = actualHits[hitIndex]
      if (JSON.stringify(expectedHit) !== JSON.stringify(actualHit)) mismatches.push(`query ${queryIndex} hit ${hitIndex} differs`)
    }
  }
  return mismatches
}

function buildRust(): void {
  execFileSync('cargo', ['build', '--manifest-path', manifestPath, '--release', '--quiet'], {
    cwd: repoRoot,
    stdio: 'pipe',
    timeout: 30_000,
    env: isolatedChildEnvironment(),
  })
}

/** Run TypeScript and Rust against the same canonical JSON input. */
export function runDifferentialReplay(): DifferentialReplayReport {
  const input = benchmarkCorpus()
  const expected = input.queries.map(query => bm25(input.pages, query))
  const tsDigest = digest(expected)
  const payload = JSON.stringify({
    schemaVersion: 1,
    requestId: 'benchmark-request-1',
    sessionId: 'benchmark-session-1',
    generation: 1,
    capability: 'knowledge-search',
    deadlineMs: 30_000,
    budget: 1,
    cancellationToken: 'benchmark-cancellation-1',
    pages: input.pages,
    queries: input.queries,
  })
  if (!existsSync(binaryPath)) {
    try {
      buildRust()
    } catch (error) {
      return {
        schemaVersion: 1,
        status: 'unknown',
        corpusHash: input.hash,
        tsDigest,
        mismatches: [],
        missingEvidence: [`Rust shadow build unavailable: ${error instanceof Error ? error.message : String(error)}`],
      }
    }
  }
  try {
    const raw = execFileSync(binaryPath, [], {
      cwd: repoRoot,
      input: payload,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      env: isolatedChildEnvironment(),
    })
    const rust = JSON.parse(raw) as RustOutput
    const inputDigest = digest(JSON.parse(payload) as unknown)
    const rustDigest = digest(rust.results)
    if (rust.inputDigest !== inputDigest) throw new Error('Rust shadow input digest mismatch')
    if (rust.digest !== rustDigest) throw new Error('Rust shadow result digest mismatch')
    const mismatches = compareResults(expected, rust.results)
    return {
      schemaVersion: 1,
      status: mismatches.length === 0 ? 'verified' : 'failed',
      corpusHash: input.hash,
      tsDigest,
      rustDigest,
      inputDigest: rust.inputDigest,
      mismatches,
      missingEvidence: mismatches.length === 0
        ? ['production candidate profile exercise and authenticated enforcement receipt', 'cross-platform Rust measurements']
        : [],
    }
  } catch (error) {
    return {
      schemaVersion: 1,
      status: 'failed',
      corpusHash: input.hash,
      tsDigest,
      mismatches: [error instanceof Error ? error.message : String(error)],
      missingEvidence: [],
    }
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(runDifferentialReplay(), null, 2)}\n`)
}
