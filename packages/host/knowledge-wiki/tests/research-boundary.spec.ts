import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

const mocks = vi.hoisted(() => ({
  completeText: vi.fn(),
  mkdir: vi.fn(),
  parseFileBlocks: vi.fn(),
  resolve: vi.fn(),
  atomicWriteFile: vi.fn(),
}))

vi.mock('../src/ingest.ts', () => ({
  completeText: mocks.completeText,
  parseFileBlocks: mocks.parseFileBlocks,
}))
vi.mock('node:fs/promises', () => ({
  mkdir: mocks.mkdir,
}))
vi.mock('../src/filesystem.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/filesystem.ts')>()
  return { ...actual, atomicWriteFile: mocks.atomicWriteFile }
})
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  mocks.resolve.mockImplementation((...paths: string[]) => actual.resolve(...paths))
  return { ...actual, resolve: mocks.resolve }
})

import { deepResearch } from '../src/research.ts'
import { stageExecutorFor } from './stage-executor-fixture.ts'
import * as reviewOwner from '../src/reviews.ts'

const llm = {} as LlmRuntime

beforeEach(() => {
  vi.clearAllMocks()
  mocks.completeText.mockResolvedValueOnce('valid query').mockResolvedValueOnce('synthesis')
  mocks.parseFileBlocks.mockReturnValue([
    { path: 'result.md', content: '---\ntitle: Result\n---\nBody', closed: true },
  ])
})

describe('research write boundary', () => {
  it('rejects a resolved target outside the Wiki root', async () => {
    mocks.resolve.mockReturnValueOnce('/project/wiki').mockReturnValueOnce('/outside/result.md')

    await expect(deepResearch(
      stageExecutorFor(llm), 'p', 'm', '/project', 'topic', new AbortController().signal,
    )).resolves.toEqual({
      written: [],
      sourceCount: 0,
      warnings: [
        'search "valid query" failed: web service unavailable',
        'research: FILE path escapes wiki directory: result.md',
      ],
    })
    expect(mocks.mkdir).not.toHaveBeenCalled()
  })

  it('reports a non-Error write failure without throwing', async () => {
    mocks.resolve
      .mockReturnValueOnce('/project/wiki')
      .mockReturnValueOnce('/project/wiki/_candidates/research/result.md')
    mocks.mkdir.mockResolvedValue(undefined)
    mocks.atomicWriteFile.mockImplementation(() => { throw 'disk unavailable' })

    const result = await deepResearch(
      stageExecutorFor(llm), 'p', 'm', '/project', 'topic', new AbortController().signal,
    )
    expect(result.warnings).toContain('disk unavailable')
    expect(result.written).toEqual([])
  })

  it('reports a primitive review preflight failure without publishing a page', async () => {
    mocks.resolve
      .mockReturnValueOnce('/project/wiki')
      .mockReturnValueOnce('/project/wiki/_candidates/research/result.md')
    const prepare = vi.spyOn(reviewOwner, 'prepareReviewAppend').mockImplementation(() => {
      throw 'review preflight denied'
    })
    try {
      const result = await deepResearch(
        stageExecutorFor(llm), 'p', 'm', '/project', 'topic', new AbortController().signal,
      )
      expect(result.warnings).toContain('review preflight denied')
      expect(result.written).toEqual([])
      expect(mocks.mkdir).not.toHaveBeenCalled()
    } finally {
      prepare.mockRestore()
    }
  })
})
