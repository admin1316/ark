import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeWikiStageExecutor } from '../src/stage-executor.ts'

const writes = vi.hoisted(() => ({ failure: undefined as unknown }))
vi.mock('../src/filesystem.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/filesystem.ts')>()
  return {
    ...actual,
    createPrivateConfinedFileIfMissing: (...args: Parameters<typeof actual.createPrivateConfinedFileIfMissing>) => {
      if (writes.failure !== undefined) throw writes.failure
      return actual.createPrivateConfinedFileIfMissing(...args)
    },
  }
})

import { deepResearch } from '../src/research.ts'

const roots: string[] = []
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'wiki-research-boundary-'))
  roots.push(value)
  return value
}

function executor(): KnowledgeWikiStageExecutor {
  return {
    isolation: 'owned-worker-v1',
    assertSearchAvailable: () => {},
    execute: request => Promise.resolve(request.kind === 'web-search'
      ? { text: null, sources: [{ url: 'https://fixture.test' }] }
      : { text: request.kind === 'llm-complete' && request.operation === 'research query expansion'
        ? 'valid query'
        : '--- FILE: wiki/_candidates/research/result.md ---\n---\ntitle: Result\n---\nBody\n--- END FILE ---' }),
  }
}

beforeEach(() => { writes.failure = undefined })
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('research write boundary', () => {
  it.each(['wiki', 'wiki/_candidates', 'wiki/_candidates/research'])
  ('refuses a real %s ancestor symlink without writing outside the project', async (part) => {
    const project = root()
    const outside = root()
    const linked = join(project, part)
    const remaining = 'wiki/_candidates/research'.slice(part.length).replace(/^\//u, '')
    const outsideParent = join(outside, remaining)
    mkdirSync(dirname(linked), { recursive: true })
    mkdirSync(outsideParent, { recursive: true })
    symlinkSync(outside, linked, 'dir')
    const result = await deepResearch(executor(), 'p', 'm', project, 'topic', new AbortController().signal)
    expect(result.written).toEqual([])
    expect(result.sourceCount).toBe(1)
    expect(result.warnings.join('\n')).toMatch(/symbolic link|unsafe directory/u)
    expect(existsSync(join(outsideParent, 'result.md'))).toBe(false)
  })

  it('reports a non-Error write failure without claiming a file was written', async () => {
    writes.failure = 'disk unavailable'
    const result = await deepResearch(executor(), 'p', 'm', root(), 'topic', new AbortController().signal)
    expect(result.warnings).toEqual(['disk unavailable'])
    expect(result.written).toEqual([])
  })
})
