import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

const mocks = vi.hoisted(() => ({
  prepareReviewAppend: vi.fn(),
  commitReviewAppend: vi.fn(),
}))

vi.mock('../src/reviews.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reviews.ts')>()
  return {
    ...actual,
    prepareReviewAppend: mocks.prepareReviewAppend,
    commitReviewAppend: mocks.commitReviewAppend,
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
  it('reports a non-Error combined review publication failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-review-errors-'))
    roots.push(root)
    const sourceRel = 'raw/sources/source.md'
    mkdirSync(dirname(join(root, sourceRel)), { recursive: true })
    writeFileSync(join(root, sourceRel), 'reusable source content', 'utf8')
    mocks.prepareReviewAppend.mockReturnValue({})
    mocks.commitReviewAppend.mockImplementation(() => { throw 'review failed' })
    const generated = [
      '---REVIEW: suggestion | Review---',
      'description: check',
      '---END REVIEW---',
    ].join('\n')

    const llm = llmFor(generated)
    const result = await ingestSource(
      stageExecutorFor(llm), 'p', 'm', root, sourceRel, new AbortController().signal,
    )

    expect(result.warnings).toContain('review append failed: review failed')
  })

  it('reports an Error during combined review preflight', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-review-errors-'))
    roots.push(root)
    const sourceRel = 'raw/sources/source.md'
    mkdirSync(dirname(join(root, sourceRel)), { recursive: true })
    writeFileSync(join(root, sourceRel), 'reusable source content', 'utf8')
    mocks.prepareReviewAppend.mockImplementation(() => { throw new Error('review preflight error') })

    const llm = llmFor('---REVIEW: suggestion | Review---\n---END REVIEW---')
    const result = await ingestSource(
      stageExecutorFor(llm), 'p', 'm', root, sourceRel, new AbortController().signal,
    )

    expect(result.warnings).toContain('review preflight failed: review preflight error')
  })

  it('keeps primitive preflight failures visible without publishing generated pages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-review-errors-'))
    roots.push(root)
    const sourceRel = 'raw/sources/source.md'
    mkdirSync(dirname(join(root, sourceRel)), { recursive: true })
    writeFileSync(join(root, sourceRel), 'reusable source content', 'utf8')
    mocks.prepareReviewAppend.mockImplementation(() => { throw 'review preflight denied' })
    const generated = [
      '--- FILE: wiki/_candidates/ingest/no-publish.md ---',
      '---', 'title: No publish', 'status: candidate', '---', 'Body.',
      '--- END FILE ---',
    ].join('\n')

    const result = await ingestSource(
      stageExecutorFor(llmFor(generated)), 'p', 'm', root, sourceRel, new AbortController().signal,
    )

    expect(result.written).toEqual([])
    expect(result.warnings).toContain('review preflight failed: review preflight denied')
  })
})
