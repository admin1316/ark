import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { WebRuntime } from '@deepseek-ai/dsh-web'

const mocks = vi.hoisted(() => ({
  completeText: vi.fn(),
  parseFileBlocks: vi.fn(),
}))

vi.mock('../src/ingest.ts', () => ({
  completeText: mocks.completeText,
  parseFileBlocks: mocks.parseFileBlocks,
}))

import { deepResearch } from '../src/research.ts'
import { stageExecutorFor } from './stage-executor-fixture.ts'

const roots: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'wiki-research-'))
  roots.push(value)
  return value
}

const llm = {} as LlmRuntime

describe('deep research', () => {
  it('stops before search when query expansion contains no usable query', async () => {
    mocks.completeText.mockResolvedValue('x\n' + 'z'.repeat(121))

    await expect(deepResearch(
      stageExecutorFor(llm), 'p', 'm', await root(), 'topic', new AbortController().signal,
    )).resolves.toEqual({
      written: [],
      sourceCount: 0,
      warnings: ['research: LLM produced no usable queries'],
    })
    expect(mocks.completeText).toHaveBeenCalledOnce()
  })

  it('deduplicates sources, records search failures, and writes governed blocks', async () => {
    const project = await root()
    mocks.completeText
      .mockResolvedValueOnce('1. alpha query\n- beta query\n* alpha query\n• gamma query\n4) delta query\nepsilon query\nzeta query')
      .mockResolvedValueOnce('synthesis')
    mocks.parseFileBlocks.mockReturnValue([
      { path: 'draft.md', content: '---\ntitle: Draft\n---\n\nBody', closed: true },
      { path: 'kept.md', content: '---\nstatus: candidate\norigin: research\ntitle: Kept\n---\n\nBody', closed: true },
      { path: 'open.md', content: 'partial', closed: false },
    ])
    const search = vi.fn()
      .mockResolvedValueOnce({ sources: [
        { url: 'https://a.test', title: 'A', snippet: 'A snippet' },
        { url: 'https://shared.test' },
      ] })
      .mockRejectedValueOnce(new Error('provider down'))
      .mockRejectedValueOnce('string failure')
      .mockResolvedValueOnce({ sources: [
        { url: 'https://shared.test', title: 'duplicate' },
        { url: 'https://d.test', title: 'D', snippet: '' },
      ] })
      .mockResolvedValueOnce({ sources: [] })
    const web = { search } as unknown as WebRuntime

    const result = await deepResearch(
      stageExecutorFor(llm, web), 'p', 'm', project, 'topic', new AbortController().signal,
    )

    expect(search).toHaveBeenCalledTimes(5)
    expect(result.sourceCount).toBe(3)
    expect(result.written).toEqual([
      'wiki/_candidates/research/draft.md',
      'wiki/_candidates/research/kept.md',
    ])
    expect(result.warnings).toEqual([
      'search "beta query" failed: provider down',
      'search "gamma query" failed: string failure',
      'FILE block not closed: open.md',
    ])
    const draft = await readFile(join(project, result.written[0] ?? ''), 'utf8')
    expect(draft).toContain('origin: research')
    expect(draft).toContain('status: candidate')
    expect(mocks.completeText.mock.calls[1]?.[3]).toContain('https://shared.test')
  })

  it('synthesizes without web and reports filesystem failures without throwing', async () => {
    const projectFile = join(await root(), 'not-a-directory')
    await writeFile(projectFile, 'occupied', 'utf8')
    mocks.completeText
      .mockResolvedValueOnce('valid query')
      .mockResolvedValueOnce('synthesis')
    mocks.parseFileBlocks.mockReturnValue([
      { path: 'result.md', content: '---\ntitle: Result\n---\nBody', closed: true },
    ])

    const result = await deepResearch(
      stageExecutorFor(llm), 'p', 'm', projectFile, 'topic', new AbortController().signal,
    )

    expect(result.sourceCount).toBe(0)
    expect(result.written).toEqual([])
    expect(result.warnings[0]).toContain('web service unavailable')
    expect(result.warnings[1]).toBeTruthy()
    expect(mocks.completeText.mock.calls[1]?.[3]).toContain('(none — synthesize from general knowledge')
  })
})
