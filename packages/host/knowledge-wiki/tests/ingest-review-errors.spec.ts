import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

const mocks = vi.hoisted(() => ({
  appendCandidateReviews: vi.fn(),
  appendReviews: vi.fn(),
}))

vi.mock('../src/reviews.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reviews.ts')>()
  return {
    ...actual,
    appendCandidateReviews: mocks.appendCandidateReviews,
    appendReviews: mocks.appendReviews,
  }
})

import { ingestSource } from '../src/ingest.ts'
import { stageExecutorFor } from './stage-executor-fixture.ts'

const roots: string[] = []

afterEach(() => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function llmFor(generated: string): LlmRuntime {
  let call = 0
  return {
    stream: () => (async function* () {
      yield { type: 'text-delta', text: call++ === 0 ? 'analysis' : generated }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  } as unknown as LlmRuntime
}

describe('ingest review error isolation', () => {
  it('reports non-Error advisory and candidate review failures independently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-review-errors-'))
    roots.push(root)
    const sourceRel = 'raw/sources/source.md'
    mkdirSync(dirname(join(root, sourceRel)), { recursive: true })
    writeFileSync(join(root, sourceRel), 'reusable source content', 'utf8')
    mocks.appendReviews.mockImplementation(() => { throw 'advisory failed' })
    mocks.appendCandidateReviews.mockImplementation(() => { throw 'candidate failed' })
    const generated = [
      '---REVIEW: suggestion | Review---',
      'description: check',
      '---END REVIEW---',
    ].join('\n')

    const llm = llmFor(generated)
    const result = await ingestSource(
      stageExecutorFor(llm), 'p', 'm', root, sourceRel, new AbortController().signal,
    )

    expect(result.warnings).toContain('review append failed: advisory failed')
    expect(result.warnings).toContain('candidate review failed: candidate failed')
  })

  it('reports Error advisory and candidate failures too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-review-errors-'))
    roots.push(root)
    const sourceRel = 'raw/sources/source.md'
    mkdirSync(dirname(join(root, sourceRel)), { recursive: true })
    writeFileSync(join(root, sourceRel), 'reusable source content', 'utf8')
    mocks.appendReviews.mockImplementation(() => { throw new Error('advisory error') })
    mocks.appendCandidateReviews.mockImplementation(() => { throw new Error('candidate error') })

    const llm = llmFor('---REVIEW: suggestion | Review---\n---END REVIEW---')
    const result = await ingestSource(
      stageExecutorFor(llm), 'p', 'm', root, sourceRel, new AbortController().signal,
    )

    expect(result.warnings).toContain('review append failed: advisory error')
    expect(result.warnings).toContain('candidate review failed: candidate error')
  })
})
