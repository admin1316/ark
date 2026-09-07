import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

vi.mock('../src/sanitize.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sanitize.ts')>()
  return {
    ...actual,
    sanitizeIngestedFileContent: () => { throw 'sanitize string failure' },
  }
})

import { ingestSource } from '../src/ingest.ts'
import { stageExecutorFor } from './stage-executor-fixture.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ingest non-Error page failure', () => {
  it('renders thrown primitive values as warnings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-non-error-'))
    roots.push(root)
    const sourceRel = 'raw/sources/source.md'
    mkdirSync(dirname(join(root, sourceRel)), { recursive: true })
    writeFileSync(join(root, sourceRel), 'source content', 'utf8')
    let call = 0
    const llm = {
      stream: () => (async function* () {
        yield { type: 'text-delta', text: call++ === 0 ? 'analysis' : [
          '--- FILE: wiki/concepts/a.md ---',
          '---',
          'title: A',
          '---',
          'Body',
          '--- END FILE ---',
        ].join('\n') }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    } as unknown as LlmRuntime

    const result = await ingestSource(
      stageExecutorFor(llm), 'p', 'm', root, sourceRel, new AbortController().signal,
    )
    expect(result.warnings).toContain('sanitize string failure')
  })
})
