import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

vi.mock('../src/filesystem.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/filesystem.ts')>()
  return {
    ...actual,
    atomicWriteFile: (path: string, content: string | Buffer, mode?: number) => {
      if (path.includes('/wiki/_')) throw 'atomic string failure'
      actual.atomicWriteFile(path, content, mode)
    },
  }
})

import { ingestSource } from '../src/ingest.ts'
import { stageExecutorFor } from './stage-executor-fixture.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ingest fallback primitive failures', () => {
  it('renders non-Error log and summary failures independently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-fallback-string-'))
    roots.push(root)
    const sourceRel = 'raw/sources/source.md'
    mkdirSync(dirname(join(root, sourceRel)), { recursive: true })
    writeFileSync(join(root, sourceRel), 'source content', 'utf8')
    let call = 0
    const llm = {
      stream: () => (async function* () {
        yield { type: 'text-delta', text: call++ === 0 ? 'analysis' : 'no blocks' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    } as unknown as LlmRuntime

    const result = await ingestSource(
      stageExecutorFor(llm), 'p', 'm', root, sourceRel, new AbortController().signal,
    )
    expect(result.warnings).toContain('log append failed: atomic string failure')
    expect(result.warnings).toContain('summary fallback failed: atomic string failure')
  })
})
