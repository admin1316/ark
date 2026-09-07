import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deepResearch } from '../src/research.ts'
import type { KnowledgeWikiStageExecutor, KnowledgeWikiStageRequest } from '../src/stage-executor.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wiki-research-executor-'))
  roots.push(root)
  return root
}

describe('research executor result boundaries', () => {
  it('treats absent expansion text as no queries without searching or creating a page', async () => {
    const root = await projectRoot()
    const execute = vi.fn<KnowledgeWikiStageExecutor['execute']>(async () => ({ text: null }))

    await expect(deepResearch(
      { isolation: 'owned-worker-v1', execute }, 'fixture-provider', 'fixture-model', root, 'topic', new AbortController().signal,
    )).resolves.toEqual({ written: [], sourceCount: 0, warnings: ['research: LLM produced no usable queries'] })

    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: 'llm-complete', provider: 'fixture-provider', model: 'fixture-model', operation: 'research query expansion',
    }), expect.any(AbortSignal))
    expect(await readdir(root)).toEqual([])
  })

  it.each([false, true])('handles absent source/text fields after a search, synchronous failure=%s', async (searchThrows) => {
    const root = await projectRoot()
    const requests: KnowledgeWikiStageRequest[] = []
    const executor: KnowledgeWikiStageExecutor = {
      isolation: 'owned-subprocess-v1',
      execute(request) {
        requests.push(request)
        if (request.kind === 'web-search' && searchThrows) throw 'search process unavailable'
        return Promise.resolve({
          text: request.kind === 'llm-complete' && request.operation === 'research query expansion' ? 'valid query' : null,
        })
      },
    }

    await expect(deepResearch(executor, 'fixture-provider', 'fixture-model', root, 'topic', new AbortController().signal))
      .resolves.toEqual({
        written: [], sourceCount: 0,
        warnings: searchThrows ? ['search "valid query" failed: search process unavailable'] : [],
      })
    expect(requests).toEqual([
      expect.objectContaining({ kind: 'llm-complete', operation: 'research query expansion' }),
      { kind: 'web-search', query: 'valid query', maxResults: 4, timeoutMs: 60_000 },
      expect.objectContaining({ kind: 'llm-complete', operation: 'research synthesis' }),
    ])
    expect(requests.at(-1)).toHaveProperty('prompt', expect.stringContaining('(none — synthesize from general knowledge'))
    expect(await readdir(root)).toEqual([])
  })
})
